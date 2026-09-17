import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  hashFeedbackToken,
  lookupFeedback,
  resolveAdviser,
  resolveRecipients,
  resolveChosenRecipient,
  breachesForFeedback,
  openReviewCount,
  latestFeedback,
  subjectSummary,
  buildFeedbackSend,
  sendFeedback,
  recordRemediationOutcome,
  feedbackAuditContext,
} from './journey-feedback.js';
import type { FeedbackBreach, FeedbackSubject } from './journey-feedback.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { alertsQueue } from '../jobs/queue.js';
import { REMEDIATION_NOTE_MAX } from '@callguard/shared';

// The confirmation endpoint is unauthenticated by necessity — a no-login adviser
// has no session to present — so the token IS the credential. These cover the
// properties that makes safe. The DB-bound paths (send, confirm, adviser
// resolution) need a database and are not unit tested here.

// lookupFeedback is the one exception: it is the read side of the GET/POST
// split (FIX 1) and the whole point of that split is that it must never
// write, so that property is worth pinning even without a live database. The
// db client is mocked rather than skipped.
vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

// sendFeedback refuses outright without an API key — deliberately, so a record
// never claims a send that could not happen. Supplied here so the recipient
// tests exercise the write path rather than that guard.
vi.mock('../config.js', () => ({
  config: { resend: { apiKey: 'test-key' }, appUrl: 'https://app.test' },
}));

vi.mock('./transcript-access.js', () => ({
  organisationKeepsHealthUnredacted: vi.fn().mockResolvedValue(false),
}));

vi.mock('./tenant-settings.js', () => ({
  orgHasFeature: vi.fn().mockResolvedValue(false),
}));

vi.mock('../jobs/queue.js', () => ({ alertsQueue: { add: vi.fn() } }));

describe('hashFeedbackToken', () => {
  it('is deterministic, so a link confirms against the row it was issued for', () => {
    const raw = 'X7fQ2mVn8pLk3sRt9wYz1aBc4dEf6gHj';
    expect(hashFeedbackToken(raw)).toBe(hashFeedbackToken(raw));
  });

  it('produces a SHA-256 hex digest', () => {
    expect(hashFeedbackToken('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never contains the raw token, so a database leak yields no working links', () => {
    const raw = 'X7fQ2mVn8pLk3sRt9wYz1aBc4dEf6gHj';
    expect(hashFeedbackToken(raw)).not.toContain(raw);
  });

  it('differs for tokens that differ by one character', () => {
    expect(hashFeedbackToken('token-aaaaaaaaaaaaaaaaaaaaaaaa')).not.toBe(
      hashFeedbackToken('token-aaaaaaaaaaaaaaaaaaaaaaab')
    );
  });

  it('matches the SHA-256 used for invite and refresh tokens', () => {
    // Same construction as hashToken in routes/auth.ts. Pinned so the two cannot
    // drift into different at-rest treatments of the same class of secret.
    expect(hashFeedbackToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

/**
 * Every statement a call issued, so the read side can be pinned on what its SQL
 * DOES rather than on how many times it ran.
 *
 * `expect(query).not.toHaveBeenCalled()` was the original pin and stopped being
 * available when the lookup began returning the findings themselves (CG-25) —
 * those are a SELECT, so the call count no longer distinguishes a read from a
 * write. This is the stronger property anyway: it fails on a write introduced
 * through any code path, including one that reuses an existing call.
 */
function expectReadOnly() {
  const statements = [
    ...vi.mocked(query).mock.calls.map((c) => String(c[0])),
    ...vi.mocked(queryOne).mock.calls.map((c) => String(c[0])),
  ];
  for (const sql of statements) {
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  }
  expect(withTransaction).not.toHaveBeenCalled();
}

/** One finding as journey_feedback_items holds it, unanswered. */
const itemRow = {
  id: 'it-1',
  item_label: 'Attitude to risk not evidenced',
  severity: 'high',
  reasoning: 'The adviser did not ask about risk tolerance.',
  remediation_guidance: 'Call the client and re-send the fact-find.',
  remediation_outcome: null,
  remediation_note: null,
  remediated_at: null,
};

describe('lookupFeedback', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(withTransaction).mockReset();
  });

  it('returns not_found for an unrecognised token, and issues no write', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    const result = await lookupFeedback('some-token');

    expect(result).toEqual({ status: 'not_found' });
    // Nothing is read either: a dead token must not cause a findings query.
    expect(query).not.toHaveBeenCalled();
    expectReadOnly();
  });

  it('returns expired for a token past its TTL — with no findings, because the credential is dead', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'fb-2',
      adviser_name: 'Jo Adviser',
      confirmed_at: null,
      token_expires_at: '2000-01-01T00:00:00.000Z',
      reasoning_withheld: false,
    });

    const result = await lookupFeedback('some-token');

    expect(result).toEqual({ status: 'expired', adviserName: 'Jo Adviser' });
    // The expiry would be cosmetic if a dead link still disclosed the findings.
    expect(query).not.toHaveBeenCalled();
    expectReadOnly();
  });

  it('returns pending with the findings, and never a confirmation, for a live unconfirmed token', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'fb-3',
      adviser_name: 'Jo Adviser',
      confirmed_at: null,
      token_expires_at: '2099-01-01T00:00:00.000Z',
      reasoning_withheld: false,
    });
    vi.mocked(query).mockResolvedValueOnce([itemRow]);

    const result = await lookupFeedback('some-token');

    expect(result.status).toBe('pending');
    expect(result.itemCount).toBe(1);
    // Shown before confirmation on purpose: "confirm you have seen this" is not
    // something a person can honestly click on a page that will not say what it
    // was.
    expect(result.items?.[0]).toMatchObject({
      label: 'Attitude to risk not evidenced',
      remediationGuidance: 'Call the client and re-send the fact-find.',
      outcome: null,
    });
    // But writing waits for the click.
    expect(result.canRecordOutcome).toBe(false);
    expectReadOnly();
  });

  it('unlocks outcome capture once the feedback is confirmed', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'fb-1',
      adviser_name: 'Jo Adviser',
      confirmed_at: '2026-01-01T00:00:00.000Z',
      token_expires_at: '2099-06-01T00:00:00.000Z',
      reasoning_withheld: false,
    });
    vi.mocked(query).mockResolvedValueOnce([itemRow]);

    const result = await lookupFeedback('some-token');

    expect(result.status).toBe('already_confirmed');
    expect(result.canRecordOutcome).toBe(true);
    expectReadOnly();
  });

  it('still shows a confirmed feedback after expiry, but refuses further writing', async () => {
    // The findings were emailed to this person and they acknowledged them;
    // re-reading is not a new assertion. Recording a fresh outcome is, and the
    // credential has run out.
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'fb-4',
      adviser_name: 'Jo Adviser',
      confirmed_at: '2026-01-01T00:00:00.000Z',
      token_expires_at: '2000-01-01T00:00:00.000Z',
      reasoning_withheld: false,
    });
    vi.mocked(query).mockResolvedValueOnce([itemRow]);

    const result = await lookupFeedback('some-token');

    expect(result.status).toBe('already_confirmed');
    expect(result.items).toHaveLength(1);
    expect(result.canRecordOutcome).toBe(false);
  });

  it('withholds the model reasoning on a tenant that withheld it from the email, and says so', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'fb-5',
      adviser_name: 'Jo Adviser',
      confirmed_at: '2026-01-01T00:00:00.000Z',
      token_expires_at: '2099-01-01T00:00:00.000Z',
      reasoning_withheld: true,
    });
    vi.mocked(query).mockResolvedValueOnce([itemRow]);

    const result = await lookupFeedback('some-token');

    // The row still holds a reason (a re-score can populate it), so this is a
    // policy decision at the boundary rather than an absence of data. This page
    // is unauthenticated, and a sentence that was not safe to email is not safe
    // here either (DPIA R5).
    expect(result.items?.[0].reasoning).toBeNull();
    // The firm's own instruction is unaffected: it was written against the
    // criterion without seeing any customer, so it cannot quote a disclosure.
    expect(result.items?.[0].remediationGuidance).toBe('Call the client and re-send the fact-find.');
    // Flagged rather than silently short, so the page can explain the gap.
    expect(result.reasoningWithheld).toBe(true);
  });
});

