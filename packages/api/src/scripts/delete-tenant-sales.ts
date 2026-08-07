/**
 * Delete a tenant's sales before a cutoff date, optionally with their calls.
 *
 * DRY RUN BY DEFAULT. Nothing is deleted without --confirm.
 *
 * This destroys more than it looks like it does. Deleting a journey cascades to
 * its checkpoint scores, its BREACHES (the compliance register for that sale),
 * its score history, any capture/reconciliation runs, and — the one people do
 * not expect — score_corrections, the human rulings where a supervisor overturned
 * the model. score_corrections.journey_id is ON DELETE CASCADE, so 077's work to
 * make rulings survive a re-score does not save them from the sale being deleted.
 *
 * So the dry run leads with those counts rather than the number of sales.
 *
 * Calls are only removed with --with-calls, and never a call that also belongs to
 * a sale outside the target set: that would silently gut a sale nobody asked to
 * touch. Audio is deleted before the row, and a storage failure aborts that row,
 * so a file is never orphaned with nothing left to locate it by.
 *
 * Usage:
 *   npx tsx src/scripts/delete-tenant-sales.ts --org "Trust Point" --before 2026-08-04
 *   npx tsx src/scripts/delete-tenant-sales.ts --org "Trust Point" --before 2026-08-04 --with-calls --confirm
 *
 *   --field scored_at|created_at|window_end   which date the cutoff applies to
 *                                             (default scored_at)
 */

import { pool, query, queryOne } from '../db/client.js';
import { deleteFile } from '../services/storage.js';
import { recordAuditEvent } from '../services/audit.js';

