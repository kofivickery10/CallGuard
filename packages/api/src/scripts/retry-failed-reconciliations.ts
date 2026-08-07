/**
 * Put reconciliation runs that errored back in the queue to be re-attempted.
 *
 * The sweep re-attempts runs on a cadence, so this is not normally needed. It is
 * for the case where the cause of a failure has just been fixed and you do not
 * want to wait: a CRM credential renewed, an API change shipped, a document
 * profile corrected.
 *
 * It works by moving the run back to 'needs_document' and clearing its attempt
 * record, which is the state the sweep looks for. It does not enqueue anything
 * itself — the worker's own sweep does that on its next tick, within half an
 * hour — so it is safe to run from anywhere with database access, and safe to
 * run twice.
 *
 * Items from the previous attempt are left alone: a failed run has none, and a
 * completed run is not touched by this script at all.
 *
 *   npx tsx src/scripts/retry-failed-reconciliations.ts                  # dry run
 *   npx tsx src/scripts/retry-failed-reconciliations.ts --apply
 *   npx tsx src/scripts/retry-failed-reconciliations.ts --org "Trust Point" --apply
 */
import { pool, query, queryOne } from '../db/client.js';

const APPLY = process.argv.includes('--apply');
const orgFlag = process.argv.indexOf('--org');
const ORG_NAME = orgFlag !== -1 ? process.argv[orgFlag + 1] : null;

interface FailedRun {
  id: string;
  organization_id: string;
  org_name: string;
  customer: string | null;
  attempts: number;
  created_at: Date;
  error_message: string | null;
}

async function main() {
  let organizationId: string | null = null;
  if (ORG_NAME) {
    const org = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE name ILIKE $1',
      [`%${ORG_NAME}%`]
    );
    if (!org) throw new Error(`No organisation matching "${ORG_NAME}"`);
    organizationId = org.id;
    console.log(`Scoped to ${org.name}\n`);
  }

  const runs = await query<FailedRun>(
    `SELECT r.id, r.organization_id, o.name AS org_name, cu.name AS customer,
            r.attempts, r.created_at, r.error_message
       FROM capture_reconciliation_runs r
       JOIN organizations o ON o.id = r.organization_id
       JOIN journeys j ON j.id = r.journey_id
       LEFT JOIN customers cu ON cu.id = j.customer_id
      WHERE r.status = 'failed'
        AND o.reconciliation_enabled = true
        AND ($1::uuid IS NULL OR r.organization_id = $1)
      ORDER BY o.name, r.created_at DESC`,
    [organizationId]
  );

  if (runs.length === 0) {
    console.log('No failed reconciliation runs to retry.');
    return;
  }

  // Group by the error, because a batch that failed for one reason is the usual
  // shape of this problem and it is worth seeing that before acting.
  const byError = new Map<string, number>();
  for (const r of runs) {
    const key = (r.error_message ?? 'no error recorded').slice(0, 100);
    byError.set(key, (byError.get(key) ?? 0) + 1);
  }
  console.log(`${runs.length} failed run(s):\n`);
  for (const [err, n] of [...byError].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)} × ${err}`);
  }
  console.log('\nSales:');
  for (const r of runs.slice(0, 30)) {
    console.log(`  ${(r.customer ?? '—').padEnd(28)} ${r.attempts} attempt(s)`);
  }
  if (runs.length > 30) console.log(`  … and ${runs.length - 30} more`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to queue these for another attempt.');
    return;
  }

  // failure_streak arrives in migration 089. Reset it where it exists so a run
  // that exhausted its retries gets a fresh allowance — that is the whole point
  // of asking for this by hand — but still work against a database that has not
  // had 089 applied yet.
  const hasStreak = await queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM information_schema.columns
      WHERE table_name = 'capture_reconciliation_runs' AND column_name = 'failure_streak'`
  );
  const resetStreak = Number(hasStreak?.n ?? 0) > 0 ? ', failure_streak = 0' : '';

  const updated = await query<{ id: string }>(
    `UPDATE capture_reconciliation_runs
        SET status = 'needs_document',
            attempts = 0,
            last_attempt_at = NULL,
            completed_at = NULL,
            error_message = NULL${resetStreak}
      WHERE id = ANY($1::uuid[])
        AND status = 'failed'
      RETURNING id`,
    [runs.map((r) => r.id)]
  );

  console.log(`\nQueued ${updated.length} run(s) for another attempt.`);
  console.log('The worker sweep picks these up on its next tick (within 30 minutes).');
  console.log('They will show as "Waiting for document" until it does.');
}

main()
  .catch((e) => {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
