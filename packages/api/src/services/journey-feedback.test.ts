import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  hashFeedbackToken,
  lookupFeedback,
  resolveRecipients,
  resolveChosenRecipient,
  sendFeedback,
} from './journey-feedback.js';
import { query, queryOne, withTransaction } from '../db/client.js';

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

describe('lookupFeedback', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
  });

  it('returns not_found for an unrecognised token, and issues no write', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    const result = await lookupFeedback('some-token');

    expect(result).toEqual({ status: 'not_found' });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns already_confirmed with the adviser name and item count, and issues no write', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({
        id: 'fb-1',
        adviser_name: 'Jo Adviser',
        confirmed_at: '2026-01-01T00:00:00.000Z',
        token_expires_at: '2026-06-01T00:00:00.000Z',
      })
      .mockResolvedValueOnce({ n: '3' });

    const result = await lookupFeedback('some-token');

    expect(result).toEqual({ status: 'already_confirmed', adviserName: 'Jo Adviser', itemCount: 3 });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns expired for a token past its TTL, and issues no write', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'fb-2',
      adviser_name: 'Jo Adviser',
      confirmed_at: null,
      token_expires_at: '2000-01-01T00:00:00.000Z',
    });

    const result = await lookupFeedback('some-token');

    expect(result).toEqual({ status: 'expired', adviserName: 'Jo Adviser' });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns pending — with the adviser name and item count, never a confirmation — for a live token', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({
        id: 'fb-3',
        adviser_name: 'Jo Adviser',
        confirmed_at: null,
        token_expires_at: '2099-01-01T00:00:00.000Z',
      })
      .mockResolvedValueOnce({ n: '2' });

    const result = await lookupFeedback('some-token');

    expect(result).toEqual({ status: 'pending', adviserName: 'Jo Adviser', itemCount: 2 });
    // The point of the whole split: a GET-driven lookup must never write —
    // no UPDATE on journey_feedback, no breach_events insert.
    expect(query).not.toHaveBeenCalled();
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
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      journeyId: 'j-1',
      sentBy: 'u-sup',
      message: null,
    });

    expect(result.recipientSource).toBe('default_last_caller');
    expect(result.suggestedAdviserUserId).toBe('u-1');

    const params = await capturedInsert();
    // adviser_user_id ($3) and suggested_adviser_user_id ($11) agree: nobody
    // overrode anything.
    expect(params[2]).toBe('u-1');
    expect(params[9]).toBe('default_last_caller');
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
      .mockResolvedValueOnce({ id: 'u-1', name: 'Jo Adviser', email: 'jo@example.com' });
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      journeyId: 'j-1',
      sentBy: 'u-sup',
      message: null,
      adviserUserId: 'u-1', // exactly what the panel sends when nothing is changed
    });

    expect(result.recipientSource).toBe('default_last_caller');
    expect((await capturedInsert())[9]).toBe('default_last_caller');
  });

  it('names who was displaced, so "chosen" is a claim an auditor can check', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({
        agent_id: 'u-1',
        agent_name: 'Jo Adviser',
        user_email: 'jo@example.com',
        user_name: 'Jo Adviser',
      })
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' });
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      journeyId: 'j-1',
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
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' });
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      journeyId: 'j-1',
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
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' });
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      journeyId: 'j-1',
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
      .mockResolvedValueOnce({ id: 'u-2', name: 'Dana Seller', email: 'dana@example.com' });
    vi.mocked(query).mockResolvedValueOnce([]);

    const result = await sendFeedback({
      organizationId: 'org-1',
      journeyId: 'j-1',
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
        journeyId: 'j-1',
        sentBy: 'u-sup',
        message: null,
        adviserUserId: 'u-3',
      })
    ).rejects.toThrow(/no email address/);

    // A feedback record nobody received is worse than none.
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
