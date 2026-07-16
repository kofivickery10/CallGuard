import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { transcribeCall } from '../../services/transcription.js';
import { cleanupTranscript } from '../../services/transcript-cleanup.js';
import { getKBContext } from '../../services/kb.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { recordUsage } from '../../services/usage.js';
import { getScoringSettings, hasUsableSaleTrigger } from '../../services/tenant-settings.js';
import { assembleJourney, maybeScoreJourneyWhenReady } from '../../services/journey.js';
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

    // A per-call direction (from the dialler's webhook, when it carries one)
    // overrides the tenant's static mono_first_speaker default — it's a
    // stronger signal since it's specific to this call, not an assumption
    // about the tenant's calling pattern as a whole.
    const callDirection = (call as Call & { direction?: 'inbound' | 'outbound' | null }).direction ?? null;
    const monoFirstSpeaker =
      callDirection === 'outbound' ? 'customer' : callDirection === 'inbound' ? 'agent' : scoringSettings.monoFirstSpeaker;

    // A captured call reaches transcription only after hydration has fetched
    // and stored its audio (set file_key). A null here means it was enqueued
    // before hydration — a bug, not a transient — so fail loudly rather than
    // hand null to the transcriber.
    if (!call.file_key) {
      throw new Error(`Call ${callId} has no file_key — not hydrated before transcription`);
    }

    const result = await transcribeCall(
      call.file_key,
      agentNames,
      (call as Call & { encrypted_at_rest?: boolean }).encrypted_at_rest ?? false,
      orgRow?.adviser_channel ?? null,
      scoringSettings.transcriptionMode,
      scoringSettings.deepgramRegion,
      monoFirstSpeaker
    );

    // Record Deepgram usage (billed per minute of audio).
    await recordUsage({
      organizationId: call.organization_id,
      callId,
      provider: 'deepgram',
      operation: 'transcribe',
      modelId: 'nova-3',
      audioSeconds: result.duration_seconds,
      deepgramMultichannel: scoringSettings.transcriptionMode === 'stereo_multichannel',
    });

    // Clean up transcript with LLM (pass org ID + KB context so Claude knows business details).
    // Below-1.0 confidence (mono-diarisation guess, not a pinned stereo channel)
    // also has Claude verify the Agent/Customer split against conversational
    // content — a safety net independent of the direction/heuristic that
    // produced result.text, catching cases like a misconfigured tenant default
    // or a call that doesn't match its usual direction.
    console.log(`[Transcription] Cleaning up transcript for call ${callId}`);
    const kbContext = await getKBContext(call.organization_id);
    const cleanup = await cleanupTranscript(
      result.text,
      call.organization_id,
      kbContext,
      callId,
      result.speaker_attribution_confidence
    );
    if (cleanup.speakerLabelsSwapped) {
      console.warn(`[Transcription] Call ${callId}: AI cleanup swapped Agent/Customer labels (heuristic guess was likely backwards)`);
    }
    // Content-verified either way (confirmed or corrected) is more reliable
    // than the raw first-speaker heuristic alone — but only a swap is a
    // strong enough positive signal to actually raise the stored confidence.
    const speakerAttributionConfidence = cleanup.speakerLabelsSwapped
      ? Math.max(result.speaker_attribution_confidence, 0.75)
      : result.speaker_attribution_confidence;

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
        cleanup.text,
        result.duration_seconds,
        speakerAttributionConfidence,
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

    // A call manually flagged as a sale at upload (see routes/calls.ts) short-
    // circuits the defer/score-immediately choice above: assemble + score a
    // journey for this customer right away, the same way the Zoho sale-trigger
    // webhook would, instead of waiting on a CRM event that will never come
    // for a manually-uploaded call. Falls through to the normal branches below
    // if there's no linked customer (no phone was given) to attach a journey to.
    const saleFlagged = (call as Call & { sale_flagged?: boolean }).sale_flagged === true;
    const customerId = (call as Call & { customer_id?: string | null }).customer_id ?? null;
    const journeyId = (call as Call & { journey_id?: string | null }).journey_id ?? null;

    if (journeyId) {
      // This call was hydrated as part of a journey (Zoho sale trigger). It is
      // never scored on its own — once every call linked to the journey has
      // been transcribed, the journey is scored as a whole.
      await maybeScoreJourneyWhenReady(journeyId);
    } else if (scoringSettings.scoringScope === 'sales_only' && saleFlagged && customerId) {
      console.log(`[Transcription] Call ${callId} manually flagged as a sale — assembling journey for customer ${customerId}`);
      await assembleJourney({ organizationId: call.organization_id, customerId, triggerSource: 'manual' });
    } else if (deferToSaleTrigger) {
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
