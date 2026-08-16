import { describe, it, expect } from 'vitest';
import { shouldSkipFile, nextErrorState, MAX_FILE_ATTEMPTS } from './sftp-poll.js';

describe('shouldSkipFile', () => {
  it('never re-touches a successfully processed file', () => {
    // The idempotency guarantee: a file already ingested must not be
    // re-ingested and duplicated, however many times the poller sees it again.
    expect(shouldSkipFile({ id: '1', status: 'processed', attempt_count: 1 })).toBe(true);
  });

  it('is attempted the first time it is seen', () => {
    expect(shouldSkipFile(null)).toBe(false);
  });

  it('retries a file that previously errored', () => {
    expect(shouldSkipFile({ id: '1', status: 'errored', attempt_count: 1 })).toBe(false);
    expect(shouldSkipFile({ id: '1', status: 'errored', attempt_count: MAX_FILE_ATTEMPTS - 1 })).toBe(false);
  });

  it('leaves an abandoned file alone until an operator resets it', () => {
    expect(shouldSkipFile({ id: '1', status: 'abandoned', attempt_count: MAX_FILE_ATTEMPTS })).toBe(true);
  });
});

describe('nextErrorState', () => {
  it('stays errored (and so retryable) below the attempt cap', () => {
    expect(nextErrorState(0)).toEqual({ status: 'errored', attemptCount: 1 });
    expect(nextErrorState(MAX_FILE_ATTEMPTS - 2)).toEqual({
      status: 'errored',
      attemptCount: MAX_FILE_ATTEMPTS - 1,
    });
  });

  it('gives up once the cap is reached, rather than retrying for ever', () => {
    expect(nextErrorState(MAX_FILE_ATTEMPTS - 1)).toEqual({
      status: 'abandoned',
      attemptCount: MAX_FILE_ATTEMPTS,
    });
  });

  it('stays abandoned on any further failure past the cap', () => {
    expect(nextErrorState(MAX_FILE_ATTEMPTS)).toEqual({
      status: 'abandoned',
      attemptCount: MAX_FILE_ATTEMPTS + 1,
    });
  });
});

describe('the retry loop, end to end via the two helpers', () => {
  it('honours the attempt cap: MAX_FILE_ATTEMPTS consecutive failures then abandons, and abandonment stops retrying', () => {
    let existing: { id: string; status: 'processed' | 'errored' | 'abandoned'; attempt_count: number } | null = null;

    for (let attempt = 1; attempt <= MAX_FILE_ATTEMPTS; attempt++) {
      expect(shouldSkipFile(existing)).toBe(false);
      const { status, attemptCount } = nextErrorState(existing?.attempt_count ?? 0);
      existing = { id: '1', status, attempt_count: attemptCount };
    }

    expect(existing).toEqual({ id: '1', status: 'abandoned', attempt_count: MAX_FILE_ATTEMPTS });
    // The poll after the cap is hit must not attempt the file again automatically.
    expect(shouldSkipFile(existing)).toBe(true);
  });

  it('a file that succeeds is never retried again, even after a prior error', () => {
    const existing = { id: '1', status: 'errored' as const, attempt_count: 2 };
    expect(shouldSkipFile(existing)).toBe(false);
    // Simulate the success path in processSFTPPoll: status flips to 'processed'.
    const afterSuccess = { id: '1', status: 'processed' as const, attempt_count: existing.attempt_count + 1 };
    expect(shouldSkipFile(afterSuccess)).toBe(true);
  });
});
