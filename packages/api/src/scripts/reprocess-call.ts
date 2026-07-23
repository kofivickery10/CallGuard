// Re-transcribe a single existing call through the FULL pipeline (Deepgram +
// cleanup), so a change to transcription settings — the narrowed redaction list
// and the compliance keyterms (services/transcription.ts), and the cleanup
// content-loss guard (services/transcript-cleanup.ts) — actually takes effect
// on that call. Re-running cleanup alone (bulk-reprocess-tenant.ts) is NOT
// enough: redaction and keyterm changes only apply on a fresh Deepgram run.
//
// Enqueues a `transcribe` job with a unique jobId (BullMQ dedupes on jobId, so
// the normal { jobId: callId } would be ignored for an already-processed call).
// The transcription WORKER must be running on the same host/Redis, or the job
// just sits in the queue.
//
// This does NOT re-score. A call that belongs to an already-scored journey is
// not auto-rescored (maybeScoreJourneyWhenReady leaves a scored journey alone);
// re-scoring is a deliberate admin action — do it AFTER this completes, via the
// admin "Re-score" button on the journey or rescore-tenant-journeys.ts.
//
// Usage:
//   tsx src/scripts/reprocess-call.ts <callId>            # dry run — reports only
//   tsx src/scripts/reprocess-call.ts <callId> --commit   # enqueue re-transcription
import { pool, queryOne } from '../db/client.js';
import { transcriptionQueue } from '../jobs/queue.js';

const MARKERS = ['fca', 'authorised and regulated', 'fully advised', 'recorded for training'];

async function main() {
  const callId = process.argv[2];
  const commit = process.argv.includes('--commit');
  if (!callId) { console.error('Usage: tsx src/scripts/reprocess-call.ts <callId> [--commit]'); process.exit(1); }

  const call = await queryOne<{
    id: string; organization_id: string; org_name: string; status: string;
    journey_id: string | null; customer_name: string | null;
    text_chars: number | null; raw_chars: number | null; transcript_text: string | null;
  }>(
    `SELECT c.id, c.organization_id, o.name AS org_name, c.status, c.journey_id,
            cust.name AS customer_name,
            length(c.transcript_text) AS text_chars,
            length(c.transcript_raw::text) AS raw_chars,
            c.transcript_text
       FROM calls c
       JOIN organizations o ON o.id = c.organization_id
       LEFT JOIN customers cust ON cust.id = c.customer_id
      WHERE c.id = $1`, [callId]);

  if (!call) { console.error('Call not found'); process.exit(1); }

  const lc = (call.transcript_text ?? '').toLowerCase();
  console.log('Call:', {
    id: call.id, org: call.org_name, customer: call.customer_name,
    status: call.status, journey_id: call.journey_id,
    transcript_text_chars: call.text_chars,
  });
  console.log('Current transcript contains:');
  for (const m of MARKERS) console.log(`  "${m}": ${lc.includes(m)}`);

  if (call.journey_id) {
    const j = await queryOne<{ status: string; overall_score: string | null; pass: boolean | null }>(
      'SELECT status, overall_score, pass FROM journeys WHERE id = $1', [call.journey_id]);
    console.log('Linked journey:', j);
  }

  if (!commit) {
    console.log('\nDRY RUN — nothing enqueued. Re-run with --commit to re-transcribe.');
    await pool.end();
    return;
  }

  const jobId = `retranscribe-${callId}-${process.env.RUN_TAG ?? 'manual'}`;
  await transcriptionQueue.add('transcribe', { callId }, { jobId });
  console.log(`\nEnqueued transcribe job (jobId=${jobId}).`);
  console.log('The transcription worker must be running to process it.');
  console.log('After it completes, re-score the journey deliberately:');
  console.log(`  - admin "Re-score" button on journey ${call.journey_id ?? '(none)'}, or`);
  console.log('  - tsx src/scripts/rescore-tenant-journeys.ts <org> --status=scored --commit');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
