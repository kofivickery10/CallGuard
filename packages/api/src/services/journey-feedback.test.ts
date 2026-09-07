import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashFeedbackToken, lookupFeedback, buildFeedbackSend } from './journey-feedback.js';
import type { FeedbackBreach } from './journey-feedback.js';
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
