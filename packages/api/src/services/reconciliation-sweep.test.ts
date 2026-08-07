import { describe, it, expect } from 'vitest';
import {
  isDueForRetry,
  isPastAbandonWindow,
  isRetryableFailure,
  retryIntervalMs,
  attemptJobId,
  ABANDON_AFTER_MS,
  MAX_FAILURE_STREAK,
  STALE_RUNNING_MS,
} from './reconciliation-sweep.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Fixed clock — the policy is pure, so the tests state times rather than sleep. */
const NOW = new Date('2026-08-05T14:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('retryIntervalMs', () => {
  it('checks every half hour on the first day, when the pack usually arrives', () => {
    expect(retryIntervalMs(0)).toBe(30 * MINUTE);
    expect(retryIntervalMs(6 * HOUR)).toBe(30 * MINUTE);
    // The observed worst case: a sale made late in the day, uploaded next morning.
    expect(retryIntervalMs(20 * HOUR)).toBe(30 * MINUTE);
  });

  it('backs off after the first day, and again after the third', () => {
    expect(retryIntervalMs(DAY)).toBe(2 * HOUR);
    expect(retryIntervalMs(2 * DAY)).toBe(2 * HOUR);
    expect(retryIntervalMs(3 * DAY)).toBe(12 * HOUR);
    expect(retryIntervalMs(6 * DAY)).toBe(12 * HOUR);
  });

  it('stops entirely at the abandon window', () => {
    expect(retryIntervalMs(ABANDON_AFTER_MS)).toBeNull();
    expect(retryIntervalMs(ABANDON_AFTER_MS + DAY)).toBeNull();
  });

  it('leaves room for an ordinary human delay before giving up', () => {
    // The point of the window: someone off sick for a few days must not cause a
    // sale to be abandoned before anyone could have uploaded the pack.
    expect(retryIntervalMs(5 * DAY)).not.toBeNull();
  });
});

describe('isDueForRetry', () => {
  it('is due immediately when it has never been attempted', () => {
    expect(isDueForRetry(NOW, ago(MINUTE), null)).toBe(true);
  });

  it('holds off until the interval has passed', () => {
    const created = ago(2 * HOUR);
    expect(isDueForRetry(NOW, created, ago(10 * MINUTE))).toBe(false);
    expect(isDueForRetry(NOW, created, ago(29 * MINUTE))).toBe(false);
    expect(isDueForRetry(NOW, created, ago(31 * MINUTE))).toBe(true);
  });

  it('uses the interval for the run\'s age, not the first tier', () => {
    // Two days old: half an hour since the last look is not enough any more.
    const created = ago(2 * DAY);
    expect(isDueForRetry(NOW, created, ago(45 * MINUTE))).toBe(false);
    expect(isDueForRetry(NOW, created, ago(3 * HOUR))).toBe(true);
  });

  it('never retries a run past the abandon window, however long since the last look', () => {
    const created = ago(ABANDON_AFTER_MS + HOUR);
    expect(isDueForRetry(NOW, created, ago(30 * DAY))).toBe(false);
    expect(isDueForRetry(NOW, created, null)).toBe(false);
  });

  it('treats the interval boundary as due, so a tick is never skipped by a millisecond', () => {
    expect(isDueForRetry(NOW, ago(HOUR), ago(30 * MINUTE))).toBe(true);
  });
});

describe('isPastAbandonWindow', () => {
  it('is false while the document could still legitimately arrive', () => {
    expect(isPastAbandonWindow(NOW, ago(HOUR))).toBe(false);
    expect(isPastAbandonWindow(NOW, ago(6 * DAY))).toBe(false);
  });

  it('is true once the window has closed', () => {
    expect(isPastAbandonWindow(NOW, ago(ABANDON_AFTER_MS))).toBe(true);
    expect(isPastAbandonWindow(NOW, ago(ABANDON_AFTER_MS + DAY))).toBe(true);
  });
});

describe('STALE_RUNNING_MS', () => {
  it('is longer than an attempt legitimately takes, so an in-flight run is not trampled', () => {
    // A reconcile attempt is a download, a parse and one model call. Minutes.
    expect(STALE_RUNNING_MS).toBeGreaterThanOrEqual(10 * MINUTE);
  });

  it('is short enough that a dead worker does not strand a sale for long', () => {
    expect(STALE_RUNNING_MS).toBeLessThanOrEqual(2 * HOUR);
  });
});

describe('attemptJobId', () => {
  it('changes per attempt, so a retry is not deduped against the attempt that already ran', () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    expect(attemptJobId(runId, 0)).not.toBe(attemptJobId(runId, 1));
  });

  it('is stable within an attempt, so two sweep ticks racing enqueue once', () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    expect(attemptJobId(runId, 3)).toBe(attemptJobId(runId, 3));
  });

  it('keeps the run id findable in the job id', () => {
    const runId = '22222222-2222-4222-8222-222222222222';
    expect(attemptJobId(runId, 2)).toContain(runId);
  });
});

describe('isRetryableFailure', () => {
  it('re-attempts a run that has just errored, because the cause is usually transient', () => {
    // The case this exists for: a CRM API change failed every sale in a tenant
    // at once. Before this, none of them recovered after the fix shipped.
    expect(isRetryableFailure(0)).toBe(true);
    expect(isRetryableFailure(1)).toBe(true);
  });

  it('gives up on a run that has errored on every recent attempt', () => {
    expect(isRetryableFailure(MAX_FAILURE_STREAK)).toBe(false);
    expect(isRetryableFailure(MAX_FAILURE_STREAK + 5)).toBe(false);
  });

  it('allows enough retries to outlast an outage of several hours', () => {
    // Consecutive failures at the first tier's cadence. An outage shorter than
    // this must not be able to exhaust a run's allowance.
    const firstTierInterval = retryIntervalMs(HOUR)!;
    expect(MAX_FAILURE_STREAK * firstTierInterval).toBeGreaterThanOrEqual(4 * HOUR);
  });

  it('gives up well before the abandon window, so a broken run stops costing CRM calls', () => {
    const firstTierInterval = retryIntervalMs(HOUR)!;
    expect(MAX_FAILURE_STREAK * firstTierInterval).toBeLessThan(ABANDON_AFTER_MS);
  });
});
