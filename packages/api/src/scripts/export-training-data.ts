/**
 * Export human-labelled scoring data as JSONL — the foundation for an offline
 * eval set and, eventually, training a proprietary scoring model.
 *
 * Source of truth: calls a reviewer marked reviewed. For each scored item on a
 * reviewed call we know the human-confirmed verdict:
 *   - if the item was corrected -> the corrected verdict
 *   - otherwise (reviewed, left unchanged) -> the AI's verdict, confirmed
 * Each line also carries the AI's original verdict, so you can compute agreement
 * offline and, later, train against ground_truth_pass.
 *
 * Usage:
 *   npm run export-training-data --workspace=packages/api                 # all orgs -> stdout
 *   npm run export-training-data --workspace=packages/api -- --org <id>   # one org
 *   npm run export-training-data --workspace=packages/api > data.jsonl
 *
 * NOTE: transcripts contain personal/special-category data. Anonymise + ensure
 * you have the data rights (see the DPA) before using this across customers.
 */

import { pool, query } from '../db/client.js';
import { isItemPass } from '@callguard/shared';

interface Row {
  call_id: string;
  organization_id: string;
  created_at: string;
  reviewed_at: string;
  transcript_text: string | null;
  scorecard_item_id: string;
  label: string;
  rubric: string | null;
  weight: string;
  severity: string | null;
  normalized_score: string;
  evidence: string | null;
  reasoning: string | null;
  corrected_pass: boolean | null;
  correction_reason: string | null;
}

async function main() {
  const orgArgIdx = process.argv.indexOf('--org');
  const orgId = orgArgIdx >= 0 ? process.argv[orgArgIdx + 1] : null;

  const rows = await query<Row>(
    `SELECT
        c.id              AS call_id,
        c.organization_id,
        c.created_at,
        c.reviewed_at,
        c.transcript_text,
        si.id             AS scorecard_item_id,
        si.label,
        si.description    AS rubric,
        si.weight::text   AS weight,
        si.severity,
        cis.normalized_score::text AS normalized_score,
        cis.evidence,
        cis.reasoning,
        corr.corrected_pass,
        corr.reason       AS correction_reason
       FROM calls c
       JOIN call_scores cs        ON cs.call_id = c.id
       JOIN call_item_scores cis  ON cis.call_score_id = cs.id
       JOIN scorecard_items si    ON si.id = cis.scorecard_item_id
       LEFT JOIN score_corrections corr ON corr.call_item_score_id = cis.id
      WHERE c.reviewed_at IS NOT NULL
        ${orgId ? 'AND c.organization_id = $1' : ''}
      ORDER BY c.reviewed_at`,
    orgId ? [orgId] : []
  );

  let emitted = 0;
  for (const r of rows) {
    const aiPass = isItemPass(Number(r.normalized_score));
    const corrected = r.corrected_pass !== null;
    const groundTruthPass = corrected ? Boolean(r.corrected_pass) : aiPass;

    process.stdout.write(
      JSON.stringify({
        call_id: r.call_id,
        organization_id: r.organization_id,
        created_at: r.created_at,
        scorecard_item: r.label,
        rubric: r.rubric,
        severity: r.severity,
        weight: Number(r.weight),
        transcript: r.transcript_text, // PII — anonymise before cross-customer use
        ai_pass: aiPass,
        ground_truth_pass: groundTruthPass,
        corrected,
        correction_reason: r.correction_reason,
        ai_evidence: r.evidence,
        ai_reasoning: r.reasoning,
      }) + '\n'
    );
    emitted++;
  }

  process.stderr.write(
    `Exported ${emitted} labelled item-scores from reviewed calls${orgId ? ` (org ${orgId})` : ' (all orgs)'}.\n`
  );
  await pool.end();
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
