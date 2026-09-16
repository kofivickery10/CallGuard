import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { scoreTranscriptConsensus } from '../../services/scoring.js';
import { getLearningContext } from '../../services/learning-context.js';
import { processScoreJourney, type ScoreJourneyJobData } from './score-journey.js';

// Sale scoring, end to end through the processor with the database and every
// outbound integration mocked. Two properties:
//
//  - a reviewer's "not applicable" ruling on this sale survives a re-score as
//    not applicable, never as a failed checkpoint with a breach;
//  - checkpoints the model scores provisionally still receive calibration
//    examples, without changing what is sent to review.

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../services/scoring.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/scoring.js')>()),
  scoreTranscriptConsensus: vi.fn(),
}));
vi.mock('../../services/kb.js', () => ({ getKBContext: vi.fn(async () => '') }));
vi.mock('../../services/learning-context.js', () => ({ getLearningContext: vi.fn(async () => undefined) }));
vi.mock('../../services/usage.js', () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock('../../services/tenant-settings.js', () => ({
  getScoringSettings: vi.fn(async () => ({
    passThreshold: 70,
    scoringSamples: 1,
    reviewConfidenceFloor: 0,
    zohoWritebackTrigger: 'on_scoring',
  })),
}));
vi.mock('../../services/webhook-delivery.js', () => ({ deliverCallScored: vi.fn(async () => {}) }));
vi.mock('../../services/ops-alert.js', () => ({ sendOpsAlert: vi.fn(async () => {}) }));
vi.mock('../../services/zoho.js', () => ({
  pushJourneyScored: vi.fn(async () => {}),
  fetchSaleProducts: vi.fn(async () => ({ stages: [] })),
}));
vi.mock('../../services/capture-runs.js', () => ({ maybeStartJourneyCapture: vi.fn(async () => {}) }));
vi.mock('../../services/reconciliation-runs.js', () => ({ maybeStartReconciliation: vi.fn(async () => {}) }));
vi.mock('../../services/journey.js', () => ({
  assessJourneyCoverage: vi.fn(),
  computeStructuralCorroboration: vi.fn(),
  resolveCoverage: vi.fn(),
}));
vi.mock('../../services/product-resolution.js', () => ({ detectProductsFromTranscript: vi.fn(async () => []) }));

const ORG = 'org-1';
const JOURNEY = 'journey-1';
const AGENT = 'agent-1';

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

interface Setup {
  transcript: string;
  items: ReturnType<typeof item>[];
  aiScores: Record<string, number>;
  rulings?: Array<{ scorecard_item_id: string; corrected_score: string | null; corrected_pass: boolean | null }>;
  speakerConfidence?: number;
}

let txCalls: Array<{ sql: string; params: unknown[] }> = [];

function setup({ transcript, items, aiScores, rulings = [], speakerConfidence = 0.9 }: Setup) {
  txCalls = [];
  vi.mocked(queryOne).mockImplementation((async (sql: string) => {
    if (sql.includes('FROM journeys')) {
      return {
        id: JOURNEY,
        organization_id: ORG,
        customer_id: 'customer-1',
        scorecard_id: 'scorecard-1',
        scorecard_version: 1,
        zoho_record_id: null,
        client_name: null,
        product_source: 'none',
        crm_stage: null,
        overall_score: null,
      };
    }
    if (sql.includes('FROM scorecards')) return { id: 'scorecard-1', version: 1, branch_config: null };
    if (sql.includes('FROM organizations')) return { plan: 'enterprise', industry: null };
    return null;
  }) as never);

  vi.mocked(query).mockImplementation((async (sql: string) => {
    if (sql.includes('FROM journey_calls')) {
      return [
        {
          id: 'call-1',
          role: 'wrap_up',
          call_date: '2026-09-01',
          created_at: '2026-09-01T10:00:00Z',
          agent_id: AGENT,
          agent_name: 'Adviser One',
          transcript_text: transcript,
          speaker_attribution_confidence: speakerConfidence,
          speaker_integrity_flag: null,
        },
      ];
    }
    if (sql.includes('FROM scorecard_items')) return items;
    if (sql.includes('FROM score_corrections')) return rulings;
    return [];
  }) as never);

  vi.mocked(withTransaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        txCalls.push({ sql, params });
        return [{ id: `row-${txCalls.length}` }];
      }),
      queryOne: vi.fn(async () => ({ next: 1 })),
    })) as never);

  vi.mocked(scoreTranscriptConsensus).mockImplementation((async () => ({
    items: Object.entries(aiScores).map(([id, score]) => ({
      scorecard_item_id: id,
      score,
      confidence: 0.9,
      evidence: '[Call 1] "quote"',
      reasoning: 'model reasoning',
      disputed: false,
      agreement: 1,
    })),
    coaching: undefined,
    coverage: undefined,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    model: 'test-model',
    samples: 1,
  })) as never);
}

