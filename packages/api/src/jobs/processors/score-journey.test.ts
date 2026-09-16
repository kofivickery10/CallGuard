import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { scoreTranscriptConsensus } from '../../services/scoring.js';
import { getLearningContext } from '../../services/learning-context.js';
import { evaluateAlertsForJourney } from '../../services/alert-evaluator.js';
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
vi.mock('../../services/alert-evaluator.js', () => ({ evaluateAlertsForJourney: vi.fn(async () => {}) }));

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

function call(id: string, role: CallRow['role'], extra: Partial<CallRow> = {}): CallRow {
  return {
    id,
    role,
    call_date: '2026-09-01',
    created_at: '2026-09-01T10:00:00Z',
    agent_id: AGENT,
    agent_name: 'Adviser One',
    transcript_text: null,
    speaker_attribution_confidence: 0.9,
    speaker_integrity_flag: null,
    ...extra,
  };
}

interface CallRow {
  id: string;
  role: 'wrap_up' | 'context';
  call_date: string | null;
  created_at: string;
  agent_id: string | null;
  agent_name: string | null;
  transcript_text: string | null;
  speaker_attribution_confidence: number | null;
  speaker_integrity_flag: string | null;
}

interface Setup {
  transcript?: string;
  items: ReturnType<typeof item>[];
  aiScores: Record<string, number>;
  rulings?: Array<{ scorecard_item_id: string; corrected_score: string | null; corrected_pass: boolean | null }>;
  speakerConfidence?: number;
  // The sale's calls, oldest first (the order the processor's query returns
  // them in). Defaults to one wrap-up call built from transcript and
  // speakerConfidence.
  calls?: CallRow[];
  // The model's evidence per checkpoint. Defaults to a quote from call 1.
  evidence?: Record<string, string>;
}

let txCalls: Array<{ sql: string; params: unknown[] }> = [];

