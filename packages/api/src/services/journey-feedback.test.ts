import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashFeedbackToken, lookupFeedback } from './journey-feedback.js';
import { query, queryOne } from '../db/client.js';

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
