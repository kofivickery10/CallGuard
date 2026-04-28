import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { scoreTranscript, normalizeScore } from '../../services/scoring.js';
import { getKBContext } from '../../services/kb.js';
import { evaluateAlertsForCall } from '../../services/alert-evaluator.js';
import { getLearningContext } from '../../services/learning-context.js';
import { PASS_THRESHOLD, hasFeature } from '@callguard/shared';
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
    // Get the org's active scorecard
    const scorecard = await queryOne<{ id: string }>(
      'SELECT id FROM scorecards WHERE organization_id = $1 AND is_active = true LIMIT 1',
      [call.organization_id]
    );

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
      if (normalized < 70) {
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
    const pass = overallScore >= PASS_THRESHOLD;

    // Update call_score with overall
    await query(
      'UPDATE call_scores SET overall_score = $1, pass = $2 WHERE id = $3',
      [overallScore, pass, callScoreId]
    );

    // Update call status + auto-exemplar if 95%+ with zero failed items
    const failingCount = output.items.filter((it) => {
      const item = items.find((i) => i.id === it.scorecard_item_id);
      if (!item) return false;
      return normalizeScore(it.score, item.score_type) < 70;
    }).length;
    const shouldAutoExemplar = overallScore >= 95 && failingCount === 0;

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

function deriveSeverity(weight: number, explicitSeverity?: string): 'critical' | 'high' | 'medium' | 'low' {
  if (explicitSeverity && ['critical', 'high', 'medium', 'low'].includes(explicitSeverity)) {
    return explicitSeverity as 'critical' | 'high' | 'medium' | 'low';
  }
  if (weight >= 2.0) return 'critical';
  if (weight >= 1.5) return 'high';
  return 'medium';
}