function setup({
  transcript = '',
  items,
  aiScores,
  rulings = [],
  speakerConfidence = 0.9,
  calls,
  evidence = {},
}: Setup) {
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
      return (
        calls ?? [
          call('call-1', 'wrap_up', { transcript_text: transcript, speaker_attribution_confidence: speakerConfidence }),
        ]
      );
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
      evidence: evidence[id] ?? '[Call 1] "quote"',
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

function run(data: Partial<ScoreJourneyJobData> = {}) {
  return processScoreJourney({
    data: { journeyId: JOURNEY, ...data },
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
  vi.mocked(evaluateAlertsForJourney).mockClear();
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

// Review routing on sales whose speakers cannot be told apart.
//
// Two rules decide whether a checkpoint is held for a person, and they key on
// different signals:
//
//  - the SALE-level rule: if the wrap-up call is one-sided or its labels are
//    flagged (transcriptSupportsAttribution), every applicable checkpoint goes
//    to review and the sale reports no score;
//  - the per-checkpoint release: a consent gate held only because some call on
//    the sale sat under the speaker-confidence floor is released once its
//    evidence turns out to come from a call at or above the floor.
//
// A call can be unattributable and still carry a confidence of 0.5 or more — a
// stereo pin is 1.0 whether or not both channels carried speech, and one-sided
// calls were lifted to 0.75 by the cleanup pass before that lift was guarded.
// The release must never undo the sale-level rule.

function journeyUpdate() {
  return txCalls.find((c) => c.sql.includes("UPDATE journeys SET\n           status = 'scored'"))!;
}

const ONE_SIDED = 'Agent: Are you happy for me to go ahead?\nAgent: Yes, go ahead.';

describe('processScoreJourney — a sale whose wrap-up cannot be attributed', () => {
  it('keeps a consent gate in review on a one-call sale even when the call clears the speaker floor', async () => {
    setup({
      transcript: ONE_SIDED,
      items: [item('consent', { consent_gate: true })],
      aiScores: { consent: 1 },
      evidence: { consent: '[Call 1] "Yes, go ahead."' },
      speakerConfidence: 0.8,
    });

    await run();

    expect(itemScoreInsert('consent')!.sql).toContain("'manual_review'");
    expect(itemScoreInsert('consent')!.sql).not.toMatch(/'pass'|'fail'/);
    // No score on a sale nobody has judged.
    expect(journeyUpdate().params[3]).toBeNull();
    expect(journeyUpdate().params[4]).toBeNull();
  });

  it('keeps every non-consent checkpoint in review too, passes and fails alike', async () => {
    setup({
      transcript: ONE_SIDED,
      items: [item('disclosure'), item('trust'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 1, trust: 0, consent: 1 },
      // A stereo-pinned call: full confidence, and still only one party heard.
      speakerConfidence: 1.0,
    });

    await run();

    for (const id of ['disclosure', 'trust', 'consent']) {
      expect(itemScoreInsert(id)!.sql).toContain("'manual_review'");
    }
    expect(txCalls.some((c) => c.sql.includes('INSERT INTO breaches'))).toBe(false);
    expect(journeyUpdate().params[3]).toBeNull();
    const history = txCalls.find((c) => c.sql.includes('INSERT INTO journey_score_runs'))!;
    expect(history.params[8]).toBe(0); // items_passed
    expect(history.params[9]).toBe(0); // items_failed
    expect(history.params[11]).toBe(3); // items_manual_review
  });

  it('keeps everything in review when the wrap-up labels are flagged, whatever the stored confidence', async () => {
    setup({
      calls: [
        call('call-1', 'wrap_up', {
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.75,
          speaker_integrity_flag: 'inverted_labels',
        }),
      ],
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 1, consent: 1 },
    });

    await run();

    expect(itemScoreInsert('disclosure')!.sql).toContain("'manual_review'");
    expect(itemScoreInsert('consent')!.sql).toContain("'manual_review'");
    expect(journeyUpdate().params[3]).toBeNull();
  });

  it('keeps a consent gate in review on a multi-call sale even when its evidence is from a well-attributed earlier call', async () => {
    setup({
      calls: [
        call('call-1', 'context', { transcript_text: ATTRIBUTABLE, speaker_attribution_confidence: 0.9 }),
        call('call-2', 'wrap_up', {
          call_date: '2026-09-02',
          created_at: '2026-09-02T10:00:00Z',
          transcript_text: ONE_SIDED,
          speaker_attribution_confidence: 0.8,
        }),
      ],
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 1, consent: 1 },
      evidence: { disclosure: '[Call 1] "quote"', consent: '[Call 1] "quote"' },
    });

    await run();

    expect(itemScoreInsert('disclosure')!.sql).toContain("'manual_review'");
    expect(itemScoreInsert('consent')!.sql).toContain("'manual_review'");
    expect(journeyUpdate().params[3]).toBeNull();
  });

  it('still lets a reviewer ruling settle a checkpoint on an unattributable sale', async () => {
    setup({
      transcript: ONE_SIDED,
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 1, consent: 1 },
      speakerConfidence: 0.8,
      rulings: [{ scorecard_item_id: 'consent', corrected_score: '1', corrected_pass: true }],
    });

    await run();

    expect(itemScoreInsert('consent')!.params[2]).toBe('pass');
    expect(itemScoreInsert('disclosure')!.sql).toContain("'manual_review'");
  });
});

describe('processScoreJourney — attributable sales route as before', () => {
  it('auto-scores a consent gate and an ordinary checkpoint on a well-attributed one-call sale', async () => {
    setup({
      transcript: ATTRIBUTABLE,
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 0, consent: 1 },
      speakerConfidence: 0.8,
    });

    await run();

    expect(itemScoreInsert('disclosure')!.params[2]).toBe('fail');
    expect(itemScoreInsert('consent')!.params[2]).toBe('pass');
    expect(txCalls.some((c) => c.sql.includes('INSERT INTO breaches') && c.params.includes('disclosure'))).toBe(true);
    expect(journeyUpdate().params[3]).toBe(50);
  });

  it('holds only the consent gate on a one-call sale under the speaker floor', async () => {
    setup({
      transcript: ATTRIBUTABLE,
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 1, consent: 1 },
      speakerConfidence: 0.3,
    });

    await run();

    expect(itemScoreInsert('disclosure')!.params[2]).toBe('pass');
    expect(itemScoreInsert('consent')!.sql).toContain("'manual_review'");
    expect(journeyUpdate().params[3]).toBe(100);
  });

  // The wrap-up is attributable, an earlier context call is not. The sale-level
  // rule is deliberately keyed on the wrap-up alone ("a scrappy 20-second
  // context call should not withhold a score the wrap-up can carry"), so it does
  // not fire. What remains is the per-checkpoint rule: the weak context call
  // holds every consent gate before scoring, and each is released only if its
  // quote came from a call at or above the floor. Ordinary checkpoints score.
  it('on a multi-call sale with an attributable wrap-up, holds only consent gates quoted from the weak call', async () => {
    setup({
      calls: [
        call('call-1', 'context', { transcript_text: ONE_SIDED, speaker_attribution_confidence: 0.3 }),
        call('call-2', 'wrap_up', {
          call_date: '2026-09-02',
          created_at: '2026-09-02T10:00:00Z',
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.8,
        }),
      ],
      items: [
        item('disclosure'),
        item('consentFromWrapUp', { consent_gate: true }),
        item('consentFromContext', { consent_gate: true }),
      ],
      aiScores: { disclosure: 1, consentFromWrapUp: 1, consentFromContext: 1 },
      evidence: {
        disclosure: '[Call 1] "quote"',
        consentFromWrapUp: '[Call 2] "quote"',
        consentFromContext: '[Call 1] "quote"',
      },
    });

    await run();

    expect(itemScoreInsert('disclosure')!.params[2]).toBe('pass');
    expect(itemScoreInsert('consentFromWrapUp')!.params[2]).toBe('pass');
    expect(itemScoreInsert('consentFromContext')!.sql).toContain("'manual_review'");
    expect(journeyUpdate().params[3]).toBe(100);
  });

  // The same shape with a two-sided, unflagged context call: it is under the
  // floor on confidence alone, and that is still the only thing that holds a
  // checkpoint. The wrap-up carries the score.
  it('on a multi-call sale, an unflagged earlier call at 0.3 holds only the consent gate quoted from it', async () => {
    setup({
      calls: [
        call('call-1', 'context', { transcript_text: ATTRIBUTABLE, speaker_attribution_confidence: 0.3 }),
        call('call-2', 'wrap_up', {
          call_date: '2026-09-02',
          created_at: '2026-09-02T10:00:00Z',
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.8,
        }),
      ],
      items: [
        item('disclosure'),
        item('consentFromWrapUp', { consent_gate: true }),
        item('consentFromContext', { consent_gate: true }),
      ],
      aiScores: { disclosure: 0, consentFromWrapUp: 1, consentFromContext: 1 },
      evidence: {
        disclosure: '[Call 1] "quote"',
        consentFromWrapUp: '[Call 2] "quote"',
        consentFromContext: '[Call 1] "quote"',
      },
    });

    await run();

    expect(itemScoreInsert('disclosure')!.params[2]).toBe('fail');
    expect(txCalls.some((c) => c.sql.includes('INSERT INTO breaches') && c.params.includes('disclosure'))).toBe(true);
    expect(itemScoreInsert('consentFromWrapUp')!.params[2]).toBe('pass');
    expect(itemScoreInsert('consentFromContext')!.sql).toContain("'manual_review'");
    expect(journeyUpdate().params[3]).toBe(50);
  });
});

