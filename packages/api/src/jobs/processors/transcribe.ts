import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { transcribeCall } from '../../services/transcription.js';
import { cleanupTranscript } from '../../services/transcript-cleanup.js';
import { getKBContext } from '../../services/kb.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { scoringQueue } from '../queue.js';
import type { Call } from '@callguard/shared';

export async function processTranscription(job: Job<{ callId: string }>) {
  const { callId } = job.data;
  console.log(`[Transcription] Processing call ${callId}`);

  const call = await queryOne<Call>(
    'SELECT * FROM calls WHERE id = $1',
    [callId]
  );

  if (!call) {
    throw new Error(`Call ${callId} not found`);
  }

  // Update status to transcribing
  await query(
    "UPDATE calls SET status = 'transcribing', updated_at = now() WHERE id = $1",
    [callId]
  );

  try {
    // Fetch agent names in this org to pass as Deepgram keyterms
    // (helps correctly transcribe agent names mentioned in the call)
    const agents = await query<{ name: string }>(
      "SELECT name FROM users WHERE organization_id = $1 AND role = 'member'",
      [call.organization_id]
    );
    const agentNames = agents.map((a) => a.name).filter(Boolean);

    const result = await transcribeCall(
      call.file_key,
      agentNames,
      (call as Call & { encrypted_at_rest?: boolean }).encrypted_at_rest ?? false
    );

    // Clean up transcript with LLM (pass org ID + KB context so Claude knows business details)
    console.log(`[Transcription] Cleaning up transcript for call ${callId}`);
    const kbContext = await getKBContext(call.organization_id);
    const cleanedText = await cleanupTranscript(result.text, call.organization_id, kbContext);

    // Store transcript
    await query(
      `UPDATE calls SET
        transcript_raw = $1,
        transcript_text = $2,
        duration_seconds = $3,
        status = 'transcribed',
        updated_at = now()
       WHERE id = $4`,
      [JSON.stringify(result.raw), cleanedText, result.duration_seconds, callId]
    );

    console.log(`[Transcription] Call ${callId} transcribed and cleaned successfully`);

    // Enqueue scoring
    await scoringQueue.add('score', { callId }, { jobId: `score-${callId}` });
  } catch (err) {
    await query(
      "UPDATE calls SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2",
      [(err as Error).message, callId]
    );
    evaluateAlertsForCall(callId, 'failed').catch((alertErr) => {
      console.error(`[Transcription] Failure alert evaluation failed:`, alertErr);
    });
    throw err;
  }
}
