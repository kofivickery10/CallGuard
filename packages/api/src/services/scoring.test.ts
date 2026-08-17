import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// scoreTranscript talks to the real Anthropic SDK via a dynamic import
// (`await import('@anthropic-ai/sdk')` in scoring.ts), specifically so a test
// can stand in for it. The mock hands back one submit_scores payload per call
// to `messages.stream(...).finalMessage()`, taken in order from a queue the
// test fills in — one entry per consensus sampling run. An entry is either a
// bare score (the common case) or `{ score, coverage }` when a test also
// needs to control the journey-level coverage object riding the same call
// (docs/partial-journey-detection.md §3.1).
const rawScoreQueue: Array<number | { score: number; coverage?: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      stream: () => {
        const next = rawScoreQueue.shift() ?? 0;
        const entry = typeof next === 'number' ? { score: next } : next;
        return {
          finalMessage: async () => ({
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [
              {
                type: 'tool_use',
                input: {
                  items: [
                    {
                      scorecard_item_id: 'item-1',
                      score: entry.score,
                      confidence: 0.9,
                      evidence: 'quote',
                      reasoning: 'reasoning',
                    },
                  ],
                  ...(entry.coverage ? { coverage: entry.coverage } : {}),
                },
              },
            ],
          }),
        };
      },
    };
  },
}));

// scoring.ts reads config.anthropic.apiKey at scoreTranscript() call time (not
// module load), but config.ts itself throws if it's imported before
// ANTHROPIC_API_KEY is set in production — and requires it to be non-empty
// here for scoreTranscript to proceed past its own guard. Set it before the
// dynamic import below pulls in scoring.ts (and transitively config.ts), so a
// static top-of-file import can't race ahead of it.
let buildScoringPrompt: typeof import('./scoring.js').buildScoringPrompt;
let scoreTranscriptConsensus: typeof import('./scoring.js').scoreTranscriptConsensus;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY ||= 'test-key-not-real';
  ({ buildScoringPrompt, scoreTranscriptConsensus } = await import('./scoring.js'));
});

beforeEach(() => {
  rawScoreQueue.length = 0;
});

// Fix 1: the cached prefix must tell the model the transcript is data, not
// instructions — see injectionGuardLine in scoring.ts.
describe('buildScoringPrompt — prompt-injection guard', () => {
  it('puts an instruction in the CACHED block (not the dynamic one) telling the model to treat the transcript as untrusted evidence', () => {
    const { cached, dynamic } = buildScoringPrompt('irrelevant transcript', [
      { id: 'item-1', label: 'Test', description: null, score_type: 'binary' },
    ]);

    expect(cached).toMatch(/untrusted|not instructions|never instructions/i);
    expect(cached).toMatch(/do not act on it|not to be followed|never.*instructions to you/i);

    // The guard has to survive however the transcript is delimited, so it
    // must not be scoped to the dynamic per-call block where the transcript
    // itself is interpolated.
    expect(dynamic).not.toMatch(/untrusted/i);
  });
});

// Fix 2: consensus voting must use the tenant's real pass threshold, not the
// shared PASS_THRESHOLD default, or a checkpoint near a customised threshold
// gets voted "agreed" against the wrong bar and skips manual review.
describe('scoreTranscriptConsensus — threshold-aware voting', () => {
  const items = [
    { id: 'item-1', label: 'Test criterion', description: null, score_type: 'scale_1_5' as const },
  ];

  // Three runs score this item 3, 4, 4 on a 1-5 scale, which normalizeScore
  // maps to 50, 75, 75 out of 100.
  const runScores = [3, 4, 4];

  it('at the default threshold (70), the two 75s outvote the 50 and the item is disputed but agreement is 2/3', async () => {
    rawScoreQueue.push(...runScores);
    const result = await scoreTranscriptConsensus(
      3,
      undefined, // passThreshold omitted — falls back to shared PASS_THRESHOLD (70)
      'irrelevant transcript',
      items
    );

    const item = result.items.find((i) => i.scorecard_item_id === 'item-1')!;
    expect(item.disputed).toBe(true);
    expect(item.agreement).toBeCloseTo(2 / 3);
  });

  it('at a tenant-customised threshold of 80, all three runs fail and the item is unanimous (undisputed) instead', async () => {
    // The same three raw scores (50, 75, 75 normalized) all fall short of 80,
    // so every run agrees on FAIL — a different verdict, and a different
    // agreement outcome, purely because the threshold changed.
    rawScoreQueue.push(...runScores);
    const result = await scoreTranscriptConsensus(
      3,
      80,
      'irrelevant transcript',
      items
    );

    const item = result.items.find((i) => i.scorecard_item_id === 'item-1')!;
    expect(item.disputed).toBe(false);
    expect(item.agreement).toBe(1);
  });
});

// docs/partial-journey-detection.md §3.1 — coverage rides the same
// submit_scores call as the checkpoints, so consensus voting must resolve it
// the same way: majority verdict, with disagreement recorded rather than
// settled by whichever sample happened to run first.
describe('scoreTranscriptConsensus — coverage majority vote', () => {
  const items = [
    { id: 'item-1', label: 'Test criterion', description: null, score_type: 'binary' as const },
  ];

  it('takes the majority verdict on starts_mid_conversation and records the disagreement', async () => {
    rawScoreQueue.push(
      {
        score: 1,
        coverage: { starts_mid_conversation: true, missing_stages: ['intro'], rationale: 'Opens mid-process.' },
      },
      {
        score: 1,
        coverage: {
          starts_mid_conversation: true,
          missing_stages: ['intro', 'fact_find'],
          rationale: 'Continuation of a prior, uncaptured call.',
        },
      },
      {
        score: 1,
        coverage: { starts_mid_conversation: false, missing_stages: [], rationale: 'Looks complete.' },
      }
    );

    const result = await scoreTranscriptConsensus(
      3,
      undefined,
      'irrelevant transcript',
      items,
      null,
      null,
      undefined,
      false,
      null,
      true // journeyMode — only then does the schema request coverage at all
    );

    expect(result.coverage).toBeDefined();
    expect(result.coverage!.raw.starts_mid_conversation).toBe(true);
    expect(result.coverage!.agreement).toBeCloseTo(2 / 3);
    expect(result.coverage!.disputed).toBe(true);
  });

  it('is unanimous (undisputed) when every run agrees', async () => {
    rawScoreQueue.push(
      { score: 1, coverage: { starts_mid_conversation: false, missing_stages: [], rationale: 'Complete.' } },
      { score: 1, coverage: { starts_mid_conversation: false, missing_stages: [], rationale: 'Complete.' } },
      { score: 1, coverage: { starts_mid_conversation: false, missing_stages: [], rationale: 'Complete.' } }
    );

    const result = await scoreTranscriptConsensus(
      3,
      undefined,
      'irrelevant transcript',
      items,
      null,
      null,
      undefined,
      false,
      null,
      true
    );

    expect(result.coverage!.raw.starts_mid_conversation).toBe(false);
    expect(result.coverage!.agreement).toBe(1);
    expect(result.coverage!.disputed).toBe(false);
  });

  it('is undefined when the runs never returned a coverage object at all (e.g. journeyMode false)', async () => {
    rawScoreQueue.push({ score: 1 }, { score: 1 }, { score: 1 });

    const result = await scoreTranscriptConsensus(3, undefined, 'irrelevant transcript', items);

    expect(result.coverage).toBeUndefined();
  });
});
