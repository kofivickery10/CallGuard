import { Job } from 'bullmq';
import { query } from '../../db/client.js';
import { scoringQueue } from '../queue.js';
import { maybeStartReconciliation } from '../../services/reconciliation-runs.js';
import {
  isDueForRetry,
  isDueForParkedRetry,
  isPastAbandonWindow,
  isRetryableFailure,
  attemptJobId,
  ABANDON_AFTER_MS,
  STALE_RUNNING_MS,
  isHeldTooLong,
} from '../../services/reconciliation-sweep.js';
import { notify, recipientsByRole } from '../../services/notify.js';

// ============================================================
// Reconciliation sweep ('reconciliation-sweep' on the maintenance queue).
//
// Reconciliation cannot be a one-shot at score time, because the document it
// needs does not exist yet: the application pack is attached to the CRM record by
// hand after the call, usually the same day and sometimes the next morning. A
// single attempt would leave every sale parked at 'needs_document' for ever, which
// reads as "checked, found nothing" to anyone looking at the screen.
//
// So this does two things on a cadence: starts runs for scored sales that have
// none, and re-attempts runs still waiting for their document — then abandons the
// ones that have waited too long, so the CRM API budget is not spent for ever on
// a sale whose pack is never coming.
//
// The cadence itself lives in services/reconciliation-sweep.ts.
// ============================================================

export interface ReconciliationSweepResult {
  started: number;
  retried: number;
  abandoned: number;
  heldNotified: number;
}

/**
 * Mention a proposed format that has been waiting alone.
 *
 * A format goes live when a SECOND sale independently produces it, so one seen
 * only once waits — correctly, since a document agreeing with itself is not
 * evidence. For a format the firm writes regularly the wait is a day or two and
 * resolves itself. For a rare insurer the second sale may never come, and until
 * now nothing was ever going to say so: the sales on it simply stayed unchecked,
 * and a module that is quiet when it is working looked exactly the same as one
 * that is quiet because it is stuck.
 *
 * Once per profile, recorded on the row. The notification's own dedupe key only
 * suppresses repeats while the earlier one is unread, so relying on it would
 * raise this again on every tick from the moment somebody read it.
 */
async function noticeHeldProfiles(now: Date): Promise<number> {
  const held = await query<{
    id: string;
    organization_id: string;
    insurer: string;
    product: string | null;
    created_at: string;
    corroborating_journeys: string[];
  }>(
    `SELECT id, organization_id, insurer, product, created_at, corroborating_journeys
       FROM capture_document_profiles
      WHERE status = 'needs_confirmation' AND held_notified_at IS NULL
      ORDER BY created_at ASC
      LIMIT 100`
  );

  let notified = 0;
  for (const profile of held) {
    if (!isHeldTooLong(now, new Date(profile.created_at))) continue;

    // Stamped before sending. A notification that fails must not leave the row
    // eligible to try again on every tick from now on — the reminder is worth
    // losing, the loop is not.
    await query(
      'UPDATE capture_document_profiles SET held_notified_at = now() WHERE id = $1',
      [profile.id]
    );

    try {
      const recipients = await recipientsByRole(profile.organization_id, ['admin']);
      if (recipients.length === 0) continue;
      const seen = profile.corroborating_journeys?.length ?? 1;
      await notify({
        organizationId: profile.organization_id,
        recipients,
        type: 'dataforms.needs_attention',
        severity: 'warning',
        title: `A document format has been waiting for a second sale`,
        body:
          `CallGuard read ${profile.insurer}${profile.product ? ` — ${profile.product}` : ''} from ` +
          `${seen === 1 ? 'one sale' : `${seen} sales`} and has been waiting for another to confirm it against. ` +
          'Sales on this format are not being checked until it goes live. Confirm it yourself if you ' +
          'are happy with the questions it found.',
        actionUrl: `/data-forms/profiles/${profile.id}`,
        dedupeKey: `dataforms-held-${profile.id}`,
      });
      notified++;
    } catch (err) {
      console.warn(
        `[Reconciliation sweep] could not notify about held profile ${profile.id}: ${(err as Error).message}`
      );
    }
  }
  return notified;
}