function run() {
  return processScoreJourney({
    data: { journeyId: JOURNEY },
    opts: { attempts: 1 },
    attemptsMade: 0,
  } as unknown as Job<ScoreJourneyJobData>);
}

function itemScoreInsert(itemId: string) {
  return txCalls.find((c) => c.sql.includes('INSERT INTO journey_item_scores') && c.params[1] === itemId);
}

const ATTRIBUTABLE = 'Agent: Shall I put the policy in trust?\nCustomer: It cannot go in trust.';

beforeEach(() => {
  vi.mocked(getLearningContext).mockClear();
});

describe('processScoreJourney — a not-applicable ruling on the same sale', () => {
  it('replays it as not applicable: no score, no breach, out of the weighted score', async () => {
    setup({
      transcript: ATTRIBUTABLE,
      items: [item('trust'), item('disclosure')],
      // The model fails the trust checkpoint; the reviewer already said it did
      // not apply to this sale.
      aiScores: { trust: 0, disclosure: 1 },
      rulings: [{ scorecard_item_id: 'trust', corrected_score: null, corrected_pass: null }],
    });

    await run();

    const trustRow = itemScoreInsert('trust')!;
    expect(trustRow.sql).toContain("'na'");
    expect(trustRow.sql).not.toMatch(/'pass'|'fail'/);
    expect(trustRow.params).toContain('Ruled by a reviewer: not applicable to this sale. model reasoning');
    expect(trustRow.params.some((p) => typeof p === 'string' && p.includes('not met'))).toBe(false);

    const breaches = txCalls.filter((c) => c.sql.includes('INSERT INTO breaches'));
    expect(breaches.some((c) => c.params.includes('trust'))).toBe(false);

    // Only the disclosure checkpoint is scored: 100%, a pass.
    const journeyUpdate = txCalls.find((c) => c.sql.includes("UPDATE journeys SET\n           status = 'scored'"))!;
    expect(journeyUpdate.params[3]).toBe(100);
    expect(journeyUpdate.params[4]).toBe(true);

    // The score history counts it with the not-applicable checkpoints.
    const history = txCalls.find((c) => c.sql.includes('INSERT INTO journey_score_runs'))!;
    expect(history.params[8]).toBe(1); // items_passed
    expect(history.params[9]).toBe(0); // items_failed
    expect(history.params[10]).toBe(1); // items_na
  });

  it('still replays pass and fail rulings as met and not met', async () => {
    setup({
      transcript: ATTRIBUTABLE,
      items: [item('trust'), item('disclosure')],
      aiScores: { trust: 1, disclosure: 1 },
      rulings: [{ scorecard_item_id: 'trust', corrected_score: '0', corrected_pass: false }],
    });

    await run();

    const trustRow = itemScoreInsert('trust')!;
    expect(trustRow.params[2]).toBe('fail');
    expect(txCalls.some((c) => c.sql.includes('INSERT INTO breaches') && c.params.includes('trust'))).toBe(true);
  });
});

describe('processScoreJourney — calibration context for provisional checkpoints', () => {
  it('passes every AI-scored checkpoint to the learning context on an unattributable sale', async () => {
    // One-sided transcript: nothing on it can be attributed, so every
    // checkpoint is provisional and none is auto-scoreable. The call's speaker
    // confidence is under the floor too, so the post-scoring release (which
    // frees checkpoints whose evidence came from a well-attributed call) does
    // not apply and both checkpoints stay with a reviewer.
    setup({
      transcript: 'Agent: Shall I put the policy in trust?\nAgent: I will note that down.',
      items: [item('trust'), item('consent', { consent_gate: true })],
      aiScores: { trust: 1, consent: 1 },
      speakerConfidence: 0.3,
    });

    await run();

    expect(getLearningContext).toHaveBeenCalledTimes(1);
    const [org, , itemIds, agentId, options] = vi.mocked(getLearningContext).mock.calls[0]!;
    expect(org).toBe(ORG);
    expect([...itemIds].sort()).toEqual(['consent', 'trust']);
    // Coaching memory belongs to the wrap-up adviser, and excludes this sale.
    expect(agentId).toBe(AGENT);
    expect(options).toEqual({ excludeJourneyId: JOURNEY });

    // Routing is unchanged: both still go to review.
    expect(itemScoreInsert('trust')!.sql).toContain("'manual_review'");
    expect(itemScoreInsert('consent')!.sql).toContain("'manual_review'");
    expect(txCalls.some((c) => c.sql.includes('INSERT INTO breaches'))).toBe(false);
  });
});