// ============================================================
// CG-25 — what the adviser did about each finding.
//
// An unauthenticated write, so the gates are the whole design. These pin the
// three that matter: it cannot run before acknowledgement (a re-send would
// destroy the row), it cannot run on a dead link, and a valid token cannot be
// aimed at a finding belonging to someone else.
// ============================================================

describe('recordRemediationOutcome', () => {
  const confirmedRow = {
    id: 'fb-1',
    organization_id: 'org-1',
    journey_id: 'j-1',
    adviser_name: 'Jo Adviser',
    adviser_user_id: 'u-1',
    confirmed_at: '2026-01-01T00:00:00.000Z',
    token_expires_at: '2099-01-01T00:00:00.000Z',
    reasoning_withheld: false,
  };

  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(withTransaction).mockReset();
  });

  it('rejects an outcome outside the three, rather than storing the nearest one', async () => {
    const result = await recordRemediationOutcome('some-token', 'it-1', 'probably_fine', null);

    expect(result.status).toBe('invalid_outcome');
    // Refused before the token is even hashed: coercing this would put words in
    // an adviser's mouth about a customer's position.
    expect(queryOne).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('refuses before the feedback has been acknowledged', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...confirmedRow, confirmed_at: null });

    const result = await recordRemediationOutcome('some-token', 'it-1', 'done', null);

    // Not a workflow preference: sendFeedback DELETEs an unconfirmed feedback
    // when a supervisor re-sends, cascading to its items, so an outcome stored
    // here could vanish with nothing said to the adviser who wrote it.
    expect(result.status).toBe('not_confirmed');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('refuses on an expired link even though the feedback was confirmed', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      ...confirmedRow,
      token_expires_at: '2000-01-01T00:00:00.000Z',
    });

    const result = await recordRemediationOutcome('some-token', 'it-1', 'done', null);

    expect(result.status).toBe('expired');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("scopes the write to the token's own feedback, so a valid token cannot answer someone else's finding", async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(confirmedRow);

    let updateSql = '';
    let updateParams: unknown[] = [];
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      queryOne: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>) =>
      fn({
        query: async () => [],
        queryOne: async (sql: string, params?: unknown[]) => {
          updateSql = sql;
          updateParams = params ?? [];
          return { id: 'it-1', breach_id: 'b-1', item_label: 'Attitude to risk not evidenced' };
        },
      })) as never);
    vi.mocked(query).mockResolvedValueOnce([
      { ...itemRow, remediation_outcome: 'done', remediation_note: 'Called them back.' },
    ]);

    const result = await recordRemediationOutcome('some-token', 'it-1', 'done', 'Called them back.');

    expect(result.status).toBe('recorded');
    // feedback_id is the authorisation, not a filter. Without it in the WHERE,
    // any live token could write onto any item id it was handed.
    expect(updateSql).toContain('feedback_id = $2');
    expect(updateParams[0]).toBe('it-1');
    expect(updateParams[1]).toBe('fb-1');
    expect(updateParams[2]).toBe('done');
    expect(result.item?.outcome).toBe('done');
  });

  it('appends a breach event per write, so a revised answer keeps both', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(confirmedRow);

    const events: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      queryOne: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('breach_events')) events.push({ sql, params: params ?? [] });
          return [];
        },
        queryOne: async () => ({ id: 'it-1', breach_id: 'b-1', item_label: 'A finding' }),
      })) as never);
    vi.mocked(query).mockResolvedValueOnce([{ ...itemRow, remediation_outcome: 'done' }]);

    await recordRemediationOutcome('some-token', 'it-1', 'done', null);

    expect(events).toHaveLength(1);
    // INSERT, never UPDATE: "said unreachable, then said done" is a fact a
    // claims file needs and a single mutable column cannot hold.
    expect(events[0].sql).toMatch(/INSERT INTO breach_events/);
    expect(events[0].sql).toContain('remediation_recorded');
    // (breach_id, user_id, to_value) — event_type is inline in the statement.
    expect(events[0].params[0]).toBe('b-1');
    expect(events[0].params[2]).toBe('done');
  });

  it('records the outcome even where a re-score has left the finding with no breach row', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(confirmedRow);

    const events: unknown[][] = [];
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      queryOne: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('breach_events')) events.push(params ?? []);
          return [];
        },
        // breach_id nulled by ON DELETE SET NULL when the sale was re-scored.
        queryOne: async () => ({ id: 'it-1', breach_id: null, item_label: 'A finding' }),
      })) as never);
    vi.mocked(query).mockResolvedValueOnce([
      { ...itemRow, remediation_outcome: 'customer_unreachable' },
    ]);

    const result = await recordRemediationOutcome(
      'some-token',
      'it-1',
      'customer_unreachable',
      'Tried three times.'
    );

    // The outcome survives on the snapshot row, which is what the snapshot is
    // for. Only the breach's own history entry is skipped, because there is no
    // longer a breach to hang it on.
    expect(result.status).toBe('recorded');
    expect(events).toHaveLength(0);
  });

  it('reports not_found when the item does not belong to this feedback', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(confirmedRow);
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      queryOne: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>) =>
      fn({
        query: async () => [],
        // The UPDATE matched nothing — the id is real but hangs off another
        // adviser's feedback.
        queryOne: async () => null,
      })) as never);

    const result = await recordRemediationOutcome('some-token', 'it-9', 'done', null);

    expect(result.status).toBe('not_found');
  });

  it('trims a whitespace-only note to null, so "no note" has one representation', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(confirmedRow);

    let noteParam: unknown = 'unset';
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      queryOne: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>) =>
      fn({
        query: async () => [],
        queryOne: async (_sql: string, params?: unknown[]) => {
          noteParam = params?.[3];
          return { id: 'it-1', breach_id: null, item_label: 'A finding' };
        },
      })) as never);
    vi.mocked(query).mockResolvedValueOnce([{ ...itemRow, remediation_outcome: 'done' }]);

    await recordRemediationOutcome('some-token', 'it-1', 'done', '   \n  ');

    expect(noteParam).toBeNull();
  });

  it('truncates an over-long note rather than losing the whole account', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(confirmedRow);

    let noteParam = '';
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      queryOne: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>) =>
      fn({
        query: async () => [],
        queryOne: async (_sql: string, params?: unknown[]) => {
          noteParam = String(params?.[3] ?? '');
          return { id: 'it-1', breach_id: null, item_label: 'A finding' };
        },
      })) as never);
    vi.mocked(query).mockResolvedValueOnce([{ ...itemRow, remediation_outcome: 'done' }]);

    await recordRemediationOutcome('some-token', 'it-1', 'done', 'x'.repeat(5000));

    expect(noteParam).toHaveLength(REMEDIATION_NOTE_MAX);
  });
});

