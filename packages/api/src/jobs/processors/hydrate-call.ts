import { Job } from 'bullmq';
import path from 'path';
import { query, queryOne } from '../../db/client.js';
import { getDialerConnection } from '../../services/tenant-settings.js';
import { fetchRecordingUrlByCallId, cloudTalkBasicAuthHeader } from '../../services/cloudtalk.js';
import { fetchRemoteAudio } from '../../services/ingestion.js';
import { uploadFile } from '../../services/storage.js';
import { maybeScoreJourneyWhenReady } from '../../services/journey.js';
import { transcriptionQueue } from '../queue.js';
import type { Call } from '@callguard/shared';

/**
 * Hydrate a 'captured' call (metadata-only, no audio) into a transcribable one,
 * driven by a Zoho sale trigger via assembleJourney (services/journey.ts). The
 * capture path recorded the CloudTalk call UUID + a recording pointer but did
 * not download the audio; here we fetch the recording, store it, flip the call
 * to 'uploaded' and enqueue transcription. When the last call in the journey
 * finishes transcribing, the transcribe processor scores the journey.
 */
export async function processHydrateCall(job: Job<{ callId: string }>) {
  const { callId } = job.data;

  const call = await queryOne<Call & { recording_pointer: string | null }>(
    'SELECT * FROM calls WHERE id = $1',
    [callId]
  );
  if (!call) throw new Error(`Call ${callId} not found`);

  // Idempotent: only a 'captured' call needs hydrating. A retry that lands
  // after the audio was already fetched (status advanced) is a no-op.
  if (call.status !== 'captured') {
    console.log(`[HydrateCall] ${callId} already hydrated (status=${call.status}), skipping`);
    return;
  }

  const conn = call.dialer_connection_id
    ? await getDialerConnection(call.organization_id, 'cloudtalk')
    : null;

  try {
    // Prefer the pointer captured with the webhook; otherwise fetch a fresh URL
    // by the CloudTalk call UUID (external_id — unless it's the hashed fallback
    // form used when the webhook carried no native call id).
    let recordingUrl = call.recording_pointer;
    const cloudtalkCallId =
      call.external_id && !call.external_id.startsWith('cloudtalk:') ? call.external_id : null;
    if (!recordingUrl && conn && cloudtalkCallId) {
      recordingUrl = await fetchRecordingUrlByCallId(conn, cloudtalkCallId);
    }
    if (!recordingUrl) {
      // Retry (see the job's backoff in services/journey.ts) — the recording may
      // simply still be processing on CloudTalk's side.
      throw new Error(`No recording URL available yet for captured call ${callId}`);
    }

    const headers = conn ? cloudTalkBasicAuthHeader(conn) ?? {} : {};
    const downloaded = await fetchRemoteAudio(recordingUrl, headers);

    const safeFileName = path.basename(downloaded.fileName);
    const fileKey = `calls/${call.organization_id}/${call.id}/${safeFileName}`;
    await uploadFile(fileKey, downloaded.buffer, downloaded.mimeType);

    // Guarded on status='captured' so a concurrent retry can't double-advance.
    await query(
      `UPDATE calls SET
         file_name = $2, file_key = $3, file_size_bytes = $4, mime_type = $5,
         encrypted_at_rest = true, status = 'uploaded', updated_at = now()
       WHERE id = $1 AND status = 'captured'`,
      [callId, safeFileName, fileKey, downloaded.buffer.length, downloaded.mimeType]
    );

    await transcriptionQueue.add('transcribe', { callId }, { jobId: callId });
    console.log(
      `[HydrateCall] ${callId} hydrated (${downloaded.buffer.length} bytes) → transcription queued`
    );
  } catch (err) {
    // On the final attempt, mark the call failed rather than leaving it
    // 'captured' forever — otherwise its journey stays 'pending' indefinitely
    // and stuck-repair keeps re-hydrating it. Marking it terminal lets the
    // journey score with whatever other calls did hydrate (or fail outright if
    // none did). Earlier attempts just rethrow so BullMQ retries.
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      console.error(`[HydrateCall] ${callId} failed after final attempt — marking failed:`, (err as Error).message);
      await query(
        "UPDATE calls SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2 AND status = 'captured'",
        [`Hydration failed: ${(err as Error).message}`.slice(0, 500), callId]
      );
      const journeyId = (call as Call & { journey_id?: string | null }).journey_id ?? null;
      if (journeyId) await maybeScoreJourneyWhenReady(journeyId);
    }
    throw err;
  }
}
