import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { scoreTranscript, normalizeScore } from '../../services/scoring.js';
import { getKBContext } from '../../services/kb.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { getLearningContext } from '../../services/learning-context.js';
import { deliverCallScored } from '../../services/webhook-delivery.js';
import { hasFeature, isItemPass, deriveSeverity, callPasses } from '@callguard/shared';
import type { Call, ScorecardItem, Plan } from '@callguard/shared';

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
      scorecard = await queryOne<{ id: string }>(
        'SELECT id FROM scorecards WHERE organization_id = $1 AND is_active = true LIMIT 1',
        [call.organization_id]
      );
    }

    if (!scorecard) {
      throw new Error('No active scorecard found for this organization');
    }

    const items = await query<ScorecardItem>(
      'SELECT * FROM scorecard_items WHERE scorecard_id = $1 ORDER BY sort_order',
      [scorecard.id]
    );

    if (items.length === 0) {
      throw new Error('Scorecard has no items');
    }

    // Check org's plan for coaching feature gate
    const org = await queryOne<{ plan: Plan }>(
      'SELECT plan FROM organizations WHERE id = $1',
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
      kbContext,
      coachingEnabled,
      learning
    );

    // Create call_score record (with coaching if generated)
    const priorCoachingCount = learning?.priorCoaching?.length ?? 0;
    const callScoreRows = await query<{ id: string }>(
      `INSERT INTO call_scores (call_id, scorecard_id, scored_at, model_id, prompt_tokens, completion_tokens, coaching, prior_coaching_count)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7) RETURNING id`,
      [
        callId,
        scorecard.id,
        model,
        usage.input_tokens,
        usage.output_tokens,
        output.coaching ? JSON.stringify(output.coaching) : null,
        priorCoachingCount,
      ]
    );
    const callScoreId = callScoreRows[0].id;

    // Insert item scores and calculate weighted average
    let totalWeightedScore = 0;
    let totalWeight = 0;

    for (const itemScore of output.items) {
      const item = items.find((i) => i.id === itemScore.scorecard_item_id);
      if (!item) continue;

      const normalized = normalizeScore(itemScore.score, item.score_type);

      const insertedItemScore = await query<{ id: string }>(
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

      // Auto-create a breach for failed items
      if (!isItemPass(normalized)) {
        const severity = deriveSeverity(
          Number(item.weight),
          (item as { severity?: string }).severity
        );
        await query(
          `INSERT INTO breaches
             (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, detected_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (call_item_score_id) DO NOTHING`,
          [call.organization_id, callId, itemScoreId, item.id, severity]
        );
      }

      const weight = Number(item.weight);
      totalWeightedScore += normalized * weight;
      totalWeight += weight;
    }

    const overallScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

    // The failing items, with the detail reused by the pass gate, the auto-exemplar
    // check and the webhook payload. A critical-severity failure fails the call
    // regardless of overall score (callPasses), so a high % cannot mask a single
    // regulator-grade failure.
    const failures = output.items.flatMap((it) => {
      const item = items.find((i) => i.id === it.scorecard_item_id);
      if (!item || isItemPass(normalizeScore(it.score, item.score_type))) return [];
      return [{
        scorecard_item_id: item.id,
        scorecard_item_label: item.label,
        severity: deriveSeverity(Number(item.weight), (item as { severity?: string }).severity),
        evidence: it.evidence ?? '',
      }];
    });

    const pass = callPasses(overallScore, failures.map((f) => f.severity));

    // Update call_score with overall
    await query(
      'UPDATE call_scores SET overall_score = $1, pass = $2 WHERE id = $3',
      [overallScore, pass, callScoreId]
    );

    // Update call status + auto-exemplar if 95%+ with zero failed items
    const shouldAutoExemplar = overallScore >= 95 && failures.length === 0;

    await query(
      `UPDATE calls SET
         status = 'scored',
         is_exemplar = CASE WHEN $2 = true AND is_exemplar = false THEN true ELSE is_exemplar END,
         exemplar_reason = CASE WHEN $2 = true AND is_exemplar = false THEN $3 ELSE exemplar_reason END,
         updated_at = now()
       WHERE id = $1`,
      [callId, shouldAutoExemplar, 'Auto: 95%+ with zero breaches']
    );

    console.log(`[Scoring] Call ${callId} scored: ${overallScore.toFixed(1)} (${pass ? 'PASS' : 'FAIL'})${shouldAutoExemplar ? ' [auto-exemplar]' : ''}`);

    // Fire a signed call.scored webhook (best-effort) so batch/uploaded calls
    // reach integrations (e.g. CRM write-back), not just live sessions.
    const callRow = call as Call & { external_id?: string | null; agent_name?: string | null };
    deliverCallScored(call.organization_id, {
      event: 'call.scored',
      call_id: callId,
      external_id: callRow.external_id ?? null,
      agent_name: callRow.agent_name ?? null,
      scorecard_id: scorecard.id,
      overall_score: overallScore,
      pass,
      scored_at: new Date().toISOString(),
      breaches: failures,
    }).catch((err) => {
      console.error(`[Scoring] call.scored webhook failed for ${callId}:`, (err as Error).message);
    });

    // Evaluate alert rules after scoring completes
    evaluateAlertsForCall(callId, 'scored').catch((alertErr) => {
      console.error(`[Scoring] Alert evaluation failed for call ${callId}:`, alertErr);
    });
  } catch (err) {
    await query(
      "UPDATE calls SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2",
      [(err as Error).message, callId]
    );
    evaluateAlertsForCall(callId, 'failed').catch((alertErr) => {
      console.error(`[Scoring] Failure alert evaluation failed:`, alertErr);
    });
    throw err;
  }
}
