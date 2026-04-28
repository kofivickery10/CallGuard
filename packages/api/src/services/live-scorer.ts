import { config } from '../config.js';

interface ScorecardItem {
  id: string;
  label: string;
  description: string | null;
  score_type: 'binary' | 'scale_1_5' | 'scale_1_10';
  severity: 'critical' | 'high' | 'medium' | 'low' | string | null;
}

export interface LiveBreach {
  scorecard_item_id: string;
  scorecard_item_label: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidence: string;
  confidence: number;
}

interface LiveScoringInput {
  partialTranscript: string;
  scorecardItems: ScorecardItem[];
  alreadyEmittedItemIds: Set<string>;
  kbContext?: string;
}

const PASS_THRESHOLD_NORMALIZED = 70;

/**
 * Run a fast scoring pass over a partial in-progress transcript and return
 * any new breaches that haven't already been emitted for this session.
 *
 * Scoped to "is this clearly already broken" rather than "what's the final
 * score" - we want low false-positive rate so we don't spam the agent
 * with bogus alerts mid-call.
 */
export async function detectLiveBreaches(input: LiveScoringInput): Promise<LiveBreach[]> {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set - required for live scoring');
  }
  if (input.partialTranscript.trim().length < 80) {
    // Too little content - skip to avoid false positives on tiny transcripts
    return [];
  }

  const remaining = input.scorecardItems.filter((i) => !input.alreadyEmittedItemIds.has(i.id));
  if (remaining.length === 0) return [];

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const criteriaBlock = remaining
    .map((item, i) => {
      return `Criterion ${i + 1} (ID: ${item.id})
  Label: ${item.label}
  ${item.description ? `Rubric: ${item.description}` : ''}`;
    })
    .join('\n\n');

  const prompt = `You are a live compliance monitor watching a sales/service call as it happens. The call is still in progress - the transcript below is everything spoken so far.

Identify ONLY criteria where you are highly confident a breach has already occurred (failed) based on what's been said. Be conservative - if the missing element could plausibly come later in the call, do NOT flag it.

Rules:
- Only flag breaches that are CLEARLY already broken (e.g. agent used pressure language, said something prohibited, gave wrong disclosure)
- Do NOT flag absence-of-something unless the call has clearly moved past the point where it should have happened
- Confidence threshold: only return items where you'd bet money on the breach being real

${input.kbContext ? `## Business Context\n${input.kbContext}\n\n` : ''}## Criteria to monitor
${criteriaBlock}

## In-progress transcript
<transcript>
${input.partialTranscript}
</transcript>

Return only the criteria you are confident have already been breached.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    tools: [
      {
        name: 'report_live_breaches',
        description: 'Report criteria that have clearly already been breached in the in-progress call',
        input_schema: {
          type: 'object' as const,
          properties: {
            breaches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  scorecard_item_id: { type: 'string' },
                  evidence: { type: 'string', description: 'Direct quote or paraphrase from transcript showing the breach' },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                },
                required: ['scorecard_item_id', 'evidence', 'confidence'],
              },
            },
          },
          required: ['breaches'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'report_live_breaches' },
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') return [];

  const out = toolUse.input as {
    breaches: Array<{ scorecard_item_id: string; evidence: string; confidence: number }>;
  };

  // Map back to scorecard items, gate on confidence, gate out anything we already emitted
  const minConfidence = 0.75;
  const breaches: LiveBreach[] = [];
  for (const b of out.breaches) {
    if (b.confidence < minConfidence) continue;
    if (input.alreadyEmittedItemIds.has(b.scorecard_item_id)) continue;
    const item = input.scorecardItems.find((i) => i.id === b.scorecard_item_id);
    if (!item) continue;
    breaches.push({
      scorecard_item_id: item.id,
      scorecard_item_label: item.label,
      severity: deriveSeverity(item.severity),
      evidence: b.evidence,
      confidence: b.confidence,
    });
  }
  return breaches;
}

function deriveSeverity(s: ScorecardItem['severity']): 'critical' | 'high' | 'medium' | 'low' {
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') return s;
  return 'medium';
}

export const LIVE_PASS_THRESHOLD = PASS_THRESHOLD_NORMALIZED;
