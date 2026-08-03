// Pick a tenant's review_confidence_floor (migration 082) from their own scored
// sales instead of guessing at it.
//
// The floor decides how much of a scorecard goes to a human, and the useful
// number is entirely tenant-specific: it depends on how confident the model
// happens to be on THEIR calls, which varies with recording quality, how much of
// each sale was captured, and how the checkpoints are worded. A floor that sends
// half of one tenant's checkpoints to review can send nearly all of another's.
//
// So this reports, over the checkpoints already scored, what each candidate floor
// would have done: how many checkpoints per sale would have gone to review, and
// what the score would have been over the ones left. Run it, read off the row
// that matches the review workload the tenant is actually willing to take on,
// and set that floor on their admin page.
//
// Read-only. Changes nothing.
//
// Usage:
//   tsx src/scripts/review-floor-preview.ts <orgId|nameSubstring> [--sales=N]
import { pool, query, queryOne } from '../db/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deliberately stops at 0.95, as the column's CHECK does: a floor of 1 routes
// everything and scores nothing.
const CANDIDATES = [0, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

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

interface ScoredItem {
  journey_id: string;
  confidence: string | null;
  normalized_score: string;
  weight: string;
}

async function main() {
  const args = process.argv.slice(2);
  const orgArg = args.find((a) => !a.startsWith('--'));
  const salesLimit = Number(args.find((a) => a.startsWith('--sales='))?.split('=')[1] ?? 50);

  if (!orgArg) {
    console.error('Usage: tsx src/scripts/review-floor-preview.ts <orgId|nameSubstring> [--sales=N]');
    process.exit(1);
  }

  const org = await resolveOrg(orgArg);
  console.log(`Tenant: ${org.name} (${org.id})`);
  // Deliberately tolerant of a database that has not had migration 082 applied
  // yet: choosing the floor is something you do BEFORE turning it on, so this has
  // to run against a pre-082 schema rather than fall over on a missing column.
  const hasFloor = await queryOne<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'organizations'
                       AND column_name = 'review_confidence_floor') AS present`
  );
  const current = await queryOne<{ floor: string | null; scoring_samples: number }>(
    `SELECT scoring_samples, ${hasFloor?.present ? 'review_confidence_floor::text' : 'NULL::text'} AS floor
       FROM organizations WHERE id = $1`,
    [org.id]
  );
  console.log(
    `Current: review floor ${current?.floor ?? 'n/a (migration 082 not applied here)'}, ` +
      `${current?.scoring_samples ?? 1} scoring pass(es)\n`
  );

  // The most recent scored sales, and the checkpoints the AI actually settled on
  // each (pass/fail only — na and manual_review were never auto-scored, so they
  // say nothing about where a floor would bite).
  const sales = await query<{ id: string }>(
    `SELECT id FROM journeys
      WHERE organization_id = $1 AND status = 'scored' AND overall_score IS NOT NULL
      ORDER BY scored_at DESC NULLS LAST
      LIMIT $2`,
    [org.id, salesLimit]
  );
  if (sales.length === 0) {
    console.log('No scored sales for this tenant yet — nothing to preview against.');
    await pool.end();
    return;
  }

  const items = await query<ScoredItem>(
    `SELECT jis.journey_id, jis.confidence::text, jis.normalized_score::text, si.weight::text
       FROM journey_item_scores jis
       JOIN scorecard_items si ON si.id = jis.scorecard_item_id
      WHERE jis.journey_id = ANY($1::uuid[])
        AND jis.result IN ('pass', 'fail')
        AND si.archived_at IS NULL`,
    [sales.map((s) => s.id)]
  );
  if (items.length === 0) {
    console.log('No auto-scored checkpoints on those sales — nothing to preview against.');
    await pool.end();
    return;
  }

  // Distribution first: the shape of the tenant's confidences is what makes one
  // floor sensible and the next one absurd, and a table of outcomes hides it.
  const buckets = new Map<string, number>();
  let missing = 0;
  for (const it of items) {
    if (it.confidence === null) {
      missing++;
      continue;
    }
    const c = Number(it.confidence);
    const lo = Math.min(0.95, Math.floor(c * 10) / 10);
    buckets.set(lo.toFixed(1), (buckets.get(lo.toFixed(1)) ?? 0) + 1);
  }
  console.log(`Confidence distribution across ${items.length} auto-scored checkpoint(s) on ${sales.length} sale(s):`);
  for (const key of [...buckets.keys()].sort()) {
    const n = buckets.get(key)!;
    const pct = (n / items.length) * 100;
    console.log(`  ${key}-${(Number(key) + 0.1).toFixed(1)}  ${String(n).padStart(5)}  ${'█'.repeat(Math.round(pct / 2))} ${pct.toFixed(1)}%`);
  }
  if (missing > 0) console.log(`  (no confidence recorded: ${missing})`);
  console.log();

  // What each floor would have done. The score column is the weighted average
  // over the checkpoints that would STILL have been auto-scored — the number the
  // tenant would have seen, with the routed ones out of the denominator.
  const byJourney = new Map<string, ScoredItem[]>();
  for (const it of items) {
    byJourney.set(it.journey_id, [...(byJourney.get(it.journey_id) ?? []), it]);
  }

  console.log('Floor   to review   % of card   sales fully routed   mean score over the rest');
  for (const floor of CANDIDATES) {
    let routed = 0;
    let fullyRouted = 0;
    const scores: number[] = [];
    for (const [, sale] of byJourney) {
      let weighted = 0;
      let weight = 0;
      let saleRouted = 0;
      for (const it of sale) {
        const c = it.confidence === null ? null : Number(it.confidence);
        const goes = floor > 0 && (c === null || c < floor);
        if (goes) {
          saleRouted++;
          continue;
        }
        const w = Number(it.weight);
        weighted += Number(it.normalized_score) * w;
        weight += w;
      }
      routed += saleRouted;
      if (weight === 0) fullyRouted++;
      else scores.push(weighted / weight);
    }
    const meanScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const perSale = routed / byJourney.size;
    console.log(
      `${floor.toFixed(2)}   ${perSale.toFixed(1).padStart(9)}   ` +
        `${((routed / items.length) * 100).toFixed(0).padStart(9)}%   ` +
        `${String(fullyRouted).padStart(18)}   ` +
        `${meanScore === null ? '        n/a' : `${meanScore.toFixed(1)}%`.padStart(11)}`
    );
  }

  console.log(
    '\n"to review" is checkpoints per sale that would go to a human instead of being\n' +
      'auto-scored — on top of the manual items and consent gates that already do.\n' +
      '"sales fully routed" is sales where nothing would be left to score: those\n' +
      'report no score at all until the queue is worked, so keep this at 0.\n' +
      '\nSet the chosen floor on the tenant\'s admin page (Call recording & scoring\n' +
      'policy → "Send to review under (% confidence)"). It applies to sales scored\n' +
      'from then on; re-score to apply it to existing ones.'
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
