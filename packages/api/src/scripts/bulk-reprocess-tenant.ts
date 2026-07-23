// Bulk-apply transcript fixes to a tenant's sales, then (optionally) re-score.
//
// TWO modes:
//
// 1. Re-clean (default) — re-runs the Haiku cleanup on each call's STORED
//    transcript (NOT Deepgram). Use this for the cleanup-truncation/content-loss
//    bug, where the raw Deepgram transcription was always correct and only the
//    cleaned text was damaged. Targets long, never-swapped calls (the ones that
//    could have truncated). Only writes when the text actually changes.
//
// 2. Re-transcribe (--retranscribe) — enqueues a fresh Deepgram `transcribe`
//    job for each call, so changes to the transcription settings themselves
//    (the narrowed redaction list, the compliance keyterms) actually take
//    effect. Re-cleaning cannot apply those — they only change on a new Deepgram
//    run. Targets ALL transcribed calls in the tenant's scored/failed sales.
//    Async: it enqueues and returns; it does NOT re-score in the same run
//    (transcription completes on the worker later). Re-score as a SECOND step,
//    after the transcription queue drains, with rescore-tenant-journeys.ts.
//
// Phases (all opt-in, so any CRM-touching step is deliberate):
//   (default)      dry run — report scope, change nothing
//   --commit       do the work (re-clean, or enqueue re-transcription)
//   --rescore      (re-clean + --commit only) re-enqueue score-journey for
//                  affected sales. Re-scoring re-pushes to the CRM unless
//                  --no-crm is set. Needs the scoring worker running.
//   --no-crm       (with --rescore) suppress the Zoho write-back + webhook on
//                  the re-score, so a bulk correction doesn't flood the CRM.
//
// Usage:
//   tsx src/scripts/bulk-reprocess-tenant.ts <org> [--commit] [--rescore] [--no-crm] [--min-chars=30000]
//   tsx src/scripts/bulk-reprocess-tenant.ts <org> --retranscribe [--commit]
import { pool, query, queryOne } from '../db/client.js';
import { transcriptionQueue } from '../jobs/queue.js';
import { cleanupTranscript, resolveSpeakerConfidence } from '../services/transcript-cleanup.js';
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

// --retranscribe: enqueue a fresh Deepgram transcription for every call in the
// tenant's scored/failed sales, so redaction/keyterm setting changes apply. This
// only ENQUEUES; the worker transcribes + re-cleans (with the content-loss
// guard) asynchronously. Re-score is a deliberate SECOND step once the queue
// drains — see the printed follow-up.
async function runRetranscribe(org: { id: string; name: string }, commit: boolean) {
  console.log(`Mode: ${commit ? 'COMMIT (enqueue re-transcription)' : 'DRY RUN'}\n`);

  const calls = await query<{ id: string; chars: number | null; mins: string | null }>(
    `SELECT DISTINCT c.id,
            length(c.transcript_text) AS chars,
            ROUND(c.duration_seconds / 60.0, 1)::text AS mins
       FROM calls c
       JOIN journey_calls jc ON jc.call_id = c.id
       JOIN journeys j ON j.id = jc.journey_id
      WHERE j.organization_id = $1
        AND j.status IN ('scored', 'failed')
        AND c.file_key IS NOT NULL
      ORDER BY mins DESC NULLS LAST`,
    [org.id]
  );

  const totalMins = calls.reduce((sum, c) => sum + Number(c.mins ?? 0), 0);
  console.log(`Calls to re-transcribe: ${calls.length} (~${totalMins.toFixed(0)} audio minutes → Deepgram + cleanup cost)`);
  for (const c of calls.slice(0, 40)) {
    console.log(`  ${c.id}  ${String(c.mins ?? '?').padStart(5)} min`);
  }
  if (calls.length > 40) console.log(`  … and ${calls.length - 40} more`);

  if (!commit) {
    console.log('\nDry run only. Re-run with --commit to enqueue re-transcription (needs the transcription worker running).');
    return;
  }

  const ts = Date.now();
  for (const c of calls) {
    await transcriptionQueue.add('transcribe', { callId: c.id }, { jobId: `retranscribe-${c.id}-${ts}` });
  }
  console.log(`\nEnqueued ${calls.length} calls for re-transcription (jobId prefix retranscribe-…-${ts}).`);
  console.log('The transcription worker must be running. When the queue has drained, re-score the sales as a SECOND step:');
  console.log(`  tsx src/scripts/rescore-tenant-journeys.ts ${org.id} --status=scored,failed --commit --no-crm`);
}

async function main() {
  const args = process.argv.slice(2);
  const orgArg = args.find((a) => !a.startsWith('--'));
  const commit = args.includes('--commit');
  const rescore = args.includes('--rescore');
  const retranscribe = args.includes('--retranscribe');
  const noCrm = args.includes('--no-crm');
  const minChars = Number(args.find((a) => a.startsWith('--min-chars='))?.split('=')[1] ?? 30000);

  if (!orgArg) {
    console.error('Usage: tsx src/scripts/bulk-reprocess-tenant.ts <org> [--commit] [--rescore] [--no-crm] [--min-chars=30000]\n       tsx src/scripts/bulk-reprocess-tenant.ts <org> --retranscribe [--commit]');
    process.exit(1);
  }

  const org = await resolveOrg(orgArg);
  console.log(`Tenant: ${org.name} (${org.id})`);

  if (retranscribe) {
    await runRetranscribe(org, commit);
    await pool.end();
    return;
  }

  console.log(`Mode: ${commit ? (rescore ? `COMMIT + RESCORE${noCrm ? ' (no CRM)' : ''}` : 'COMMIT (cleanup only)') : 'DRY RUN'} | min transcript length: ${minChars} chars\n`);

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
    const newConfidence = resolveSpeakerConfidence(confidence, cleanup.speakerVerdict);
    const confidenceRaised = newConfidence !== confidence;

    if (changed || confidenceRaised) {
      await query(
        'UPDATE calls SET transcript_text = $1, speaker_attribution_confidence = $2, updated_at = now() WHERE id = $3',
        [cleanup.text, newConfidence, c.id]
      );
      changedCallIds.push(c.id);
      if (cleanup.speakerLabelsSwapped) swappedCount++;
      console.log(`  updated ${c.id} (verdict: ${cleanup.speakerVerdict})`);
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
      await scoringQueue.add('score-journey', { journeyId: j.id, suppressCrm: noCrm }, { jobId: `rescore-journey-${j.id}-${ts}` });
    }
    console.log(`\nEnqueued ${affected.length} sales for re-scoring${noCrm ? ' (CRM write-back suppressed)' : ' — this re-pushes corrected results to the CRM'}. Ensure the scoring worker is running to process them.`);
  } else if (affected.length) {
    console.log('\nRe-run with --rescore (on the host where the scoring worker runs) to re-score these sales, or use the admin Re-score button per sale.');
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
