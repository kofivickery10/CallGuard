// ============================================================
// Retry policy for reconciliation runs waiting on an application document.
//
// The pack is attached to the CRM record by hand, after the call: usually the
// same day, and for a sale made late in the day, the next morning. Scoring
// finishes minutes after the last call, so the first attempt on almost every
// sale legitimately finds nothing. 'needs_document' is early, not wrong.
//
// So the run has to be revisited — but not indefinitely. Every attempt lists the
// sale's attachments and downloads each candidate to see whether it parses
// against a known profile, and a sale whose pack never arrives (cancelled, or
// handled off-system) would spend that CRM API budget for ever.
//
// Hence a decaying cadence: often while the document is most likely to appear,
// sparse after that, then a hard stop. Pure functions, so the policy is testable
// without a database or a clock.
// ============================================================

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * After this long with no document we stop looking.
 *
 * Set well beyond the observed lag (hours, worst case next morning) so an
 * ordinary delay — someone off sick, a bank holiday — never abandons a sale that
 * would have resolved. It is a backstop against sales whose pack is never coming,
 * not a deadline for the team.
 */
export const ABANDON_AFTER_MS = 7 * DAY;

/**
 * How often to re-check, by how long the run has been waiting.
 *
 * The first tier carries the real load: a same-day upload is caught within half
 * an hour of landing, and a next-morning one within half an hour of that.
 */
const TIERS: Array<{ untilAgeMs: number; everyMs: number }> = [
  { untilAgeMs: DAY, everyMs: 30 * MINUTE },
  { untilAgeMs: 3 * DAY, everyMs: 2 * HOUR },
  { untilAgeMs: ABANDON_AFTER_MS, everyMs: 12 * HOUR },
];

/**
 * How long a run may sit at 'running' before we accept the attempt is not coming
 * back and re-enqueue it.
 *
 * A reconcile attempt is a document download, a parse and one model call on a
 * single excerpt set: minutes, not tens of minutes. Past this, the worker died
 * mid-flight and the row is stranded, because nothing else revisits it.
 */
export const STALE_RUNNING_MS = 30 * MINUTE;

/**
 * How many attempts in a row may end in an unexpected error before we stop
 * re-attempting a run.
 *
 * 'failed' is only ever written by the reconcile processor's catch block —
 * every anticipated outcome has its own status — so it means "something went
 * wrong this time", and the cause is usually transient. Such a run has to be
 * revisited, or one bad attempt parks the sale for ever.
 *
 * Twelve, against the first tier's half-hourly cadence, is roughly six hours of
 * retrying: comfortably longer than a CRM outage or a bad deploy, and short of
 * spending the whole seven-day window on a run that errors every time. The
 * counter is consecutive, not cumulative, and any other outcome resets it, so a
 * run that waits days for its document still has its full allowance if it later
 * hits a real error.
 */
export const MAX_FAILURE_STREAK = 12;

/**
 * Whether a run that errored should be attempted again.
 *
 * Past the cap we stop, but deliberately leave the run at 'failed' with the
 * error that caused it rather than abandoning it: that error is the honest thing
 * to show someone looking at the sale, and it is what tells us what to fix.
 * The abandon window still closes over it in the end.
 */
export function isRetryableFailure(failureStreak: number): boolean {
  return failureStreak < MAX_FAILURE_STREAK;
}

/** The retry interval for a run of this age, or null once it should be abandoned. */
export function retryIntervalMs(ageMs: number): number | null {
  for (const tier of TIERS) {
    if (ageMs < tier.untilAgeMs) return tier.everyMs;
  }
  return null;
}

export function isPastAbandonWindow(now: Date, createdAt: Date): boolean {
  return now.getTime() - createdAt.getTime() >= ABANDON_AFTER_MS;
}

/**
 * Whether a waiting run should be re-attempted now.
 *
 * A run that has never been attempted is always due: it was created by the sweep
 * itself, or by scoring, and has not yet looked for its document.
 */
export function isDueForRetry(
  now: Date,
  createdAt: Date,
  lastAttemptAt: Date | null
): boolean {
  const interval = retryIntervalMs(now.getTime() - createdAt.getTime());
  if (interval === null) return false;
  if (lastAttemptAt === null) return true;
  return now.getTime() - lastAttemptAt.getTime() >= interval;
}

/**
 * The BullMQ job id for one attempt at a run.
 *
 * Attempt-scoped deliberately. The scoring queue keeps its last 100 completed
 * jobs, so reusing `reconcile-<run id>` would have every retry silently deduped
 * against the attempt that already ran. Including the attempt counter also keeps
 * the useful half of that dedupe: two sweep ticks racing before the run is
 * processed produce the same id, and the second is correctly dropped.
 */
export function attemptJobId(runId: string, attempts: number): string {
  return `reconcile-${runId}-a${attempts}`;
}