const DATE_FIELDS = ['scored_at', 'created_at', 'window_end'] as const;
type DateField = (typeof DATE_FIELDS)[number];

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const orgArg = arg('--org');
  const before = arg('--before');
  const field = (arg('--field') ?? 'scored_at') as DateField;
  const withCalls = process.argv.includes('--with-calls');
  const confirmed = process.argv.includes('--confirm');

  if (!orgArg || !before) {
    console.error('Required: --org "<name or uuid>" --before YYYY-MM-DD');
    process.exitCode = 1;
    return;
  }
  if (!DATE_FIELDS.includes(field)) {
    console.error(`--field must be one of ${DATE_FIELDS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    console.error('--before must be YYYY-MM-DD');
    process.exitCode = 1;
    return;
  }

  const org = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM organizations
      WHERE id::text = $1 OR name ILIKE $2
      ORDER BY (id::text = $1) DESC LIMIT 1`,
    [orgArg, `%${orgArg}%`]
  );
  if (!org) {
    console.error(`No organisation matching "${orgArg}".`);
    process.exitCode = 1;
    return;
  }

  // Interpolated, not parameterised: a column name cannot be a bind parameter.
  // Safe because it is checked against the DATE_FIELDS allowlist above.
  const targets = await query<{ id: string }>(
    `SELECT id FROM journeys
      WHERE organization_id = $1 AND ${field} < $2::date
      ORDER BY ${field}`,
    [org.id, before]
  );
  const journeyIds = targets.map((t) => t.id);

  if (journeyIds.length === 0) {
    console.log(`No sales for ${org.name} with ${field} before ${before}.`);
    return;
  }

  // Calls belonging to a target sale AND to no sale outside the set. The
  // exclusion is the safety property: a shared call would take a surviving sale's
  // evidence with it.
  const callRows = withCalls
    ? await query<{ id: string; file_key: string | null }>(
        `SELECT DISTINCT c.id, c.file_key
           FROM journey_calls jc
           JOIN calls c ON c.id = jc.call_id
          WHERE jc.journey_id = ANY($1::uuid[])
            AND NOT EXISTS (
                  SELECT 1 FROM journey_calls other
                   WHERE other.call_id = c.id
                     AND other.journey_id <> ALL($1::uuid[])
                )`,
        [journeyIds]
      )
    : [];

  const shared = withCalls
    ? await queryOne<{ n: string }>(
        `SELECT count(DISTINCT jc.call_id) AS n
           FROM journey_calls jc
          WHERE jc.journey_id = ANY($1::uuid[])
            AND EXISTS (
                  SELECT 1 FROM journey_calls other
                   WHERE other.call_id = jc.call_id
                     AND other.journey_id <> ALL($1::uuid[])
                )`,
        [journeyIds]
      )
    : { n: '0' };

  const impact = await queryOne<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM journey_item_scores WHERE journey_id = ANY($1::uuid[])) AS checkpoint_scores,
       (SELECT count(*) FROM breaches           WHERE journey_id = ANY($1::uuid[])) AS breaches,
       (SELECT count(*) FROM score_corrections  WHERE journey_id = ANY($1::uuid[])) AS human_rulings,
       (SELECT count(*) FROM journey_score_runs WHERE journey_id = ANY($1::uuid[])) AS score_history`,
    [journeyIds]
  );

  console.log(`\nTenant : ${org.name}`);
  console.log(`Cutoff : ${field} < ${before}`);
  console.log(`\nWould delete:`);
  console.log(`  sales                     : ${journeyIds.length}`);
  console.log(`  checkpoint scores         : ${impact?.checkpoint_scores}`);
  console.log(`  breaches                  : ${impact?.breaches}   <- the compliance register for these sales`);
  console.log(`  human rulings (overturns) : ${impact?.human_rulings}   <- supervisor decisions, not recoverable`);
  console.log(`  score history             : ${impact?.score_history}`);
  if (withCalls) {
    console.log(`  calls                     : ${callRows.length}`);
    console.log(`  audio files               : ${callRows.filter((c) => c.file_key).length}`);
    if (Number(shared?.n ?? 0) > 0) {
      console.log(
        `  ${shared!.n} call(s) SKIPPED — they also belong to a sale outside this set and would gut it`
      );
    }
  } else {
    console.log(`  calls                     : 0 (pass --with-calls to remove them too)`);
  }

  if (!confirmed) {
    console.log(`\nDRY RUN — nothing has been deleted. Re-run with --confirm.\n`);
    return;
  }

  console.log('\nDeleting...');

  // Sales first. Everything hanging off them goes with them.
  await query('DELETE FROM journeys WHERE id = ANY($1::uuid[])', [journeyIds]);
  console.log(`  ${journeyIds.length} sale(s) deleted`);

  let callsDeleted = 0;
  let audioDeleted = 0;
  const stranded: string[] = [];
  for (const c of callRows) {
    if (c.file_key) {
      try {
        await deleteFile(c.file_key);
        audioDeleted++;
      } catch (err) {
        console.error(`  ! audio delete failed for ${c.id}: ${(err as Error).message}`);
        stranded.push(c.id);
        continue;
      }
    }
    await query('DELETE FROM calls WHERE id = $1', [c.id]);
    callsDeleted++;
  }
  if (withCalls) console.log(`  ${callsDeleted} call(s), ${audioDeleted} audio file(s) deleted`);
  if (stranded.length) {
    console.error(`  ! ${stranded.length} call(s) left in place — their audio could not be removed`);
  }

  await recordAuditEvent({
    organizationId: org.id,
    userId: null,
    actionType: 'journey.bulk_delete',
    entityType: 'journey',
    entityId: journeyIds.slice(0, 50),
    summary:
      `Bulk-deleted ${journeyIds.length} sale(s) with ${field} before ${before}: ` +
      `${impact?.breaches} breach(es), ${impact?.human_rulings} human ruling(s), ${callsDeleted} call(s)`,
    metadata: {
      cutoff: before,
      date_field: field,
      sales_deleted: journeyIds.length,
      breaches_deleted: Number(impact?.breaches ?? 0),
      human_rulings_deleted: Number(impact?.human_rulings ?? 0),
      checkpoint_scores_deleted: Number(impact?.checkpoint_scores ?? 0),
      calls_deleted: callsDeleted,
      audio_files_deleted: audioDeleted,
      calls_skipped_shared: Number(shared?.n ?? 0),
      calls_not_deleted: stranded,
      via: 'scripts/delete-tenant-sales.ts',
    },
  });

  console.log(`\nDone. Audit event written against ${org.name}.\n`);
}

main()
  .catch((err) => {
    console.error('\nFailed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