// ============================================================
// CG-5 — choosing the recipient.
//
// The default (the sale's closing adviser) is right almost every time, and
// wrong occasionally, which is the dangerous shape: feedback that reaches the
// wrong adviser and is confirmed by them sets confirmed_at on a record that
// proves nothing while still looking complete. These pin the properties that
// stop that — tenant scoping on a chosen recipient, refusal rather than a
// silent misdelivery, and the override being recorded as an override.
// ============================================================

describe('resolveRecipients', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
  });

  it('marks a user with no address ineligible rather than dropping them', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { id: 'u-1', name: 'Jo Adviser', email: 'jo@example.com', role: 'adviser' },
      { id: 'u-2', name: 'Sam No-Login', email: null, role: 'adviser' },
    ]);

    const rows = await resolveRecipients('org-1');

    // Listed, not hidden: a supervisor who cannot find someone needs to be told
    // they are undeliverable, not left to conclude they have left the firm.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'u-1', eligible: true });
    expect(rows[1]).toMatchObject({ id: 'u-2', eligible: false });
  });

  it('treats an empty-string address as undeliverable', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { id: 'u-3', name: 'Blank', email: '', role: 'adviser' },
    ]);

    expect((await resolveRecipients('org-1'))[0].eligible).toBe(false);
  });

  it('scopes to the organisation and does not exclude no-login advisers', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await resolveRecipients('org-1');

    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(params).toEqual(['org-1']);
    // 061 no-login advisers are exactly who the tokenised link exists for.
    // Filtering them out here would remove the people this feature is for.
    expect(sql).not.toContain('login_disabled');
  });
});

describe('resolveChosenRecipient', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
  });

  it('looks the user up scoped by organisation, not by id alone', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'u-1',
      name: 'Jo Adviser',
      email: 'jo@example.com',
    });

    const target = await resolveChosenRecipient('org-1', 'u-1');

    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain('organization_id = $2');
    expect(params).toEqual(['u-1', 'org-1']);
    expect(target).toEqual({
      userId: 'u-1',
      name: 'Jo Adviser',
      email: 'jo@example.com',
      problem: null,
    });
  });

  it('refuses a user id that is not in the organisation', async () => {
    // The org-scoped lookup returns nothing for another tenant's user, so a
    // guessed or stale id cannot be fed back to.
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    await expect(resolveChosenRecipient('org-1', 'u-other-tenant')).rejects.toThrow(
      /no longer on this team/
    );
  });

  it('reports a chosen recipient with no address rather than returning them as sendable', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'u-2', name: 'Sam', email: null });

    expect(await resolveChosenRecipient('org-1', 'u-2')).toEqual({
      userId: 'u-2',
      name: 'Sam',
      email: null,
      problem: 'no_email',
    });
  });
});