/** Cap per tick. A backlog drains over several ticks rather than in one burst of CRM calls. */
const MAX_STARTS_PER_TICK = 200;
const MAX_RETRIES_PER_TICK = 200;

interface WaitingRun {
  id: string;
  status: string;
  attempts: number;
  failure_streak: number;
  created_at: string;
  last_attempt_at: string | null;
}

/**
 * The states a run can be re-attempted from.
 *
 * 'failed' belongs here, unobviously. It is written only by the reconcile
 * processor's catch block — every anticipated outcome has its own status — so it
 * is an unexpected error on one attempt, and usually a transient one. Leaving it
 * out is how a CRM API change stranded an entire tenant's sales permanently.
 */
export const RETRYABLE_STATUSES = [
  'needs_document',
  'pending',
  'running',
  'failed',
  // 'needs_profile' was deliberately excluded, and the reasoning was sound at
  // the time: re-downloading and re-parsing a document nothing recognised could
  // only ever reach the same conclusion, so a retry was pure spend against the
  // CRM's API budget. What it needed was a person, once.
  //
  // Auto-proposing changed what a retry accomplishes, and the exclusion was not
  // revisited with it. The consequence was total: 13 sales already parked here
  // were never re-enqueued, so the processor that now proposes a format never
  // ran for a single one of them. The feature worked only for sales that had
  // yet to be scored, which on this tenant was none.
  //
  // The cost that justified the exclusion does not return, because
  // learnProfileFromSale tests a document against already-proposed formats
  // BEFORE reaching for the model. The first sale on a format pays for a model
  // pass; every other sale on that same format matches the pending proposal and
  // pays nothing. So a backlog costs roughly one pass per distinct format, not
  // one per sale.
  'needs_profile',
];

/**
 * Statuses the abandon window closes over.
 *
 * 'needs_profile' is deliberately NOT among them, and this is the one place the
 * two lists must differ. Abandoning means "we stopped trying, and the document
 * is never coming" — true of a pack nobody uploaded, false of a sale that is
 * only waiting for a format to go live. Worse, confirming a format requeues runs
 * WHERE status = 'needs_profile', so abandoning one would quietly put it beyond
 * the reach of the very act that was going to fix it.
 *
 * Nothing waits silently as a result: a proposal alone for three days raises a
 * notice, and a pack no format could be made of raises one immediately.
 */
export const ABANDONABLE_STATUSES = ['needs_document', 'pending', 'running', 'failed'];

