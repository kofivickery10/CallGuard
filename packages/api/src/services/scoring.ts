import { config } from '../config.js';
import type { CallCoaching } from '@callguard/shared';

interface ScorecardItemInput {
  id: string;
  label: string;
  description: string | null;
  score_type: 'binary' | 'scale_1_5' | 'scale_1_10';
}

export interface ItemScoreOutput {
  scorecard_item_id: string;
  score: number;
  confidence: number;
  evidence: string;
  reasoning: string;
}

export interface ScoringOutput {
  items: ItemScoreOutput[];
  coaching?: CallCoaching;
}

export interface LearningContext {
  // Per-scorecard-item list of past corrections
  correctionsByItem: Record<string, Array<{
    corrected_pass: boolean;
    reason: string | null;
    transcript_excerpt: string | null;
  }>>;
  // Firm exemplar transcript excerpts
  exemplars: Array<{ excerpt: string; reason: string | null }>;
  // Prior coaching given to this agent
  priorCoaching: Array<{ created_at: string; coaching: CallCoaching }>;
}

function buildScoringPrompt(
  transcript: string,
  items: ScorecardItemInput[],
  kbContext: string = '',
  withCoaching: boolean = false,
  learning?: LearningContext
): string {
  const criteriaBlock = items
    .map((item, i) => {
      const scaleDesc = {
        binary: 'Score 1 if yes, 0 if no.',
        scale_1_5: 'Score from 1 (poor) to 5 (excellent).',
        scale_1_10: 'Score from 1 (poor) to 10 (excellent).',
      }[item.score_type];

      // Append any past corrections for this specific criterion
      const corrections = learning?.correctionsByItem[item.id] || [];
      const correctionsBlock = corrections.length > 0
        ? `\n  Tenant calibration (past human corrections):\n${corrections
            .slice(0, 5)
            .map((c, idx) => {
              const excerpt = (c.transcript_excerpt || '').slice(0, 200);
              return `    ${idx + 1}. Human judged: ${c.corrected_pass ? 'PASS' : 'FAIL'}${c.reason ? ` - ${c.reason}` : ''}${excerpt ? ` (evidence: "${excerpt}")` : ''}`;
            })
            .join('\n')}`
        : '';

      return `Criterion ${i + 1} (ID: ${item.id}):
  Label: ${item.label}
  ${item.description ? `Rubric: ${item.description}` : ''}
  Scoring: ${scaleDesc}${correctionsBlock}`;
    })
    .join('\n\n');

  const kbBlock = kbContext.trim()
    ? `\n\n## Business Knowledge Base\n\nThis is the business-specific context you should use when evaluating. Use this to understand the company's products, compliance requirements, expected call flow, and industry-specific language.\n\n${kbContext}\n`
    : '';

  const exemplarBlock = learning?.exemplars && learning.exemplars.length > 0
    ? `\n\n## Firm Exemplars (What Good Looks Like Here)\n\nThe following excerpts are from calls this firm has marked as exemplars - representative of the quality bar. Score the current call against this standard:\n\n${learning.exemplars
        .map((e, i) => `**Exemplar ${i + 1}${e.reason ? ` - ${e.reason}` : ''}:**\n${e.excerpt.slice(0, 400)}`)
        .join('\n\n')}\n`
    : '';

  const priorCoachingBlock = withCoaching && learning?.priorCoaching && learning.priorCoaching.length > 0
    ? `\n\n## Prior Coaching Given To This Agent\n\nBelow is the most recent coaching this agent received. When producing coaching for the current call:\n- If they have improved on prior flagged areas, explicitly acknowledge it\n- If they have NOT improved, escalate the tone (firmer language, clearer action)\n- Avoid repeating the same improvements verbatim unless the issue has recurred\n\n${learning.priorCoaching
        .slice(0, 3)
        .map((pc, i) => {
          return `**${i + 1}. ${new Date(pc.created_at).toLocaleDateString('en-GB')}:**\n- Summary: ${pc.coaching.summary}\n- Improvements flagged: ${pc.coaching.improvements.slice(0, 3).join('; ')}\n- Actions requested: ${pc.coaching.next_actions.slice(0, 2).join('; ')}`;
        })
        .join('\n\n')}\n`
    : '';

  return `You are a call center quality analyst evaluating a UK telecom/broadband sales call. You will evaluate the transcript against specific scoring criteria.

## Important Context

- This is a call between a sales agent and a customer about broadband, mobile, energy, or utility services.
- Speaker labels ("Agent" / "Customer") are auto-generated and may occasionally be swapped. Use context to determine who is actually the agent vs customer. The agent is the one asking verification questions, presenting products, reading disclaimers, and guiding the call flow. The customer is asking questions, confirming details, and making decisions.
- The audio quality may be low, so some words may be transcribed incorrectly. Consider near-homophones and phonetic similarities when evaluating.${kbBlock}${exemplarBlock}${priorCoachingBlock}

## Scoring Criteria

${criteriaBlock}

## Call Transcript

<transcript>
${transcript}
</transcript>

## Instructions

Evaluate the transcript against each criterion listed above. For each criterion:
1. Determine the appropriate score based on the scoring type
2. Provide a direct quote from the transcript as evidence (or state "No relevant evidence found")
3. Explain your reasoning in 1-2 sentences
4. Assess your confidence from 0.0 to 1.0

Be strict but fair. Only score based on what is explicitly present in the transcript.
If the transcript is unclear or the criterion cannot be evaluated, give the lowest score and note low confidence.${withCoaching ? `

## Coaching Output (REQUIRED)

In addition to the scoring, produce a coaching brief for the agent:

- **summary**: 1-2 sentences describing the overall call quality in plain, motivating language
- **strengths**: 2-4 specific things the agent did well (reference exact moments where possible)
- **improvements**: 2-4 specific things to work on next time (be constructive, not punitive)
- **next_actions**: 1-3 concrete, practical actions the agent should take next (e.g. "Practice open-ended ATR questioning using the scenario: 'If your portfolio fell 20%, how would that affect your plans?'")

Coaching tone: supportive, specific, actionable. Avoid generic platitudes like "keep up the good work" - be concrete. If the call was a critical fail, focus coaching on the most impactful 2-3 things the agent must change, not a laundry list.` : ''}`;
}

