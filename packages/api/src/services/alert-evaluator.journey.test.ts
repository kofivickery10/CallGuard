import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne } from '../db/client.js';
import { alertsQueue } from '../jobs/queue.js';
import { evaluateAlertsForJourney } from './alert-evaluator.js';

// Sale (journey) scoring used to raise no alerts at all: a firm scored on sales
// rather than on individual calls never received the email or Slack breach
// alert the product sells, because the calls behind a sale are never scored on
// their own (jobs/processors/transcribe.ts) and score-journey.ts never
// evaluated a rule.
//
// The rules themselves are the per-call ones, applied to the sale: only a
// checkpoint with a verdict ('pass'/'fail') and a real score can fail (#208),
// and a sale nobody has scored yet has no low score to report.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));
vi.mock('../jobs/queue.js', () => ({
  alertsQueue: { add: vi.fn(async () => undefined) },
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
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
    // Slack only, so delivery is a single queue add with no user lookup.
    channels: { slack: { webhook_url: 'https://hooks.slack.test/x' } },
    is_active: true,
    created_at: '2026-09-15T00:00:00Z',
    updated_at: '2026-09-15T00:00:00Z',
  };
}

const itemRule = () => rule('item_below_threshold', { scorecard_item_id: ITEM, threshold: 70 });

// Stands in for the unique index on alert_events (migration 117): a claim for
// the same (org, rule, entity, checkpoint) succeeds once and never again, which
// is what makes an alert at-most-once across re-scores and retries.
let claims: Set<string>;

function claim(params: unknown[]): Array<{ id: string }> {
  const key = params.map((p) => String(p)).join('|');
  if (claims.has(key)) return [];
  claims.add(key);
  return [{ id: `event-${claims.size}` }];
}

interface JourneySetup {
  rules: ReturnType<typeof rule>[];
  overallScore: string | null;
  itemScores: Array<{ scorecard_item_id?: string; normalized_score: string | null; result: string | null }>;
}

// Mirrors the evaluator's reads for a scored sale: the sale with its wrap-up
// call, the org's active rules, then the sale's checkpoint rows. Values are
// strings where pg returns NUMERIC as a string.
function mockScoredJourney({ rules, overallScore, itemScores }: JourneySetup) {
  vi.mocked(queryOne).mockImplementation((async (sql: string) => {
    if (sql.includes('FROM journeys')) {
      return {
        id: JOURNEY,
        organization_id: ORG,
        overall_score: overallScore,
        customer_name: 'Dana Patel',
        anchor_call_id: WRAP_UP_CALL,
        anchor_file_name: 'wrap-up.wav',
        agent_name: 'Adviser A',
      };
    }
    return null;
  }) as never);

  vi.mocked(query).mockImplementation((async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM alert_rules')) return rules;
    if (sql.includes('FROM journey_item_scores')) {
      return itemScores.map((s) => ({
        scorecard_item_id: ITEM,
        label: 'Consent to proceed',
        ...s,
      }));
    }
    if (sql.includes('INSERT INTO alert_events')) return claim(params);
    return [];
  }) as never);
}

beforeEach(() => {
  claims = new Set();
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
  vi.mocked(alertsQueue.add).mockClear();
});

describe('evaluateAlertsForJourney: item_below_threshold ("Item failed")', () => {
  it('fires once for a sale checkpoint scored below threshold, pointing at the sale', async () => {
    mockScoredJourney({
      rules: [itemRule()],
      overallScore: '60',
      itemScores: [{ normalized_score: '0', result: 'fail' }],
    });

    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = vi.mocked(alertsQueue.add).mock.calls[0]!;
    expect(name).toBe('deliver');
    expect(data).toMatchObject({
      ruleId: 'rule-item_below_threshold',
      // Anchored on the wrap-up call, as every other journey-level alert is:
      // alert_deliveries and notifications hang off a real call.
      callId: WRAP_UP_CALL,
      channel: 'slack',
      payload: {
        title: 'Item failed: Consent to proceed',
        severity: 'critical',
        // Attributed to the wrap-up adviser, as the sale is everywhere else.
        agent_name: 'Adviser A',
        action_url: `/journeys/${JOURNEY}`,
        action_label: 'View Sale',
      },
    });
    // The body names the sale, not a file: a sale spans several calls.
    expect((data as { payload: { body: string } }).payload.body).toContain('Dana Patel');
    expect(opts).toEqual({ jobId: `alert-rule-item_below_threshold-${JOURNEY}-slack` });
  });

  it('does not fire for a checkpoint held for review with a provisional score below threshold', async () => {
    mockScoredJourney({
      rules: [itemRule()],
      overallScore: '90',
      itemScores: [{ normalized_score: '0', result: 'manual_review' }],
    });

    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('does not fire for a manual checkpoint, whose score is NULL', async () => {
    mockScoredJourney({
      rules: [itemRule()],
      overallScore: '90',
      itemScores: [{ normalized_score: null, result: 'manual_review' }],
    });

    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('does not fire for a checkpoint that did not apply to the sale (na, NULL score)', async () => {
    mockScoredJourney({
      rules: [itemRule()],
      overallScore: '90',
      itemScores: [{ normalized_score: null, result: 'na' }],
    });

    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('does not fire for a sale checkpoint at or above threshold', async () => {
    mockScoredJourney({
      rules: [itemRule()],
      overallScore: '100',
      itemScores: [{ normalized_score: '100', result: 'pass' }],
    });

    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });
});

describe('evaluateAlertsForJourney: low_overall_score', () => {
  it('fires once for a sale scored below threshold', async () => {
    mockScoredJourney({
      rules: [rule('low_overall_score', { threshold: 70 })],
      overallScore: '50',
      itemScores: [{ normalized_score: '50', result: 'fail' }],
    });

    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
    const [, data] = vi.mocked(alertsQueue.add).mock.calls[0]!;
    expect(data).toMatchObject({
      payload: {
        title: 'Low score: Dana Patel',
        overall_score: 50,
        action_url: `/journeys/${JOURNEY}`,
        action_label: 'View Sale',
      },
    });
  });

  it('fires nothing on a sale where every checkpoint awaits review', async () => {
    // score-journey.ts writes overall_score NULL rather than a fabricated 0
    // when nothing was auto-scored. Nobody has judged this sale yet, so there
    // is neither a failed checkpoint nor a low score to report.
    mockScoredJourney({
      rules: [rule('low_overall_score', { threshold: 70 }), itemRule()],
      overallScore: null,
      itemScores: [{ normalized_score: '0', result: 'manual_review' }],
    });

    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).not.toHaveBeenCalled();
  });
});

describe('evaluateAlertsForJourney: an alert is delivered at most once', () => {
  it('does not re-send the same "Item failed" when the sale is re-scored', async () => {
    mockScoredJourney({
      rules: [itemRule()],
      overallScore: '60',
      itemScores: [{ normalized_score: '0', result: 'fail' }],
    });

    await evaluateAlertsForJourney(JOURNEY);
    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
  });

  it('does not re-send the same "Low score" when the sale is re-scored', async () => {
    mockScoredJourney({
      rules: [rule('low_overall_score', { threshold: 70 })],
      overallScore: '50',
      itemScores: [{ normalized_score: '50', result: 'fail' }],
    });

    await evaluateAlertsForJourney(JOURNEY);
    await evaluateAlertsForJourney(JOURNEY);

    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
  });
});
