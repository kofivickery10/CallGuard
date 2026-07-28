import { Job } from 'bullmq';
import { transcriptionQueue, scoringQueue, ingestionQueue } from '../queue.js';
import { findStuckCalls, findStuckJourneys } from '../../services/stuck.js';

export interface StuckRepairResult {
  hydrated: number;
  transcribed: number;
  scored: number;
  journeys: number;
}

/**
 * Periodic repair sweep for the "row committed, job never queued" gap (M2/M3).
 * ingestCall / assembleJourney write their status row and then enqueue as a
 * separate step; if the enqueue fails, nothing else ever retries it and the
 * call/journey is stranded silently. This re-enqueues anything stuck, and also
 * covers jobs that started and never came back.
 *
 * What counts as stuck lives in services/stuck.ts, shared with the superadmin
 * health check — previously this sweep only handled calls at 'uploaded' while
 * health reported four statuses as stuck, so the panel showed a backlog nothing
 * was even trying to clear.
 *
 * All targets are idempotent to re-run: transcription overwrites the
 * transcript, score-journey upserts item scores and supersedes breaches, and a
 * fresh timestamped jobId sidesteps BullMQ's retained-completed-job dedup.
 */
export async function processStuckRepair(_job?: Job): Promise<StuckRepairResult> {
  const result: StuckRepairResult = { hydrated: 0, transcribed: 0, scored: 0, journeys: 0 };

  const stuckCalls = await findStuckCalls();
  for (const call of stuckCalls) {
    const stamp = Date.now();
    try {
      if (call.action === 'hydrate') {
        await ingestionQueue.add('hydrate-call', { callId: call.id }, { jobId: `hydrate-repair-${call.id}-${stamp}` });
        result.hydrated++;
      } else if (call.action === 'transcribe') {
        await transcriptionQueue.add('transcribe', { callId: call.id }, { jobId: `transcribe-repair-${call.id}-${stamp}` });
        result.transcribed++;
      } else {
        await scoringQueue.add('score', { callId: call.id }, { jobId: `score-repair-${call.id}-${stamp}` });
        result.scored++;
      }
    } catch (err) {
      console.error(
        `[Repair] Failed to re-enqueue ${call.action} for call ${call.id} (${call.status}):`,
        (err as Error).message
      );
    }
  }

  // A journey's own repair: 'wait' means a linked call is still legitimately
  // mid-flight and its completion will drive scoring, so leave it alone.
  for (const journey of await findStuckJourneys()) {
    if (journey.action === 'wait') continue;
    const stamp = Date.now();
    try {
      if (journey.action === 'hydrate') {
        for (const callId of journey.captured_call_ids) {
          await ingestionQueue.add('hydrate-call', { callId }, { jobId: `hydrate-repair-${callId}-${stamp}` });
          result.hydrated++;
        }
      } else {
        await scoringQueue.add(
          'score-journey',
          { journeyId: journey.id },
          { jobId: `score-journey-repair-${journey.id}-${stamp}` }
        );
      }
      result.journeys++;
    } catch (err) {
      console.error(`[Repair] Failed to re-enqueue journey ${journey.id}:`, (err as Error).message);
    }
  }

  const total = result.hydrated + result.transcribed + result.scored + result.journeys;
  if (total > 0) {
    console.log(
      `[Repair] Re-enqueued ${result.transcribed} transcription(s), ${result.hydrated} hydration(s), ` +
      `${result.scored} call score(s), ${result.journeys} journey(s)`
    );
  }
  return result;
}
