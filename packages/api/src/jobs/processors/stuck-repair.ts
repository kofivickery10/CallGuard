import { Job } from 'bullmq';
import { query } from '../../db/client.js';
import { transcriptionQueue, scoringQueue } from '../queue.js';

// How long a call/journey may sit in a pre-terminal state before we assume its
// job was never enqueued (a Redis blip between the DB write and queue.add) or
// was lost, and re-enqueue it. Comfortably longer than any normal transcription
// or scoring run so we never double-process a job that is merely slow.
const STUCK_AFTER_MINUTES = 20;

/**
 * Periodic repair sweep for the "row committed, job never queued" gap (M2/M3).
 * ingestCall / assembleJourney write their status row and then enqueue as a
 * separate step; if the enqueue fails, nothing else ever retries it and the
 * call/journey is stranded silently. This re-enqueues anything stuck.
 *
 * All targets are idempotent to re-run: transcription overwrites the
 * transcript, score-journey upserts item scores and supersedes breaches, and a
 * fresh timestamped jobId sidesteps BullMQ's retained-completed-job dedup.
 */
export async function processStuckRepair(_job: Job): Promise<void> {
  const stuckCalls = await query<{ id: string }>(
    `SELECT id FROM calls
       WHERE status = 'uploaded'
         AND updated_at < now() - interval '1 minute' * $1`,
    [STUCK_AFTER_MINUTES]
  );
  for (const call of stuckCalls) {
    await transcriptionQueue
      .add('transcribe', { callId: call.id }, { jobId: `transcribe-repair-${call.id}-${Date.now()}` })
      .catch((err) => console.error(`[Repair] Failed to re-enqueue transcription for call ${call.id}:`, (err as Error).message));
  }

  const stuckJourneys = await query<{ id: string }>(
    `SELECT id FROM journeys
       WHERE status = 'pending'
         AND updated_at < now() - interval '1 minute' * $1`,
    [STUCK_AFTER_MINUTES]
  );
  for (const journey of stuckJourneys) {
    await scoringQueue
      .add('score-journey', { journeyId: journey.id }, { jobId: `score-journey-repair-${journey.id}-${Date.now()}` })
      .catch((err) => console.error(`[Repair] Failed to re-enqueue journey ${journey.id}:`, (err as Error).message));
  }

  if (stuckCalls.length > 0 || stuckJourneys.length > 0) {
    console.log(`[Repair] Re-enqueued ${stuckCalls.length} stuck call(s) and ${stuckJourneys.length} stuck journey(s)`);
  }
}
