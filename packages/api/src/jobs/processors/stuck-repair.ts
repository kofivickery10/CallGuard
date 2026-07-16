import { Job } from 'bullmq';
import { query } from '../../db/client.js';
import { transcriptionQueue, scoringQueue, ingestionQueue } from '../queue.js';

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
  let rehydrated = 0;
  let rescoredJourneys = 0;
  for (const journey of stuckJourneys) {
    // A pending journey may legitimately be waiting for its captured calls to
    // hydrate + transcribe — NOT stuck. Decide by the linked calls' states:
    //  - any still 'captured' → its hydrate-call job was lost; re-enqueue it.
    //  - any 'uploaded'/'transcribing' → mid-flight, its own completion will
    //    drive scoring; leave alone.
    //  - all terminal (transcribed/scored/failed/skipped) → the journey is
    //    genuinely ready but the score-journey enqueue was lost; re-enqueue it.
    const linked = await query<{ id: string; status: string }>(
      `SELECT c.id, c.status FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
        WHERE jc.journey_id = $1`,
      [journey.id]
    );
    const capturedIds = linked.filter((c) => c.status === 'captured').map((c) => c.id);
    const midFlight = linked.some((c) => c.status === 'uploaded' || c.status === 'transcribing');

    if (capturedIds.length > 0) {
      for (const callId of capturedIds) {
        await ingestionQueue
          .add('hydrate-call', { callId }, { jobId: `hydrate-repair-${callId}-${Date.now()}` })
          .catch((err) => console.error(`[Repair] Failed to re-enqueue hydration for call ${callId}:`, (err as Error).message));
        rehydrated++;
      }
    } else if (!midFlight) {
      await scoringQueue
        .add('score-journey', { journeyId: journey.id }, { jobId: `score-journey-repair-${journey.id}-${Date.now()}` })
        .catch((err) => console.error(`[Repair] Failed to re-enqueue journey ${journey.id}:`, (err as Error).message));
      rescoredJourneys++;
    }
  }

  if (stuckCalls.length > 0 || rehydrated > 0 || rescoredJourneys > 0) {
    console.log(
      `[Repair] Re-enqueued ${stuckCalls.length} stuck call(s), ${rehydrated} hydration(s), ${rescoredJourneys} journey score(s)`
    );
  }
}