export async function processReconciliationSweep(
  _job?: Job
): Promise<ReconciliationSweepResult> {
  const result: ReconciliationSweepResult = { started: 0, retried: 0, abandoned: 0, heldNotified: 0 };
  const now = new Date();

  // ── Stop waiting on runs past the window ────────────────────────────────────
  // Done first so the same tick does not also retry them. The message is written
  // for the person reading the sale, not for a log: it says what we did and what
  // would change it.
  // 'pending' and 'running' are included so a run whose job never landed, or whose
  // worker died mid-attempt, cannot sit in a non-terminal state for ever: past the
  // window nothing retries it, so without this it would be stranded silently.
  // 'failed' is included for the same reason, but its message keeps the error
  // that caused it: that is what tells whoever looks why nothing was checked.
  const abandoned = await query<{ id: string }>(
    `UPDATE capture_reconciliation_runs
        SET status = 'abandoned',
            completed_at = now(),
            error_message = CASE
              WHEN status = 'needs_document' THEN $2
              WHEN status = 'failed'
                THEN $4 || COALESCE(error_message, 'no error was recorded')
              ELSE $3
            END
      WHERE status = ANY($5::text[])
        AND created_at <= now() - ($1 || ' milliseconds')::interval
      RETURNING id`,
    [
      String(ABANDON_AFTER_MS),
      'No application document was attached to this sale in the CRM, so it was never checked. Attach the pack and re-run the check if this sale still needs one.',
      'CallGuard stopped trying to check this sale. Re-run the check if it still needs one.',
      'CallGuard stopped trying to check this sale after repeated errors. Last error: ',
      ABANDONABLE_STATUSES,
    ]
  );
  result.abandoned = abandoned.length;

  // ── Sales scored but never started ──────────────────────────────────────────
  // Normally scoring starts the run itself. This covers the enqueue that failed,
  // the worker that died mid-tick, and sales scored before the feature was
  // enabled for the tenant.
  const unstarted = await query<{ id: string; organization_id: string }>(
    `SELECT j.id, j.organization_id
       FROM journeys j
       JOIN organizations o ON o.id = j.organization_id
      WHERE o.reconciliation_enabled = true
        AND j.status = 'scored'
        AND j.zoho_record_id IS NOT NULL
        AND j.scored_at > now() - ($1 || ' milliseconds')::interval
        AND NOT EXISTS (
              SELECT 1 FROM capture_reconciliation_runs r WHERE r.journey_id = j.id
            )
      ORDER BY j.scored_at DESC
      LIMIT ${MAX_STARTS_PER_TICK}`,
    [String(ABANDON_AFTER_MS)]
  );

  for (const journey of unstarted) {
    try {
      await maybeStartReconciliation(journey.organization_id, journey.id);
      result.started++;
    } catch (err) {
      console.error(
        `[Reconciliation sweep] Could not start a run for journey ${journey.id}:`,
        (err as Error).message
      );
    }
  }

  // ── Runs still waiting for their document, or stranded mid-flight ───────────
  // 'pending' means the row was written but its job never landed. 'running' means
  // an attempt started and never finished. Re-attempting either is safe:
  // processReconcile skips runs that already reached a terminal state, and
  // replaces a run's items wholesale rather than adding to them.
  const waiting = await query<WaitingRun>(
    `SELECT r.id, r.status, r.attempts, r.failure_streak, r.created_at, r.last_attempt_at
       FROM capture_reconciliation_runs r
       JOIN organizations o ON o.id = r.organization_id
      WHERE o.reconciliation_enabled = true
        AND r.status = ANY($1::text[])
      ORDER BY r.last_attempt_at ASC NULLS FIRST
      LIMIT 1000`,
    [RETRYABLE_STATUSES]
  );

  for (const run of waiting) {
    if (result.retried >= MAX_RETRIES_PER_TICK) break;

    const createdAt = new Date(run.created_at);
    // A sale parked for want of a readable format keeps its own, much longer
    // schedule. The abandon window asks "might the document still arrive", which
    // is not this run's problem — its document is already attached and merely
    // unreadable — and applying it here stranded parked runs completely: never
    // abandoned by design, never retried past seven days, so nothing revisited
    // them again. See PARKED_GIVE_UP_MS.
    const parked = run.status === 'needs_profile';
    // Belt and braces: the UPDATE above should have caught these already, but a
    // row created between the two statements must not be retried past its window.
    if (!parked && isPastAbandonWindow(now, createdAt)) continue;

    // A run that has errored on every one of its last several attempts is not
    // going to come good by being asked again on the same cadence, and each
    // attempt costs CRM calls. Stop, and leave the error on display.
    if (run.status === 'failed' && !isRetryableFailure(run.failure_streak)) continue;

    const lastAttemptAt = run.last_attempt_at ? new Date(run.last_attempt_at) : null;

    // Don't trample an attempt that is legitimately still in flight.
    if (
      run.status === 'running' &&
      lastAttemptAt !== null &&
      now.getTime() - lastAttemptAt.getTime() < STALE_RUNNING_MS
    ) {
      continue;
    }

    const due = parked
      ? isDueForParkedRetry(now, createdAt, lastAttemptAt)
      : isDueForRetry(now, createdAt, lastAttemptAt);
    if (!due) continue;

    try {
      await scoringQueue.add(
        'reconcile',
        { runId: run.id },
        { jobId: attemptJobId(run.id, run.attempts) }
      );
      result.retried++;
    } catch (err) {
      console.error(
        `[Reconciliation sweep] Could not re-enqueue run ${run.id}:`,
        (err as Error).message
      );
    }
  }

  result.heldNotified = await noticeHeldProfiles(now);

  if (result.started || result.retried || result.abandoned || result.heldNotified) {
    console.log(
      `[Reconciliation sweep] started ${result.started}, retried ${result.retried}, ` +
        `abandoned ${result.abandoned}, held-format notices ${result.heldNotified}`
    );
  }
  return result;
}
