import { config } from '../config.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import type { CallCoaching } from '@callguard/shared';

// 1-hour prompt-cache TTL (2x write, 0.1x read). The pinned SDK's types
// predate the GA `ttl` field, hence the cast; the beta header below is the
// pre-GA opt-in — harmless now, and keeps this working if the account is
// still gated on it.
export const CACHE_1H = { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' };
export const CACHE_TTL_HEADERS = { headers: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } };

interface ScorecardItemInput {
  id: string;
  label: string;
  description: string | null;
  score_type: 'binary' | 'scale_1_5' | 'scale_1_10';
  // Checkpoint model additions (spec §8) — only 'ai' items with these
  // populated are ever passed to this function; 'manual' and branch-excluded
  // ('na') items are filtered out by the caller before scoring.
  expectation?: string | null;
  ai_check?: string | null;
  consent_gate?: boolean;
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
  kbContext: string | null | undefined = '',
  withCoaching: boolean = false,
  learning?: LearningContext | null,
  industry?: string | null,
  journeyMode: boolean = false
): { cached: string; dynamic: string } {
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

      const expectationLine = item.expectation ? `\n  Expectation: ${item.expectation}` : '';
      const aiCheckLine = item.ai_check
        ? `\n  Presence-and-meaning check: ${item.ai_check} — a keyword match alone is not enough; confirm the substance was actually conveyed.`
        : '';
      const consentLine = item.consent_gate
        ? '\n  CONSENT GATE: only score this as met if the customer gives an explicit, affirmative response (e.g. "yes", "that\'s fine", "I agree"). Do NOT infer consent from silence, from the call continuing, or from the adviser proceeding as if consent were given. If the transcript does not show an explicit customer affirmative, score it as not met.'
        : '';

      return `Criterion ${i + 1} (ID: ${item.id}):
  Label: ${item.label}
  ${item.description ? `Rubric: ${item.description}` : ''}${expectationLine}${aiCheckLine}${consentLine}
  Scoring: ${scaleDesc}${correctionsBlock}`;
    })
    .join('\n\n');

  const kbBlock = kbContext?.trim()
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

  const domain = industry?.trim();
  const callHeadline = domain
    ? `a UK ${domain} call`
    : 'a UK sales or customer-service call';
  const domainContextLine = domain
    ? `- This is ${callHeadline} between an agent/adviser and the customer. Evaluate it against the standards, disclosures and regulatory expectations of that sector, using the Business Knowledge Base below for the firm's specifics.`
    : '- This is a sales or customer-service call between an agent and a customer. Use the Business Knowledge Base below to understand the products, expected call flow, and context.';

  // Split into a stable, cacheable prefix (system framing + KB + exemplars +
  // criteria + instructions — identical for every call scored against the same
  // scorecard for this org) and a volatile suffix (this agent's prior coaching +
  // this call's transcript). Prompt caching then bills the big prefix once per
  // ~1-hour window (see the cache_control ttl below) instead of on every call.
  const cached = `You are a call quality and compliance analyst evaluating ${callHeadline}. You will evaluate the transcript against specific scoring criteria.

## Important Context

${domainContextLine}
- Speaker labels ("Agent" / "Customer") are auto-generated and may occasionally be swapped. Use context to determine who is actually the agent vs customer. The agent is the one asking verification questions, presenting products, reading disclaimers, and guiding the call flow. The customer is asking questions, confirming details, and making decisions.
- The audio quality may be low, so some words may be transcribed incorrectly. Consider near-homophones and phonetic similarities when evaluating.
- Personal/sensitive data is redacted to typed tags like [PII_NAME_1], [LOCATION_1], [PHONE_NUMBER_1], [CREDIT_CARD_1] or [PHI_...]. A tag is positive evidence that the customer DID provide (and/or the agent DID collect) that piece of information - treat it as the information being present, and quote the tag as evidence. Do NOT mark a criterion unmet merely because the value is redacted. The one limit: when a criterion requires the agent to read a value back and confirm it MATCHES what the customer gave, you cannot verify the values are identical (each redacted instance is numbered independently) - score that on whether the read-back/confirmation step occurred, and note the limitation in your reasoning.${kbBlock}${exemplarBlock}

## Scoring Criteria

${criteriaBlock}

## Instructions

Evaluate the call transcript${journeyMode ? '(s)' : ''} (provided below) against each criterion listed above. For each criterion:
1. Determine the appropriate score based on the scoring type
2. Provide a direct quote from the transcript as evidence (or state "No relevant evidence found")
3. Explain your reasoning in 1-2 sentences
4. Assess your confidence from 0.0 to 1.0
${journeyMode ? `
This is a customer JOURNEY spanning multiple calls, each delimited by a header like "=== Call 2 (2026-01-15, agent: Jane) ===". Score each criterion against the whole journey, not any single call in isolation — a statement, disclosure or consent counts as met if it was given anywhere across the calls, even if the criterion's specific call ended without it. When you cite evidence, prefix the quote with the matching call marker in brackets exactly as shown, e.g. \`[Call 2] "...quote..."\`, so it's clear which call it came from.
` : ''}
Be strict but fair. Only score based on what is explicitly present in the transcript${journeyMode ? '(s)' : ''}.
If the transcript${journeyMode ? '(s are)' : ' is'} unclear or the criterion cannot be evaluated, give the lowest score and note low confidence.${withCoaching ? `

