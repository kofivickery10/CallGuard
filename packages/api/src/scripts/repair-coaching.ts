// Repair coaching briefs stored in the wrong shape.
//
// The coaching brief is free-form model output written straight into a JSONB
// column. The scoring tool schema declares it an object, but a model can answer
// with the object serialised as a *string* (sometimes with trailing junk), and
// nothing used to check. Postgres accepts that happily — a JSONB string scalar
// is valid JSONB — so it sat in the column until a UI called `.map` on
// `coaching.strengths` and the sale page died on it.
//
// scoring.ts now normalises the brief before it is ever written, so this is for
// rows created before that. It rewrites each bad row to a proper object where
// the brief can be salvaged, and NULLs it where it cannot — coaching is
// advisory, so an unreadable brief is worth less than a column the UI can trust.
// Scores, checkpoints and breaches are never touched.
//
//   npx tsx src/scripts/repair-coaching.ts            # dry run — report only
//   npx tsx src/scripts/repair-coaching.ts --commit    # write the repairs
import 'dotenv/config';
import { parseCoaching } from '@callguard/shared';
import { query } from '../db/client.js';

const COMMIT = process.argv.includes('--commit');

interface BadRow {
  id: string;
  raw: string;
  scored_at: string | null;
}

// The column holds a JSONB scalar (string/number/bool) or an array — anything
// but the object the UI expects. `#>> '{}'` renders it as text either way.
async function findBad(table: 'journeys' | 'call_scores'): Promise<BadRow[]> {
  return query<BadRow>(
    `SELECT id, coaching #>> '{}' AS raw, scored_at
       FROM ${table}
      WHERE coaching IS NOT NULL AND jsonb_typeof(coaching) <> 'object'
      ORDER BY scored_at DESC NULLS LAST`
  );
}

async function repair(table: 'journeys' | 'call_scores'): Promise<void> {
  const rows = await findBad(table);
  console.log(`\n${table}: ${rows.length} row(s) with a non-object coaching brief`);

  let salvaged = 0;
  let cleared = 0;
  for (const row of rows) {
    const coaching = parseCoaching(row.raw);
    const when = row.scored_at ? new Date(row.scored_at).toISOString().slice(0, 10) : 'unscored';
    if (coaching) {
      salvaged++;
      console.log(`  ${row.id} (${when}) — salvageable, ${coaching.strengths.length} strengths / ` +
        `${coaching.improvements.length} improvements / ${coaching.next_actions.length} actions`);
    } else {
      cleared++;
      console.log(`  ${row.id} (${when}) — unreadable, will be cleared (${row.raw.length} chars)`);
    }
    if (!COMMIT) continue;
    await query(
      `UPDATE ${table} SET coaching = $2 WHERE id = $1`,
      [row.id, coaching ? JSON.stringify(coaching) : null]
    );
  }

  console.log(`  → ${salvaged} salvageable, ${cleared} to clear${COMMIT ? ' (written)' : ' (dry run)'}`);
}

async function main(): Promise<void> {
  if (!COMMIT) console.log('DRY RUN — nothing will be written. Re-run with --commit to apply.');
  await repair('journeys');
  await repair('call_scores');
  process.exit(0);
}

main().catch((err) => {
  console.error('repair-coaching failed:', err);
  process.exit(1);
});
