import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne } from '../db/client.js';
import { deliverCallScored } from './webhook-delivery.js';
import { pushCallScored, pushJourneyScored } from './zoho.js';
import { getScoringSettings } from './tenant-settings.js';
import { pushCallScoreUpdate, pushCallFeedbackRelease } from './score-writeback.js';

// The per-call half of the on_feedback write-back trigger (CG-4), added with
// feedback on calls scored on their own (migration 118). The contract is the
// sale's: on a tenant that pushes on feedback nothing reaches the CRM until a
// round has been sent, the send releases it, and the release never re-fires the
// scored webhook or throws.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));
vi.mock('./webhook-delivery.js', () => ({ deliverCallScored: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./zoho.js', () => ({
  pushCallScored: vi.fn().mockResolvedValue(undefined),
  pushJourneyScored: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./tenant-settings.js', async (importOriginal) => ({
  // The real rule, shared with the feedback routes, not a stand-in for it.
  scoresCallsIndividually: (await importOriginal<typeof import('./tenant-settings.js')>()).scoresCallsIndividually,
  getScoringSettings: vi.fn(),
}));

const ORG = 'org-1';
const CALL = 'c-1';

let feedbackSent: boolean;

function trigger(
  zohoWritebackTrigger: 'on_scoring' | 'on_feedback',
  scoringScope: 'sales_only' | 'over_threshold' | 'everything' = 'everything'
) {
  vi.mocked(getScoringSettings).mockResolvedValue({ zohoWritebackTrigger, scoringScope } as Awaited<
    ReturnType<typeof getScoringSettings>
  >);
}

beforeEach(() => {
  feedbackSent = false;
  vi.mocked(deliverCallScored).mockClear();
  vi.mocked(pushCallScored).mockReset().mockResolvedValue(undefined);
  vi.mocked(pushJourneyScored).mockClear();
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockImplementation((async (sql: string) => {
    if (sql.includes('FROM call_scores cs')) {
      return {
        external_id: 'ext-1',
        agent_name: 'Jo Adviser',
        customer_id: null,
        customer_phone: '+447700900123',
        scorecard_id: 'sc-1',
        overall_score: '64.50',
        pass: false,
      };
    }
    if (sql.includes('FROM journey_feedback')) return feedbackSent ? { id: 'fb-1' } : null;
    return null;
  }) as never);
});

describe('pushCallScoreUpdate — the hold', () => {
  it('holds the Zoho write-back on an on_feedback tenant until a round has been sent for the call', async () => {
    trigger('on_feedback');

    await pushCallScoreUpdate(ORG, CALL);

    expect(pushCallScored).not.toHaveBeenCalled();
    // The webhook is a machine feed of "this call's score changed", and is true.
    expect(deliverCallScored).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(queryOne).mock.calls.find(([q]) => String(q).includes('FROM journey_feedback'))!;
    expect(sql).toContain('WHERE call_id = $1');
    expect(params).toEqual([CALL]);
  });

  it('does not hold a call where the setting is sales_only, which cannot send a call round', async () => {
    // Held there, a call an admin scored on its own would never reach the CRM.
    trigger('on_feedback', 'sales_only');

    await pushCallScoreUpdate(ORG, CALL);

    expect(pushCallScored).toHaveBeenCalledTimes(1);
  });

  it('lets the correction through once feedback has been sent', async () => {
    trigger('on_feedback');
    feedbackSent = true;

    await pushCallScoreUpdate(ORG, CALL);

    expect(pushCallScored).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushCallScored).mock.calls[0][1]).toMatchObject({ call_id: CALL, overall_score: 64.5 });
  });

  it('pushes straight away on an on_scoring tenant, as it always has', async () => {
    trigger('on_scoring');

    await pushCallScoreUpdate(ORG, CALL);

    expect(pushCallScored).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryOne).mock.calls.some(([q]) => String(q).includes('FROM journey_feedback'))).toBe(false);
  });
});

describe('pushCallFeedbackRelease', () => {
  it('releases the call to Zoho on an on_feedback tenant, with no webhook re-fire', async () => {
    trigger('on_feedback');

    await pushCallFeedbackRelease(ORG, CALL, 'fb-1');

    expect(pushCallScored).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushCallScored).mock.calls[0][0]).toBe(ORG);
    expect(vi.mocked(pushCallScored).mock.calls[0][1]).toMatchObject({ event: 'call.scored', call_id: CALL });
    expect(deliverCallScored).not.toHaveBeenCalled();
    expect(pushJourneyScored).not.toHaveBeenCalled();
  });

  it('does nothing on an on_scoring tenant, whose call went out when it was scored', async () => {
    trigger('on_scoring');

    await pushCallFeedbackRelease(ORG, CALL, 'fb-1');

    expect(pushCallScored).not.toHaveBeenCalled();
  });

  it('does not release where the setting is sales_only, because the call was never held', async () => {
    // Its push went out when it was scored (holdsCallWritebackForFeedback is
    // false there), so releasing again would restate it and raise a second
    // breach task.
    trigger('on_feedback', 'sales_only');

    await pushCallFeedbackRelease(ORG, CALL, 'fb-1');

    expect(pushCallScored).not.toHaveBeenCalled();
  });

  it('holds a call with no score yet rather than pushing 0%', async () => {
    trigger('on_feedback');
    vi.mocked(queryOne).mockImplementation((async (sql: string) =>
      sql.includes('FROM call_scores cs')
        ? { external_id: null, agent_name: null, customer_id: null, customer_phone: null, scorecard_id: 'sc-1', overall_score: null, pass: null }
        : null) as never);

    await pushCallFeedbackRelease(ORG, CALL, 'fb-1');

    expect(pushCallScored).not.toHaveBeenCalled();
  });

  it('never throws: a Zoho failure must not fail a feedback that has already been sent', async () => {
    trigger('on_feedback');
    vi.mocked(pushCallScored).mockRejectedValue(new Error('Zoho is down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(pushCallFeedbackRelease(ORG, CALL, 'fb-1')).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
