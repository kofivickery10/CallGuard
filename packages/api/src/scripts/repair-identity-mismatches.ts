// Retire findings from runs that compared two different people.
//
// The guard in reconcile.ts stops this happening from now on. It cannot help the
// runs that already finished: their findings are on screen, on an adviser's
// record, and in the breach counts, and nothing about them is true.
//
// So this re-reads every completed run's own stored identity items through the
// same checkIdentity used live — not a hardcoded list of sales — and repairs the
// ones that contradict. Deriving it from the function rather than a list means
// this finds sales nobody noticed, and means the repair and the guard can never
// disagree about what counts.
//
// It does NOT re-run anything. There is nothing to re-read: the document and the
// call are both fine, the pairing between them is wrong, and re-running would
// re-match on the same phone number and reach the same place. A person has to
// decide which call belongs to the sale.
//
// WHAT IT DELIBERATELY LEAVES ALONE
//
// The journey's score. A score measures adviser conduct on a call, and the call
// is a real call — a real adviser really did conduct it. What is wrong is which
// customer and which CRM record it is filed against, which is a different
// problem with a different owner, and on at least one sale the failing
// checkpoint was confirmed by a human reviewer. Deleting that would discard
// their work to fix a labelling error.
//
// The Zoho write-back, for the same reason plus a harder one: nothing here can
// see whether a push succeeded, so blanking a field in a client's CRM on a guess
// is not a repair.
//
// Usage:
//   tsx src/scripts/repair-identity-mismatches.ts "Trust Point"           # dry run
//   tsx src/scripts/repair-identity-mismatches.ts "Trust Point" --commit
import { pool, query, queryOne } from '../db/client.js';
import {
  checkIdentity,
  identityRoleOf,
  type IdentityCheckInput,
} from '../services/reconciliation-identity.js';

interface ItemRow {
  question: string;
  application_answer: string | null;
  call_answer: string | null;
  outcome: string;
}

async function main(): Promise<void> {
  const orgArg = process.argv[2] ?? 'Trust Point';
  const commit = process.argv.includes('--commit');

  const org = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE name ILIKE $1 LIMIT 1`,
    [`%${orgArg}%`]
  );
  if (!org) {
    console.log(`No organization matching "${orgArg}"`);
    return;
  }
  console.log(`\n${org.name}${commit ? '' : '   (dry run — pass --commit to write)'}\n`);

  const runs = await query<{
    id: string;
    journey_id: string;
    client_name: string | null;
    customer_name: string | null;
  }>(
    `SELECT r.id, r.journey_id, j.client_name, c.name AS customer_name
       FROM capture_reconciliation_runs r
       JOIN journeys j ON j.id = r.journey_id
       LEFT JOIN customers c ON c.id = j.customer_id
      WHERE r.organization_id = $1 AND r.status = 'completed'
      ORDER BY r.created_at`,
    [org.id]
  );

  let repaired = 0;
  let itemsRetired = 0;
  let findingsRetired = 0;

  for (const run of runs) {
    const items = await query<ItemRow>(
      `SELECT question, application_answer, call_answer, outcome
         FROM capture_reconciliation_items WHERE run_id = $1`,
      [run.id]
    );

    const inputs: IdentityCheckInput[] = items.flatMap((i) => {
      const role = identityRoleOf(i.question);
      return role === null
        ? []
        : [
            {
              role,
              question: i.question,
              applicationAnswer: i.application_answer,
              callAnswer: i.call_answer,
            },
          ];
    });

    const verdict = checkIdentity(inputs);
    if (!verdict.aborts) continue;

    // Findings are what actually reached a person, so they are counted
    // separately from the total — "6 accusations withdrawn" is the number that
    // matters, not "19 rows deleted".
    const findings = items.filter((i) =>
      ['mismatch', 'not_asked', 'asked_no_answer', 'missing_from_application'].includes(i.outcome)
    ).length;

    repaired++;
    itemsRetired += items.length;
    findingsRetired += findings;

    console.log(`  sale ${run.journey_id.slice(0, 8)}  ${run.client_name ?? '(no CRM name)'}`);
    if (run.client_name && run.customer_name && run.client_name !== run.customer_name) {
      console.log(`      CRM says "${run.client_name}", the call is filed under "${run.customer_name}"`);
    }
    console.log(`      ${verdict.dobGapDays} days apart — ${items.length} items, ${findings} of them findings`);

    if (commit) {
      await query('DELETE FROM capture_reconciliation_items WHERE run_id = $1', [run.id]);
      await query(
        `UPDATE capture_reconciliation_runs
            SET status = 'identity_mismatch', error_message = $2, completed_at = now()
          WHERE id = $1`,
        [run.id, verdict.message]
      );
    }
  }

  console.log(
    `\n${runs.length} completed run(s) examined. ` +
      `${repaired} about different people: ${itemsRetired} items, ${findingsRetired} findings ` +
      `${commit ? 'retired' : 'would be retired'}.`
  );
  if (repaired > 0 && !commit) console.log('Re-run with --commit to apply.\n');
  else console.log('');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
