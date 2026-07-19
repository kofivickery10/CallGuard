// Re-enqueue score-journey for a tenant's sales — used to recover sales whose
// scoring failed (e.g. the non-streaming >10-min SDK error that wedged
// score-journey jobs), which leaves the journey stuck in 'scoring' where the
// admin Re-score button refuses it (409 "already being scored").
//
// Unlike bulk-reprocess-tenant.ts this does NOT re-clean transcripts — it only
// re-scores. score-journey clears the sale's prior breaches and upserts item
// scores, so a re-score replaces the result in place (no duplication) and
// re-pushes to the CRM. Needs the scoring worker running on the same host/Redis.
//
// Phases:
//   (default)   dry run — list matching sales and their status, enqueue nothing
//   --commit    set each matching sale to 'scoring' and enqueue score-journey
//
// Targeting (a sale matches if its status is in the target set):
//   default        --status=scoring,failed   (the stuck/failed ones from a bug)
//   --all          every status incl. already-scored (re-scores everything)
//   --status=a,b   explicit set, e.g. --status=failed
//
// Usage:
//   tsx src/scripts/rescore-tenant-journeys.ts <orgId|nameSubstring> [--commit] [--all] [--status=scoring,failed]
import { pool, query, queryOne } from '../db/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = ['pending', 'scoring', 'scored', 'failed'] as const;

async function resolveOrg(idOrName: string): Promise<{ id: string; name: string }> {
  if (UUID_RE.test(idOrName)) {
    const row = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [idOrName]
    );
    if (!row) throw new Error(`No organization with id ${idOrName}`);
    return row;
  }
  const rows = await query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE name ILIKE $1 ORDER BY name',
    [`%${idOrName}%`]
  );
  if (rows.length === 0) throw new Error(`No organization matching "${idOrName}"`);
  if (rows.length > 1) {
    throw new Error(
      `Ambiguous tenant "${idOrName}" — matches:\n` + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n')
    );
  }
  return rows[0]!;
}

async function main() {
  const args = process.argv.slice(2);
  const orgArg = args.find((a) => !a.startsWith('--'));
  const commit = args.includes('--commit');
  const all = args.includes('--all');
  const statusArg = args.find((a) => a.startsWith('--status='))?.split('=')[1];

  if (!orgArg) {
    console.error('Usage: tsx src/scripts/rescore-tenant-journeys.ts <orgId|nameSubstring> [--commit] [--all] [--status=scoring,failed]');
    process.exit(1);
  }

  const statuses = all
    ? [...VALID_STATUSES]
    : (statusArg ? statusArg.split(',').map((s) => s.trim()) : ['scoring', 'failed']);
  const invalid = statuses.filter((s) => !VALID_STATUSES.includes(s as typeof VALID_STATUSES[number]));
  if (invalid.length) {
    console.error(`Invalid status(es): ${invalid.join(', ')}. Valid: ${VALID_STATUSES.join(', ')}`);
    process.exit(1);
  }

  const org = await resolveOrg(orgArg);
  console.log(`Tenant: ${org.name} (${org.id})`);
  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY RUN'} | target statuses: ${statuses.join(', ')}\n`);

  const journeys = await query<{ id: string; status: string; call_count: string; created_at: string }>(
    `SELECT j.id, j.status,
            COUNT(jc.call_id)::text AS call_count,
            to_char(j.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM journeys j
       LEFT JOIN journey_calls jc ON jc.journey_id = j.id
      WHERE j.organization_id = $1
        AND j.status = ANY($2::text[])
      GROUP BY j.id
      ORDER BY j.created_at DESC`,
    [org.id, statuses]
  );

  console.log(`Matching sales: ${journeys.length}`);
  for (const j of journeys) {
    console.log(`  ${j.id}  ${j.status.padEnd(8)}  ${String(j.call_count).padStart(2)} calls  ${j.created_at}`);
  }

  if (!commit) {
    console.log('\nDry run only. Re-run with --commit to set these to scoring and enqueue score-journey.');
    await pool.end();
    return;
  }

  if (journeys.length === 0) {
    console.log('\nNothing to re-score.');
    await pool.end();
    return;
  }

  const { scoringQueue } = await import('../jobs/queue.js');
  const ts = Date.now();
  for (const j of journeys) {
    await query("UPDATE journeys SET status = 'scoring', updated_at = now() WHERE id = $1", [j.id]);
    await scoringQueue.add('score-journey', { journeyId: j.id }, { jobId: `rescore-journey-${j.id}-${ts}` });
    console.log(`  enqueued ${j.id}`);
  }
  console.log(`\nEnqueued ${journeys.length} sales for re-scoring. This re-pushes corrected results to the CRM. Ensure the scoring worker is running to process them.`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
