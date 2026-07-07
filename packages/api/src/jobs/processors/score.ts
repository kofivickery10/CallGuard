import { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { scoreTranscript, verifyItems, normalizeScore } from '../../services/scoring.js';
import { getKBContext } from '../../services/kb.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { getLearningContext } from '../../services/learning-context.js';
import { recordUsage } from '../../services/usage.js';
import { deliverCallScored } from '../../services/webhook-delivery.js';
import { pushCallScored } from '../../services/zoho.js';
import { hasFeature, isItemPass, deriveSeverity, callPasses, MIN_SCOREABLE_WORDS, MIN_SCOREABLE_DURATION_SECONDS } from '@callguard/shared';
import type { Call, ScorecardItem, Plan, WebhookCallScoredPayload } from '@callguard/shared';

export async function processScoring(job: Job<{ callId: string }>) {
  const { callId } = job.data;
  console.log(`[Scoring] Processing call ${callId}`);

  const call = await queryOne<Call>(
    'SELECT * FROM calls WHERE id = $1',
    [callId]
  );

  if (!call || !call.transcript_text) {
    throw new Error(`Call ${callId} not found or has no transcript`);
  }

  // Skip calls too short to score meaningfully (wrong numbers, voicemails,
  // instant hangups). Either too few words OR — when duration is known — too
  // short trips it. This avoids wasting a Claude call and polluting scores,
  // breaches and agent averages with junk. Not a failure: dedicated status.
  const wordCount = call.transcript_text.trim().split(/\s+/).filter(Boolean).length;
  const durationSeconds = Number(call.duration_seconds ?? 0);
  const tooFewWords = wordCount < MIN_SCOREABLE_WORDS;
  const tooShortDuration = durationSeconds > 0 && durationSeconds < MIN_SCOREABLE_DURATION_SECONDS;

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
    let scorecard: { id: string } | null = null;

    const callScorecardId = call.scorecard_id;
    if (callScorecardId) {
      scorecard = await queryOne<{ id: string }>(
        'SELECT id FROM scorecards WHERE id = $1 AND organization_id = $2',
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
      const activeScorecards = await query<{ id: string }>(
        'SELECT id FROM scorecards WHERE organization_id = $1 AND is_active = true ORDER BY created_at ASC',
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
          items.map((i) => i.id),
          call.agent_id
        )
      : undefined;

    const { output, usage, model } = await scoreTranscript(
      call.transcript_text,
      items.map((i) => ({
        id: i.id,
        label: i.label,
        description: i.description,
        score_type: i.score_type,
      })),
      null,       // use default model
      kbContext,
      learning,
      coachingEnabled,
      org?.industry ?? null
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

    // Second opinion: re-check the failed critical/high-severity items on a
    // stronger model before they become breaches. This catches first-pass false
    // positives in the compliance register without paying for the bigger model
    // on every item. Best-effort: a verify failure falls back to first-pass scores.
    try {
      const flagged = output.items.flatMap((it) => {
        const item = items.find((i) => i.id === it.scorecard_item_id);
        if (!item) return [];
        if (isItemPass(normalizeScore(it.score, item.score_type))) return [];
        const severity = deriveSeverity(Number(item.weight), (item as { severity?: string }).severity);
        if (severity !== 'critical' && severity !== 'high') return [];
        return [{
          id: item.id,
          label: item.label,
          description: item.description,
          score_type: item.score_type,
          firstPass: { score: it.score, evidence: it.evidence, reasoning: it.reasoning },
        }];
      });

      if (flagged.length > 0) {
        const verified = await verifyItems(
          call.transcript_text,
          flagged,
          kbContext,
          org?.industry ?? null
        );
        const byId = new Map(verified.items.map((v) => [v.scorecard_item_id, v]));
        output.items = output.items.map((it) => byId.get(it.scorecard_item_id) ?? it);
        await recordUsage({
          organizationId: call.organization_id,
          callId,
          provider: 'anthropic',
          operation: 'verify',
          modelId: verified.model,
          inputTokens: verified.usage.input_tokens,
          outputTokens: verified.usage.output_tokens,
        });
        console.log(
          `[Scoring] Verified ${flagged.length} flagged item(s) for call ${callId} on ${verified.model}`
        );
      }
    } catch (verifyErr) {
      console.error(
        `[Scoring] Verify pass failed for call ${callId}, using first-pass scores:`,
        (verifyErr as Error).message
      );
    }

    // The model must return exactly one score per scorecard item — no fewer
    // (a silently-skipped item would understate the true failure count and
    // compute the weighted average over a subset, a silent false-pass channel
    // in a compliance product) and no more (a duplicate would trip the
    // call_item_scores unique constraint below). Fail loudly and let BullMQ
    // retry rather than persist a partial score.
    const scoredIds = new Set(output.items.map((it) => it.scorecard_item_id));
    const expectedIds = new Set(items.map((i) => i.id));
    const missing = items.filter((i) => !scoredIds.has(i.id));
    const duplicateCount = output.items.length - scoredIds.size;
    const unknown = output.items.filter((it) => !expectedIds.has(it.scorecard_item_id));
    if (missing.length > 0 || duplicateCount > 0 || unknown.length > 0) {
      throw new Error(
        `Scoring output does not cover the scorecard 1:1 (missing: ${missing.map((i) => i.label).join(', ') || 'none'}, ` +
        `duplicates: ${duplicateCount}, unknown item ids: ${unknown.length})`
      );
    }

    // Weighted average + breach detection, computed up front so the write
    // below is a single all-or-nothing transaction.
    let totalWeightedScore = 0;
    let totalWeight = 0;
    const itemWrites: Array<{
      item: ScorecardItem;
      itemScore: (typeof output.items)[number];
      normalized: number;
    }> = [];

    for (const itemScore of output.items) {
      const item = items.find((i) => i.id === itemScore.scorecard_item_id)!;
      const normalized = normalizeScore(itemScore.score, item.score_type);
      itemWrites.push({ item, itemScore, normalized });
      const weight = Number(item.weight);
      totalWeightedScore += normalized * weight;
      totalWeight += weight;
    }

    const overallScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

    // The failing items, with the detail reused by the pass gate, the auto-exemplar
    // check and the webhook payload. A critical-severity failure fails the call
    // regardless of overall score (callPasses), so a high % cannot mask a single
    // regulator-grade failure.
    const failures = itemWrites
      .filter(({ normalized }) => !isItemPass(normalized))
      .map(({ item, itemScore }) => ({
        scorecard_item_id: item.id,
        scorecard_item_label: item.label,
        severity: deriveSeverity(Number(item.weight), (item as { severity?: string }).severity),
        evidence: itemScore.evidence ?? '',
      }));

    const pass = callPasses(overallScore, failures.map((f) => f.severity));
    const shouldAutoExemplar = overallScore >= 95 && failures.length === 0;
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
        `INSERT INTO call_scores (call_id, scorecard_id, scored_at, model_id, prompt_tokens, completion_tokens, coaching, prior_coaching_count, overall_score, pass)
         VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          callId,
          scorecard.id,
          model,
          usage.input_tokens,
          usage.output_tokens,
          output.coaching ? JSON.stringify(output.coaching) : null,
          priorCoachingCount,
          overallScore,
          pass,
        ]
      );
      const callScoreId = callScoreRows[0]!.id;

      for (const { item, itemScore, normalized } of itemWrites) {
        const insertedItemScore = await tx.query<{ id: string }>(
          `INSERT INTO call_item_scores (call_score_id, scorecard_item_id, score, normalized_score, confidence, evidence, reasoning)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            callScoreId,
            itemScore.scorecard_item_id,
            itemScore.score,
            normalized,
            itemScore.confidence,
            itemScore.evidence,
            itemScore.reasoning,
          ]
        );
        const itemScoreId = insertedItemScore[0]!.id;

        if (!isItemPass(normalized)) {
          const severity = deriveSeverity(
            Number(item.weight),
            (item as { severity?: string }).severity
          );
          await tx.query(
            `INSERT INTO breaches
               (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, detected_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (call_item_score_id) DO NOTHING`,
            [call.organization_id, callId, itemScoreId, item.id, severity]
          );
        }
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

    console.log(`[Scoring] Call ${callId} scored: ${overallScore.toFixed(1)} (${pass ? 'PASS' : 'FAIL'})${shouldAutoExemplar ? ' [auto-exemplar]' : ''}`);

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

    deliverCallScored(call.organization_id, scoredPayload).catch((err) => {
      console.error(`[Scoring] call.scored webhook failed for ${callId}:`, (err as Error).message);
    });

    // Native Zoho CRM write-back (no-op unless the org has an active connection).
    // Best-effort and self-contained — never blocks or fails scoring.
    pushCallScored(call.organization_id, scoredPayload).catch((err) => {
      console.error(`[Scoring] Zoho write-back failed for ${callId}:`, (err as Error).message);
    });

    // Evaluate alert rules after scoring completes
    evaluateAlertsForCall(callId, 'scored').catch((alertErr) => {
      console.error(`[Scoring] Alert evaluation failed for call ${callId}:`, alertErr);
    });
  } catch (err) {
    // Only surface 'failed' (and alert the tenant) once BullMQ's retries are
    // exhausted — a transient Claude/DB blip on attempt 1 of 2 shouldn't flip
    // an in-progress call to failed when the retry may well succeed.
    const totalAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= totalAttempts;
    if (isFinalAttempt) {
      await query(
        "UPDATE calls SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2",
        [(err as Error).message, callId]
      );
      evaluateAlertsForCall(callId, 'failed').catch((alertErr) => {
        console.error(`[Scoring] Failure alert evaluation failed:`, alertErr);
      });
    } else {
      console.warn(
        `[Scoring] Call ${callId} failed on attempt ${job.attemptsMade + 1}/${totalAttempts}, will retry:`,
        (err as Error).message
      );
    }
    throw err;
  }
}
