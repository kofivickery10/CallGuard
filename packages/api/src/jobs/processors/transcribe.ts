import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { transcribeCall } from '../../services/transcription.js';
import { cleanupTranscript } from '../../services/transcript-cleanup.js';
import { getKBContext } from '../../services/kb.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { recordUsage } from '../../services/usage.js';
import { getScoringSettings } from '../../services/tenant-settings.js';
import { scoringQueue } from '../queue.js';
import type { Call } from '@callguard/shared';

async function hasUsableSaleTrigger(organizationId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM zoho_connections
      WHERE organization_id = $1 AND status = 'active' AND inbound_secret_encrypted IS NOT NULL`,
    [organizationId]
  );
  return !!row;
}

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
      "SELECT name FROM users WHERE organization_id = $1 AND role = 'adviser'",
      [call.organization_id]
    );
    const agentNames = agents.map((a) => a.name).filter(Boolean);

    // Per-tenant stereo channel mapping (which channel is the adviser).
    const orgRow = await queryOne<{ adviser_channel: number | null }>(
      'SELECT adviser_channel FROM organizations WHERE id = $1',
      [call.organization_id]
    );
    const scoringSettings = await getScoringSettings(call.organization_id);

    const result = await transcribeCall(
      call.file_key,
      agentNames,
      (call as Call & { encrypted_at_rest?: boolean }).encrypted_at_rest ?? false,
      orgRow?.adviser_channel ?? null,
      scoringSettings.transcriptionMode,
      scoringSettings.deepgramRegion
    );

    // Record Deepgram usage (billed per minute of audio).
    await recordUsage({
      organizationId: call.organization_id,
      callId,
      provider: 'deepgram',
      operation: 'transcribe',
      modelId: 'nova-3',
      audioSeconds: result.duration_seconds,
    });

    // Clean up transcript with LLM (pass org ID + KB context so Claude knows business details)
    console.log(`[Transcription] Cleaning up transcript for call ${callId}`);
    const kbContext = await getKBContext(call.organization_id);
    const cleanedText = await cleanupTranscript(result.text, call.organization_id, kbContext, callId);

    // Store transcript
    await query(
      `UPDATE calls SET
        transcript_raw = $1,
        transcript_text = $2,
        duration_seconds = $3,
        speaker_attribution_confidence = $4,
        status = 'transcribed',
        updated_at = now()
       WHERE id = $5`,
      [
        JSON.stringify(result.raw),
        cleanedText,
        result.duration_seconds,
        result.speaker_attribution_confidence,
        callId,
      ]
    );

    console.log(`[Transcription] Call ${callId} transcribed and cleaned successfully`);

    // Cost-control triage (spec §16): 'sales_only' defers per-call scoring
    // and waits for the Zoho sale-trigger webhook to score a journey instead
    // (jobs/processors/score-journey.ts) — but ONLY when the org actually has
    // a working trigger configured. Deferring with no configured trigger
    // would silently stop scoring forever for that org, so this falls back
    // to scoring every call immediately (today's behaviour) until the org
    // sets up their Zoho inbound secret.
    const deferToSaleTrigger =
      scoringSettings.scoringScope === 'sales_only' &&
      (await hasUsableSaleTrigger(call.organization_id));

    if (deferToSaleTrigger) {
      console.log(`[Transcription] Call ${callId} held for Zoho sale trigger (scoring_scope=sales_only)`);
    } else {
      await scoringQueue.add('score', { callId }, { jobId: `score-${callId}` });
    }
  } catch (err) {
    // BullMQ retries this job (see queue.ts). Only surface the call as
    // 'failed' — and alert the tenant — once retries are exhausted; otherwise
    // a single transient Deepgram/network blip fires a false failure alert
    // and flips the dashboard red for a call that succeeds on the next try.
    const totalAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= totalAttempts;
    if (isFinalAttempt) {
      await query(
        "UPDATE calls SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2",
        [(err as Error).message, callId]
      );
      evaluateAlertsForCall(callId, 'failed').catch((alertErr) => {
        console.error(`[Transcription] Failure alert evaluation failed:`, alertErr);
      });
    } else {
      console.warn(
        `[Transcription] Call ${callId} failed on attempt ${job.attemptsMade + 1}/${totalAttempts}, will retry:`,
        (err as Error).message
      );
    }
    throw err;
  }
}
