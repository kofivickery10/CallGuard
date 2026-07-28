import { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { scoreTranscript, normalizeScore } from '../../services/scoring.js';
import { getKBContext } from '../../services/kb.js';
import { getLearningContext } from '../../services/learning-context.js';
import { recordUsage } from '../../services/usage.js';
import { getScoringSettings } from '../../services/tenant-settings.js';
import { classifyItems } from '../../services/checkpoint-classification.js';
import { deliverCallScored } from '../../services/webhook-delivery.js';
import { sendOpsAlert } from '../../services/ops-alert.js';
import { pushJourneyScored } from '../../services/zoho.js';
import { maybeStartJourneyCapture } from '../../services/capture-runs.js';
import { buildCombinedTranscript, CALL_MARKER } from '../../services/journey-transcript.js';
import { detectProductsFromTranscript } from '../../services/product-resolution.js';
import { isItemPass, deriveSeverity, callPasses, resolveBranchWithSource, isNoScoreCrmStage } from '@callguard/shared';
import type { Scorecard, ScorecardItem, WebhookJourneyScoredPayload, ProductSource } from '@callguard/shared';

interface JourneyRow {
  id: string;
  organization_id: string;
  customer_id: string;
  scorecard_id: string;
  scorecard_version: number;
  zoho_record_id: string | null;
  client_name: string | null;
  product_source: ProductSource | null;
  crm_stage: string | null;
  // The score this run is about to replace, if any. Read before scoring purely
  // so a re-score logs what it changed — the durable record is journey_score_runs.
  overall_score: string | number | null;
}

interface JourneyCallRow {
  id: string;
  role: 'wrap_up' | 'context';
  call_date: string | null;
  created_at: string;
  agent_id: string | null;
  agent_name: string | null;
  transcript_text: string | null;
  speaker_attribution_confidence: number | null;
  speaker_integrity_flag: string | null;
}


export interface ScoreJourneyJobData {
  journeyId: string;
  suppressCrm?: boolean;
  // Who pressed "re-score", for the score-history row (migration 074). Absent
  // for automatic scoring off the sale trigger and for bulk operational runs.
  rescoredBy?: string | null;
}

export async function processScoreJourney(job: Job<ScoreJourneyJobData>) {
  const { journeyId, suppressCrm, rescoredBy } = job.data;
  console.log(`[ScoreJourney] Processing journey ${journeyId}${suppressCrm ? ' (CRM write-back suppressed)' : ''}`);

  // Which kind of run this is, for the history row. A human pressing the button
  // is the case that has to be distinguishable after the fact — that is the one
  // someone will later ask about when a score has moved.
  const runTrigger: 'initial' | 'rescore' | 'bulk' = rescoredBy
    ? 'rescore'
    : suppressCrm
      ? 'bulk'
      : 'initial';

  const journey = await queryOne<JourneyRow>('SELECT * FROM journeys WHERE id = $1', [journeyId]);
  if (!journey) throw new Error(`Journey ${journeyId} not found`);

  await query("UPDATE journeys SET status = 'scoring', updated_at = now() WHERE id = $1", [journeyId]);

  try {
    const journeyCalls = await query<JourneyCallRow>(
      `SELECT c.id, jc.role, c.call_date, c.created_at, c.agent_id, c.agent_name,
              c.transcript_text, c.speaker_attribution_confidence, c.speaker_integrity_flag
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
        WHERE jc.journey_id = $1
        ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
      [journeyId]
    );

    const withTranscript = journeyCalls.filter((c) => c.transcript_text);
    if (withTranscript.length === 0) {
      throw new Error('No transcribed calls in this journey');
    }

    // Combined, call-delimited transcript — one Claude call sees the whole
    // journey at once, so a statement/consent given in one call and a sale
    // closed in another are scored together, not each in isolation (spec §9.3).
    // Shared with data capture (services/journey-transcript.ts): the header
    // format and the [Call N] evidence marker are one contract.
    const combinedTranscript = buildCombinedTranscript(withTranscript);

    // Org predicate is defence-in-depth: journey.scorecard_id was org-validated
    // at assembly, but a mis-wired reference must never score one tenant's
    // calls against another tenant's scorecard.
    const scorecard = await queryOne<Scorecard>(
      'SELECT * FROM scorecards WHERE id = $1 AND organization_id = $2',
      [journey.scorecard_id, journey.organization_id]
    );
    if (!scorecard) throw new Error(`Scorecard ${journey.scorecard_id} not found in org ${journey.organization_id}`);

    const items = await query<ScorecardItem>(
      'SELECT * FROM scorecard_items WHERE scorecard_id = $1 AND archived_at IS NULL ORDER BY sort_order',
      [scorecard.id]
    );
    if (items.length === 0) throw new Error('Scorecard has no items');

    // A sale the customer never took up is not scored (see migration 071).
    // Assembly already skips these, so reaching here means the stage moved to
    // NTU after the journey was created, or this is a deliberate re-score.
    // Either way, record it as skipped rather than minting a breach register
    // for business that never completed.
    if (isNoScoreCrmStage(journey.crm_stage, scorecard.branch_config)) {
      await withTransaction(async (tx) => {
        // Clear anything a previous scoring left behind — the sale is no longer
        // one we hold against the adviser.
        await tx.query('DELETE FROM breaches WHERE journey_id = $1', [journeyId]);
        await tx.query('DELETE FROM journey_item_scores WHERE journey_id = $1', [journeyId]);
        await tx.query(
          `UPDATE journeys SET status = 'skipped', overall_score = NULL, pass = NULL,
             error_message = $2, updated_at = now()
           WHERE id = $1`,
          [journeyId, `Not scored: CRM stage "${journey.crm_stage}" marks this sale as not taken up`]
        );
      });
      console.log(
        `[ScoreJourney] ${journeyId}: CRM stage "${journey.crm_stage}" is a no-score state — marked skipped, not scored`
      );
      return;
    }

    // Branch decides which checkpoints apply at all, so how it was decided is
    // recorded alongside it. The CRM's own policy stage wins where available;
    // transcript keywords are a fallback, and `default` means nothing matched
    // and the first branch was assumed (migration 071).
    const { branch, source: branchSource, unmappedCrmStage } = resolveBranchWithSource(
      combinedTranscript,
      scorecard.branch_config,
      journey.crm_stage
    );
    if (branchSource === 'default') {
      console.warn(
        `[ScoreJourney] ${journeyId}: branch defaulted to "${branch}" — no CRM stage ` +
          `(${journey.crm_stage ?? 'none'}) and no keyword match. Branch-scoped checkpoints ` +
          `are being applied on an assumption.`
      );
    }
    // The CRM told us the sale's status and the scorecard has no branch for it.
    // Unlike a missing stage, this is fixable config — and until it is fixed
    // every sale at that stage is scored under a guessed branch. Alert rather
    // than bury it in a log line.
    if (unmappedCrmStage) {
      console.error(
        `[ScoreJourney] ${journeyId}: CRM stage "${journey.crm_stage}" is not mapped to any branch ` +
          `in scorecard ${scorecard.id}'s branch_config.crm_values — fell back to ${branchSource}, branch "${branch}".`
      );
      sendOpsAlert(
        `Unmapped CRM stage "${journey.crm_stage}" — sales scored on a guessed branch`,
        `Org:       ${journey.organization_id}\n` +
          `Journey:   ${journeyId}\n` +
          `Scorecard: ${scorecard.id}\n` +
          `Stage:     ${journey.crm_stage}\n` +
          `Fell back to branch "${branch}" via ${branchSource}.\n\n` +
          `Add this stage value to the scorecard's branch_config.crm_values. Until then every ` +
          `sale at this stage is scored against branch-scoped checkpoints that may not apply.`,
        `score-journey:unmapped-stage:${journey.organization_id}:${journey.crm_stage}`
      ).catch(() => {});
    }

    // Product-aware scoring: resolve which products this sale covered. CRM
    // values were attached at assembly (product_source='crm'). If still
    // unresolved — the CRM never delivered within the wait window, or the org
    // relies purely on the fallback — infer them from the transcript now. An org
    // with no product catalogue resolves to no products (detect returns []),
    // and every item is scored as before.
    let journeyProducts = await query<{ product_id: string | null; product_name: string }>(
      'SELECT product_id, product_name FROM journey_products WHERE journey_id = $1',
      [journeyId]
    );
    if (!journey.product_source) {
      const detected = await detectProductsFromTranscript(journey.organization_id, combinedTranscript);
      const source: ProductSource = detected.length > 0 ? 'ai' : 'none';
      await withTransaction(async (tx) => {
        for (const p of detected) {
          await tx.query(
            `INSERT INTO journey_products (journey_id, product_id, product_name, source)
             VALUES ($1, $2, $3, 'ai')
             ON CONFLICT (journey_id, product_id) WHERE product_id IS NOT NULL DO NOTHING`,
            [journeyId, p.product_id, p.product_name]
          );
        }
        await tx.query('UPDATE journeys SET product_source = $2 WHERE id = $1', [journeyId, source]);
      });
      journeyProducts = detected.map((p) => ({ product_id: p.product_id, product_name: p.product_name }));
      if (detected.length > 0) {
        console.log(`[ScoreJourney] ${journeyId}: ${detected.length} product(s) inferred from transcript (AI fallback)`);
      }
    }
    const journeyProductIds = journeyProducts
      .map((p) => p.product_id)
      .filter((id): id is string => id !== null);
    const productNames = journeyProducts.map((p) => p.product_name);

    // Conservative: if any call in the journey has an unreliable speaker
    // split, treat the whole journey's consent gates as unreliable too — a
    // consent quote could have come from any of the calls.
    const confidences = withTranscript
      .map((c) => c.speaker_attribution_confidence)
      .filter((c): c is number => c !== null);
    const journeySpeakerConfidence = confidences.length > 0 ? Math.min(...confidences) : null;

    const { scoreable, na, manualReview, provisional } = classifyItems(
      items,
      branch,
      journeySpeakerConfidence,
      undefined,
      journeyProductIds
    );
    // Provisional items (consent gates under the speaker-confidence floor) are
    // AI-scored alongside the rest — the verdict is stored on their
    // manual_review row so the reviewer confirms instead of scoring blind.
    const aiItems = [...scoreable, ...provisional];
    if (aiItems.length === 0) {
      throw new Error(`No AI-scoreable items for branch "${branch ?? 'default'}"`);
    }
    if (provisional.length > 0) {
      console.log(
        `[ScoreJourney] ${journeyId}: ${provisional.length} consent gate(s) scored provisionally ` +
          `(speaker confidence ${journeySpeakerConfidence} < floor)`
      );
    }

    const org = await queryOne<{ plan: import('@callguard/shared').Plan; industry: string | null }>(
      'SELECT plan, industry FROM organizations WHERE id = $1',
      [journey.organization_id]
    );
    const scoringSettings = await getScoringSettings(journey.organization_id);
    const kbContext = await getKBContext(journey.organization_id);
    const wrapUp = journeyCalls.find((c) => c.role === 'wrap_up') ?? journeyCalls[journeyCalls.length - 1]!;
    const learning = org
      ? await getLearningContext(journey.organization_id, org.plan, scoreable.map((i) => i.id), wrapUp.agent_id)
      : undefined;

    // Journey-level coaching: one brief for the whole sale (strengths /
    // improvements / next actions across all the calls), stored on the journey.
    // Deliberately journey-level, not per-call — a sale can span advisers, so
    // the useful unit is the sale as a whole.
    const { output, usage, model } = await scoreTranscript(
      combinedTranscript,
      aiItems.map((i) => ({
        id: i.id,
        label: i.label,
        description: i.description,
        score_type: i.score_type,
        expectation: i.expectation,
        ai_check: i.ai_check,
        consent_gate: i.consent_gate,
      })),
      null,
      kbContext,
      learning,
      true, // withCoaching — journey-level brief
      org?.industry ?? null,
      true, // journeyMode
      productNames,
      // Any call in the set with contradicted speaker labels makes the whole
      // combined transcript unsafe to judge by label — evidence for a given
      // checkpoint could have come from any of the calls.
      withTranscript.some((c) => c.speaker_integrity_flag !== null)
    );

    await recordUsage({
      organizationId: journey.organization_id,
      callId: wrapUp.id,
      provider: 'anthropic',
      operation: 'score',
      modelId: model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
    });

    const scoredIds = new Set(output.items.map((it) => it.scorecard_item_id));
    const expectedIds = new Set(aiItems.map((i) => i.id));
    const missing = aiItems.filter((i) => !scoredIds.has(i.id));
    const unknown = output.items.filter((it) => !expectedIds.has(it.scorecard_item_id));
    if (missing.length > 0 || output.items.length !== scoredIds.size || unknown.length > 0) {
      throw new Error(
        `Journey scoring output does not cover the scoreable set 1:1 (missing: ${missing.map((i) => i.label).join(', ') || 'none'}, unknown: ${unknown.length})`
      );
    }

    // Map each call marker back to a source call id, in order.
    const callIdsInOrder = withTranscript.map((c) => c.id);

    let totalWeightedScore = 0;
    let totalWeight = 0;
    const itemWrites: Array<{
      item: ScorecardItem;
      itemScore: (typeof output.items)[number];
      normalized: number;
      sourceCallId: string | null;
    }> = [];

    // Provisional consent gates: AI verdict is recorded for the reviewer but
    // stays out of the weighted score and the breach register until a human
    // confirms it (see checkpoint-classification.ts).
    const provisionalIds = new Set(provisional.map((i) => i.id));
    const provisionalWrites: typeof itemWrites = [];

    for (const itemScore of output.items) {
      const item = aiItems.find((i) => i.id === itemScore.scorecard_item_id)!;
      const normalized = normalizeScore(itemScore.score, item.score_type);
      const markerMatch = itemScore.evidence?.match(CALL_MARKER);
      const callIndex = markerMatch ? Number(markerMatch[1]) - 1 : -1;
      const sourceCallId = callIndex >= 0 && callIndex < callIdsInOrder.length ? callIdsInOrder[callIndex]! : null;
      if (provisionalIds.has(item.id)) {
        provisionalWrites.push({ item, itemScore, normalized, sourceCallId });
        continue;
      }
      itemWrites.push({ item, itemScore, normalized, sourceCallId });
      const weight = Number(item.weight);
      totalWeightedScore += normalized * weight;
      totalWeight += weight;
    }

    const overallScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
    const failures = itemWrites
      .filter(({ normalized }) => !isItemPass(normalized, scoringSettings.passThreshold))
      .map(({ item, itemScore }) => ({
        scorecard_item_id: item.id,
        scorecard_item_label: item.label,
        severity: deriveSeverity(Number(item.weight), item.severity),
        evidence: itemScore.evidence ?? '',
      }));
    const pass = callPasses(overallScore, failures.map((f) => f.severity), scoringSettings.passThreshold);

    await withTransaction(async (tx) => {
      // Supersede any breaches from a prior scoring of this journey (a BullMQ
      // retry after a committed first pass, or a re-trigger): without this an
      // item that flips fail -> pass/na on re-score would leave its old breach
      // open in the register against a score that now reads pass. Mirrors the
      // per-call path, where deleting call_scores cascades old breaches away.
      await tx.query('DELETE FROM breaches WHERE journey_id = $1', [journeyId]);

      // Clear prior per-item rows before re-inserting. Without this, a re-score
      // after the scorecard changed leaves orphaned rows for items that were
      // removed (or archived) since the last scoring — so a sale keeps showing
      // the old checkpoint count (e.g. 47) instead of the current one (44). The
      // loops below re-insert exactly the current scoreable/na/manual set.
      await tx.query('DELETE FROM journey_item_scores WHERE journey_id = $1', [journeyId]);

      for (const { item, itemScore, normalized, sourceCallId } of itemWrites) {
        const result = isItemPass(normalized, scoringSettings.passThreshold) ? 'pass' : 'fail';
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO journey_item_scores
             (journey_id, scorecard_item_id, result, score, normalized_score, confidence, evidence, reasoning, source_call_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (journey_id, scorecard_item_id) DO UPDATE SET
             result = EXCLUDED.result, score = EXCLUDED.score, normalized_score = EXCLUDED.normalized_score,
             confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, reasoning = EXCLUDED.reasoning,
             source_call_id = EXCLUDED.source_call_id
           RETURNING id`,
          [journeyId, item.id, result, itemScore.score, normalized, itemScore.confidence, itemScore.evidence, itemScore.reasoning, sourceCallId]
        );
        if (result === 'fail') {
          const severity = deriveSeverity(Number(item.weight), item.severity);
          await tx.query(
            `INSERT INTO breaches (organization_id, journey_id, journey_item_score_id, scorecard_item_id, severity, detected_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (journey_item_score_id) DO NOTHING`,
            [journey.organization_id, journeyId, inserted[0]!.id, item.id, severity]
          );
        }
      }
      for (const item of na) {
        await tx.query(
          `INSERT INTO journey_item_scores (journey_id, scorecard_item_id, result)
           VALUES ($1, $2, 'na')
           ON CONFLICT (journey_id, scorecard_item_id) DO UPDATE SET result = 'na'`,
          [journeyId, item.id]
        );
      }
      for (const item of manualReview) {
        await tx.query(
          `INSERT INTO journey_item_scores (journey_id, scorecard_item_id, result)
           VALUES ($1, $2, 'manual_review')
           ON CONFLICT (journey_id, scorecard_item_id) DO UPDATE SET result = 'manual_review'`,
          [journeyId, item.id]
        );
      }
      // Provisional consent gates: manual_review WITH the AI's suggested
      // verdict/evidence stored, so the reviewer confirms rather than scoring
      // blind. No breach until a human fails it.
      for (const { item, itemScore, normalized, sourceCallId } of provisionalWrites) {
        await tx.query(
          `INSERT INTO journey_item_scores
             (journey_id, scorecard_item_id, result, score, normalized_score, confidence, evidence, reasoning, source_call_id)
           VALUES ($1, $2, 'manual_review', $3, $4, $5, $6, $7, $8)
           ON CONFLICT (journey_id, scorecard_item_id) DO UPDATE SET
             result = 'manual_review', score = EXCLUDED.score, normalized_score = EXCLUDED.normalized_score,
             confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, reasoning = EXCLUDED.reasoning,
             source_call_id = EXCLUDED.source_call_id`,
          [journeyId, item.id, itemScore.score, normalized, itemScore.confidence, itemScore.evidence, itemScore.reasoning, sourceCallId]
        );
      }

      await tx.query(
        `UPDATE journeys SET
           status = 'scored', branch = $2, branch_source = $3, overall_score = $4, pass = $5,
           model_id = $6, coaching = $7, scored_at = now(), updated_at = now()
         WHERE id = $1`,
        [journeyId, branch, branchSource, overallScore, pass, model,
         output.coaching ? JSON.stringify(output.coaching) : null]
      );

      // Append this run to the sale's score history (migration 074). Inside the
      // same transaction as the score itself, so the history can never disagree
      // with the number it is meant to explain.
      //
      // run_number is derived here rather than counted outside: the SELECT and
      // the INSERT share this transaction, and the UNIQUE (journey_id,
      // run_number) constraint turns any surviving race into a rolled-back
      // scoring run rather than a duplicated history entry.
      //
      // The item counts are stored alongside the score because a score can move
      // for two very different reasons — different verdicts on the same items,
      // or a different set of items being scoreable at all (a branch flip, a
      // consent gate routing to manual review, a scorecard edit). Recording only
      // the percentage makes those indistinguishable afterwards.
      const priorRuns = await tx.queryOne<{ next: number }>(
        'SELECT COALESCE(max(run_number), 0) + 1 AS next FROM journey_score_runs WHERE journey_id = $1',
        [journeyId]
      );
      await tx.query(
        `INSERT INTO journey_score_runs
           (journey_id, organization_id, run_number, overall_score, pass, branch, branch_source,
            model_id, items_passed, items_failed, items_na, items_manual_review, calls_scored,
            triggered_by, trigger_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          journeyId,
          journey.organization_id,
          priorRuns?.next ?? 1,
          overallScore,
          pass,
          branch,
          branchSource,
          model,
          itemWrites.length - failures.length,
          failures.length,
          na.length,
          manualReview.length + provisionalWrites.length,
          withTranscript.length,
          rescoredBy ?? null,
          runTrigger,
        ]
      );
    });

    // Log the movement, not just the result. A re-score that lands on a
    // different number is the thing worth seeing in the logs; the previous
    // score is otherwise gone from view the moment it is overwritten.
    const priorScore = journey.overall_score == null ? null : Number(journey.overall_score);
    const delta =
      priorScore == null
        ? ''
        : ` [was ${priorScore.toFixed(1)}, ${overallScore >= priorScore ? '+' : ''}${(overallScore - priorScore).toFixed(1)} via ${runTrigger}]`;
    console.log(
      `[ScoreJourney] Journey ${journeyId} scored: ${overallScore.toFixed(1)} (${pass ? 'PASS' : 'FAIL'})` +
      `${branch ? ` [branch: ${branch} via ${branchSource}]` : ''} across ${withTranscript.length} call(s)${delta}`
    );

    const customer = await queryOne<{ name: string | null; phone_normalized: string | null; external_crm_id: string | null }>(
      'SELECT name, phone_normalized, external_crm_id FROM customers WHERE id = $1',
      [journey.customer_id]
    );

    // The wrap-up (closing) agent's email — used to set the QA record's owner
    // to the agent (services/zoho.ts). Null if the agent is unlinked.
    const agent = wrapUp.agent_id
      ? await queryOne<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [wrapUp.agent_id])
      : null;

    const payload: WebhookJourneyScoredPayload = {
      event: 'journey.scored',
      journey_id: journeyId,
      scorecard_id: scorecard.id,
      branch,
      overall_score: overallScore,
      pass,
      scored_at: new Date().toISOString(),
      agent_name: wrapUp.agent_name,
      agent_email: agent?.email ?? null,
      customer_id: journey.customer_id,
      customer_phone: customer?.phone_normalized ?? null,
      customer_external_crm_id: customer?.external_crm_id ?? null,
      zoho_record_id: journey.zoho_record_id,
      // Prefer the name the sale trigger carried; fall back to the customer's
      // stored name (backfilled from Zoho/CloudTalk) so the QA record shows a
      // real client rather than "Unknown" for sales assembled without a trigger
      // client name (manual/re-scored journeys, or a trigger that didn't send
      // client_name). pushQARecord keeps 'Unknown' only as a last resort.
      client_name: journey.client_name ?? customer?.name ?? null,
      breaches: failures,
    };

    // suppressCrm: a bulk backfill/correction re-scores many historical sales at
    // once (e.g. after a transcription-pipeline fix). Re-firing the outbound
    // webhook and Zoho write-back for each would flood the tenant's CRM with
    // re-pushed scores and duplicate breach tasks, so bulk re-scores set this to
    // correct CallGuard's own scores quietly. Normal (per-sale) scoring never
    // sets it, so live sales still push as usual.
    if (suppressCrm) {
      console.log(`[ScoreJourney] Skipping webhook + Zoho write-back for ${journeyId} (suppressCrm)`);
    } else {
      deliverCallScored(journey.organization_id, payload).catch((err) => {
        console.error(`[ScoreJourney] journey.scored webhook failed for ${journeyId}:`, (err as Error).message);
      });
      pushJourneyScored(journey.organization_id, payload).catch((err) => {
        console.error(`[ScoreJourney] Zoho write-back failed for ${journeyId}:`, (err as Error).message);
      });
    }
    // Data capture runs strictly after (and independently of) scoring — a
    // capture failure never affects the journey's score. No-op unless the
    // org has capture_enabled and a form resolves.
    await maybeStartJourneyCapture(journey.organization_id, journeyId);
  } catch (err) {
    const totalAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= totalAttempts;
    if (isFinalAttempt) {
      await query(
        "UPDATE journeys SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2",
        [(err as Error).message, journeyId]
      );
    } else {
      console.warn(`[ScoreJourney] Journey ${journeyId} failed on attempt ${job.attemptsMade + 1}/${totalAttempts}, will retry:`, (err as Error).message);
    }
    throw err;
  }
}
