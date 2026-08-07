/**
 * Erase everything held about one customer: their sales, calls, transcripts and
 * stored audio, and finally the customer record itself.
 *
 * Written for erasure requests, which recur for any regulated firm and are worse
 * done by hand: the FK from calls.customer_id has no ON DELETE clause, so
 * removing the customer before their calls fails outright, and deleting a call
 * row before its audio orphans an encrypted file with nothing left to locate it
 * by. Both orderings are enforced here.
 *
 * DRY RUN BY DEFAULT. Nothing is deleted without --confirm.
 *
 * Deliberately keyed on the customer's UUID, not their name, for the destructive
 * path: a name is not unique, and an ILIKE that matched two people would erase
 * the wrong one silently. Use --find to get the id first.
 *
 * NOTE: this removes the data from CallGuard only. Recordings held by the
 * dialler (CloudTalk) are a separate system and must be erased there too, or the
 * personal data is still live.
 *
 * Usage:
 *   npx tsx src/scripts/delete-customer-data.ts --find "ian young"
 *   npx tsx src/scripts/delete-customer-data.ts --customer <uuid>            # dry run
 *   npx tsx src/scripts/delete-customer-data.ts --customer <uuid> --confirm  # delete
 */

import { pool, query, queryOne } from '../db/client.js';
import { deleteFile } from '../services/storage.js';
import { recordAuditEvent } from '../services/audit.js';

interface CustomerRow {
  id: string;
  organization_id: string;
  name: string | null;
  phone_normalized: string;
  org_name: string;
}

interface CallRow {
  id: string;
  file_key: string | null;
  /** pg returns TIMESTAMPTZ as a Date, not a string. */
  call_date: Date | null;
  agent_name: string | null;
  duration_seconds: string | null;
}

