import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { scoreTranscript } from '../../services/scoring.js';
import { getLearningContext } from '../../services/learning-context.js';
import { processScoring } from './score.js';

// Per-call scoring, through the processor with the database and integrations
// mocked. A consent gate below the speaker-confidence floor is still scored by
// the model (provisionally, for a reviewer to confirm), so it must receive the
// firm's calibration examples like any other checkpoint, and still go to review.

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../services/scoring.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/scoring.js')>()),
  scoreTranscript: vi.fn(),
  scoreTranscriptConsensus: vi.fn(),
}));
vi.mock('../../services/kb.js', () => ({ getKBContext: vi.fn(async () => '') }));
vi.mock('../../services/alert-evaluator.js', () => ({ evaluateAlertsForCall: vi.fn(async () => {}) }));
vi.mock('../../services/learning-context.js', () => ({ getLearningContext: vi.fn(async () => undefined) }));
vi.mock('../../services/usage.js', () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock('../../services/webhook-delivery.js', () => ({ deliverCallScored: vi.fn(async () => {}) }));
vi.mock('../../services/zoho.js', () => ({ pushCallScored: vi.fn(async () => {}) }));
vi.mock('../../services/capture-runs.js', () => ({ maybeStartCallCapture: vi.fn(async () => {}) }));
vi.mock('../../services/tenant-settings.js', () => ({
  getScoringSettings: vi.fn(async () => ({
    minScoreableWords: 0,
    minScoreableSeconds: 0,
    passThreshold: 70,
    scoringSamples: 1,
    reviewConfidenceFloor: 0,
  })),
}));

function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label: `Checkpoint ${id}`,
    description: null,
    score_type: 'binary',
    weight: '1',
    severity: null,
    sort_order: 1,
    item_type: 'ai',
    applies_when: null,
    applies_to_products: null,
    expectation: null,
    ai_check: null,
    consent_gate: false,
    ...extra,
  };
}

describe('processScoring — calibration context for provisional checkpoints', () => {
  it('passes the provisional consent gate to the learning context and still routes it to review', async () => {
    const txCalls: Array<{ sql: string; params: unknown[] }> = [];

    vi.mocked(queryOne).mockImplementation((async (sql: string) => {
      if (sql.includes('FROM calls')) {
        return {
          id: 'call-1',
          organization_id: 'org-1',
          scorecard_id: 'scorecard-1',
          agent_id: 'agent-1',
          transcript_text: 'Agent: Are you happy to proceed?\nCustomer: Yes, that is fine.',
          duration_seconds: 120,
          // Below the consent-gate floor: the gate is provisional.
          speaker_attribution_confidence: 0.3,
          speaker_integrity_flag: null,
          customer_id: null,
        };
      }
      if (sql.includes('FROM scorecards')) return { id: 'scorecard-1', version: 1, branch_config: null };
      if (sql.includes('FROM organizations')) return { plan: 'enterprise', industry: null };
      return null;
    }) as never);
    vi.mocked(query).mockImplementation((async (sql: string) =>
      sql.includes('FROM scorecard_items')
        ? [item('disclosure'), item('consent', { consent_gate: true })]
        : []) as never);
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          txCalls.push({ sql, params });
          return [{ id: `row-${txCalls.length}` }];
        }),
      })) as never);
    vi.mocked(scoreTranscript).mockImplementation((async () => ({
      output: {
        items: ['disclosure', 'consent'].map((id) => ({
          scorecard_item_id: id,
          score: 1,
          confidence: 0.9,
          evidence: 'quote',
          reasoning: 'reasoning',
        })),
      },
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      model: 'test-model',
    })) as never);

    await processScoring({ data: { callId: 'call-1' } } as unknown as Job<{ callId: string }>);

    expect(getLearningContext).toHaveBeenCalledTimes(1);
    const itemIds = vi.mocked(getLearningContext).mock.calls[0]![2];
    expect([...itemIds].sort()).toEqual(['consent', 'disclosure']);

    // Routing unchanged: the gate is written for review, the other auto-scored.
    const consentRow = txCalls.find((c) => c.sql.includes('INSERT INTO call_item_scores') && c.params[1] === 'consent')!;
    expect(consentRow.sql).toContain("'manual_review'");
    const disclosureRow = txCalls.find(
      (c) => c.sql.includes('INSERT INTO call_item_scores') && c.params[1] === 'disclosure'
    )!;
    expect(disclosureRow.params[7]).toBe('pass');
  });
});