describe('sendFeedback — what gets recorded about the recipient', () => {
  const saleRow = {
    client_name: 'James Whitfield',
    customer_name: 'James Whitfield',
    overall_score: '77.8',
    pass: false,
  };

  // sendFeedback is otherwise DB-bound, but the columns it writes are the whole
  // audit-trail claim of CG-5, so the INSERT parameters are worth pinning.
  async function capturedInsert(): Promise<unknown[]> {
    const call = vi
      .mocked(withTransaction)
      .mock.calls[0][0] as (tx: {
        query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
        queryOne: (sql: string, params?: unknown[]) => Promise<unknown>;
      }) => Promise<string>;

    let insertParams: unknown[] = [];
    await call({
      query: async () => [],
      queryOne: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO journey_feedback')) insertParams = params ?? [];
        return { id: 'fb-new' };
      },
    });
    return insertParams;
  }

  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(withTransaction).mockReset();
    vi.mocked(withTransaction).mockResolvedValue('fb-new');
  });

  it('records a default send as the default, with the adviser it derived', async () => {
    // resolveAdviser's row, then breachesForFeedback.
    vi.mocked(queryOne).mockResolvedValueOnce({
      agent_id: 'u-1',
      agent_name: 'Jo Adviser',
      user_email: 'jo@example.com',
      user_name: 'Jo Adviser',
    });
    vi.mocked(queryOne).mockResolvedValueOnce(saleRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: { kind: 'journey', id: 'j-1' },
      sentBy: 'u-sup',
      message: null,
    });

    expect(result.recipientSource).toBe('default_closing_adviser');
    expect(result.suggestedAdviserUserId).toBe('u-1');

    const params = await capturedInsert();
    // adviser_user_id ($3) and suggested_adviser_user_id ($11) agree: nobody
    // overrode anything.
    expect(params[2]).toBe('u-1');
    expect(params[9]).toBe('default_closing_adviser');
    expect(params[10]).toBe('u-1');
  });

  it('still records the default when the caller names the adviser it would have picked anyway', async () => {
    // REGRESSION. The panel pre-fills the picker with the suggestion and always
    // posts adviser_user_id, so an ordinary send names the same person the
    // server would have derived. Keying 'manual' off the field's mere presence
    // marked every send an override, which left the flag distinguishing nothing
    // and the audit line asserting a choice nobody made — a column that reads as
    // evidence and is not. An override is a DIFFERENT recipient.
    vi.mocked(queryOne)
      .mockResolvedValueOnce({
        agent_id: 'u-1',
        agent_name: 'Jo Adviser',
        user_email: 'jo@example.com',
        user_name: 'Jo Adviser',
      })
      .mockResolvedValueOnce({ id: 'u-1', name: 'Jo Adviser', email: 'jo@example.com' })
      .mockResolvedValueOnce(saleRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: { kind: 'journey', id: 'j-1' },
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-1', // exactly what the panel sends when nothing is changed
    });

    expect(result.recipientSource).toBe('default_closing_adviser');
    expect((await capturedInsert())[9]).toBe('default_closing_adviser');
  });

  it('names who was displaced, so "chosen" is a claim an auditor can check', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({
        agent_id: 'u-1',
        agent_name: 'Jo Adviser',
        user_email: 'jo@example.com',
        user_name: 'Jo Adviser',
      })
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' })
      .mockResolvedValueOnce(saleRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: { kind: 'journey', id: 'j-1' },
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-2',
    });

    expect(result.suggestedAdviserName).toBe('Jo Adviser');
  });

  it('reports no displaced adviser on an unattributed sale, rather than a placeholder name', async () => {
    // resolveAdviser returns the literal string 'Unknown adviser' here. Putting
    // that in an audit line would read as a real person who was passed over.
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' })
      .mockResolvedValueOnce(saleRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: { kind: 'journey', id: 'j-1' },
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-2',
    });

    expect(result.recipientSource).toBe('manual');
    expect(result.suggestedAdviserName).toBeNull();
  });

  it('records a chosen recipient as an override, keeping who it would have gone to', async () => {
    vi.mocked(queryOne)
      // resolveAdviser — the last caller.
      .mockResolvedValueOnce({
        agent_id: 'u-1',
        agent_name: 'Jo Adviser',
        user_email: 'jo@example.com',
        user_name: 'Jo Adviser',
      })
      // resolveChosenRecipient — the person the supervisor actually picked.
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' })
      .mockResolvedValueOnce(saleRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: { kind: 'journey', id: 'j-1' },
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-2',
    });

    expect(result.recipientSource).toBe('manual');
    expect(result.adviser.userId).toBe('u-2');
    // The override is only evidence of anything if what was overridden is
    // stored beside it.
    expect(result.suggestedAdviserUserId).toBe('u-1');

    const params = await capturedInsert();
    expect(params[2]).toBe('u-2');
    expect(params[4]).toBe('dana@example.com');
    expect(params[9]).toBe('manual');
    expect(params[10]).toBe('u-1');
  });

  it('lets an unattributed sale be sent to a chosen recipient, with no suggestion recorded', async () => {
    // No calls attributed to anyone — the case that used to be a dead end.
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' })
      .mockResolvedValueOnce(saleRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: { kind: 'journey', id: 'j-1' },
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-2',
    });

    expect(result.recipientSource).toBe('manual');
    expect(result.suggestedAdviserUserId).toBeNull();
    expect((await capturedInsert())[10]).toBeNull();
  });

  it('refuses a chosen recipient with no address before writing anything', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({
        agent_id: 'u-1',
        agent_name: 'Jo Adviser',
        user_email: 'jo@example.com',
        user_name: 'Jo Adviser',
      })
      .mockResolvedValueOnce({ id: 'u-3', name: 'Sam No-Email', email: null });

    await expect(
      sendFeedback({
        organizationId: 'org-1',
        subject: { kind: 'journey', id: 'j-1' },
        sentBy: 'u-sup',
        message: null,
        adviserUserId: 'u-3',
      })
    ).rejects.toThrow(/no email address/);

    // A feedback record nobody received is worse than none.
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ============================================================
// buildFeedbackSend — the policy layer.
//
// Pure, so both gates are testable without a database, a queue or a live
// tenant. The properties pinned here are the ones that matter if they ever
// regress: what leaves the platform, and whether the audit record agrees with
// what left.
// ============================================================

const REASON = 'The adviser moved on to payment without the customer agreeing.';

const breach = (over: Partial<FeedbackBreach> = {}): FeedbackBreach => ({
  breach_id: 'b1',
  scorecard_item_id: 'si1',
  item_label: 'Obtained clear affirmative consent',
  severity: 'high',
  status: 'open',
  reasoning: REASON,
  ...over,
});

const sendInput = (over: Record<string, unknown> = {}) => ({
  adviserEmail: 'danni@example.test',
  adviserName: 'Danni Beck',
  confirmUrl: 'https://app.example.test/feedback/tok',
  message: null,
  clientName: 'James Whitfield',
  score: 77.8,
  pass: false,
  breaches: [breach()],
  includeReasoning: true,
  includeVerdict: true,
  ...over,
});

describe('buildFeedbackSend', () => {
  it('keeps a model reason out of the email where the tenant keeps health unredacted (DPIA R5)', () => {
    // The control R5's residual rating is conditional on. Asserted against the
    // serialised payload, not the object: this is what is handed to BullMQ and
    // persisted in Redis, so "not in the JSON" is the property with teeth.
    const { payload } = buildFeedbackSend(sendInput({ includeReasoning: false }));
    expect(JSON.stringify(payload)).not.toContain(REASON);
    expect(payload.items[0]).not.toHaveProperty('reasoning');
  });

  it('still tells the adviser what was missed when the reason is withheld', () => {
    const { payload } = buildFeedbackSend(sendInput({ includeReasoning: false }));
    expect(payload.items[0].label).toBe('Obtained clear affirmative consent');
    expect(payload.items[0].severity).toBe('high');
    expect(payload.reasoningWithheld).toBe(true);
  });

  it('claims no suppression when there was no reason to suppress', () => {
    // "Withheld" asserts something existed. A finding with no reasoning has had
    // nothing kept from it, and saying otherwise would put a suppression in the
    // record that never happened.
    const { payload, snapshot } = buildFeedbackSend(
      sendInput({ includeReasoning: false, breaches: [breach({ reasoning: null })] })
    );
    expect(payload.reasoningWithheld).toBeUndefined();
    expect(snapshot.reasoningWithheld).toBe(false);
  });

  it('withholds the verdict from the payload under score_only, not just the render', () => {
    // routes/share.ts sets the precedent: hiding a value in the client while
    // shipping it in the payload hides nothing. There is no client here at all.
    const { payload, snapshot } = buildFeedbackSend(sendInput({ includeVerdict: false }));
    expect(payload).not.toHaveProperty('pass');
    expect(payload.score).toBe(77.8);
    // Never shown, so never recorded as shown.
    expect(snapshot.pass).toBeNull();
  });

  it('records exactly what travelled, so the acknowledgement is evidence of it', () => {
    const sent = buildFeedbackSend(sendInput());
    expect(sent.snapshot.items[0].reasoning).toBe(REASON);
    expect(sent.snapshot.clientName).toBe('James Whitfield');
    expect(sent.snapshot.pass).toBe(false);

    const withheld = buildFeedbackSend(sendInput({ includeReasoning: false }));
    expect(withheld.snapshot.items[0].reasoning).toBeNull();
    expect(withheld.snapshot.items[0].breachId).toBe('b1');
  });
});

describe('buildFeedbackSend — remediation guidance (CG-24)', () => {
  const breach = {
    breach_id: 'b1',
    scorecard_item_id: 'si1',
    item_label: 'Explained the pre-existing conditions exclusion',
    severity: 'high',
    status: 'open',
    reasoning: 'The adviser did not mention the exclusion.',
    remediation_guidance: 'Call the customer back and confirm the exclusion applies.',
  };
  const input = {
    adviserEmail: 'a@example.test',
    adviserName: 'Danni Beck',
    confirmUrl: 'https://app.example.test/feedback/tok',
    message: null,
    clientName: 'James Whitfield',
    score: 77.8,
    pass: false,
    breaches: [breach],
    includeReasoning: true,
    includeVerdict: true,
    recipientCanSeeDetail: true,
  };

  it('carries guidance into the payload and freezes it in the snapshot', () => {
    const { payload, snapshot } = buildFeedbackSend(input);
    expect(payload.items[0]!.remediationGuidance).toBe(breach.remediation_guidance);
    expect(snapshot.items[0]!.remediationGuidance).toBe(breach.remediation_guidance);
  });

  // The decision this phase turns on. Reasoning is withheld because the MODEL
  // derived it from the call and it can quote a health disclosure. Guidance was
  // written by the firm in advance against the criterion, so that rule does not
  // reach it — and on exactly these tenants it is the only actionable content
  // the adviser receives.
  it('keeps guidance when reasoning is withheld', () => {
    const { payload, snapshot } = buildFeedbackSend({ ...input, includeReasoning: false });
    expect(payload.items[0]!.reasoning).toBeUndefined();
    expect(snapshot.items[0]!.reasoning).toBeNull();
    expect(payload.items[0]!.remediationGuidance).toBe(breach.remediation_guidance);
    expect(snapshot.items[0]!.remediationGuidance).toBe(breach.remediation_guidance);
  });

  it('omits guidance entirely on a checkpoint that has none', () => {
    const { payload, snapshot } = buildFeedbackSend({
      ...input,
      breaches: [{ ...breach, remediation_guidance: null }],
    });
    expect(payload.items[0]!.remediationGuidance).toBeUndefined();
    expect(snapshot.items[0]!.remediationGuidance).toBeNull();
  });

  // Whitespace is not an instruction. A checkpoint whose guidance is a stray
  // space must not render "What to do:" followed by nothing.
  it('treats whitespace-only guidance as none', () => {
    const { payload } = buildFeedbackSend({
      ...input,
      breaches: [{ ...breach, remediation_guidance: '   \n ' }],
    });
    expect(payload.items[0]!.remediationGuidance).toBeUndefined();
  });
});

// ============================================================
// Migration 118 — feedback on a call scored on its own.
//
// The adviser's half (token, confirmation, outcomes) is subject-blind and is
// covered above. These pin the half that branches on the subject: who a call is
// fed back to, which findings stand, where the re-send and the insert are
// keyed, and what the email is told it is about. The failure each guards
// against is a call round that quietly behaves like a sale round — keyed on a
// NULL journey_id, it would match nothing and supersede nothing.
// ============================================================

const CALL: FeedbackSubject = { kind: 'call', id: 'c-1' };
const SALE: FeedbackSubject = { kind: 'journey', id: 'j-1' };

type Tx = {
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  queryOne: (sql: string, params?: unknown[]) => Promise<unknown>;
};

/** Every statement the send's transaction issued, in order. */
async function replaySendTransaction(): Promise<Array<{ sql: string; params: unknown[] }>> {
  const fn = vi.mocked(withTransaction).mock.calls[0][0] as (tx: Tx) => Promise<string>;
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  await fn({
    query: async (sql, params) => {
      statements.push({ sql, params: params ?? [] });
      return [];
    },
    queryOne: async (sql, params) => {
      statements.push({ sql, params: params ?? [] });
      return { id: 'fb-new' };
    },
  });
  return statements;
}

const callAdviserRow = {
  agent_id: 'u-1',
  agent_name: 'Jo (dialler)',
  user_email: 'jo@example.com',
  user_name: 'Jo Adviser',
};

const callSummaryRow = {
  customer_name: 'Ann Lee',
  overall_score: '64.50',
  pass: false,
};

describe('resolveAdviser — a call', () => {
  beforeEach(() => {
    vi.mocked(queryOne).mockReset();
  });

  it("takes the call's own adviser, with no sale ordering to apply", async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(callAdviserRow);

    const target = await resolveAdviser(CALL);

    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain('FROM calls c');
    expect(sql).toContain('WHERE c.id = $1');
    // There is one call, so no wrap_up tie-break exists to be applied.
    expect(sql).not.toContain('journey_calls');
    expect(params).toEqual(['c-1']);
    expect(target).toEqual({
      userId: 'u-1',
      name: 'Jo Adviser',
      email: 'jo@example.com',
      problem: null,
    });
  });

  it('reports no_adviser for a call nobody is attributed to', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      agent_id: null,
      agent_name: null,
      user_email: null,
      user_name: null,
    });

    expect((await resolveAdviser(CALL)).problem).toBe('no_adviser');
  });

  it('reports no_email for a dialler-named adviser with no account', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      agent_id: null,
      agent_name: 'Dave (dialler)',
      user_email: null,
      user_name: null,
    });

    expect(await resolveAdviser(CALL)).toEqual({
      userId: null,
      name: 'Dave (dialler)',
      email: null,
      problem: 'no_email',
    });
  });

  it("still resolves a sale by its closing call", async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(callAdviserRow);

    await resolveAdviser(SALE);

    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain('journey_calls');
    expect(sql).toContain("jc.role = 'wrap_up'");
    expect(params).toEqual(['j-1']);
  });
});

