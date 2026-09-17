import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { queryOne } from '../db/client.js';
import {
  lookupFeedback,
  confirmFeedback,
  sendFeedback,
  resolveAdviser,
  breachesForFeedback,
  openReviewCount,
  latestFeedback,
  resolveRecipients,
  subjectSummary,
  feedbackAuditContext,
} from '../services/journey-feedback.js';
import { getScoringSettings } from '../services/tenant-settings.js';
import { pushCallFeedbackRelease, pushJourneyFeedbackRelease } from '../services/score-writeback.js';
import { recordAuditEvent } from '../services/audit.js';

// This test guards a mount-order trap, not just a code path:
//
//   app.use('/api', feedbackRouter)   -- authenticated supervisor routes
//
// `feedbackRouter`'s own routes live under /journeys/:journeyId/feedback, so
// it has no route matching `/api/feedback/<token>` at all. But in Express 4,
// `router.use(fn)` (no path) runs for every request that reaches the router,
// matching route or not. If auth is ever put back as router-level middleware
// on `feedbackRouter` (`feedbackRouter.use(authenticate, requireActioner)`)
// instead of per-route, `GET /api/feedback/<token>` will hit that router
// first, get 401'd by `authenticate`, and never reach
// `publicFeedbackRouter` — which is exactly the bug this test exists to
// catch. Do not "simplify" the per-route auth back into a single
// `router.use(...)` call, and do not reorder the two `app.use` calls that
// mount these routers in app.ts.

// No database is reached by any test here. The call routes need a call row to
// look at, so the client is mocked and each test says what the row is.
vi.mock('../db/client.js', () => ({
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  withTransaction: vi.fn(),
}));

vi.mock('../services/tenant-settings.js', async () => {
  const actual = await vi.importActual<typeof import('../services/tenant-settings.js')>(
    '../services/tenant-settings.js'
  );
  return { ...actual, getScoringSettings: vi.fn() };
});

