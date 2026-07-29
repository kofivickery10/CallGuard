/**
 * Recover calls whose stored audio has gone missing from disk.
 *
 * A call can hold a valid `file_key` pointing at a file that is not there. The
 * case this was written for: calls hydrated by a worker running on a
 * DIFFERENT HOST to the one now processing them. CallGuard stores audio on the
 * local filesystem, so a call hydrated by a developer's machine writes the file
 * there and records a path the production server has never had. Re-transcribing
 * such a call fails with ENOENT, and the call lands in 'failed' with its old
 * transcript still attached — which reads as a transcription problem rather
 * than a missing file.
 *
 * Deepgram never sees the audio in that state, so nothing downstream improves
 * until the file is fetched onto the host that will actually process it.
 *
 * Resets each call to 'captured' and clears file_key, then enqueues
 * hydrate-call. Hydration re-fetches from the dialler (by recording_pointer, or
 * by call id where the pointer was never stored — the backfill path leaves it
 * null deliberately so hydration gets a fresh, unexpired URL), writes the audio
 * on THIS host, and chains into transcription.
 *
 * MUST run on the host whose worker will process the queue. Running it from a
 * machine whose Redis no worker is watching enqueues jobs nobody executes, and
 * recreates the same class of problem it exists to fix.
 *
 * Usage:
 *   ORG=<uuid> npx tsx src/scripts/rehydrate-missing-audio.ts            # dry run
 *   ORG=<uuid> npx tsx src/scripts/rehydrate-missing-audio.ts --commit
 *   CALLS=<uuid,uuid> npx tsx src/scripts/rehydrate-missing-audio.ts --commit
 */

import { pool, query } from '../db/client.js';
import { ingestionQueue } from '../jobs/queue.js';

const orgId = process.env.ORG;
const explicitCalls = (process.env.CALLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const commit = process.argv.includes('--commit');

if (!orgId && explicitCalls.length === 0) {
  console.error('ORG or CALLS is required');
  process.exit(1);
}

async function main() {
  // ENOENT is the specific signature of "the row is fine, the file is gone".
  // Deliberately narrow: a call that failed for any other reason should not be
  // silently re-hydrated, because re-fetching audio would not address it.
  const rows = explicitCalls.length > 0
    ? await query<{ id: string; duration_seconds: string | null; error_message: string | null }>(
        `SELECT id, duration_seconds, error_message FROM calls WHERE id = ANY($1::uuid[])`,
        [explicitCalls]
      )
    : await query<{ id: string; duration_seconds: string | null; error_message: string | null }>(
        `SELECT id, duration_seconds, error_message
           FROM calls
          WHERE organization_id = $1
            AND status = 'failed'
            AND error_message LIKE '%ENOENT%'
          ORDER BY duration_seconds DESC NULLS LAST`,
        [orgId as string]
      );

  if (rows.length === 0) {
    console.log('No calls with missing audio to recover.');
    await pool.end();
    process.exit(0);
  }

  const mins = rows.reduce((n, r) => n + Number(r.duration_seconds ?? 0), 0) / 60;
  console.log(
    `Calls to re-hydrate: ${rows.length} (~${mins.toFixed(0)} audio minutes)` +
      `${commit ? '' : '  — DRY RUN'}\n`
  );
  for (const r of rows) {
    console.log(`  ${r.id}  ${((Number(r.duration_seconds ?? 0)) / 60).toFixed(1)} min`);
  }

  if (!commit) {
    console.log('\nDry run. Re-run with --commit to reset these to captured and enqueue hydration.');
    console.log('Must be run on the host whose worker is consuming the queue.');
    await pool.end();
    process.exit(0);
  }

  for (const r of rows) {
    // Clearing file_key matters: hydrate-call writes a new one, and leaving the
    // stale path would survive a failure and point at nothing again. The
    // transcript is deliberately left in place — it is the only copy until the
    // new one lands, and a half-recovered call with no transcript is worse than
    // one with an old transcript.
    await query(
      `UPDATE calls
          SET status = 'captured', file_key = NULL, error_message = NULL, updated_at = now()
        WHERE id = $1`,
      [r.id]
    );
    await ingestionQueue.add(
      'hydrate-call',
      { callId: r.id },
      {
        // Unique jobId: the fixed `hydrate-${callId}` form used at assembly is
        // deduped by BullMQ and would be ignored for a call hydrated before.
        jobId: `rehydrate-${r.id}-${process.pid}`,
        attempts: 6,
        backoff: { type: 'exponential', delay: 60_000 },
      }
    );
    console.log(`  enqueued ${r.id}`);
  }

  console.log(
    `\nEnqueued ${rows.length} hydration job(s). The worker fetches the audio, then ` +
      `transcription chains automatically. Re-score afterwards as a separate step.`
  );
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[Rehydrate] failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
