import { describe, it, expect } from 'vitest';
import { hashFeedbackToken } from './journey-feedback.js';

// The confirmation endpoint is unauthenticated by necessity — a no-login adviser
// has no session to present — so the token IS the credential. These cover the
// properties that makes safe. The DB-bound paths (send, confirm, adviser
// resolution) need a database and are not unit tested here.

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
