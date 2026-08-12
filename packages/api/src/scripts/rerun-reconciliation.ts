// Re-run the Data Forms check on sales that already finished.
//
// WHY THIS EXISTS
//
// A finished reconciliation run is terminal, and deliberately so: the sweep must
// not keep re-reading a sale it has already answered. But that means an
// improvement to HOW sales are judged reaches only sales judged after it ships.
// Every sale checked before it keeps the old verdict for ever, and nothing
// anywhere says the verdict is stale.
//
// That is fine for one sale (the admin re-run on the sale page) and useless for
// a tenant's whole history, which is exactly when a judgement change matters
// most — you ship a fix for a false-positive storm and the storm stays on
// screen.
//
// WHAT IT DOES
//
// The same thing the admin re-run does, in bulk: delete the run and create a
// fresh one. Deleting is what the route does too, and it is the right shape —
// a run is one-per-sale, so keeping the old row alongside a new one would leave
// two sets of items with no way to tell which is current.
//
// THE PRICE, STATED PLAINLY: the existing items are deleted with the run
// (ON DELETE CASCADE), including any a human has already reviewed. On a tenant
// where somebody has worked through the queue, that review is lost. Dry run
// says how many items are at stake before anything happens.
//
// Needs the worker running against the same Redis: this enqueues, the worker
// does the work.
//
// --in-process does the work HERE instead, and exists for one specific
// situation: measuring a judgement change before it is deployed. Enqueueing
// sends the job to whichever worker is running, which in that situation is the
// DEPLOYED one on the OLD build — so the results come back from the code you are
// trying to measure against, silently, and look like a finished re-run. Serial
// and slower, which is the right trade for a sample of a few sales.
//
// Usage:
//   tsx src/scripts/rerun-reconciliation.ts "Trust Point"            # dry run
//   tsx src/scripts/rerun-reconciliation.ts "Trust Point" --commit
//   tsx src/scripts/rerun-reconciliation.ts "Trust Point" --commit --include-abandoned
//   tsx src/scripts/rerun-reconciliation.ts "Trust Point" --commit --limit=5
//   tsx src/scripts/rerun-reconciliation.ts "Trust Point" --commit --limit=5 --in-process
import type { Job } from 'bullmq';
import { pool, query, queryOne } from '../db/client.js';
import { scoringQueue } from '../jobs/queue.js';
import { attemptJobId } from '../services/reconciliation-sweep.js';
import { processReconcile } from '../jobs/processors/reconcile.js';
import { recordAuditEvent } from '../services/audit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which runs are worth re-running.
 *
 * Only the terminal ones. A sale at 'needs_document' or 'needs_profile' is
 * already being revisited by the sweep on its own cadence, and re-running it
 * would reset its created_at — restarting the clock on a sale that has been
 * waiting for days, and moving the abandon window it is meant to be measured
 * against. 'failed' is left alone for the same reason: the sweep retries it,
 * and its failure_streak is the record of how many times.
 */
