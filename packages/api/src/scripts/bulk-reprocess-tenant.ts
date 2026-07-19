// Bulk-apply the transcript cleanup fix to a tenant's sales, then (optionally)
// re-score them.
//
// The cleanup-truncation bug only affected LONG calls: cleanup hit the old
// 8192-token output cap, discarded its result (including the speaker-label
// swap), and fell back to the raw, sometimes label-inverted, transcript. Short
// calls cleaned fine. So this targets long, never-swapped calls in the tenant's
// sales and re-runs cleanup on their stored transcript (NOT Deepgram — the raw
// transcription was always correct). It only writes when the text actually
// changes, so correctly-labelled calls are left alone.
//
// Phases (all opt-in, so the CRM-touching step is deliberate):
//   (default)   dry run — report scope and cost, change nothing
//   --commit    re-run cleanup and store corrected transcripts
//   --rescore   (with --commit) re-enqueue score-journey for affected sales.
//               Re-scoring re-pushes each sale's corrected result to the CRM,
//               and needs the scoring worker running (run this on the host
//               where the worker/Redis live, else the jobs sit unprocessed).
//
// Usage:
//   tsx src/scripts/bulk-reprocess-tenant.ts <orgId|nameSubstring> [--commit] [--rescore] [--min-chars=30000]
import { pool, query, queryOne } from '../db/client.js';
import { cleanupTranscript } from '../services/transcript-cleanup.js';
import { getKBContext } from '../services/kb.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const rescore = args.includes('--rescore');
  const minChars = Number(args.find((a) => a.startsWith('--min-chars='))?.split('=')[1] ?? 30000);

  if (!orgArg) {
    console.error('Usage: tsx src/scripts/bulk-reprocess-tenant.ts <orgId|nameSubstring> [--commit] [--rescore] [--min-chars=30000]');
    process.exit(1);
  }

  const org = await resolveOrg(orgArg);
  console.log(`Tenant: ${org.name} (${org.id})`);
  console.log(`Mode: ${commit ? (rescore ? 'COMMIT + RESCORE' : 'COMMIT (cleanup only)') : 'DRY RUN'} | min transcript length: ${minChars} chars\n`);

  // Candidate calls: linked to an already-scored/failed sale, transcribed,
  // never swapped (confidence <= 0.6), and long enough to have truncated.
  const candidates = await query<{
    id: string;
    chars: number;
    mins: string | null;
    confidence: string | null;
  }>(
    `SELECT DISTINCT c.id,
            length(c.transcript_text) AS chars,
            ROUND(c.duration_seconds / 60.0, 1)::text AS mins,
            c.speaker_attribution_confidence AS confidence
       FROM calls c
       JOIN journey_calls jc ON jc.call_id = c.id
       JOIN journeys j ON j.id = jc.journey_id
      WHERE j.organization_id = $1
        AND j.status IN ('scored', 'failed')
        AND c.transcript_text IS NOT NULL
        AND COALESCE(c.speaker_attribution_confidence, 0) <= 0.6
        AND length(c.transcript_text) >= $2
      ORDER BY chars DESC`,
    [org.id, minChars]
  );

  const affectedSales = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT j.id) AS count
       FROM journeys j
       JOIN journey_calls jc ON jc.journey_id = j.id
       JOIN calls c ON c.id = jc.call_id
      WHERE j.organization_id = $1
        AND j.status IN ('scored', 'failed')
        AND c.transcript_text IS NOT NULL
        AND COALESCE(c.speaker_attribution_confidence, 0) <= 0.6
        AND length(c.transcript_text) >= $2`,
    [org.id, minChars]
  );

  console.log(`Candidate calls: ${candidates.length} (across ~${affectedSales[0]?.count ?? 0} sales)`);
  for (const c of candidates.slice(0, 40)) {
    console.log(`  ${c.id}  ${String(c.chars).padStart(6)} chars  ${String(c.mins ?? '?').padStart(5)} min  conf=${c.confidence}`);
  }
  if (candidates.length > 40) console.log(`  … and ${candidates.length - 40} more`);

  if (!commit) {
    console.log('\nDry run only. Re-run with --commit to re-clean these transcripts, then add --rescore to re-score the affected sales.');
    await pool.end();
    return;
  }

  // Re-clean each candidate; only write when the text actually changes.
  const kbContext = await getKBContext(org.id);
  const changedCallIds: string[] = [];
  let swappedCount = 0;

  for (const c of candidates) {
    const callRow = await queryOne<{ transcript_text: string; speaker_attribution_confidence: string | null }>(
      'SELECT transcript_text, speaker_attribution_confidence FROM calls WHERE id = $1',
      [c.id]
    );
    if (!callRow?.transcript_text) continue;
    const confidence = callRow.speaker_attribution_confidence ? Number(callRow.speaker_attribution_confidence) : 0.6;

    const cleanup = await cleanupTranscript(callRow.transcript_text, org.id, kbContext, c.id, confidence);
    const changed = cleanup.text !== callRow.transcript_text;

    if (changed || cleanup.speakerLabelsSwapped) {
      const newConfidence = cleanup.speakerLabelsSwapped ? Math.max(confidence, 0.75) : confidence;
      await query(
        'UPDATE calls SET transcript_text = $1, speaker_attribution_confidence = $2, updated_at = now() WHERE id = $3',
        [cleanup.text, newConfidence, c.id]
      );
      changedCallIds.push(c.id);
      if (cleanup.speakerLabelsSwapped) swappedCount++;
      console.log(`  updated ${c.id}${cleanup.speakerLabelsSwapped ? ' (labels swapped)' : ''}`);
    } else {
      console.log(`  unchanged ${c.id}`);
    }
  }

  console.log(`\nCleaned: ${changedCallIds.length} calls changed (${swappedCount} had labels swapped), ${candidates.length - changedCallIds.length} unchanged.`);

  // Sales that contain at least one changed call.
  const affected = changedCallIds.length
    ? await query<{ id: string }>(
        `SELECT DISTINCT j.id
           FROM journeys j
           JOIN journey_calls jc ON jc.journey_id = j.id
          WHERE j.organization_id = $1
            AND j.status IN ('scored', 'failed')
            AND jc.call_id = ANY($2::uuid[])`,
        [org.id, changedCallIds]
      )
    : [];

  console.log(`Sales needing re-score: ${affected.length}`);
  console.log(affected.map((j) => `  ${j.id}`).join('\n'));

  if (rescore && affected.length) {
    const { scoringQueue } = await import('../jobs/queue.js');
    const ts = Date.now();
    for (const j of affected) {
      await query("UPDATE journeys SET status = 'scoring', updated_at = now() WHERE id = $1", [j.id]);
      await scoringQueue.add('score-journey', { journeyId: j.id }, { jobId: `rescore-journey-${j.id}-${ts}` });
    }
    console.log(`\nEnqueued ${affected.length} sales for re-scoring. This re-pushes corrected results to the CRM. Ensure the scoring worker is running to process them.`);
  } else if (affected.length) {
    console.log('\nRe-run with --rescore (on the host where the scoring worker runs) to re-score these sales, or use the admin Re-score button per sale.');
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