// An earlier call on a sale whose wrap-up IS attributable. The sale-level rule
// does not fire, so what decides a consent gate quoted from the earlier call is
// the per-checkpoint release. That release must ask the same question the
// sale-level rule asks of the wrap-up (can this call be attributed at all?) as
// well as checking the confidence number, because a flagged or one-sided call
// can still carry 0.5 or more.
describe('processScoreJourney — an earlier call that cannot be attributed', () => {
  it('keeps a consent gate in review when it is quoted from an earlier call with flagged labels at 0.75', async () => {
    setup({
      calls: [
        call('call-1', 'context', {
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.75,
          speaker_integrity_flag: 'model_verdict_conflict',
        }),
        call('call-2', 'wrap_up', {
          call_date: '2026-09-02',
          created_at: '2026-09-02T10:00:00Z',
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.8,
        }),
      ],
      items: [
        item('disclosure'),
        item('consentFromWrapUp', { consent_gate: true }),
        item('consentFromFlagged', { consent_gate: true }),
      ],
      aiScores: { disclosure: 1, consentFromWrapUp: 1, consentFromFlagged: 1 },
      evidence: {
        disclosure: '[Call 1] "quote"',
        consentFromWrapUp: '[Call 2] "quote"',
        consentFromFlagged: '[Call 1] "quote"',
      },
    });

    await run();

    expect(itemScoreInsert('consentFromFlagged')!.sql).toContain("'manual_review'");
    expect(itemScoreInsert('consentFromFlagged')!.sql).not.toMatch(/'pass'|'fail'/);
    // The wrap-up still carries the sale: nothing else is withheld.
    expect(itemScoreInsert('disclosure')!.params[2]).toBe('pass');
    expect(itemScoreInsert('consentFromWrapUp')!.params[2]).toBe('pass');
    expect(journeyUpdate().params[3]).toBe(100);
  });

  // Same, with a third call under the floor, so every consent gate is held
  // before scoring and the flagged call's quote reaches the post-scoring release
  // rather than being auto-scored at classification.
  it('does not release a consent gate quoted from a flagged call at 0.75 when another call already held it', async () => {
    setup({
      calls: [
        call('call-1', 'context', {
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.75,
          speaker_integrity_flag: 'partial_inversion',
        }),
        call('call-2', 'context', {
          call_date: '2026-09-02',
          created_at: '2026-09-02T09:00:00Z',
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.3,
        }),
        call('call-3', 'wrap_up', {
          call_date: '2026-09-03',
          created_at: '2026-09-03T10:00:00Z',
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.8,
        }),
      ],
      items: [
        item('disclosure'),
        item('consentFromWrapUp', { consent_gate: true }),
        item('consentFromFlagged', { consent_gate: true }),
      ],
      aiScores: { disclosure: 1, consentFromWrapUp: 1, consentFromFlagged: 1 },
      evidence: {
        disclosure: '[Call 1] "quote"',
        consentFromWrapUp: '[Call 3] "quote"',
        consentFromFlagged: '[Call 1] "quote"',
      },
    });

    await run();

    expect(itemScoreInsert('consentFromFlagged')!.sql).toContain("'manual_review'");
    expect(itemScoreInsert('consentFromWrapUp')!.params[2]).toBe('pass');
    expect(itemScoreInsert('disclosure')!.params[2]).toBe('pass');
    expect(journeyUpdate().params[3]).toBe(100);
  });

  it('keeps a consent gate in review when it is quoted from a one-sided earlier call at 1.0', async () => {
    setup({
      calls: [
        call('call-1', 'context', { transcript_text: ONE_SIDED, speaker_attribution_confidence: 1.0 }),
        call('call-2', 'wrap_up', {
          call_date: '2026-09-02',
          created_at: '2026-09-02T10:00:00Z',
          transcript_text: ATTRIBUTABLE,
          speaker_attribution_confidence: 0.8,
        }),
      ],
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 1, consent: 1 },
      evidence: { disclosure: '[Call 1] "quote"', consent: '[Call 1] "quote"' },
    });

    await run();

    expect(itemScoreInsert('consent')!.sql).toContain("'manual_review'");
    expect(itemScoreInsert('disclosure')!.params[2]).toBe('pass');
    expect(journeyUpdate().params[3]).toBe(100);
  });
});