describe('breachesForFeedback — a call', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset().mockResolvedValue([]);
  });

  it("reads the call's own breaches, with their reasons from the call's item scores", async () => {
    await breachesForFeedback('org-1', CALL);

    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain('b.call_id = $2');
    expect(sql).toContain('LEFT JOIN call_item_scores');
    expect(sql).toContain('b.call_item_score_id');
    expect(sql).not.toContain('journey_item_scores');
    expect(sql).not.toContain('b.journey_id');
    expect(params).toEqual(['org-1', 'c-1']);
  });

  it('applies the same exclusions and the same order as a sale', async () => {
    await breachesForFeedback('org-1', CALL);
    await breachesForFeedback('org-1', SALE);

    const [callSql] = vi.mocked(query).mock.calls[0];
    const [saleSql] = vi.mocked(query).mock.calls[1];
    for (const sql of [callSql, saleSql]) {
      // A finding a supervisor already dismissed is not fed back, on either.
      expect(sql).toContain("b.status NOT IN ('resolved', 'noted')");
      expect(sql).toContain("WHEN 'critical' THEN 0 WHEN 'high' THEN 1");
      expect(sql).toContain('b.organization_id = $1');
    }
    expect(saleSql).toContain('b.journey_id = $2');
    expect(saleSql).toContain('journey_item_scores');
    expect(saleSql).not.toContain('b.call_id');
  });
});