## Coaching Output (REQUIRED)

In addition to the scoring, produce a coaching brief for the agent:

- **summary**: 1-2 sentences describing the overall call quality in plain, motivating language
- **strengths**: 2-4 specific things the agent did well (reference exact moments where possible)
- **improvements**: 2-4 specific things to work on next time (be constructive, not punitive)
- **next_actions**: 1-3 concrete, practical actions the agent should take next (e.g. "Practice open-ended ATR questioning using the scenario: 'If your portfolio fell 20%, how would that affect your plans?'")

Coaching tone: supportive, specific, actionable. Avoid generic platitudes like "keep up the good work" - be concrete. If the call was a critical fail, focus coaching on the most impactful 2-3 things the agent must change, not a laundry list.` : ''}`;

  const dynamic = `${priorCoachingBlock}

## Call Transcript${journeyMode ? 's (this customer\'s journey)' : ''}

<transcript>
${transcript}
</transcript>`;

  return { cached, dynamic };
}

const DEFAULT_SCORING_MODEL = CLAUDE_MODELS.HAIKU;

export async function scoreTranscript(
  transcript: string,
  items: ScorecardItemInput[],
  modelOverride: string | null = null,
  kbContext: string | null = null,
  learning?: LearningContext | null,
  withCoaching: boolean = false,
  industry: string | null = null,
  // True for journey scoring (spec §9): the transcript spans multiple calls
  // delimited by "=== Call N ===" markers — see services/journey.ts, which
  // asks Claude to prefix evidence quotes with the matching marker so the
  // journey processor can attribute each checkpoint back to its source call.
  journeyMode: boolean = false
): Promise<{ output: ScoringOutput; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }; model: string }> {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env - needed for scoring');
  }

  // Dynamic import to avoid SDK initializing at startup
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const model = modelOverride ?? DEFAULT_SCORING_MODEL;

  const prompt = buildScoringPrompt(transcript, items, kbContext, withCoaching, learning, industry, journeyMode);

  const response = await client.messages.create({
    model,
    max_tokens: withCoaching ? 6144 : 4096,
    messages: [
      {
        role: 'user',
        content: [
          // Stable prefix (scorecard + KB + instructions) — cached across
          // calls. 1-hour TTL (2x write vs 1.25x for 5-min, reads 0.1x
          // either way): production calls arrive minutes-to-an-hour apart,
          // which the 5-minute TTL misses on all but tight batches — one
          // extra hit within the hour already pays for the dearer write.
          { type: 'text', text: prompt.cached, cache_control: CACHE_1H },
          // Per-call suffix (this agent's coaching + this transcript).
          { type: 'text', text: prompt.dynamic },
        ],
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
  }, CACHE_TTL_HEADERS);

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
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    model,
  };
}

/**
 * Independent second opinion on a small set of flagged (failed) criteria, run on
 * a stronger model. Used to confirm or overturn first-pass breaches before they
 * hit the register — high accuracy where it matters, without paying for the
 * bigger model on every item of every call.
 */
