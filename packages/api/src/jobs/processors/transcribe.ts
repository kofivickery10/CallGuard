import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { transcribeCall, resolveTenantRedactCategories } from '../../services/transcription.js';
import { cleanupTranscript, resolveSpeakerConfidence } from '../../services/transcript-cleanup.js';
import { assessSpeakerIntegrity, UNRELIABLE_SPEAKER_CONFIDENCE } from '../../services/speaker-integrity.js';
import { getKBContext } from '../../services/kb.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { recordUsage } from '../../services/usage.js';
import { getScoringSettings, hasUsableSaleTrigger } from '../../services/tenant-settings.js';
import { assembleJourney, maybeScoreJourneyWhenReady } from '../../services/journey.js';
import { scoringQueue } from '../queue.js';
import type { Call } from '@callguard/shared';

// A call's transcription-stage work is done — nothing left to redo on a
// retry — once it reaches either of these. 'transcribed' means Deepgram ran
// and the Haiku cleanup pass produced text; 'skipped' means Deepgram ran and
// came back with nothing usable (see the empty-transcript handling below),
// which is just as final an outcome as far as this job is concerned.
const TRANSCRIPTION_DONE_STATUSES = new Set(['transcribed', 'skipped']);

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

  // Idempotency guard against BullMQ retries.
  //
  // This job used to be one big try/catch wrapping Deepgram, the Haiku
  // cleanup pass, the DB write, AND the downstream journey-assembly/scoring
  // enqueue. A failure in that downstream tail (a Redis blip on
  // scoringQueue.add, say) was caught by the same block and rethrown for
  // BullMQ to retry — which re-ran Deepgram and Haiku from scratch on every
  // retry. Expensive, and worse: a fresh Deepgram/Haiku run does not
  // reproduce the same transcript byte-for-byte, so the retry would silently
  // overwrite an already-stored (and possibly already reviewed) transcript
  // with a different one.
  //
  // A retry must never silently replace an existing transcript with a
  // regenerated one — that is the property this guard protects. Once a call
  // has reached a terminal transcription state, any re-entry into this
  // function (a genuine BullMQ retry, or a superadmin manually retrying a
  // failed job) skips straight to the downstream routing below instead of
  // redoing the transcription work.
  const alreadyTranscribed = TRANSCRIPTION_DONE_STATUSES.has(call.status);

  const finalStatus = alreadyTranscribed
    ? (call.status as 'transcribed' | 'skipped')
    : await transcribeAndStore(job, call);

  if (alreadyTranscribed) {
    console.log(
      `[Transcription] Call ${callId} already at status='${call.status}' — retry skips straight to downstream routing`
    );
  }

  // Downstream: journey assembly / scoring-queue enqueue. Deliberately its
  // own try/catch, separate from transcribeAndStore's, so a failure here
  // retries only this step — see the idempotency guard above for why that
  // separation exists.
  await routeTranscribedCall(job, call, finalStatus);
}

/**
 * Shared final-attempt failure handling for both stages of this job
 * (transcription itself, and the downstream routing that follows it). BullMQ
 * retries either stage the same way; only on the LAST attempt do we flip the
 * call to 'failed' and fire the tenant failure alert — a transient blip on
 * attempt 1 of N must not flash the dashboard red for a call that succeeds on
 * the next try. Note this only ever touches `status`/`error_message`, never
 * the transcript columns, so a downstream failure recorded here does not
 * disturb a transcript that was already stored successfully.
 */
async function markFailedIfFinalAttempt(
  job: Job<{ callId: string }>,
  callId: string,
  err: unknown
): Promise<void> {
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
}

/**
 * Deepgram + the Haiku cleanup pass + the transcript DB write. The expensive,
 * non-deterministic half of this job — only reached when processTranscription's
 * idempotency guard has confirmed there is nothing already stored for this
 * pass.
 */