describe('openReviewCount and latestFeedback — a call', () => {
  beforeEach(() => {
    vi.mocked(queryOne).mockReset();
  });

  it("counts the call's manual-review checkpoints the way the review queue does", async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ n: '3' });

    expect(await openReviewCount(CALL)).toBe(3);

    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain('FROM call_item_scores cis');
    expect(sql).toContain('JOIN call_scores cs ON cs.id = cis.call_score_id');
    expect(sql).toContain("cis.result = 'manual_review'");
    expect(params).toEqual(['c-1']);
  });

  it("reads the call's latest round off call_id, scoped to the organisation", async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    await latestFeedback('org-1', CALL);

    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain('organization_id = $1 AND call_id = $2');
    expect(params).toEqual(['org-1', 'c-1']);
  });
});

describe('subjectSummary — a call', () => {
  beforeEach(() => {
    vi.mocked(queryOne).mockReset();
  });

  it("names the call's customer and states its latest score", async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...callSummaryRow, customer_name: '  Ann Lee ' });

    expect(await subjectSummary('org-1', CALL)).toEqual({
      clientName: 'Ann Lee',
      // NUMERIC arrives as a string and is coerced once, here.
      score: 64.5,
      pass: false,
    });

    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain('FROM calls c');
    expect(sql).toContain('call_scores');
    expect(sql).toContain('ORDER BY scored_at DESC');
    expect(sql).toContain('c.organization_id = $2');
    expect(params).toEqual(['c-1', 'org-1']);
  });

  it('names nobody on a call with no named customer — never the phone number', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      customer_name: null,
      overall_score: null,
      pass: null,
    });

    expect(await subjectSummary('org-1', CALL)).toEqual({
      clientName: null,
      // No score is stated as no score, never as 0.
      score: null,
      pass: null,
    });
    // Not merely unused: the number is never read, so it cannot reach the
    // email or the panel by any later change to how the row is used.
    const [sql] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).not.toContain('customer_phone');
  });

  it('treats a whitespace-only name as no name', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      customer_name: '   ',
      overall_score: '80',
      pass: true,
    });

    expect((await subjectSummary('org-1', CALL)).clientName).toBeNull();
  });
});