export async function verifyItems(
  transcript: string,
  items: Array<ScorecardItemInput & {
    firstPass: { score: number; evidence: string; reasoning: string };
  }>,
  kbContext: string | null = null,
  industry: string | null = null
): Promise<{
  items: ItemScoreOutput[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  model: string;
}> {
  const model = CLAUDE_MODELS.SONNET;
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env - needed for verification');
  }
  if (items.length === 0) {
    return {
      items: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      model,
    };
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const domain = industry?.trim();
  const headline = domain ? `a UK ${domain} call` : 'a UK sales or customer-service call';

  const criteriaBlock = items
    .map((item, i) => {
      const scaleDesc = {
        binary: 'Score 1 if yes, 0 if no.',
        scale_1_5: 'Score from 1 (poor) to 5 (excellent).',
        scale_1_10: 'Score from 1 (poor) to 10 (excellent).',
      }[item.score_type];
      const expectationLine = item.expectation ? `\n  Expectation: ${item.expectation}` : '';
      const consentLine = item.consent_gate
        ? '\n  CONSENT GATE: only confirm this as met if the customer gives an explicit, affirmative response. Do not accept inferred consent as grounds to overturn a failure.'
        : '';
      return `Criterion ${i + 1} (ID: ${item.id}):
  Label: ${item.label}
  ${item.description ? `Rubric: ${item.description}` : ''}${expectationLine}${consentLine}
  Scoring: ${scaleDesc}
  First-pass verdict (to confirm or overturn): scored ${item.firstPass.score} — ${item.firstPass.reasoning || 'no reasoning given'} (evidence: ${item.firstPass.evidence || 'none cited'})`;
    })
    .join('\n\n');

  const kbBlock = kbContext?.trim()
    ? `\n\n## Business Knowledge Base\n\n${kbContext}\n`
    : '';

  // Stable per-org prefix (instructions + KB) vs per-call suffix (the flagged
  // criteria + transcript). The prefix is most of this prompt's tokens when a
  // KB is configured, and it's identical for every verify in the org — cache
  // it (1h TTL, same reasoning as scoreTranscript) so only the per-call part
  // bills at Sonnet's full input rate. Orgs without a KB fall below Sonnet's
  // minimum cacheable prefix and silently skip caching, which is harmless.
  const cachedPrefix = `You are a senior compliance QA reviewer providing an independent second opinion on ${headline}. A faster first-pass model marked the criteria below as FAILED (a breach). Re-evaluate each one strictly and independently against the transcript, then either CONFIRM the failure or OVERTURN it if the first pass got it wrong.

Be rigorous in both directions: a wrong breach in a regulated firm's compliance register is costly, and so is a missed one. Only score a criterion as met (passed) if the transcript clearly shows it was satisfied; only confirm a failure if the transcript clearly shows it was not.

Personal/sensitive data is redacted to typed tags like [PII_NAME_1], [PHONE_NUMBER_1] or [CREDIT_CARD_1]. A tag is positive evidence the information was provided/collected - do NOT confirm a failure simply because a value is redacted. Only where a criterion needs the agent to confirm a read-back value MATCHES the customer's, treat the match as unverifiable and judge on whether the confirmation step occurred.

For each criterion return the corrected score, a direct quote from the transcript as evidence (or "No relevant evidence found"), 1-2 sentences of reasoning, and your confidence from 0.0 to 1.0.${kbBlock}`;

  const dynamic = `## Criteria to re-check

${criteriaBlock}

## Call Transcript

<transcript>
${transcript}
</transcript>`;

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: cachedPrefix, cache_control: CACHE_1H },
          { type: 'text', text: dynamic },
        ],
      },
    ],
    tools: [
      {
        name: 'submit_scores',
        description: 'Submit the re-checked evaluation scores',
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
                required: ['scorecard_item_id', 'score', 'confidence', 'evidence', 'reasoning'],
              },
            },
          },
          required: ['items'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_scores' },
  }, CACHE_TTL_HEADERS);

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Verifier did not return structured scores');
  }

  return {
    items: (toolUse.input as { items: ItemScoreOutput[] }).items,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    model,
  };
}

// Clamped to [0, 100] — Claude's raw score is expected within the scale's
// range (e.g. 1-5), but an out-of-range or malformed value (0, a negative
// number, a hallucinated 6 on a 1-5 scale) would otherwise normalize outside
// [0, 100] and skew the weighted average / auto-exemplar check silently.
export function normalizeScore(score: number, scoreType: string): number {
  const normalized = (() => {
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
  })();
  return Math.min(100, Math.max(0, normalized));
}