vi.mock('../services/score-writeback.js', async () => {
  const actual = await vi.importActual<typeof import('../services/score-writeback.js')>(
    '../services/score-writeback.js'
  );
  return {
    ...actual,
    pushCallFeedbackRelease: vi.fn().mockResolvedValue(undefined),
    pushJourneyFeedbackRelease: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../services/audit.js', async () => {
  const actual = await vi.importActual<typeof import('../services/audit.js')>('../services/audit.js');
  return { ...actual, recordAuditEvent: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../services/transcript-access.js', async () => {
  const actual = await vi.importActual<typeof import('../services/transcript-access.js')>(
    '../services/transcript-access.js'
  );
  return { ...actual, organisationKeepsHealthUnredacted: vi.fn().mockResolvedValue(false) };
});

vi.mock('../services/journey-feedback.js', async () => {
  const actual = await vi.importActual<typeof import('../services/journey-feedback.js')>(
    '../services/journey-feedback.js'
  );
  return {
    ...actual,
    // Real DB-bound logic is covered elsewhere (hashing) or needs a live DB
    // (send/confirm/adviser resolution) — irrelevant to this test, which is
    // only about which router a request reaches and, now, which one of the
    // two handlers a page load vs. a confirm click hits. 'not_found' is a
    // real, successful outcome of both lookupFeedback and confirmFeedback (an
    // unrecognised token), so it exercises the same response path a bad link
    // would without touching the database.
    lookupFeedback: vi.fn().mockResolvedValue({ status: 'not_found' }),
    confirmFeedback: vi.fn().mockResolvedValue({ status: 'not_found' }),
    // The panel and send are DB-bound and covered in the service's own tests.
    // Here they only need to answer, so the route's own preconditions, guards
    // and response shape are what is under test.
    sendFeedback: vi.fn(),
    resolveAdviser: vi.fn(),
    breachesForFeedback: vi.fn(),
    openReviewCount: vi.fn(),
    latestFeedback: vi.fn(),
    resolveRecipients: vi.fn(),
    subjectSummary: vi.fn(),
    feedbackAuditContext: vi.fn(),
  };
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Imported after the mock above is registered, and only once, so app.ts's
  // module-level router wiring (including the mount order under test) is
  // exercised exactly as it runs in production.
  const { app } = await import('../app.js');
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('journey feedback routes mounted at the bare /api prefix', () => {
  it('reaches the public handler for a token, with no Authorization header', async () => {
    const token = 'a'.repeat(43);
    const res = await fetch(`${baseUrl}/api/feedback/${token}`);

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('not_found');
  });

  it('still 401s the supervisor route with no Authorization header', async () => {
    const journeyId = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${baseUrl}/api/journeys/${journeyId}/feedback`);

    expect(res.status).toBe(401);
  });

  it('GET is a read-only status check: it never confirms', async () => {
    // The whole point of the fix: a page load (which is all a prefetching
    // mail-security gateway ever does) must not be able to record an
    // acknowledgment. Only the POST below can.
    vi.mocked(confirmFeedback).mockClear();
    vi.mocked(lookupFeedback).mockClear();
    const token = 'b'.repeat(43);

    const res = await fetch(`${baseUrl}/api/feedback/${token}`);

    expect(res.status).toBe(200);
    expect(lookupFeedback).toHaveBeenCalledWith(token);
    expect(confirmFeedback).not.toHaveBeenCalled();
  });

  it('POST /:token/confirm reaches the confirm handler, with no Authorization header', async () => {
    vi.mocked(confirmFeedback).mockClear();
    const token = 'c'.repeat(43);

    const res = await fetch(`${baseUrl}/api/feedback/${token}/confirm`, { method: 'POST' });

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('not_found');
    expect(confirmFeedback).toHaveBeenCalled();
  });
});

// ============================================================
// CG-5 — the chosen recipient is validated before anything is written.
//
// A malformed adviser_user_id must be refused outright rather than falling back
// to the sale's own adviser. Silently defaulting would send the feedback to
// someone other than the person the supervisor picked, and the acknowledgement
// that came back would look exactly like a correct one.
//
// The check is settled before the journey lookup, so this runs against a live
// Express app with no database (same pattern as review.resolve.route.test.ts).
// ============================================================

function signToken(role = 'supervisor'): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      organizationId: '00000000-0000-0000-0000-0000000000bb',
      role,
      mfa: true,
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

describe('POST /api/journeys/:journeyId/feedback — recipient validation', () => {
  const journeyId = '11111111-1111-1111-1111-111111111111';

  async function post(body: unknown, role = 'supervisor'): Promise<Response> {
    return fetch(`${baseUrl}/api/journeys/${journeyId}/feedback`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signToken(role)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects a recipient id that is not a uuid', async () => {
    const res = await post({ message: null, adviser_user_id: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Invalid recipient');
  });

  it('rejects a non-string recipient rather than coercing it', async () => {
    const res = await post({ message: null, adviser_user_id: 12345 });

    expect(res.status).toBe(400);
  });

  it('403s a viewer: choosing a recipient is still an actioner-only send', async () => {
    // The picker widens who feedback can go TO, never who can send it.
    const res = await post({ message: null, adviser_user_id: null }, 'viewer');

    expect(res.status).toBe(403);
  });
});

// ============================================================
// Migration 118 — feedback on a call scored on its own.
//
// The call routes share the sale's handlers, so what is really under test here
// is what differs: which firms may use them at all, the refusal for a call that
// belongs to a sale, and that the right Zoho release and audit line fire.
// ============================================================

const ORG = '00000000-0000-0000-0000-0000000000bb';
const CALL_ID = '22222222-2222-2222-2222-222222222222';

type CallRow = { id: string; status: string; in_sale: boolean } | null;

function scoringScope(scope: 'sales_only' | 'over_threshold' | 'everything') {
  vi.mocked(getScoringSettings).mockResolvedValue({
    scoringScope: scope,
    zohoWritebackTrigger: 'on_feedback',
  } as Awaited<ReturnType<typeof getScoringSettings>>);
}

function callRow(row: CallRow) {
  vi.mocked(queryOne).mockImplementation((async (sql: string) =>
    String(sql).includes('FROM calls c') ? row : null) as never);
}

/** A round sent earlier, as latestFeedback returns it. */
const existingRound = {
  id: 'fb-old',
  journey_id: null,
  call_id: CALL_ID,
  adviser_user_id: 'u-1',
  adviser_name: 'Jo Adviser',
  adviser_email: 'jo@example.com',
  sent_by: 'u-sup',
  sent_at: '2026-08-01T09:00:00.000Z',
  message: null,
  confirmed_at: '2026-08-02T09:00:00.000Z',
  token_expires_at: '2026-08-31T09:00:00.000Z',
  recipient_source: 'default_last_caller' as const,
  suggested_adviser_user_id: 'u-1',
};

function callFeedback(method: 'GET' | 'POST', role = 'supervisor', body: unknown = { message: null }) {
  return fetch(`${baseUrl}/api/calls/${CALL_ID}/feedback`, {
    method,
    headers: {
      Authorization: `Bearer ${signToken(role)}`,
      'Content-Type': 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.mocked(queryOne).mockReset().mockResolvedValue(null);
  vi.mocked(getScoringSettings).mockReset();
  vi.mocked(sendFeedback).mockReset();
  vi.mocked(pushCallFeedbackRelease).mockClear();
  vi.mocked(pushJourneyFeedbackRelease).mockClear();
  vi.mocked(recordAuditEvent).mockClear();
  vi.mocked(feedbackAuditContext).mockReset();

  vi.mocked(resolveAdviser).mockResolvedValue({
    userId: 'u-1',
    name: 'Jo Adviser',
    email: 'jo@example.com',
    problem: null,
  });
  vi.mocked(breachesForFeedback).mockResolvedValue([
    {
      breach_id: 'b-1',
      scorecard_item_id: 'si-1',
      item_label: 'Confirmed the customer understood the exclusions',
      severity: 'high',
      status: 'open',
      reasoning: 'The adviser moved on without checking.',
      remediation_guidance: '  Ring the customer back.  ',
    },
  ]);
  vi.mocked(openReviewCount).mockResolvedValue(1);
  vi.mocked(latestFeedback).mockResolvedValue(null);
  vi.mocked(resolveRecipients).mockResolvedValue([
    { id: 'u-1', name: 'Jo Adviser', email: 'jo@example.com', role: 'adviser', eligible: true },
  ]);
  vi.mocked(subjectSummary).mockResolvedValue({ clientName: 'Ann Lee', score: 64.5, pass: false });
});

describe('call feedback routes — guards and mount order', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/calls/${CALL_ID}/feedback`);
    expect(res.status).toBe(401);
  });

  it('403s a viewer on both the panel and the send', async () => {
    scoringScope('everything');
    callRow({ id: CALL_ID, status: 'scored', in_sale: false });

    expect((await callFeedback('GET', 'viewer')).status).toBe(403);
    expect((await callFeedback('POST', 'viewer')).status).toBe(403);
    expect(sendFeedback).not.toHaveBeenCalled();
  });

  it('rejects a call id that is not a uuid', async () => {
    const res = await fetch(`${baseUrl}/api/calls/not-a-uuid/feedback`, {
      headers: { Authorization: `Bearer ${signToken()}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Invalid call id');
  });

  it('still reaches the public token handler after the call routes were added', async () => {
    const res = await fetch(`${baseUrl}/api/feedback/${'d'.repeat(43)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('not_found');
  });
});

describe('call feedback routes — which firms may send', () => {
  const SALES_ONLY_MESSAGE =
    'Your firm scores sales rather than single calls, so feedback is sent from the sale.';

  it('refuses SENDING where the setting is sales_only, and that sentence wins over the call being in a sale', async () => {
    scoringScope('sales_only');
    callRow({ id: CALL_ID, status: 'scored', in_sale: true });

    const res = await callFeedback('POST');

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(SALES_ONLY_MESSAGE);
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(pushCallFeedbackRelease).not.toHaveBeenCalled();
  });

  it('still READS the call where the setting is sales_only, returning its rounds and why a new one cannot go', async () => {
    // The firm switched to scoring sales after a round went out. The backlog
    // still links here and the re-score refusal names that round, so the page
    // must be able to show it.
    scoringScope('sales_only');
    callRow({ id: CALL_ID, status: 'scored', in_sale: false });
    vi.mocked(latestFeedback).mockResolvedValueOnce(existingRound);

    const res = await callFeedback('GET');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feedback).toMatchObject({ id: 'fb-old', call_id: CALL_ID, adviser_name: 'Jo Adviser' });
    expect(body.can_send).toBe(false);
    expect(body.cannot_send_reason).toBe(SALES_ONLY_MESSAGE);
  });

  for (const scope of ['over_threshold', 'everything'] as const) {
    it(`allows sending where the setting is ${scope}`, async () => {
      scoringScope(scope);
      callRow({ id: CALL_ID, status: 'scored', in_sale: false });
      vi.mocked(sendFeedback).mockResolvedValue({
        feedbackId: 'fb-1',
        itemCount: 1,
        adviser: { userId: 'u-1', name: 'Jo Adviser', email: 'jo@example.com', problem: null },
        recipientSource: 'default_last_caller',
        suggestedAdviserUserId: 'u-1',
        suggestedAdviserName: 'Jo Adviser',
      });

      const panel = await (await callFeedback('GET')).json();
      expect(panel.can_send).toBe(true);
      expect(panel.cannot_send_reason).toBeNull();
      expect((await callFeedback('POST')).status).toBe(201);
    });
  }
});

describe('call feedback routes — a call that belongs to a sale', () => {
  const IN_SALE_MESSAGE =
    'This call is part of a sale. Send feedback from the sale, which covers every call in it.';

  it('refuses SENDING it where the setting allows calls, because the sale owns it', async () => {
    scoringScope('everything');
    callRow({ id: CALL_ID, status: 'scored', in_sale: true });

    const res = await callFeedback('POST');

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(IN_SALE_MESSAGE);
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(pushCallFeedbackRelease).not.toHaveBeenCalled();
  });

  it('still READS a call assembled into a sale after it was fed back, with the reason it cannot be sent again', async () => {
    scoringScope('everything');
    callRow({ id: CALL_ID, status: 'scored', in_sale: true });
    vi.mocked(latestFeedback).mockResolvedValueOnce(existingRound);

    const res = await callFeedback('GET');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feedback).toMatchObject({ id: 'fb-old', call_id: CALL_ID });
    expect(body.can_send).toBe(false);
    expect(body.cannot_send_reason).toBe(IN_SALE_MESSAGE);
  });

  it('checks sale membership against both markers, not calls.journey_id alone', async () => {
    scoringScope('everything');
    callRow({ id: CALL_ID, status: 'scored', in_sale: true });

    await callFeedback('POST');

    const [sql, params] = vi.mocked(queryOne).mock.calls.find(([q]) => String(q).includes('FROM calls c'))!;
    expect(sql).toContain('c.journey_id IS NOT NULL');
    expect(sql).toContain('journey_calls');
    // Tenant-scoped: another firm's call id is a 404, not a refusal.
    expect(sql).toContain('c.organization_id = $2');
    expect(params).toEqual([CALL_ID, ORG]);
  });
});

describe('GET /api/calls/:callId/feedback', () => {
  it('404s a call that is not in the organisation', async () => {
    scoringScope('everything');
    callRow(null);

    const res = await callFeedback('GET');
    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe('Call not found');
  });

  it("answers with the sale panel's shape, field for field, built for this call", async () => {
    scoringScope('over_threshold');
    callRow({ id: CALL_ID, status: 'scored', in_sale: false });

    const res = await callFeedback('GET');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(
      [
        'adviser',
        'breach_count',
        'breaches',
        'can_send',
        'cannot_send_reason',
        'client_name',
        'feedback',
        'guidance_included',
        'open_reviews',
        'reasoning_included',
        'reasoning_withheld',
        'recipients',
      ].sort()
    );
    expect(body.adviser).toEqual({
      user_id: 'u-1',
      name: 'Jo Adviser',
      email: 'jo@example.com',
      problem: null,
    });
    expect(body.breach_count).toBe(1);
    expect(body.breaches).toEqual([
      {
        label: 'Confirmed the customer understood the exclusions',
        severity: 'high',
        remediation_guidance: 'Ring the customer back.',
      },
    ]);
    // The reasons are said to travel, never returned.
    expect(JSON.stringify(body)).not.toContain('The adviser moved on without checking.');
    expect(body.reasoning_included).toBe(true);
    expect(body.reasoning_withheld).toBe(false);
    expect(body.guidance_included).toBe(true);
    expect(body.open_reviews).toBe(1);
    expect(body.client_name).toBe('Ann Lee');
    expect(body.feedback).toBeNull();
    expect(body.can_send).toBe(true);
    expect(body.cannot_send_reason).toBeNull();

    const subject = { kind: 'call', id: CALL_ID };
    expect(resolveAdviser).toHaveBeenCalledWith(subject);
    expect(breachesForFeedback).toHaveBeenCalledWith(ORG, subject);
    expect(openReviewCount).toHaveBeenCalledWith(subject);
    expect(latestFeedback).toHaveBeenCalledWith(ORG, subject);
    expect(subjectSummary).toHaveBeenCalledWith(ORG, subject);
  });
});

describe('POST /api/calls/:callId/feedback', () => {
  beforeEach(() => {
    vi.mocked(sendFeedback).mockResolvedValue({
      feedbackId: 'fb-1',
      itemCount: 1,
      adviser: { userId: 'u-2', name: 'Dana Seller', email: 'dana@example.com', problem: null },
      recipientSource: 'manual',
      suggestedAdviserUserId: 'u-1',
      suggestedAdviserName: 'Jo Adviser',
    });
  });

  it('validates the recipient before anything else, exactly as on a sale', async () => {
    scoringScope('everything');
    const res = await callFeedback('POST', 'supervisor', { message: null, adviser_user_id: 'nope' });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Invalid recipient');
    expect(getScoringSettings).not.toHaveBeenCalled();
  });

  it('refuses a call that has not been scored, and the panel says the same', async () => {
    scoringScope('everything');
    callRow({ id: CALL_ID, status: 'transcribed', in_sale: false });
    const NOT_SCORED = 'This call has not been scored yet, so there is nothing to feed back.';

    const res = await callFeedback('POST');
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(NOT_SCORED);
    expect(sendFeedback).not.toHaveBeenCalled();

    const panel = await (await callFeedback('GET')).json();
    expect(panel.can_send).toBe(false);
    expect(panel.cannot_send_reason).toBe(NOT_SCORED);
  });

  it("sends against the call, releases the call to Zoho, and files the audit line on the call", async () => {
    scoringScope('everything');
    callRow({ id: CALL_ID, status: 'scored', in_sale: false });
    const chosen = '33333333-3333-3333-3333-333333333333';

    const res = await callFeedback('POST', 'supervisor', {
      message: '  Worth a quick chat.  ',
      adviser_user_id: chosen,
    });

    expect(res.status).toBe(201);
    // The sale's POST response, field for field.
    expect(await res.json()).toEqual({ id: 'fb-1', adviser_name: 'Dana Seller', item_count: 1 });

    expect(sendFeedback).toHaveBeenCalledWith({
      organizationId: ORG,
      subject: { kind: 'call', id: CALL_ID },
      sentBy: '00000000-0000-0000-0000-0000000000aa',
      message: 'Worth a quick chat.',
      adviserUserId: chosen,
    });

    expect(pushCallFeedbackRelease).toHaveBeenCalledWith(ORG, CALL_ID, 'fb-1');
    expect(pushJourneyFeedbackRelease).not.toHaveBeenCalled();

    const event = vi.mocked(recordAuditEvent).mock.calls
      .map(([e]) => e)
      .find((e) => e.actionType === 'call.feedback_sent')!;
    expect(event.entityType).toBe('call');
    expect(event.entityId).toBe(CALL_ID);
    expect(event.summary).toBe(
      'Fed back 1 finding(s) on this call to Dana Seller, chosen instead of Jo Adviser'
    );
  });

  it("surfaces the service's refusal as a 400 rather than a 500", async () => {
    scoringScope('everything');
    callRow({ id: CALL_ID, status: 'scored', in_sale: false });
    vi.mocked(sendFeedback).mockRejectedValue(
      new Error('This call has no adviser attributed to it. Choose who to send the feedback to.')
    );

    const res = await callFeedback('POST');
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('This call has no adviser attributed');
    expect(pushCallFeedbackRelease).not.toHaveBeenCalled();
  });
});

describe('the public token endpoints on a call round', () => {
  it('confirms a call round even after the firm has switched to scoring sales, and files it on the call', async () => {
    // The adviser already has the email. The record of what they were told
    // must be able to complete whatever the firm has decided since.
    scoringScope('sales_only');
    vi.mocked(confirmFeedback).mockResolvedValueOnce({
      status: 'confirmed',
      adviserName: 'Jo Adviser',
      itemCount: 2,
    });
    vi.mocked(feedbackAuditContext).mockResolvedValueOnce({
      organizationId: ORG,
      subject: { kind: 'call', id: CALL_ID },
      adviserName: 'Jo Adviser',
      adviserUserId: null,
    });

    const res = await fetch(`${baseUrl}/api/feedback/${'e'.repeat(43)}/confirm`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('confirmed');
    expect(getScoringSettings).not.toHaveBeenCalled();

    const event = vi.mocked(recordAuditEvent).mock.calls
      .map(([e]) => e)
      .find((e) => e.actionType === 'call.feedback_confirmed')!;
    expect(event.entityType).toBe('call');
    expect(event.entityId).toBe(CALL_ID);
    expect(event.summary).toBe('Jo Adviser confirmed they received feedback on this call');
  });

  it('files a sale confirmation against the sale, as before', async () => {
    vi.mocked(confirmFeedback).mockResolvedValueOnce({
      status: 'confirmed',
      adviserName: 'Jo Adviser',
      itemCount: 1,
    });
    vi.mocked(feedbackAuditContext).mockResolvedValueOnce({
      organizationId: ORG,
      subject: { kind: 'journey', id: '11111111-1111-1111-1111-111111111111' },
      adviserName: 'Jo Adviser',
      adviserUserId: 'u-1',
    });

    await fetch(`${baseUrl}/api/feedback/${'f'.repeat(43)}/confirm`, { method: 'POST' });

    const event = vi.mocked(recordAuditEvent).mock.calls
      .map(([e]) => e)
      .find((e) => e.actionType === 'journey.feedback_confirmed')!;
    expect(event.entityType).toBe('journey');
    expect(event.summary).toBe('Jo Adviser confirmed they received feedback on this sale');
  });

  it("passes the subject kind through on a page load", async () => {
    vi.mocked(lookupFeedback).mockResolvedValueOnce({
      status: 'pending',
      adviserName: 'Jo Adviser',
      itemCount: 0,
      items: [],
      reasoningWithheld: false,
      canRecordOutcome: false,
      subject_kind: 'call',
    });

    const body = await (await fetch(`${baseUrl}/api/feedback/${'g'.repeat(43)}`)).json();
    expect(body.subject_kind).toBe('call');
    expect(getScoringSettings).not.toHaveBeenCalled();
  });
});
