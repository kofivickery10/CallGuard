/**
 * Measure the partial-journey coverage signal (CG-8, docs/partial-journey-detection.md §6).
 *
 * Usage:
 *   ORG_ID=<uuid> npx tsx src/scripts/measure-journey-coverage.ts
 *   npx tsx src/scripts/measure-journey-coverage.ts          # every org
 *
 * WHY THIS EXISTS: Phase 1 already persists `coverage` on every scoring run
 * (migration 100), but §6 gates everything user-facing — the breach caveat, the
 * banner, the evidence-pack line — behind knowing how often 'partial' fires and
 * whether it agrees with the structural signal. Until someone has that number,
 * turning the flag on means shipping a claim ("this sale's evidence may be
 * incomplete") whose false-positive rate nobody knows, onto a screen a
 * compliance officer is meant to trust.
 *
 * That measurement has never been run. This is the instrument for it, and it is
 * the thing standing between CG-8's "done looks like" and being able to ship it
 * honestly.
 *
 * READ-ONLY. It issues no writes and no re-scoring: every figure below comes
 * from what scoring already stored. Safe to run against production, which is
 * where the only meaningful sample lives.
 *
 * What it cannot tell you: whether a 'partial' verdict is CORRECT. Only a human
 * opening the audio can settle that. What it gives you is the size of the
 * review job and where the model and the structure disagree — the two places a
 * false positive is most likely to be hiding.
 */

import { query } from '../db/client.js';

interface Row {
  organization_id: string;
  org_name: string;
  coverage: string | null;
  n: string;
  corroborated: string;
  with_stages: string;
}

async function main() {
  const orgId = process.env.ORG_ID ?? null;

  // Corroboration is read back out of the rationale rather than recomputed:
  // score-journey appends a note when the structural signal did NOT back a
  // partial verdict (migration 100), so its absence on a partial row is the
  // recorded agreement. Recomputing the structural shape here would measure
  // today's code against yesterday's verdicts.
  const rows = await query<Row>(
    `SELECT j.organization_id,
            o.name AS org_name,
            j.coverage,
            COUNT(*)::text AS n,
            COUNT(*) FILTER (
              WHERE j.coverage = 'partial'
                AND COALESCE(j.coverage_rationale, '') NOT ILIKE '%did not corroborate%'
            )::text AS corroborated,
            COUNT(*) FILTER (WHERE cardinality(j.coverage_missing_stages) > 0)::text AS with_stages
       FROM journeys j
       JOIN organizations o ON o.id = j.organization_id
      WHERE ($1::uuid IS NULL OR j.organization_id = $1)
      GROUP BY 1, 2, 3
      ORDER BY 2, 3`,
    [orgId]
  );

  if (rows.length === 0) {
    console.log('No journeys found for that scope.');
    process.exit(0);
  }

  const byOrg = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byOrg.get(r.org_name) ?? [];
    list.push(r);
    byOrg.set(r.org_name, list);
  }

  for (const [org, orgRows] of byOrg) {
    const total = orgRows.reduce((a, r) => a + Number(r.n), 0);
    // NULL means "never assessed" — a journey scored before Phase 1 shipped.
    // Kept out of the rate's denominator: including it would understate how
    // often the detector fires by diluting it with sales it never saw.
    const assessed = orgRows
      .filter((r) => r.coverage !== null)
      .reduce((a, r) => a + Number(r.n), 0);
    const partial = Number(orgRows.find((r) => r.coverage === 'partial')?.n ?? 0);
    const corroborated = Number(orgRows.find((r) => r.coverage === 'partial')?.corroborated ?? 0);

    console.log(`\n${org}`);
    console.log(`  journeys:            ${total}`);
    console.log(`  assessed (Phase 1):  ${assessed}${assessed === 0 ? '  <- nothing scored since migration 100' : ''}`);
    for (const r of orgRows) {
      const label = r.coverage ?? 'never assessed';
      console.log(`    ${label.padEnd(16)} ${String(r.n).padStart(5)}`);
    }
    if (assessed > 0) {
      const rate = ((partial / assessed) * 100).toFixed(1);
      console.log(`  partial rate:        ${rate}% of assessed sales`);
      if (partial > 0) {
        console.log(
          `  of those partial:    ${corroborated}/${partial} corroborated by the structural signal`
        );
        console.log(
          `                       ${partial - corroborated} flagged on the model's word alone ` +
            `— the likeliest false positives, and where to start reviewing`
        );
      }
    }
  }

  console.log(
    `\nNext: review a sample of 'partial' sales against their audio, starting with the\n` +
      `uncorroborated ones. Phase 2 (docs/partial-journey-detection.md §6) needs that\n` +
      `false-positive rate before anything is shown to a tenant.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
