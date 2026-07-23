// Retire a tenant's back-office "manual" scorecard items (item_type='manual').
//
// A tenant may want their scorecard to contain only AI-scored checkpoints, with
// the back-office/manual items taken out. Manual items are never sent to the AI
// and are already excluded from the AI score; this script removes them from the
// scorecard so they no longer show in the editor, in future scoring, or in
// reports.
//
// It ARCHIVES (sets archived_at = now()) rather than deleting, so that:
//   - compliance history (past call_item_scores/journey_item_scores) stays intact,
//   - it is fully reversible — UPDATE scorecard_items SET archived_at = NULL, and
//   - it never hits the journey_item_scores.scorecard_item_id FK (which has no
//     ON DELETE, so a hard delete of a journey-scored item would throw).
// A structural change bumps scorecards.version, mirroring the editor, so scores
// taken before the change stay pinned to the version they were judged against.
//
// Modes:
//   (default)  dry run — list the manual items and any pending manual-review
//              backlog, and change nothing.
//   --commit   archive the manual items and bump the affected scorecard version.
//
// Usage:
//   tsx src/scripts/remove-manual-items.ts <orgId|nameSubstring> [--commit]
//
// Connects to whatever DATABASE_URL points at (usually production) — treat as a
// production tool.
import { pool, query, withTransaction } from '../db/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOrg(idOrName: string): Promise<{ id: string; name: string }> {
  if (UUID_RE.test(idOrName)) {
    const rows = await query<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [idOrName]
    );
    if (rows.length === 0) throw new Error(`No organization with id ${idOrName}`);
    return rows[0]!;
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

interface ManualItemRow {
  id: string;
  label: string;
  section: string | null;
  scorecard_id: string;
  scorecard_name: string;
  scorecard_version: number;
  call_scores: number;
  journey_scores: number;
  pending_call_reviews: number;
  pending_journey_reviews: number;
}

async function main() {
  const args = process.argv.slice(2);
  const orgArg = args.find((a) => !a.startsWith('--'));
  const commit = args.includes('--commit');

  if (!orgArg) {
    console.error('Usage: tsx src/scripts/remove-manual-items.ts <orgId|nameSubstring> [--commit]');
    process.exit(1);
  }

  const org = await resolveOrg(orgArg);
  console.log(`Tenant: ${org.name} (${org.id})`);
  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY RUN'}\n`);

  // Every non-archived manual item across all of this org's scorecards, with
  // how many results reference it (history that archiving preserves) and how
  // many of those are still awaiting manual review (the review-queue backlog).
  const items = await query<ManualItemRow>(
    `SELECT si.id, si.label, si.section,
            sc.id AS scorecard_id, sc.name AS scorecard_name, sc.version AS scorecard_version,
            (SELECT COUNT(*) FROM call_item_scores cis
               WHERE cis.scorecard_item_id = si.id)::int AS call_scores,
            (SELECT COUNT(*) FROM journey_item_scores jis
               WHERE jis.scorecard_item_id = si.id)::int AS journey_scores,
            (SELECT COUNT(*) FROM call_item_scores cis
               WHERE cis.scorecard_item_id = si.id AND cis.result = 'manual_review')::int AS pending_call_reviews,
            (SELECT COUNT(*) FROM journey_item_scores jis
               WHERE jis.scorecard_item_id = si.id AND jis.result = 'manual_review')::int AS pending_journey_reviews
       FROM scorecard_items si
       JOIN scorecards sc ON sc.id = si.scorecard_id
      WHERE sc.organization_id = $1
        AND si.item_type = 'manual'
        AND si.archived_at IS NULL
      ORDER BY sc.name, si.sort_order`,
    [org.id]
  );

  if (items.length === 0) {
    console.log('No active manual (back-office) items on this tenant\'s scorecards. Nothing to do.');
    await pool.end();
    return;
  }

  let pendingReviews = 0;
  const byScorecard = new Map<string, { name: string; version: number; ids: string[] }>();
  for (const it of items) {
    pendingReviews += it.pending_call_reviews + it.pending_journey_reviews;
    const g = byScorecard.get(it.scorecard_id) ?? { name: it.scorecard_name, version: it.scorecard_version, ids: [] };
    g.ids.push(it.id);
    byScorecard.set(it.scorecard_id, g);
  }

  console.log(`Found ${items.length} manual item(s) across ${byScorecard.size} scorecard(s):\n`);
  for (const [, g] of byScorecard) {
    console.log(`  ${g.name} (v${g.version}):`);
    for (const it of items.filter((i) => i.scorecard_name === g.name)) {
      const scored = it.call_scores + it.journey_scores;
      const section = it.section ? `[${it.section}] ` : '';
      console.log(
        `    - ${section}${it.label}  (${scored} historical result(s)` +
          `${scored ? ' — will be archived, kept for history' : ' — no history'})`
      );
    }
  }

  if (pendingReviews > 0) {
    console.log(
      `\nNote: ${pendingReviews} pending manual-review item(s) reference these checkpoints.\n` +
        '      Archiving removes the items from the scorecard, scoring and editor, but the\n' +
        '      review queue does not currently filter archived items, so those will remain\n' +
        '      in the queue until resolved. Flag this if you want them cleared too.'
    );
  }

  if (!commit) {
    console.log('\nDry run only. Re-run with --commit to archive these manual items.');
    await pool.end();
    return;
  }

  await withTransaction(async (tx) => {
    for (const [scorecardId, g] of byScorecard) {
      await tx.query(
        'UPDATE scorecard_items SET archived_at = now() WHERE id = ANY($1::uuid[])',
        [g.ids]
      );
      await tx.query(
        'UPDATE scorecards SET version = version + 1, updated_at = now() WHERE id = $1',
        [scorecardId]
      );
      console.log(`  ${g.name}: archived ${g.ids.length} manual item(s), version ${g.version} -> ${g.version + 1}`);
    }
  });

  console.log('\nDone. Manual items archived (reversible: SET archived_at = NULL).');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
