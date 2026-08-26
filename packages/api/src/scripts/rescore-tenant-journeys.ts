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
//   default          --status=scoring,failed   (the stuck/failed ones from a bug)
//   --all            every status incl. already-scored (re-scores everything)
//   --status=a,b     explicit set, e.g. --status=failed
//   --out-of-scope   narrows the set to sales holding a score for a checkpoint
//                    that no longer applies to the products they sold. Implies
//                    --status=scored.
//   --unattributable narrows the set to sales whose wrap-up cannot support a
//                    claim about who said something — a one-sided transcript, or
//                    labels the content contradicts. Implies --status=scored
//                    unless one is given.
//
// WHY --unattributable EXISTS
//
// Those sales are the ones the attribution gate in checkpoint-classification.ts
// now withholds a score for, and they are a small minority: on the tenant that
// prompted it, 9 of 111. Re-scoring the whole tenant to reach 9 sales would put
// every other sale's checkpoints back through the model for nothing, and would
// re-push 100-odd CRM records.
//
// It selects by running the live predicate (transcriptSupportsAttribution)
// rather than a list of ids, so the set can never drift from the gate that
// produced it.
//
// Note these sales will come back UNSCORED by design: every applicable
// checkpoint routes to review, so score-journey takes its nothingAutoScored
// path, which holds the CRM write-back rather than pushing a 0%. The reviewer's
// first resolution pushes a real number. The consequence worth knowing: until
// somebody works the queue, CallGuard shows no score while the CRM still holds
// the old — now known-unsound — one.
//
// Usage:
//   tsx src/scripts/rescore-tenant-journeys.ts <orgId|nameSubstring> [--commit] [--all] [--status=scoring,failed] [--no-crm]
//   tsx src/scripts/rescore-tenant-journeys.ts "Trust Point" --unattributable
//   tsx src/scripts/rescore-tenant-journeys.ts "Trust Point" --unattributable --commit
//   tsx src/scripts/rescore-tenant-journeys.ts "Trust Point" --out-of-scope
//   tsx src/scripts/rescore-tenant-journeys.ts "Trust Point" --out-of-scope --commit
import { pool, query, queryOne } from '../db/client.js';
import {
  transcriptSupportsAttribution,
  type SpeakerIntegrityFlag,
} from '../services/speaker-integrity.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 'skipped' (migration 071) is a deliberate not-taken-up sale. It is a valid
// --status target so a sale wrongly skipped (e.g. the CRM stage was corrected
// afterwards) can be pulled back in, but it is NOT in the --all default sweep
// below for the same reason it was skipped: re-scoring it would put a breach
// register back on business that never completed.
const VALID_STATUSES = ['pending', 'scoring', 'scored', 'failed', 'skipped'] as const;
const ALL_SWEEP_STATUSES = ['pending', 'scoring', 'scored', 'failed'] as const;

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
  const noCrm = args.includes('--no-crm');
  const statusArg = args.find((a) => a.startsWith('--status='))?.split('=')[1];
  const unattributable = args.includes('--unattributable');
  const outOfScope = args.includes('--out-of-scope');

  if (!orgArg) {
    console.error('Usage: tsx src/scripts/rescore-tenant-journeys.ts <orgId|nameSubstring> [--commit] [--all] [--status=scoring,failed] [--no-crm]');
    process.exit(1);
  }

  const statuses = all
    ? [...ALL_SWEEP_STATUSES]
    : statusArg
      ? statusArg.split(',').map((s) => s.trim())
      // The sales this targets are already scored — that IS the problem — so the
      // stuck/failed default would match none of them.
      : unattributable || outOfScope
        ? ['scored']
        : ['scoring', 'failed'];
  const invalid = statuses.filter((s) => !VALID_STATUSES.includes(s as typeof VALID_STATUSES[number]));
  if (invalid.length) {
    console.error(`Invalid status(es): ${invalid.join(', ')}. Valid: ${VALID_STATUSES.join(', ')}`);
    process.exit(1);
  }

  const org = await resolveOrg(orgArg);
  console.log(`Tenant: ${org.name} (${org.id})`);
  console.log(
    `Mode: ${commit ? 'COMMIT' : 'DRY RUN'} | target statuses: ${statuses.join(', ')}` +
      `${unattributable ? ' | filter: wrap-up cannot be attributed' : ''}` +
      `${outOfScope ? ' | filter: holds a checkpoint score now out of product scope' : ''}` +
      ` | CRM write-back: ${noCrm ? 'SUPPRESSED' : 'on'}\n`
  );

  const matched = await query<{
    id: string;
    status: string;
    call_count: string;
    created_at: string;
    client_name: string | null;
    score: string | null;
  }>(
    `SELECT j.id, j.status,
            COUNT(jc.call_id)::text AS call_count,
            to_char(j.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
            j.client_name, j.overall_score::text AS score
       FROM journeys j
       LEFT JOIN journey_calls jc ON jc.journey_id = j.id
      WHERE j.organization_id = $1
        AND j.status = ANY($2::text[])
      GROUP BY j.id
      ORDER BY j.created_at DESC`,
    [org.id, statuses]
  );

  // The wrap-up each sale is judged from, resolved the same way score-journey
  // resolves it: the call marked 'wrap_up', falling back to the most recent.
  // Only loaded when the filter is in play — it is a transcript per sale.
  const reasons = new Map<string, string>();
  let journeys = matched;
  if (unattributable) {
    const wrapUps = await query<{
      jid: string;
      transcript_text: string | null;
      flag: string | null;
    }>(
      `SELECT jid, transcript_text, flag FROM (
         SELECT j.id AS jid, c.transcript_text, c.speaker_integrity_flag AS flag,
                ROW_NUMBER() OVER (
                  PARTITION BY j.id
                  ORDER BY (jc.role = 'wrap_up') DESC,
                           COALESCE(c.call_date::timestamptz, c.created_at) DESC
                ) AS rn
           FROM journeys j
           JOIN journey_calls jc ON jc.journey_id = j.id
           JOIN calls c ON c.id = jc.call_id
          WHERE j.organization_id = $1 AND j.id = ANY($2::uuid[])
            AND c.transcript_text IS NOT NULL
       ) ranked WHERE rn = 1`,
      [org.id, matched.map((j) => j.id)]
    );
    const byId = new Map(wrapUps.map((w) => [w.jid, w]));
    journeys = matched.filter((j) => {
      const w = byId.get(j.id);
      // No transcribed wrap-up at all: not this script's problem — such a sale
      // never reached the gate, and re-scoring cannot give it a transcript.
      if (!w) return false;
      const v = transcriptSupportsAttribution(
        w.transcript_text,
        w.flag as SpeakerIntegrityFlag | null
      );
      if (v.ok) return false;
      reasons.set(j.id, v.reason ?? 'unattributable');
      return true;
    });
    console.log(`Sales examined: ${matched.length}\n`);
  }

  // Sales carrying a score for a checkpoint that no longer applies to what they
  // sold.
  //
  // Scoping a checkpoint to products changes nothing on its own: applies_to_products
  // is read at SCORING time, so every sale already scored keeps the item it
  // should never have been given, and a recorded failure keeps its breach. Only
  // a re-score drops it out.
  //
  // Targeted rather than swept for the reason --unattributable is: on the tenant
  // this was written for, 34 sales of 110 hold such a score, and re-scoring the
  // other 76 would put their checkpoints back through the model and re-push
  // their CRM records to change nothing.
  //
  // Selected by the same rule scoring applies — an item whose applies_to_products
  // names none of the sale's products — so the set cannot drift from the gate
  // that produced it.
  if (outOfScope) {
    const stale = await query<{ jid: string; labels: string[]; fails: number }>(
      `SELECT jis.journey_id AS jid,
              array_agg(DISTINCT si.label ORDER BY si.label) AS labels,
              COUNT(*) FILTER (WHERE jis.result = 'fail')::int AS fails
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.journey_id = ANY($1::uuid[])
          AND si.applies_to_products IS NOT NULL
          AND cardinality(si.applies_to_products) > 0
          AND NOT EXISTS (
                SELECT 1 FROM journey_products jp
                 WHERE jp.journey_id = jis.journey_id
                   AND jp.product_id = ANY(si.applies_to_products)
              )
        GROUP BY jis.journey_id`,
      [matched.map((j) => j.id)]
    );
    const byId = new Map(stale.map((r) => [r.jid, r]));
    journeys = matched.filter((j) => byId.has(j.id));
    for (const j of journeys) {
      const r = byId.get(j.id)!;
      reasons.set(
        j.id,
        `${r.labels.length} out of scope${r.fails > 0 ? `, ${r.fails} recorded as FAILED` : ''}`
      );
    }
    const totalItems = stale.reduce((n, r) => n + r.labels.length, 0);
    const totalFails = stale.reduce((n, r) => n + r.fails, 0);
    console.log(
      `Sales examined: ${matched.length}\n` +
        `Out-of-scope checkpoint scores: ${totalItems}, of which ${totalFails} recorded as FAILED ` +
        `(each one a breach on an adviser's record for something never in scope)\n`
    );
  }

  console.log(`Matching sales: ${journeys.length}`);
  for (const j of journeys) {
    console.log(
      `  ${j.id}  ${j.status.padEnd(8)}  ${String(j.call_count).padStart(2)} calls  ${j.created_at}` +
        `  ${(j.client_name ?? '(no name)').padEnd(20)} score ${(j.score ?? '-').padStart(6)}` +
        `${reasons.has(j.id) ? `  ${reasons.get(j.id)}` : ''}`
    );
  }
  if (unattributable && journeys.length > 0) {
    console.log(
      `\nThese will come back UNSCORED: every checkpoint routes to review, and the\n` +
        `CRM write-back is held rather than pushing a 0%. Until the queue is worked,\n` +
        `CallGuard shows no score while the CRM still holds the old one.`
    );
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
    await scoringQueue.add('score-journey', { journeyId: j.id, suppressCrm: noCrm }, { jobId: `rescore-journey-${j.id}-${ts}` });
    console.log(`  enqueued ${j.id}`);
  }
  console.log(`\nEnqueued ${journeys.length} sales for re-scoring${noCrm ? ' (CRM write-back suppressed)' : ' — this re-pushes corrected results to the CRM'}. Ensure the scoring worker is running to process them.`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