// Alerting a sale-scored firm at all. The calls behind a sale are never scored
// on their own, so if scoring a sale raises no alert, the firm's email and
// Slack breach alerts never arrive — whatever rules they have configured.
describe('processScoreJourney — alert rules', () => {
  it("evaluates the sale's alert rules once it has been scored", async () => {
    setup({
      transcript: ATTRIBUTABLE,
      items: [item('disclosure')],
      aiScores: { disclosure: 0 },
      speakerConfidence: 0.8,
    });

    await run();

    expect(evaluateAlertsForJourney).toHaveBeenCalledWith(JOURNEY);
  });

  it('raises nothing on a sale where every checkpoint awaits review', async () => {
    // Mirrors the webhook and Zoho write-back, which are held for the same
    // reason: there is no verdict yet to tell anyone about.
    setup({
      transcript: ONE_SIDED,
      items: [item('disclosure'), item('trust')],
      aiScores: { disclosure: 1, trust: 0 },
      speakerConfidence: 1.0,
    });

    await run();

    expect(evaluateAlertsForJourney).not.toHaveBeenCalled();
  });

  it('raises nothing on a bulk re-score, which suppresses downstream side effects', async () => {
    setup({
      transcript: ATTRIBUTABLE,
      items: [item('disclosure')],
      aiScores: { disclosure: 0 },
      speakerConfidence: 0.8,
    });

    await run({ suppressCrm: true });

    expect(evaluateAlertsForJourney).not.toHaveBeenCalled();
  });
});