function isoDate(d: Date | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : '(no date)';
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function find(needle: string): Promise<void> {
  const rows = await query<CustomerRow & { call_count: number }>(
    `SELECT c.id, c.organization_id, c.name, c.phone_normalized, c.call_count,
            o.name AS org_name
       FROM customers c JOIN organizations o ON o.id = c.organization_id
      WHERE c.name ILIKE $1
      ORDER BY o.name, c.name`,
    [`%${needle.replace(/\s+/g, '%')}%`]
  );
  if (rows.length === 0) {
    console.log(`No customer matches "${needle}".`);
    return;
  }
  for (const r of rows) {
    console.log(`${r.id}  ${r.name ?? '(no name)'}  ${r.phone_normalized}  — ${r.org_name}`);
  }
  console.log(`\n${rows.length} match(es). Re-run with --customer <id> to see what would be deleted.`);
}

async function main() {
  const needle = arg('--find');
  if (needle) {
    await find(needle);
    return;
  }

  const customerId = arg('--customer');
  const confirmed = process.argv.includes('--confirm');
  if (!customerId) {
    console.error('Pass --customer <uuid> (or --find "<name>" to look one up).');
    process.exitCode = 1;
    return;
  }

  const customer = await queryOne<CustomerRow>(
    `SELECT c.id, c.organization_id, c.name, c.phone_normalized, o.name AS org_name
       FROM customers c JOIN organizations o ON o.id = c.organization_id
      WHERE c.id = $1`,
    [customerId]
  );
  if (!customer) {
    console.error(`No customer with id ${customerId}.`);
    process.exitCode = 1;
    return;
  }

  const journeys = await query<{ id: string; status: string; overall_score: string | null }>(
    'SELECT id, status, overall_score FROM journeys WHERE customer_id = $1',
    [customerId]
  );
  const calls = await query<CallRow>(
    `SELECT id, file_key, call_date, agent_name, duration_seconds
       FROM calls WHERE customer_id = $1 ORDER BY call_date NULLS LAST`,
    [customerId]
  );
  const itemScores = journeys.length
    ? await queryOne<{ n: string }>(
        'SELECT count(*) AS n FROM journey_item_scores WHERE journey_id = ANY($1::uuid[])',
        [journeys.map((j) => j.id)]
      )
    : { n: '0' };

  console.log(`\nCustomer : ${customer.name ?? '(no name)'}  ${customer.phone_normalized}`);
  console.log(`Tenant   : ${customer.org_name}`);
  console.log(`Sales    : ${journeys.length} (${itemScores?.n ?? 0} checkpoint scores)`);
  console.log(`Calls    : ${calls.length}, of which ${calls.filter((c) => c.file_key).length} have stored audio`);
  for (const c of calls) {
    const mins = c.duration_seconds ? `${Math.round(Number(c.duration_seconds) / 60)}m` : '?';
    console.log(`  ${isoDate(c.call_date)}  ${mins.padStart(4)}  ${c.agent_name ?? 'unknown adviser'}  ${c.id}`);
  }

  if (!confirmed) {
    console.log(`
DRY RUN — nothing has been deleted.
Re-run with --confirm to erase all of the above, permanently.
`);
    return;
  }

  console.log('\nDeleting...');

  // 1. Sales first. Cascades journey_item_scores, journey_calls, capture_runs and
  //    capture_reconciliation_runs.
  for (const j of journeys) {
    await query('DELETE FROM journeys WHERE id = $1', [j.id]);
    console.log(`  sale ${j.id} deleted`);
  }

  // 2. Calls: audio BEFORE the row. A storage failure must not be followed by
  //    deleting the row — that would leave the encrypted audio on disk with
  //    nothing left to find it by. Same rule as the retention purge.
  let callsDeleted = 0;
  let audioDeleted = 0;
  const stranded: string[] = [];
  for (const c of calls) {
    if (c.file_key) {
      try {
        await deleteFile(c.file_key);
        audioDeleted++;
      } catch (err) {
        console.error(`  ! audio delete failed for ${c.id}: ${(err as Error).message}`);
        console.error('    leaving the call row in place so the file stays locatable');
        stranded.push(c.id);
        continue;
      }
    }
    await query('DELETE FROM calls WHERE id = $1', [c.id]);
    callsDeleted++;
    console.log(`  call ${c.id} deleted`);
  }

  // 3. The customer record last: calls.customer_id has no ON DELETE clause, so
  //    this fails while any call still references it.
  let customerDeleted = false;
  if (stranded.length === 0) {
    await query('DELETE FROM customers WHERE id = $1', [customer.id]);
    customerDeleted = true;
    console.log(`  customer ${customer.id} deleted`);
  } else {
    console.error(`\n  customer record KEPT — ${stranded.length} call(s) could not be removed.`);
  }

  // 4. Audit. Ids and counts only: putting the person's name in the audit log
  //    would retain the personal data this erasure exists to remove.
  await recordAuditEvent({
    organizationId: customer.organization_id,
    userId: null,
    actionType: 'customer.delete',
    entityType: 'customer',
    entityId: customer.id,
    summary: `Erased all data for customer ${customer.id}: ${journeys.length} sale(s), ${callsDeleted} call(s), ${audioDeleted} audio file(s)`,
    metadata: {
      customer_id: customer.id,
      journeys_deleted: journeys.map((j) => j.id),
      calls_deleted: callsDeleted,
      audio_files_deleted: audioDeleted,
      customer_record_deleted: customerDeleted,
      calls_not_deleted: stranded,
      via: 'scripts/delete-customer-data.ts',
    },
  });

  console.log(`
Done. ${journeys.length} sale(s), ${callsDeleted} call(s), ${audioDeleted} audio file(s) removed.
Audit event written against ${customer.org_name}.

Reminder: the dialler (CloudTalk) holds its own copy of these recordings. Erase
them there too, or the personal data is still live.
`);
}

main()
  .catch((err) => {
    console.error('\nFailed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
