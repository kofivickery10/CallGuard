import { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { scoreTranscript, normalizeScore } from '../../services/scoring.js';
import { getKBContext } from '../../services/kb.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { getLearningContext } from '../../services/learning-context.js';
import { recordUsage } from '../../services/usage.js';
import { deliverCallScored } from '../../services/webhook-delivery.js';
import { pushCallScored } from '../../services/zoho.js';
import { getScoringSettings } from '../../services/tenant-settings.js';
import { maybeStartCallCapture } from '../../services/capture-runs.js';
import {
  classifyItems,
  CONSENT_SPEAKER_CONFIDENCE_FLOOR,
  routesToReviewOnConfidence,
} from '../../services/checkpoint-classification.js';
import { hasFeature, isItemPass, deriveSeverity, callPasses, resolveBranch } from '@callguard/shared';
import type { Call, Scorecard, ScorecardItem, Plan, WebhookCallScoredPayload } from '@callguard/shared';

export async function processScoring(job: Job<{ callId: string }>) {
  const { callId } = job.data;
  console.log(`[Scoring] Processing call ${callId}`);

  const call = await queryOne<
    Call & {
      speaker_attribution_confidence: number | null;
      speaker_integrity_flag: string | null;
      customer_id: string | null;
    }
  >('SELECT * FROM calls WHERE id = $1', [callId]);

  if (!call || !call.transcript_text) {
    throw new Error(`Call ${callId} not found or has no transcript`);
  }

  const scoringSettings = await getScoringSettings(call.organization_id);

  // Skip calls too short to score meaningfully (wrong numbers, voicemails,
  // instant hangups). Either too few words OR — when duration is known — too
  // short trips it. Per-tenant thresholds (default: the historical globals).
  // Not a failure: dedicated status.
  const wordCount = call.transcript_text.trim().split(/\s+/).filter(Boolean).length;
  const durationSeconds = Number(call.duration_seconds ?? 0);
  const tooFewWords = wordCount < scoringSettings.minScoreableWords;
  const tooShortDuration = durationSeconds > 0 && durationSeconds < scoringSettings.minScoreableSeconds;

  if (tooFewWords || tooShortDuration) {
    const reason = `Skipped scoring: too short to evaluate (${wordCount} words` +
      (durationSeconds > 0 ? `, ${durationSeconds.toFixed(0)}s` : '') + ')';
    await query(
      "UPDATE calls SET status = 'skipped', error_message = $2, updated_at = now() WHERE id = $1",
      [callId, reason]
    );
    console.log(`[Scoring] Call ${callId} ${reason}`);
    return;
  }

  // Update status
  await query(
    "UPDATE calls SET status = 'scoring', updated_at = now() WHERE id = $1",
    [callId]
  );

  try {
    // Pick the scorecard:
    //   1. The caller-specified scorecard on the call (per-campaign BPO use case)
    //   2. Otherwise the org's active scorecard
    let scorecard: Scorecard | null = null;

    const callScorecardId = call.scorecard_id;
    if (callScorecardId) {
      scorecard = await queryOne<Scorecard>(
        'SELECT * FROM scorecards WHERE id = $1 AND organization_id = $2',
        [callScorecardId, call.organization_id]
      );
      if (!scorecard) {
        throw new Error(
          `Specified scorecard ${callScorecardId} not found for this organization`
        );
      }
    }

    if (!scorecard) {
      // Deterministic fallback: the org's oldest active scorecard, not
      // "whichever row Postgres happens to return first" (LIMIT with no
      // ORDER BY). Orgs intentionally running several scorecards (BPOs
      // scoring different campaigns differently) select one explicitly per
      // call via scorecardId above; this path is only reached when they
      // don't, so more than one active scorecard here is worth a log line —
      // it means some calls are silently landing on an arbitrary one.
      const activeScorecards = await query<Scorecard>(
        'SELECT * FROM scorecards WHERE organization_id = $1 AND is_active = true ORDER BY created_at ASC',
        [call.organization_id]
      );
      if (activeScorecards.length > 1) {
        console.warn(
          `[Scoring] Org ${call.organization_id} has ${activeScorecards.length} active scorecards and call ${callId} specified none — defaulting to the oldest (${activeScorecards[0]!.id})`
        );
      }
      scorecard = activeScorecards[0] ?? null;
    }

    if (!scorecard) {
      throw new Error('No active scorecard found for this organization');
    }

    const items = await query<ScorecardItem>(
      'SELECT * FROM scorecard_items WHERE scorecard_id = $1 AND archived_at IS NULL ORDER BY sort_order',
      [scorecard.id]
    );

    if (items.length === 0) {
      throw new Error('Scorecard has no items');
    }

    // Branch detection FIRST (spec §8.2): resolves which of the scorecard's
    // branches (e.g. On Risk vs Referred) applies, before anything is scored.
    const branch = resolveBranch(call.transcript_text, scorecard.branch_config);

    // Split into what's actually sent to Claude vs what resolves to a
    // terminal na/manual_review state up front — na (branch-excluded) and
    // manual (item_type='manual', or a consent_gate item whose speaker
    // attribution is too unreliable to trust) are never auto-scored and are
    // excluded from the weighted denominator.
    const { scoreable, na, manualReview, provisional } = classifyItems(
      items,
      branch,
      call.speaker_attribution_confidence
    );
    // Provisional items (consent gates under the speaker-confidence floor) are
    // AI-scored alongside the rest; their verdict is stored on the
    // manual_review row for the reviewer to confirm (never auto-passed).
    const aiItems = [...scoreable, ...provisional];

    if (aiItems.length === 0) {
      throw new Error(
        `No AI-scoreable items for branch "${branch ?? 'default'}" (${na.length} na, ${manualReview.length} manual)`
      );
    }

    // Check org's plan for coaching feature gate
    const org = await queryOne<{ plan: Plan; industry: string | null }>(
      'SELECT plan, industry FROM organizations WHERE id = $1',
      [call.organization_id]
    );
    const coachingEnabled = org ? hasFeature(org.plan, 'coaching') : false;

    // Score with Claude (inject KB context + tenant learning context)
    const kbContext = await getKBContext(call.organization_id);
    const learning = org
      ? await getLearningContext(
          call.organization_id,
          org.plan,
          scoreable.map((i) => i.id),
          call.agent_id
        )
      : undefined;

    const { output, usage, model } = await scoreTranscript(
      call.transcript_text,
      aiItems.map((i) => ({
        id: i.id,
        label: i.label,
        description: i.description,
        score_type: i.score_type,
        expectation: i.expectation,
        ai_check: i.ai_check,
        consent_gate: i.consent_gate,
      })),
      null,       // use default model
      kbContext,
      learning,
      coachingEnabled,
      org?.industry ?? null,
      false, // journeyMode
      [],    // productsSold — product-aware scoring is journey-level
      // Judge who spoke from content, not the label, whenever the labels are
      // not trustworthy — either actively contradicted (integrity flag) or
      // never established (attribution abstained, leaving a positional guess
      // measured at 1 in 3, or never even attempted). Mirrors score-journey.ts;
      // the per-call path had the same gap.
      //
      // A NULL confidence must trip this, not slide past it: NULL means we
      // never established who was speaking at all, which is strictly LESS
      // trustworthy than a measured low score, not more. Reading NULL as
      // "fully confident" (`!== null` before the floor check) is what let
      // live-streamed calls — which have no stereo-channel pin and never run
      // the mono heuristic, so their confidence column was left NULL — sail
      // through with their consent gates auto-scored off unverified labels.
      call.speaker_integrity_flag !== null ||
        call.speaker_attribution_confidence === null ||
        Number(call.speaker_attribution_confidence) < CONSENT_SPEAKER_CONFIDENCE_FLOOR
    );

    // Record the scoring call's usage (Haiku first pass, incl. prompt-cache tokens).
    await recordUsage({
      organizationId: call.organization_id,
      callId,
      provider: 'anthropic',
      operation: 'score',
      modelId: model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
    });

    // The model must return exactly one score per AI-scoreable item — no
    // fewer (a silently-skipped item would understate the true failure
    // count and compute the weighted average over a subset, a silent
    // false-pass channel in a compliance product) and no more (a duplicate
    // would trip the call_item_scores unique constraint below). Fail loudly
    // and let BullMQ retry rather than persist a partial score.
    const scoredIds = new Set(output.items.map((it) => it.scorecard_item_id));
    const expectedIds = new Set(aiItems.map((i) => i.id));
    const missing = aiItems.filter((i) => !scoredIds.has(i.id));
    const duplicateCount = output.items.length - scoredIds.size;
    const unknown = output.items.filter((it) => !expectedIds.has(it.scorecard_item_id));
    if (missing.length > 0 || duplicateCount > 0 || unknown.length > 0) {
      throw new Error(
        `Scoring output does not cover the scoreable set 1:1 (missing: ${missing.map((i) => i.label).join(', ') || 'none'}, ` +
        `duplicates: ${duplicateCount}, unknown item ids: ${unknown.length})`
      );
    }

    // Weighted average + breach detection — computed over the AI-scored
    // items only, so na/manual_review are excluded from the denominator
    // (spec §8.3/§8.6).
    let totalWeightedScore = 0;
    let totalWeight = 0;
    const itemWrites: Array<{
      item: ScorecardItem;
      itemScore: (typeof output.items)[number];
      normalized: number;
    }> = [];

    // Provisional consent gates: AI verdict recorded for the reviewer, but
    // excluded from the weighted score and breach register until confirmed.
    const provisionalIds = new Set(provisional.map((i) => i.id));
    const provisionalWrites: typeof itemWrites = [];

    // How many went to review purely because the model was unsure (migration
    // 082) — surfaced in the log line so the tenant's confidence floor is
    // visible in its effect, not just in its configuration.
    let lowConfidenceCount = 0;

    for (const itemScore of output.items) {
      const item = aiItems.find((i) => i.id === itemScore.scorecard_item_id)!;
      const normalized = normalizeScore(itemScore.score, item.score_type);
      // Same destination as a consent gate under the speaker floor, and for the
      // same reason: a verdict the model is not confident in is one a person
      // should give. The AI's provisional verdict rides along on the
      // manual_review row so the reviewer confirms rather than starts over.
      const lowConfidence = routesToReviewOnConfidence(
        itemScore.confidence,
        scoringSettings.reviewConfidenceFloor
      );
      if (provisionalIds.has(item.id) || lowConfidence) {
        provisionalWrites.push({ item, itemScore, normalized });
        if (lowConfidence) lowConfidenceCount++;
        continue;
      }
      itemWrites.push({ item, itemScore, normalized });
      const weight = Number(item.weight);
      totalWeightedScore += normalized * weight;
      totalWeight += weight;
    }

    // Every applicable checkpoint went to a human, so there is no score to
    // report. Writing the 0 that a zero denominator produces would be a
    // fabricated fail on a call nobody has judged — see the same guard in
    // score-journey.ts. Resolving the review items recomputes a real score
    // (routes/review.ts).
    const nothingAutoScored = totalWeight === 0;
    const overallScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

    // The failing items, with the detail reused by the pass gate, the auto-exemplar
    // check and the webhook payload. A critical-severity failure fails the call
    // regardless of overall score (callPasses), so a high % cannot mask a single
    // regulator-grade failure.
    const failures = itemWrites
      .filter(({ normalized }) => !isItemPass(normalized, scoringSettings.passThreshold))
      .map(({ item, itemScore }) => ({
        scorecard_item_id: item.id,
        scorecard_item_label: item.label,
        severity: deriveSeverity(Number(item.weight), item.severity),
        evidence: itemScore.evidence ?? '',
      }));

    const pass = callPasses(overallScore, failures.map((f) => f.severity), scoringSettings.passThreshold);
    // An unscored call is not an exemplar, however empty its breach list is.
    // Nor is a call with any checkpoint still awaiting a human: manual items
    // and provisional consent gates (manualReview/provisional) are unconfirmed
    // evidence, and an exemplar isn't just displayed — it's fed back into the
    // model's learning context as "what good looks like" on future calls. Award
    // it on an unadjudicated checkpoint and the model gets calibrated on a
    // verdict no human ever signed off, which is the same failure mode as
    // auto-scoring a consent gate off a NULL speaker split. Once the reviewer
    // clears the queue, resolveCallItem in routes/review.ts re-evaluates the
    // same gate so a call that only missed exemplar status for a pending
    // checkpoint isn't lost for good.
    const shouldAutoExemplar =
      !nothingAutoScored &&
      overallScore >= 95 &&
      failures.length === 0 &&
      manualReview.length === 0 &&
      provisional.length === 0;
    const priorCoachingCount = learning?.priorCoaching?.length ?? 0;

    // Write everything in one transaction. Re-scoring the same call against
    // the same scorecard (manual re-run, or a retry after a mid-write crash on
    // a prior attempt) would otherwise hit call_scores' UNIQUE(call_id,
    // scorecard_id) and permanently flip an already-scored call to 'failed' —
    // so any prior score for this (call, scorecard) pair is superseded here;
    // its item scores and breaches cascade-delete with it.
    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM call_scores WHERE call_id = $1 AND scorecard_id = $2', [
        callId,
        scorecard.id,
      ]);

      const callScoreRows = await tx.query<{ id: string }>(
        `INSERT INTO call_scores (call_id, scorecard_id, scorecard_version, scored_at, model_id, prompt_tokens, completion_tokens, coaching, prior_coaching_count, overall_score, pass)
         VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          callId,
          scorecard.id,
          scorecard.version,
          model,
          usage.input_tokens,
          usage.output_tokens,
          output.coaching ? JSON.stringify(output.coaching) : null,
          priorCoachingCount,
          nothingAutoScored ? null : overallScore,
          nothingAutoScored ? null : pass,
        ]
      );
      const callScoreId = callScoreRows[0]!.id;

      for (const { item, itemScore, normalized } of itemWrites) {
        const result = isItemPass(normalized, scoringSettings.passThreshold) ? 'pass' : 'fail';
        const insertedItemScore = await tx.query<{ id: string }>(
          `INSERT INTO call_item_scores (call_score_id, scorecard_item_id, score, normalized_score, confidence, evidence, reasoning, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            callScoreId,
            itemScore.scorecard_item_id,
            itemScore.score,
            normalized,
            itemScore.confidence,
            itemScore.evidence,
            itemScore.reasoning,
            result,
          ]
        );
        const itemScoreId = insertedItemScore[0]!.id;

        if (result === 'fail') {
          const severity = deriveSeverity(Number(item.weight), item.severity);
          await tx.query(
            `INSERT INTO breaches
               (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, detected_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (call_item_score_id) DO NOTHING`,
            [call.organization_id, callId, itemScoreId, item.id, severity]
          );
        }
      }

      // na/manual_review items: terminal states, never scored, no evidence.
      for (const item of na) {
        await tx.query(
          `INSERT INTO call_item_scores (call_score_id, scorecard_item_id, score, normalized_score, result)
           VALUES ($1, $2, NULL, NULL, 'na')`,
          [callScoreId, item.id]
        );
      }
      for (const item of manualReview) {
        await tx.query(
          `INSERT INTO call_item_scores (call_score_id, scorecard_item_id, score, normalized_score, result)
           VALUES ($1, $2, NULL, NULL, 'manual_review')`,
          [callScoreId, item.id]
        );
      }
      // Provisional consent gates: manual_review WITH the AI's suggested
      // verdict/evidence, so the reviewer confirms rather than scoring blind.
      for (const { item, itemScore, normalized } of provisionalWrites) {
        await tx.query(
          `INSERT INTO call_item_scores
             (call_score_id, scorecard_item_id, score, normalized_score, confidence, evidence, reasoning, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual_review')`,
          [callScoreId, item.id, itemScore.score, normalized, itemScore.confidence, itemScore.evidence, itemScore.reasoning]
        );
      }

      await tx.query(
        `UPDATE calls SET
           status = 'scored',
           is_exemplar = CASE WHEN $2 = true AND is_exemplar = false THEN true ELSE is_exemplar END,
           exemplar_reason = CASE WHEN $2 = true AND is_exemplar = false THEN $3 ELSE exemplar_reason END,
           updated_at = now()
         WHERE id = $1`,
        [callId, shouldAutoExemplar, 'Auto: 95%+ with zero breaches']
      );
    });

    console.log(
      `[Scoring] Call ${callId} ` +
      (nothingAutoScored
        ? `not scored: all ${provisionalWrites.length + manualReview.length} applicable checkpoint(s) await review`
        : `scored: ${overallScore.toFixed(1)} (${pass ? 'PASS' : 'FAIL'})`) +
      `${branch ? ` [branch: ${branch}]` : ''}${manualReview.length ? ` [${manualReview.length} manual_review]` : ''}` +
      `${lowConfidenceCount ? ` [${lowConfidenceCount} to review under confidence floor ${scoringSettings.reviewConfidenceFloor}]` : ''}` +
      `${shouldAutoExemplar ? ' [auto-exemplar]' : ''}`
    );

    // Recompute customer aggregate stats from source data so re-scoring a call
    // doesn't increment call_count a second time (COUNT is idempotent; +1 is not).
    if ((call as Call & { customer_id?: string | null }).customer_id) {
      query(
        `UPDATE customers SET
           call_count   = (SELECT COUNT(DISTINCT c2.id)
                           FROM calls c2
                           WHERE c2.customer_id = $1 AND c2.status = 'scored'),
           avg_score    = (SELECT AVG(cs2.overall_score)
                           FROM call_scores cs2
                           JOIN calls c2 ON c2.id = cs2.call_id
                           WHERE c2.customer_id = $1
                           AND cs2.id = (
                             SELECT id FROM call_scores
                             WHERE call_id = c2.id
                             ORDER BY scored_at DESC LIMIT 1
                           )),
           last_seen_at = now()
         WHERE id = $1`,
        [(call as Call & { customer_id: string }).customer_id]
      ).catch((err) => {
        console.error(`[Scoring] Customer stats update failed for ${callId}:`, err);
      });
    }

    // Fire a signed call.scored webhook (best-effort) so batch/uploaded calls
    // reach integrations (e.g. CRM write-back), not just live sessions.
    type ExtendedCall = Call & {
      external_id?: string | null;
      agent_name?: string | null;
      customer_id?: string | null;
      customer_phone?: string | null;
    };
    const callRow = call as ExtendedCall;

    // Look up external_crm_id if customer is linked.
    let customerExternalCrmId: string | null = null;
    if (callRow.customer_id) {
      const cust = await queryOne<{ external_crm_id: string | null }>(
        'SELECT external_crm_id FROM customers WHERE id = $1',
        [callRow.customer_id]
      );
      customerExternalCrmId = cust?.external_crm_id ?? null;
    }

    const scoredPayload: WebhookCallScoredPayload = {
      event: 'call.scored',
      call_id: callId,
      external_id: callRow.external_id ?? null,
      agent_name: callRow.agent_name ?? null,
      scorecard_id: scorecard.id,
      overall_score: overallScore,
      pass,
      scored_at: new Date().toISOString(),
      customer_id: callRow.customer_id ?? null,
      customer_phone: callRow.customer_phone ?? null,
      customer_external_crm_id: customerExternalCrmId,
      breaches: failures,
    };

    // Nothing to push while every checkpoint is still with a reviewer: the
    // payload's score is non-nullable, so this would send 0%/fail for a call the
    // platform declined to judge. The first resolution re-pushes a real score
    // (services/score-writeback.ts).
    if (nothingAutoScored) {
      console.log(
        `[Scoring] Holding call.scored webhook + Zoho write-back for ${callId} — all checkpoints await review`
      );
    } else {
      deliverCallScored(call.organization_id, scoredPayload).catch((err) => {
        console.error(`[Scoring] call.scored webhook failed for ${callId}:`, (err as Error).message);
      });

      // Native Zoho CRM write-back (no-op unless the org has an active connection).
      // Best-effort and self-contained — never blocks or fails scoring.
      pushCallScored(call.organization_id, scoredPayload).catch((err) => {
        console.error(`[Scoring] Zoho write-back failed for ${callId}:`, (err as Error).message);
      });
    }

    // Evaluate alert rules after scoring completes
    evaluateAlertsForCall(callId, 'scored').catch((alertErr) => {
      console.error(`[Scoring] Alert evaluation failed for call ${callId}:`, alertErr);
    });

    // Data capture runs strictly after (and independently of) scoring — a
    // capture failure never affects the call's score. No-op unless the org
    // has capture_enabled and a form resolves.
    await maybeStartCallCapture(call.organization_id, callId);
  } catch (err) {
    // Only surface 'failed' (and alert the tenant) once BullMQ's retries are
    // exhausted — a transient Claude/DB blip on attempt 1 of 2 shouldn't flip
    // an in-progress call to failed when the retry may well succeed.
    const totalAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= totalAttempts;
    if (isFinalAttempt) {
      // A failed *re-score* must not bury a call's existing valid score: if a
      // call_scores row survived (the DELETE+INSERT supersede only runs on a
      // successful pass), restore 'scored' rather than flipping to 'failed'
      // and hiding the result behind result: null.
      const priorScore = await queryOne<{ id: string }>(
        'SELECT id FROM call_scores WHERE call_id = $1 LIMIT 1',
        [callId]
      );
      if (priorScore) {
        await query(
          "UPDATE calls SET status = 'scored', error_message = $1, updated_at = now() WHERE id = $2",
          [`Re-score failed, previous score retained: ${(err as Error).message}`, callId]
        );
        console.warn(`[Scoring] Re-score of call ${callId} failed on final attempt; kept existing score.`);
      } else {
        await query(
          "UPDATE calls SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2",
          [(err as Error).message, callId]
        );
        evaluateAlertsForCall(callId, 'failed').catch((alertErr) => {
          console.error(`[Scoring] Failure alert evaluation failed:`, alertErr);
        });
      }
    } else {
      console.warn(
        `[Scoring] Call ${callId} failed on attempt ${job.attemptsMade + 1}/${totalAttempts}, will retry:`,
        (err as Error).message
      );
    }
    throw err;
  }
}
