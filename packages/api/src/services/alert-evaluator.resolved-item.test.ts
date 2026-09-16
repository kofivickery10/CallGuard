import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne } from '../db/client.js';
import { alertsQueue } from '../jobs/queue.js';
import { evaluateAlertsForJourney, evaluateAlertsForResolvedItem } from './alert-evaluator.js';

// A checkpoint held for review is not a verdict, so it raises no alert when the
// AI scores it (#208). Nothing then re-ran the rules when a person ruled on it,
// so the failure a reviewer CONFIRMED — the one finding the platform is most
// certain about — reached nobody. Same for a verdict corrected from pass to
// fail.
//
// The other half of the contract is that nobody is told twice: an alert for a
// given rule and checkpoint on a given call or sale is delivered at most once,
// whether it was raised at scoring time, on a re-score, or on the reviewer's
// ruling.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));
vi.mock('../jobs/queue.js', () => ({
  alertsQueue: { add: vi.fn(async () => undefined) },
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const CALL = '00000000-0000-0000-0000-0000000000c1';
const SCORE = '00000000-0000-0000-0000-0000000000d1';
const JOURNEY = '00000000-0000-0000-0000-0000000000a1';
const WRAP_UP_CALL = '00000000-0000-0000-0000-0000000000c9';
const ITEM = '00000000-0000-0000-0000-0000000000e1';

function rule(triggerType: string, triggerConfig: Record<string, unknown>) {
  return {
    id: `rule-${triggerType}`,
    organization_id: ORG,
    name: triggerType,
    description: null,
    trigger_type: triggerType,
    trigger_config: triggerConfig,
    channels: { slack: { webhook_url: 'https://hooks.slack.test/x' } },
    is_active: true,
    created_at: '2026-09-15T00:00:00Z',
    updated_at: '2026-09-15T00:00:00Z',
  };
}

const itemRule = () => rule('item_below_threshold', { scorecard_item_id: ITEM, threshold: 70 });

// Stands in for the unique index on alert_events (migration 117).
let claims: Set<string>;

function claim(params: unknown[]): Array<{ id: string }> {
  const key = params.map((p) => String(p)).join('|');
  if (claims.has(key)) return [];
  claims.add(key);
  return [{ id: `event-${claims.size}` }];
}

// One mutable world both entity kinds are read out of, so a test can move a
// checkpoint from held to ruled between evaluations the way a reviewer does.
const state = {
  rules: [] as ReturnType<typeof rule>[],
  itemResult: 'manual_review' as string | null,
  itemScore: '0' as string | null,
  overallScore: '90' as string | null,
};

function mockWorld(overrides: Partial<typeof state> = {}) {
  Object.assign(state, overrides);

  vi.mocked(queryOne).mockImplementation((async (sql: string) => {
    if (sql.includes('FROM journeys')) {
      return {
        id: JOURNEY,
        organization_id: ORG,
        overall_score: state.overallScore,
        customer_name: 'Dana Patel',
        anchor_call_id: WRAP_UP_CALL,
        anchor_file_name: 'wrap-up.wav',
        agent_name: 'Adviser A',
      };
    }
    if (sql.includes('FROM call_scores')) {
      return { id: SCORE, overall_score: state.overallScore, pass: null };
    }
    if (sql.includes('FROM calls')) {
      return {
        id: CALL,
        organization_id: ORG,
        file_name: 'call-1.wav',
        status: 'scored',
        agent_name: 'Adviser A',
        error_message: null,
      };
    }
    return null;
  }) as never);

  vi.mocked(query).mockImplementation((async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM alert_rules')) return state.rules;
    if (sql.includes('INSERT INTO alert_events')) return claim(params);
    if (sql.includes('journey_item_scores') || sql.includes('call_item_scores')) {
      return [
        {
          scorecard_item_id: ITEM,
          label: 'Consent to proceed',
          normalized_score: state.itemScore,
          result: state.itemResult,
        },
      ];
    }
    return [];
  }) as never);
}

beforeEach(() => {
  claims = new Set();
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
  vi.mocked(alertsQueue.add).mockClear();
});

describe('evaluateAlertsForResolvedItem: a reviewer confirms a held checkpoint', () => {
  it('fires "Item failed" once when a held checkpoint on a sale is confirmed FAIL', async () => {
    mockWorld({ rules: [itemRule()], itemResult: 'fail', itemScore: '0', overallScore: '60' });

    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alertsQueue.add).mock.calls[0]![1]).toMatchObject({
      ruleId: 'rule-item_below_threshold',
      payload: {
        title: 'Item failed: Consent to proceed',
        severity: 'critical',
        action_url: `/journeys/${JOURNEY}`,
      },
    });
  });

  it('fires "Item failed" once when a held checkpoint on a call is confirmed FAIL', async () => {
    mockWorld({ rules: [itemRule()], itemResult: 'fail', itemScore: '0', overallScore: '60' });

    await evaluateAlertsForResolvedItem({ kind: 'call', entityId: CALL, scorecardItemId: ITEM });

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alertsQueue.add).mock.calls[0]![1]).toMatchObject({
      callId: CALL,
      payload: { title: 'Item failed: Consent to proceed' },
    });
  });

  it('does not fire again when the same checkpoint is confirmed a second time, or the job retries', async () => {
    mockWorld({ rules: [itemRule()], itemResult: 'fail', itemScore: '0', overallScore: '60' });

    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });
    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });
    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the reviewer confirms the checkpoint as a PASS', async () => {
    mockWorld({ rules: [itemRule()], itemResult: 'pass', itemScore: '100', overallScore: '95' });

    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('does not fire when the reviewer rules the checkpoint not applicable', async () => {
    // 'na' carries a NULL score, which Number() would read as 0 — a ruling that
    // the checkpoint was never in scope must never read as a failure.
    mockWorld({ rules: [itemRule()], itemResult: 'na', itemScore: null, overallScore: '95' });

    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('is not alerted again when it already alerted at scoring time', async () => {
    mockWorld({ rules: [itemRule()], itemResult: 'fail', itemScore: '0', overallScore: '60' });

    // The AI scored it a fail and the firm was told.
    await evaluateAlertsForJourney(JOURNEY);
    // A reviewer later corrects something else on the sale and this checkpoint
    // is re-evaluated. It is the same failure; the firm is not told twice.
    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateAlertsForResolvedItem: a verdict corrected to FAIL', () => {
  it('fires once on a call corrected from pass to fail', async () => {
    mockWorld({ rules: [itemRule()], itemResult: 'fail', itemScore: '0', overallScore: '60' });

    await evaluateAlertsForResolvedItem({ kind: 'call', entityId: CALL, scorecardItemId: ITEM });
    await evaluateAlertsForResolvedItem({ kind: 'call', entityId: CALL, scorecardItemId: ITEM });

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
  });

  it('fires once on a sale corrected from pass to fail', async () => {
    mockWorld({ rules: [itemRule()], itemResult: 'fail', itemScore: '0', overallScore: '60' });

    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });
    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
  });

  it('leaves a correction back to pass unannounced', async () => {
    mockWorld({ rules: [itemRule()], itemResult: 'pass', itemScore: '100', overallScore: '95' });

    await evaluateAlertsForResolvedItem({ kind: 'call', entityId: CALL, scorecardItemId: ITEM });

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });
});

describe('evaluateAlertsForResolvedItem: the overall score the ruling produced', () => {
  it('evaluates "Low score" once when resolving drops the sale below the threshold', async () => {
    mockWorld({
      rules: [rule('low_overall_score', { threshold: 70 })],
      itemResult: 'fail',
      itemScore: '0',
      overallScore: '50',
    });

    // Two checkpoints resolved in turn, both leaving the sale below threshold.
    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });
    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alertsQueue.add).mock.calls[0]![1]).toMatchObject({
      payload: { title: 'Low score: Dana Patel' },
    });
  });

  it('does not report a low score on a sale that still has none', async () => {
    mockWorld({
      rules: [rule('low_overall_score', { threshold: 70 })],
      itemResult: 'fail',
      itemScore: '0',
      overallScore: null,
    });

    await evaluateAlertsForResolvedItem({ kind: 'journey', entityId: JOURNEY, scorecardItemId: ITEM });

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });
});