async function transcribeAndStore(
  job: Job<{ callId: string }>,
  call: Call
): Promise<'transcribed' | 'skipped'> {
  const callId = call.id;

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

    // Per-tenant stereo channel mapping (which channel is the adviser), plus
    // the org's own name and domain vocabulary (migration 058) for keyterm
    // boosting — tenant terms are boosted ahead of the generic core list.
    // pii_unredacted_categories is NOT selected here: resolveTenantRedactCategories
    // below is the one place that loads and resolves that column, so batch and
    // live cannot drift on redaction policy again — see its comment.
    const orgRow = await queryOne<{
      name: string | null;
      adviser_channel: number | null;
      keyterms: string[] | null;
    }>(
      'SELECT name, adviser_channel, keyterms FROM organizations WHERE id = $1',
      [call.organization_id]
    );
    const tenantKeyterms = [
      ...(orgRow?.name ? [orgRow.name] : []),
      ...(orgRow?.keyterms ?? []),
      ...agentNames,
    ];
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

    const redactCategories = await resolveTenantRedactCategories(call.organization_id);

    const result = await transcribeCall(
      call.file_key,
      tenantKeyterms,
      (call as Call & { encrypted_at_rest?: boolean }).encrypted_at_rest ?? false,
      orgRow?.adviser_channel ?? null,
      scoringSettings.transcriptionMode,
      scoringSettings.deepgramRegion,
      monoFirstSpeaker,
      redactCategories
    );

    // Record Deepgram usage (billed per minute of audio) — the call was
    // still transcribed (and billed) even if the result below turns out to
    // carry no usable text.
    await recordUsage({
      organizationId: call.organization_id,
      callId,
      provider: 'deepgram',
      operation: 'transcribe',
      modelId: 'nova-3',
      audioSeconds: result.duration_seconds,
      deepgramMultichannel: scoringSettings.transcriptionMode === 'stereo_multichannel',
    });

    // A transcript with no usable text at all (see the fallback logging in
    // transcribeCall) cannot be cleaned up — there is nothing for Haiku to
    // verify — and must not be scored as if it were evidence: scored against
    // every non-consent checkpoint, an empty transcript reads as "every
    // disclosure went unaddressed" for a call where nothing was ever heard.
    // Route it the same way jobs/processors/score.ts routes a transcript too
    // short to evaluate meaningfully: the dedicated 'skipped' status
    // (migration 028) — not scored, and not a processing failure either.
    if (!result.text.trim()) {
      const reason = 'Skipped: transcription produced no usable text (Deepgram returned nothing for this audio — likely silent or corrupted)';
      await query(
        `UPDATE calls SET
          transcript_raw = $1,
          transcript_text = $2,
          duration_seconds = $3,
          status = 'skipped',
          error_message = $4,
          updated_at = now()
         WHERE id = $5`,
        [JSON.stringify(result.raw), result.text, result.duration_seconds, reason, callId]
      );
      console.log(`[Transcription] Call ${callId} ${reason}`);
      return 'skipped';
    }

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
    // A swap OR a positive content-confirmation both mean the Agent/Customer
    // split is now content-verified — strong enough to raise the stored
    // confidence above the consent-gate floor so a genuinely-correct mono call
    // no longer routes every consent gate to manual review. 'unclear' (no
    // strong evidence either way) leaves the heuristic confidence untouched.
    let speakerAttributionConfidence = resolveSpeakerConfidence(
      result.speaker_attribution_confidence,
      cleanup.speakerVerdict,
      result.adviser_identified_by_content
    );

    // Deterministic cross-check on the labels the cleanup pass just blessed.
    // The cleanup verdict is the only thing that can lift a mono call above the
    // consent-gate floor, so it cannot be the sole judge of its own work: an
    // observed 33-minute call was 'confirmed' with the labels inverted across
    // most of it, which auto-scored every consent gate and produced a critical
    // breach quoting the customer as if they were the adviser. Where the content
    // markers contradict the verdict, we refuse the lift and pin confidence
    // below the floor (services/speaker-integrity.ts).
    const integrity = assessSpeakerIntegrity(cleanup.text, cleanup.speakerVerdict);
    if (integrity.flag) {
      speakerAttributionConfidence = Math.min(
        speakerAttributionConfidence,
        UNRELIABLE_SPEAKER_CONFIDENCE
      );
      console.warn(
        `[Transcription] Call ${callId}: speaker attribution flagged as ${integrity.flag} — ` +
          `${integrity.detail}. Confidence pinned to ${speakerAttributionConfidence}; ` +
          `consent gates will route to manual review.`
      );
    }

    // Store transcript
    await query(
      `UPDATE calls SET
        transcript_raw = $1,
        transcript_text = $2,
        duration_seconds = $3,
        speaker_attribution_confidence = $4,
        speaker_integrity_flag = $5,
        status = 'transcribed',
        -- A retry that succeeds must clear the last failure's text, or the
        -- superadmin panel keeps showing a dead error against a healthy call
        -- (a whole tenant's calls read as broken for days that way).
        error_message = NULL,
        updated_at = now()
       WHERE id = $6`,
      [
        JSON.stringify(result.raw),
        cleanup.text,
        result.duration_seconds,
        speakerAttributionConfidence,
        integrity.flag,
        callId,
      ]
    );

    console.log(`[Transcription] Call ${callId} transcribed and cleaned successfully`);
    return 'transcribed';
  } catch (err) {
    await markFailedIfFinalAttempt(job, callId, err);
    throw err;
  }
}

/**
 * Journey assembly / scoring-queue enqueue for a call whose transcription
 * stage is already done (freshly, via transcribeAndStore, or on a retry that
 * skipped straight here — see processTranscription's idempotency guard).
 */
async function routeTranscribedCall(
  job: Job<{ callId: string }>,
  call: Call,
  finalStatus: 'transcribed' | 'skipped'
): Promise<void> {
  const callId = call.id;

  try {
    const scoringSettings = await getScoringSettings(call.organization_id);

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
      // reached a terminal transcription state (which 'skipped' counts as —
      // see maybeScoreJourneyWhenReady), the journey is scored as a whole.
      await maybeScoreJourneyWhenReady(journeyId);
    } else if (scoringSettings.scoringScope === 'sales_only' && saleFlagged && customerId) {
      console.log(`[Transcription] Call ${callId} manually flagged as a sale — assembling journey for customer ${customerId}`);
      await assembleJourney({ organizationId: call.organization_id, customerId, triggerSource: 'manual' });
    } else if (finalStatus === 'skipped') {
      // Nothing to score on its own, and not part of a journey or a manually
      // flagged sale — see the empty-transcript handling in transcribeAndStore.
      // Must not reach the scoring queue: score.ts treats an empty
      // transcript_text as "call not found or has no transcript" and throws,
      // which would just bounce this straight to 'failed'.
      console.log(`[Transcription] Call ${callId} not enqueued for scoring — no usable transcript (status=skipped)`);
    } else if (deferToSaleTrigger) {
      console.log(`[Transcription] Call ${callId} held for Zoho sale trigger (scoring_scope=sales_only)`);
    } else {
      await scoringQueue.add('score', { callId }, { jobId: `score-${callId}` });
    }
  } catch (err) {
    await markFailedIfFinalAttempt(job, callId, err);
    throw err;
  }
}