describe('sendFeedback — a call', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(withTransaction).mockReset();
    vi.mocked(withTransaction).mockResolvedValue('fb-new');
    vi.mocked(alertsQueue.add).mockClear();
  });

  it("defaults to the call's own adviser, and records that as the default", async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce(callSummaryRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: CALL,
      sentBy: 'u-sup',
      message: null,
    });

    expect(result.recipientSource).toBe('default_closing_adviser');
    expect(result.adviser.userId).toBe('u-1');
    expect(result.suggestedAdviserUserId).toBe('u-1');
  });

  it("supersedes only this call's unconfirmed round, and writes the new one against the call", async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce(callSummaryRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    await sendFeedback({ organizationId: 'org-1', subject: CALL, sentBy: 'u-sup', message: null });
    const statements = await replaySendTransaction();

    // The re-send. Keyed on journey_id this would match nothing on a call —
    // NULL equals nothing — and leave the old link live beside the new one.
    const del = statements.find((st) => st.sql.includes('DELETE FROM journey_feedback'))!;
    expect(del.sql).toContain('call_id = $1');
    expect(del.sql).toContain('organization_id = $2');
    expect(del.sql).toContain('confirmed_at IS NULL');
    expect(del.sql).not.toContain('journey_id');
    expect(del.params).toEqual(['c-1', 'org-1']);

    const ins = statements.find((st) => /INSERT INTO journey_feedback\s*\(/.test(st.sql))!;
    expect(ins.sql).toMatch(/\(organization_id, call_id, adviser_user_id/);
    expect(ins.sql).not.toContain('journey_id');
    expect(ins.params[0]).toBe('org-1');
    expect(ins.params[1]).toBe('c-1');
    expect(ins.params[2]).toBe('u-1');
    expect(ins.params[9]).toBe('default_closing_adviser');
    expect(ins.params[10]).toBe('u-1');
    // The snapshot records what the email named.
    expect(ins.params[11]).toBe('Ann Lee');
    expect(ins.params[12]).toBe(64.5);
  });

  it('still supersedes a sale round by journey_id', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce({ client_name: 'James Whitfield', customer_name: null, overall_score: '70', pass: true });
    vi.mocked(query).mockResolvedValueOnce([]);

    await sendFeedback({ organizationId: 'org-1', subject: SALE, sentBy: 'u-sup', message: null });
    const statements = await replaySendTransaction();

    const del = statements.find((st) => st.sql.includes('DELETE FROM journey_feedback'))!;
    expect(del.sql).toContain('journey_id = $1');
    expect(del.sql).not.toContain('call_id');
    expect(del.params).toEqual(['j-1', 'org-1']);
  });

  it('tells the email it is about a call, and names the call\'s customer in the body only', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce(callSummaryRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    await sendFeedback({ organizationId: 'org-1', subject: CALL, sentBy: 'u-sup', message: null });

    const [name, payload] = vi.mocked(alertsQueue.add).mock.calls[0];
    expect(name).toBe('feedback-email');
    expect(payload).toMatchObject({ subjectKind: 'call', clientName: 'Ann Lee', score: 64.5 });
    // The subject's id is not something the email needs, and the payload sits
    // in Redis until sent.
    expect(JSON.stringify(payload)).not.toContain('c-1');
  });

  // The recipient matrix, on a call. Same rules as a sale: an override is a
  // DIFFERENT person, and what was overridden is stored beside it.
  it('records a different person chosen for a call as an override', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' })
      .mockResolvedValueOnce(callSummaryRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: CALL,
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-2',
    });

    expect(result.recipientSource).toBe('manual');
    expect(result.adviser.userId).toBe('u-2');
    expect(result.suggestedAdviserUserId).toBe('u-1');
    expect(result.suggestedAdviserName).toBe('Jo Adviser');
  });

  it("keeps the default when the call's own adviser is the one chosen", async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce({ id: 'u-1', name: 'Jo Adviser', email: 'jo@example.com' })
      .mockResolvedValueOnce(callSummaryRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: CALL,
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-1',
    });

    expect(result.recipientSource).toBe('default_closing_adviser');
  });

  it('lets an unattributed call go to a chosen recipient, with no suggestion recorded', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({ agent_id: null, agent_name: null, user_email: null, user_name: null })
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' })
      .mockResolvedValueOnce(callSummaryRow);
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      subject: CALL,
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-2',
    });

    expect(result.recipientSource).toBe('manual');
    expect(result.suggestedAdviserUserId).toBeNull();
    expect(result.suggestedAdviserName).toBeNull();
  });

  it('refuses an unattributed call with nobody chosen, calling it a call, before writing anything', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      agent_id: null,
      agent_name: null,
      user_email: null,
      user_name: null,
    });

    await expect(
      sendFeedback({ organizationId: 'org-1', subject: CALL, sentBy: 'u-sup', message: null })
    ).rejects.toThrow('This call has no adviser attributed to it. Choose who to send the feedback to.');
    expect(withTransaction).not.toHaveBeenCalled();
    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('refuses a chosen recipient with no address on a call, before writing anything', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce({ id: 'u-3', name: 'Sam No-Email', email: null });

    await expect(
      sendFeedback({
        organizationId: 'org-1',
        subject: CALL,
        sentBy: 'u-sup',
        message: null,
        adviserUserId: 'u-3',
      })
    ).rejects.toThrow(/no email address/);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe('sendFeedback — can the recipient read the withheld reasons?', () => {
  // Only matters where reasoning is withheld (the tenant keeps health
  // unredacted), where it picks between "sign in to read it" and "ask your
  // supervisor". The sentence must be TRUE for the reader it is sent to.
  const withReason = [
    {
      breach_id: 'b-1',
      scorecard_item_id: 'si-1',
      item_label: 'Explained the exclusions',
      severity: 'high',
      status: 'open',
      reasoning: 'The adviser skipped the exclusions.',
      remediation_guidance: null,
    },
  ];

  beforeEach(async () => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(withTransaction).mockReset();
    vi.mocked(withTransaction).mockResolvedValue('fb-new');
    vi.mocked(alertsQueue.add).mockClear();
    const { organisationKeepsHealthUnredacted } = await import('./transcript-access.js');
    vi.mocked(organisationKeepsHealthUnredacted).mockResolvedValue(true);
  });

  afterAll(async () => {
    const { organisationKeepsHealthUnredacted } = await import('./transcript-access.js');
    vi.mocked(organisationKeepsHealthUnredacted).mockResolvedValue(false);
  });

  function visibilityQuery(): [string, unknown[]] {
    const hit = vi.mocked(queryOne).mock.calls.find(([sql]) => String(sql).includes('password_hash IS NOT NULL'))!;
    return [String(hit[0]), hit[1] as unknown[]];
  }

  it("sends a call's own adviser, signed in, to CallGuard: GET /calls/:id/scores carries every reason", async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce(callSummaryRow)
      .mockResolvedValueOnce({ id: 'u-1' });
    vi.mocked(query).mockResolvedValueOnce(withReason);

    await sendFeedback({ organizationId: 'org-1', subject: CALL, sentBy: 'u-sup', message: null });

    const [sql, params] = visibilityQuery();
    // An adviser-role reader qualifies only on a call they took.
    expect(sql).toContain("u.role = 'adviser'");
    expect(sql).toContain('c.agent_id = u.id');
    expect(sql).toContain('c.organization_id = $2');
    expect(params).toEqual(['u-1', 'org-1', ['admin', 'supervisor', 'viewer'], 'c-1']);

    const payload = vi.mocked(alertsQueue.add).mock.calls[0][1] as { reasoningWithheld?: boolean; recipientCanSeeDetail?: boolean };
    expect(payload.reasoningWithheld).toBe(true);
    expect(payload.recipientCanSeeDetail).toBe(true);
  });

  it('points them at their supervisor when the query finds they cannot (no login, or not their call)', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce(callSummaryRow)
      .mockResolvedValueOnce(null);
    vi.mocked(query).mockResolvedValueOnce(withReason);

    await sendFeedback({ organizationId: 'org-1', subject: CALL, sentBy: 'u-sup', message: null });

    const payload = vi.mocked(alertsQueue.add).mock.calls[0][1] as { recipientCanSeeDetail?: boolean };
    expect(payload.recipientCanSeeDetail).toBe(false);
  });

  it('never lets an adviser-role reader qualify on a sale, whose reasons span calls', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(callAdviserRow)
      .mockResolvedValueOnce({ client_name: 'James Whitfield', customer_name: null, overall_score: '70', pass: true })
      .mockResolvedValueOnce(null);
    vi.mocked(query).mockResolvedValueOnce(withReason);

    await sendFeedback({ organizationId: 'org-1', subject: SALE, sentBy: 'u-sup', message: null });

    const [sql, params] = visibilityQuery();
    expect(sql).toContain('role = ANY($3::text[])');
    expect(sql).not.toContain("'adviser'");
    expect(sql).not.toContain('agent_id');
    expect(params).toEqual(['u-1', 'org-1', ['admin', 'supervisor', 'viewer']]);
  });
});

