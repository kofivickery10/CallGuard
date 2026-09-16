import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne } from '../db/client.js';
import { alertsQueue } from '../jobs/queue.js';
import { evaluateAlertsForCall } from './alert-evaluator.js';

// Alert rules reach a firm's team by email, Slack and in-app notification, so a
// rule that fires on a checkpoint nobody has ruled on tells people an adviser
// failed something when no one has decided that. A checkpoint held in the
// manual review queue (result 'manual_review') is not a verdict, whatever
// provisional score the AI attached to it; nor is a manual item or a
// branch-excluded 'na' item, whose NULL score must never read as 0.

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
const ITEM = '00000000-0000-0000-0000-0000000000e1';

function rule(triggerType: string, triggerConfig: Record<string, unknown>) {
  return {
    id: `rule-${triggerType}`,
    organization_id: ORG,
    name: triggerType,
    description: null,
    trigger_type: triggerType,
    trigger_config: triggerConfig,
    // Slack only, so delivery is a single queue add with no user lookup.
    channels: { slack: { webhook_url: 'https://hooks.slack.test/x' } },
    is_active: true,
    created_at: '2026-09-15T00:00:00Z',
    updated_at: '2026-09-15T00:00:00Z',
  };
}

const itemRule = () => rule('item_below_threshold', { scorecard_item_id: ITEM, threshold: 70 });

// Mirrors the evaluator's read order for a scored call: call, rules, latest
// call_scores row, then its item scores. Values are strings where pg returns
// NUMERIC as a string.
function mockScoredCall(
  rules: ReturnType<typeof rule>[],
  callScore: { overall_score: string | null; pass: boolean | null },
  itemScores: Array<{ normalized_score: string | null; result: string | null }>
) {
  vi.mocked(queryOne)
    .mockResolvedValueOnce({
      id: CALL,
      organization_id: ORG,
      file_name: 'call-1.wav',
      status: 'scored',
      agent_name: 'Adviser A',
      error_message: null,
    })
    .mockResolvedValueOnce({ id: SCORE, ...callScore });
  vi.mocked(query)
    .mockResolvedValueOnce(rules)
    .mockResolvedValueOnce(
      itemScores.map((s) => ({ scorecard_item_id: ITEM, label: 'Consent to proceed', ...s }))
    )
    // Everything after that is the alert_events claim (migration 117), which
    // returns the row it inserted when this firm has not already been told
    // about this checkpoint. These calls are all first-time alerts.
    .mockResolvedValue([{ id: 'alert-event-1' }]);
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
  vi.mocked(alertsQueue.add).mockClear();
});

describe('evaluateAlertsForCall: item_below_threshold ("Item failed")', () => {
  it('does not fire for a checkpoint held for review with a provisional score below threshold', async () => {
    // A low-confidence or unattributable checkpoint: the AI's provisional FAIL
    // rides along on the manual_review row for the reviewer to confirm.
    mockScoredCall([itemRule()], { overall_score: '90', pass: true }, [
      { normalized_score: '0', result: 'manual_review' },
    ]);

    await evaluateAlertsForCall(CALL, 'scored');

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('does not fire for a manual item, whose score is NULL', async () => {
    mockScoredCall([itemRule()], { overall_score: '90', pass: true }, [
      { normalized_score: null, result: 'manual_review' },
    ]);

    await evaluateAlertsForCall(CALL, 'scored');

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('does not fire for a checkpoint that did not apply (na, NULL score)', async () => {
    mockScoredCall([itemRule()], { overall_score: '90', pass: true }, [
      { normalized_score: null, result: 'na' },
    ]);

    await evaluateAlertsForCall(CALL, 'scored');

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('still fires for an ordinary scored checkpoint below threshold', async () => {
    mockScoredCall([itemRule()], { overall_score: '60', pass: false }, [
      { normalized_score: '0', result: 'fail' },
    ]);

    await evaluateAlertsForCall(CALL, 'scored');

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = vi.mocked(alertsQueue.add).mock.calls[0]!;
    expect(name).toBe('deliver');
    expect(data).toMatchObject({
      ruleId: 'rule-item_below_threshold',
      callId: CALL,
      channel: 'slack',
      payload: { title: 'Item failed: Consent to proceed', severity: 'critical' },
    });
    expect(opts).toEqual({ jobId: `alert-rule-item_below_threshold-${SCORE}-slack` });
  });

  it('does not fire for an ordinary scored checkpoint at or above threshold', async () => {
    mockScoredCall([itemRule()], { overall_score: '100', pass: true }, [
      { normalized_score: '100', result: 'pass' },
    ]);

    await evaluateAlertsForCall(CALL, 'scored');

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });
});

describe('evaluateAlertsForCall: low_overall_score', () => {
  it('does not fire when every checkpoint awaits review and the call has no score', async () => {
    // score.ts writes overall_score NULL rather than a fabricated 0 when
    // nothing was auto-scored; that must not read as a low score either.
    mockScoredCall([rule('low_overall_score', { threshold: 70 })], { overall_score: null, pass: null }, [
      { normalized_score: '0', result: 'manual_review' },
    ]);

    await evaluateAlertsForCall(CALL, 'scored');

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('still fires for a scored call below threshold', async () => {
    mockScoredCall([rule('low_overall_score', { threshold: 70 })], { overall_score: '50', pass: false }, [
      { normalized_score: '50', result: 'fail' },
    ]);

    await evaluateAlertsForCall(CALL, 'scored');

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alertsQueue.add).mock.calls[0]![1]).toMatchObject({
      payload: { title: 'Low score: call-1.wav' },
    });
  });
});