export async function scoreTranscript(
  transcript: string,
  items: ScorecardItemInput[],
  kbContext: string = '',
  withCoaching: boolean = false,
  learning?: LearningContext
): Promise<{ output: ScoringOutput; usage: { input_tokens: number; output_tokens: number }; model: string }> {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env - needed for scoring');
  }

  // Dynamic import to avoid SDK initializing at startup
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const model = 'claude-sonnet-4-20250514';

  const response = await client.messages.create({
    model,
    max_tokens: withCoaching ? 6144 : 4096,
    messages: [
      {
        role: 'user',
        content: buildScoringPrompt(transcript, items, kbContext, withCoaching, learning),
      },
    ],
    tools: [
      {
        name: 'submit_scores',
        description: 'Submit the evaluation scores for all criteria',
        input_schema: {
          type: 'object' as const,
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  scorecard_item_id: { type: 'string' },
                  score: { type: 'number' },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  evidence: { type: 'string' },
                  reasoning: { type: 'string' },
                },
                required: [
                  'scorecard_item_id',
                  'score',
                  'confidence',
                  'evidence',
                  'reasoning',
                ],
              },
            },
            ...(withCoaching ? {
              coaching: {
                type: 'object',
                description: 'Coaching brief for the agent - strengths, improvements, and next actions',
                properties: {
                  summary: { type: 'string', description: '1-2 sentence overall assessment' },
                  strengths: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 2,
                    maxItems: 4,
                  },
                  improvements: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 2,
                    maxItems: 4,
                  },
                  next_actions: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    maxItems: 3,
                  },
                },
                required: ['summary', 'strengths', 'improvements', 'next_actions'],
              },
            } : {}),
          },
          required: withCoaching ? ['items', 'coaching'] : ['items'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_scores' },
  });

  const toolUse = response.content.find(
    (block) => block.type === 'tool_use'
  );
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return structured scores');
  }

  return {
    output: toolUse.input as ScoringOutput,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    model,
  };
}

export function normalizeScore(score: number, scoreType: string): number {
  switch (scoreType) {
    case 'binary':
      return score * 100;
    case 'scale_1_5':
      return ((score - 1) / 4) * 100;
    case 'scale_1_10':
      return ((score - 1) / 9) * 100;
    default:
      return score;
  }
}