describe('the open-round rule for calls (migration 118)', () => {
  // Read from the migration itself: this is a property of the schema, and a
  // unit test with no database can only hold it by holding the DDL.
  const ddl = readFileSync(
    path.resolve(__dirname, '../db/migrations/118_feedback_call_subject.sql'),
    'utf8'
  )
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ');

  it('allows at most one outstanding round per call', () => {
    // 087's open index is unique on journey_id, and every NULL is distinct, so
    // on call rows it enforces nothing. This is the one that does.
    expect(ddl).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_feedback_open_call ON journey_feedback (call_id) WHERE confirmed_at IS NULL AND call_id IS NOT NULL'
    );
  });

  it('requires exactly one subject on every round', () => {
    expect(ddl).toContain('ALTER COLUMN journey_id DROP NOT NULL');
    expect(ddl).toContain('call_id UUID REFERENCES calls(id) ON DELETE CASCADE');
    expect(ddl).toContain('CHECK (num_nonnulls(journey_id, call_id) = 1)');
  });

  it('gives up waiting for its lock on calls rather than queueing ingest behind it', () => {
    // The foreign key blocks writes to calls while the file runs. Set before
    // any statement that takes a lock, or it protects nothing.
    const timeout = ddl.indexOf("SET LOCAL lock_timeout = '5s';");
    expect(timeout).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeLessThan(ddl.indexOf('ALTER TABLE'));
    // SET LOCAL only lasts for a transaction, which migrate.ts gives every file
    // that does not opt out with the no-transaction marker.
    const firstLine = readFileSync(
      path.resolve(__dirname, '../db/migrations/118_feedback_call_subject.sql'),
      'utf8'
    ).split('\n', 1)[0];
    expect(firstLine.trim()).not.toBe('-- callguard:no-transaction');
  });

  it("indexes a call's latest round", () => {
    expect(ddl).toContain('ON journey_feedback (call_id, sent_at DESC)');
  });
});

describe('lookupFeedback — which kind of subject', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(withTransaction).mockReset();
  });

  const liveRow = {
    id: 'fb-9',
    adviser_name: 'Jo Adviser',
    confirmed_at: null,
    token_expires_at: '2099-01-01T00:00:00.000Z',
    reasoning_withheld: false,
  };

  it("says a call round is about a call, without saying which call", async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...liveRow, call_id: 'c-1' });
    vi.mocked(query).mockResolvedValueOnce([itemRow]);

    const result = await lookupFeedback('some-token');

    expect(result.subject_kind).toBe('call');
    expect(JSON.stringify(result)).not.toContain('c-1');
    expectReadOnly();
  });

  it('says a sale round is about a sale', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...liveRow, call_id: null });
    vi.mocked(query).mockResolvedValueOnce([itemRow]);

    expect((await lookupFeedback('some-token')).subject_kind).toBe('journey');
  });

  it('tells a dead link nothing about its subject', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      ...liveRow,
      call_id: 'c-1',
      token_expires_at: '2000-01-01T00:00:00.000Z',
    });

    expect(await lookupFeedback('some-token')).toEqual({
      status: 'expired',
      adviserName: 'Jo Adviser',
    });
  });
});

describe('feedbackAuditContext', () => {
  beforeEach(() => {
    vi.mocked(queryOne).mockReset();
  });

  it('returns the call a call round was about, so the audit line is filed against it', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      organization_id: 'org-1',
      journey_id: null,
      call_id: 'c-1',
      adviser_name: 'Jo Adviser',
      adviser_user_id: null,
    });

    expect(await feedbackAuditContext('some-token')).toEqual({
      organizationId: 'org-1',
      subject: { kind: 'call', id: 'c-1' },
      adviserName: 'Jo Adviser',
      adviserUserId: null,
    });
  });

  it('returns the sale a sale round was about', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      organization_id: 'org-1',
      journey_id: 'j-1',
      call_id: null,
      adviser_name: 'Jo Adviser',
      adviser_user_id: 'u-1',
    });

    expect((await feedbackAuditContext('some-token'))?.subject).toEqual({ kind: 'journey', id: 'j-1' });
  });

  it('returns nothing for an unknown token', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await feedbackAuditContext('some-token')).toBeNull();
  });
});