const DEFAULT_STATUSES = ['completed', 'summary_only'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--')) ?? null;
  const commit = args.includes('--commit');
  const includeAbandoned = args.includes('--include-abandoned');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;
  const inProcess = args.includes('--in-process');

  if (!target) {
    console.error('Usage: tsx src/scripts/rerun-reconciliation.ts <orgId|nameSubstring> [--commit]');
    process.exitCode = 1;
    return;
  }

  const org = await queryOne<{ id: string; name: string; reconciliation_enabled: boolean }>(
    `SELECT id, name, reconciliation_enabled FROM organizations
      WHERE ${UUID_RE.test(target) ? 'id = $1' : 'name ILIKE $1'}
      ORDER BY name LIMIT 1`,
    [UUID_RE.test(target) ? target : `%${target}%`]
  );
  if (!org) {
    console.error(`No organisation matching "${target}".`);
    process.exitCode = 1;
    return;
  }
  if (!org.reconciliation_enabled) {
    // Re-running would create rows the sweep then ignores, leaving the tenant
    // worse off than before: sales stuck at 'pending' with nothing to move them.
    console.error(`${org.name} does not have the reconciliation module enabled — nothing to do.`);
    process.exitCode = 1;
    return;
  }

  const statuses = includeAbandoned ? [...DEFAULT_STATUSES, 'abandoned'] : DEFAULT_STATUSES;

  const runs = await query<{
    id: string;
    journey_id: string;
    status: string;
    extraction_method: string;
    attachment_name: string | null;
    items: number;
  }>(
    `SELECT r.id, r.journey_id, r.status, r.extraction_method, r.attachment_name,
            (SELECT count(*)::int FROM capture_reconciliation_items i WHERE i.run_id = r.id) AS items
       FROM capture_reconciliation_runs r
       JOIN journeys j ON j.id = r.journey_id
      WHERE r.organization_id = $1
        AND r.status = ANY($2::text[])
        AND j.zoho_record_id IS NOT NULL
      ORDER BY r.completed_at DESC NULLS LAST
      ${limit ? `LIMIT ${Number(limit)}` : ''}`,
    [org.id, statuses]
  );

  // Is anything these sales depend on still being transcribed?
  //
  // Re-checking reads the transcripts as they stand right now. Do it while a
  // re-transcription is draining — precisely when someone reaches for this
  // script, having just changed the redaction settings — and half the sales are
  // compared against the old text and have to be done again. Easy to get wrong,
  // invisible when you do, so it is checked here rather than left to whoever
  // remembers to watch the log.
  //
  // Scoped to the calls belonging to the sales being re-checked, and to the two
  // statuses that genuinely mean "on its way to a transcript".
  //
  // Both narrowings are load-bearing. Asking instead for calls that are not
  // settled, across the whole tenant, reported 2,545 in flight on a tenant with
  // 54 to re-transcribe: 'captured' is a metadata-only row from a dialler
  // webhook, holding a recording pointer with no audio, and it stays that way
  // unless a sale trigger claims it. That is a resting state, not a queue, and
  // counting it would have blocked this script for ever on any tenant with a
  // dialler connected.
  const inFlight = await query<{ status: string; n: number }>(
    `SELECT c.status, count(*)::int AS n
       FROM calls c
       JOIN journey_calls jc ON jc.call_id = c.id
      WHERE jc.journey_id = ANY($1::uuid[])
        AND c.status IN ('uploaded', 'transcribing')
      GROUP BY 1 ORDER BY 2 DESC`,
    [runs.map((r) => r.journey_id)]
  );
  const inFlightCount = inFlight.reduce((n, r) => n + r.n, 0);

  console.log(`\n${org.name}`);
  console.log(`Statuses: ${statuses.join(', ')}`);
  console.log(`Runs to re-check: ${runs.length}`);
  if (inFlightCount > 0) {
    console.log(
      `\n  !! ${inFlightCount} call(s) on these sales are still on their way to a transcript ` +
        `(${inFlight.map((r) => `${r.n} ${r.status}`).join(', ')}).\n` +
        '     Re-checking now compares those sales against the transcripts as they are\n' +
        '     at this moment, so any that finish afterwards would need doing again.\n' +
        '     Wait for the transcription queue to drain, then re-run this.'
    );
  }
  const itemsAtStake = runs.reduce((n, r) => n + r.items, 0);
  console.log(`Existing items that will be deleted and rebuilt: ${itemsAtStake}\n`);

  if (runs.length === 0) return;

  for (const r of runs) {
    console.log(
      `  ${r.status.padEnd(13)} ${r.extraction_method.padEnd(8)} ` +
        `${String(r.items).padStart(3)} items  ${r.attachment_name ?? '—'}`
    );
  }

  if (!commit) {
    console.log(`\nDry run — nothing changed. Add --commit to re-check these ${runs.length} sale(s).`);
    return;
  }

  // Refused rather than warned. The cost of going ahead is doing the whole thing
  // again — deleting and rebuilding every item a second time — and by then the
  // person who ran it has moved on and is reading numbers built against text
  // that has since changed underneath them.
  if (inFlightCount > 0 && !args.includes('--force')) {
    console.error(
      `\nRefusing: ${inFlightCount} call(s) on these sales are still in transcription. Wait for the queue to\n` +
        'drain so every sale is checked against its final transcript. Pass --force to\n' +
        'override if you know these calls are stuck rather than working.'
    );
    process.exitCode = 1;
    return;
  }

  // Sales with no CRM record are already excluded above: re-running one would
  // create a run whose only possible outcome is 'abandoned' on first attempt.
  let enqueued = 0;
  for (const r of runs) {
    try {
      await query('DELETE FROM capture_reconciliation_runs WHERE id = $1', [r.id]);
      const created = await queryOne<{ id: string }>(
        `INSERT INTO capture_reconciliation_runs (organization_id, journey_id, status)
         VALUES ($1, $2, 'pending') RETURNING id`,
        [org.id, r.journey_id]
      );
      if (!created) {
        console.warn(`  ! could not recreate the run for journey ${r.journey_id}`);
        continue;
      }
      if (inProcess) {
        // The processor only reads job.data.runId. Cast rather than fabricate a
        // whole BullMQ Job: inventing the other fields would be inventing state
        // the processor might one day rely on, and a cast at least fails loudly
        // if that day comes.
        await processReconcile({ data: { runId: created.id } } as Job<{ runId: string }>);
        console.log(`  · rebuilt ${r.journey_id}`);
      } else {
        await scoringQueue.add(
          'reconcile',
          { runId: created.id },
          { jobId: attemptJobId(created.id, 0) }
        );
      }
      enqueued++;
    } catch (err) {
      // One sale failing must not abandon the rest of the batch half-done.
      console.warn(`  ! journey ${r.journey_id}: ${(err as Error).message}`);
    }
  }

  // userId is null: nobody clicked anything, and recording an operator's name
  // against a decision they did not make is worse than recording none.
  await recordAuditEvent({
    organizationId: org.id,
    userId: null,
    actionType: 'reconciliation.run',
    entityType: 'organization',
    entityId: org.id,
    summary: `Bulk re-check of ${enqueued} sale(s) via rerun-reconciliation script`,
    metadata: { statuses, requested: runs.length, enqueued, itemsDeleted: itemsAtStake, inProcess },
  });

  console.log(`\nRe-checked ${enqueued} of ${runs.length} sale(s).`);
  if (inProcess) {
    console.log('Done here, in this process — the results are already written.');
  } else {
    console.log('The worker processes these from the scoring queue — watch its log for');
    console.log('"[Reconciliation] Run … completed", then re-run dataforms-status.ts.');
  }
}

main()
  .catch((err) => {
    console.error('Failed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    // The queue wrapper exposes no close, so BullMQ's Redis socket stays open
    // and would hold the process up indefinitely. Everything this script does is
    // already committed by here — the jobs are on the queue and the audit row is
    // written — so exiting outright is safe and is the only way it ends.
    process.exit(process.exitCode ?? 0);
  });
