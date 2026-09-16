import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { scoreTranscript } from '../../services/scoring.js';
import { getLearningContext } from '../../services/learning-context.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { deliverCallScored } from '../../services/webhook-delivery.js';
import { pushCallScored } from '../../services/zoho.js';
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

// Review routing on a call scored on its own, for firms that score every call
// rather than whole sales.
//
// Sale scoring holds every checkpoint for a person when the call it is judged
// from cannot be attributed: the transcript is one-sided, or its speaker labels
// are flagged (transcriptSupportsAttribution). Per-call scoring must apply the
// same rule. The consent-gate confidence floor is not enough on its own: a call
// can be unattributable and still carry a confidence of 0.5 or more (a stereo
// pin is 1.0 or 0.7 whether or not both channels carried speech, older
// one-sided rows were lifted to 0.75, and repair scripts write the value
// directly), and the floor only ever protected consent gates anyway.

interface CallSetup {
  transcript: string;
  speakerConfidence: number | null;
  integrityFlag?: string | null;
  items: ReturnType<typeof item>[];
  aiScores: Record<string, number>;
}

let txCalls: Array<{ sql: string; params: unknown[] }> = [];

function setupCall({ transcript, speakerConfidence, integrityFlag = null, items, aiScores }: CallSetup) {
  txCalls = [];
  vi.mocked(deliverCallScored).mockClear();
  vi.mocked(pushCallScored).mockClear();
  vi.mocked(evaluateAlertsForCall).mockClear();

  vi.mocked(queryOne).mockImplementation((async (sql: string) => {
    if (sql.includes('FROM calls')) {
      return {
        id: 'call-1',
        organization_id: 'org-1',
        scorecard_id: 'scorecard-1',
        agent_id: 'agent-1',
        transcript_text: transcript,
        duration_seconds: 120,
        speaker_attribution_confidence: speakerConfidence,
        speaker_integrity_flag: integrityFlag,
        customer_id: null,
      };
    }
    if (sql.includes('FROM scorecards')) return { id: 'scorecard-1', version: 1, branch_config: null };
    if (sql.includes('FROM organizations')) return { plan: 'enterprise', industry: null };
    return null;
  }) as never);
  vi.mocked(query).mockImplementation((async (sql: string) =>
    sql.includes('FROM scorecard_items') ? items : []) as never);
  vi.mocked(withTransaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        txCalls.push({ sql, params });
        return [{ id: `row-${txCalls.length}` }];
      }),
    })) as never);
  vi.mocked(scoreTranscript).mockImplementation((async () => ({
    output: {
      items: Object.entries(aiScores).map(([id, score]) => ({
        scorecard_item_id: id,
        score,
        confidence: 0.9,
        evidence: 'quote',
        reasoning: 'reasoning',
      })),
    },
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    model: 'test-model',
  })) as never);
}

function runCall() {
  return processScoring({ data: { callId: 'call-1' } } as unknown as Job<{ callId: string }>);
}

function callItemRow(itemId: string) {
  return txCalls.find((c) => c.sql.includes('INSERT INTO call_item_scores') && c.params[1] === itemId);
}

function callScoreInsert() {
  return txCalls.find((c) => c.sql.includes('INSERT INTO call_scores'))!;
}

const ATTRIBUTABLE_CALL = 'Agent: Are you happy for me to go ahead?\nCustomer: Yes, go ahead.';
const ONE_SIDED_CALL = 'Agent: Are you happy for me to go ahead?\nAgent: Yes, go ahead.';

// What a held call looks like: every applicable checkpoint in review with the
// AI's verdict attached, no breach, no score, and nothing pushed downstream.
function expectHeld(itemIds: string[]) {
  for (const id of itemIds) {
    expect(callItemRow(id)!.sql).toContain("'manual_review'");
    expect(callItemRow(id)!.sql).not.toMatch(/'pass'|'fail'/);
  }
  expect(txCalls.some((c) => c.sql.includes('INSERT INTO breaches'))).toBe(false);
  expect(callScoreInsert().params[8]).toBeNull(); // overall_score
  expect(callScoreInsert().params[9]).toBeNull(); // pass
  expect(deliverCallScored).not.toHaveBeenCalled();
  expect(pushCallScored).not.toHaveBeenCalled();
}

describe('processScoring — a call that cannot be attributed', () => {
  it('holds a consent gate and every other checkpoint on a one-sided call above the speaker floor', async () => {
    setupCall({
      transcript: ONE_SIDED_CALL,
      // A stereo pin: full confidence, and still only one party heard.
      speakerConfidence: 1.0,
      items: [item('disclosure'), item('trust'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 1, trust: 0, consent: 1 },
    });

    await runCall();

    expectHeld(['disclosure', 'trust', 'consent']);
    // The call still completes: it is scored as "awaiting review", not failed.
    const statusUpdate = txCalls.find((c) => c.sql.includes("status = 'scored'"))!;
    expect(statusUpdate.params[1]).toBe(false); // never an auto-exemplar
  });

  it('holds everything when the labels are flagged, whatever the stored confidence', async () => {
    setupCall({
      transcript: ATTRIBUTABLE_CALL,
      speakerConfidence: 0.75,
      integrityFlag: 'inverted_labels',
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 0, consent: 1 },
    });

    await runCall();

    expectHeld(['disclosure', 'consent']);
  });
});

describe('processScoring — attributable calls route as before', () => {
  it('auto-scores a consent gate and an ordinary checkpoint on a well-attributed call', async () => {
    setupCall({
      transcript: ATTRIBUTABLE_CALL,
      speakerConfidence: 0.8,
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 0, consent: 1 },
    });

    await runCall();

    expect(callItemRow('disclosure')!.params[7]).toBe('fail');
    expect(callItemRow('consent')!.params[7]).toBe('pass');
    expect(txCalls.some((c) => c.sql.includes('INSERT INTO breaches') && c.params.includes('disclosure'))).toBe(true);
    expect(callScoreInsert().params[8]).toBe(50);
    expect(callScoreInsert().params[9]).toBe(false);
    expect(deliverCallScored).toHaveBeenCalledTimes(1);
    expect(pushCallScored).toHaveBeenCalledTimes(1);
  });

  it('holds only the consent gate on an attributable call under the speaker floor', async () => {
    setupCall({
      transcript: ATTRIBUTABLE_CALL,
      speakerConfidence: 0.3,
      items: [item('disclosure'), item('consent', { consent_gate: true })],
      aiScores: { disclosure: 1, consent: 1 },
    });

    await runCall();

    expect(callItemRow('disclosure')!.params[7]).toBe('pass');
    expect(callItemRow('consent')!.sql).toContain("'manual_review'");
    expect(callScoreInsert().params[8]).toBe(100);
    expect(deliverCallScored).toHaveBeenCalledTimes(1);
  });
});
