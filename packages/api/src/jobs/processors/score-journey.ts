import { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { scoreTranscriptConsensus, normalizeScore, type ScoringOutput } from '../../services/scoring.js';
import { getKBContext } from '../../services/kb.js';
import { getLearningContext } from '../../services/learning-context.js';
import { recordUsage } from '../../services/usage.js';
import { getScoringSettings } from '../../services/tenant-settings.js';
import { classifyItems } from '../../services/checkpoint-classification.js';
import {
  transcriptSupportsAttribution,
  type SpeakerIntegrityFlag,
} from '../../services/speaker-integrity.js';
import { deliverCallScored } from '../../services/webhook-delivery.js';
import { sendOpsAlert } from '../../services/ops-alert.js';
import { pushJourneyScored, fetchSaleProducts } from '../../services/zoho.js';
import { maybeStartJourneyCapture } from '../../services/capture-runs.js';
import { maybeStartReconciliation } from '../../services/reconciliation-runs.js';
import { buildCombinedTranscript, resolveSourceCallIndex } from '../../services/journey-transcript.js';
import { assessJourneyCoverage, computeStructuralCorroboration, resolveCoverage } from '../../services/journey.js';
import { detectProductsFromTranscript } from '../../services/product-resolution.js';
import { isItemPass, deriveSeverity, callPasses, resolveBranchWithSource, isNoScoreCrmStage } from '@callguard/shared';
import {
  CONSENT_SPEAKER_CONFIDENCE_FLOOR,
  routesToReviewOnConfidence,
} from '../../services/checkpoint-classification.js';
import type { Scorecard, ScorecardItem, WebhookJourneyScoredPayload, ProductSource, JourneyCoverage } from '@callguard/shared';

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


export type ScoreRunTrigger = 'initial' | 'rescore' | 'bulk' | 'backfill';

export interface ScoreJourneyJobData {
  journeyId: string;
  suppressCrm?: boolean;
  // Who pressed "re-score", for the score-history row (migration 074). Absent
  // for automatic scoring off the sale trigger and for bulk operational runs.
  rescoredBy?: string | null;
  // Explicit run kind, when the enqueuer knows something the derivation below
  // cannot infer — currently only the backfill mending an existing sale.
  triggerSource?: ScoreRunTrigger;
}

export async function processScoreJourney(job: Job<ScoreJourneyJobData>) {
  const { journeyId, suppressCrm, rescoredBy, triggerSource } = job.data;
  console.log(`[ScoreJourney] Processing journey ${journeyId}${suppressCrm ? ' (CRM write-back suppressed)' : ''}`);

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

    // Resolved here rather than at first use: the checkpoint classification
    // below needs it to decide whether this sale's evidence can be attributed
    // at all, and that has to happen before anything is sent to Claude.
    const wrapUp = journeyCalls.find((c) => c.role === 'wrap_up') ?? journeyCalls[journeyCalls.length - 1]!;

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

    // Fill in the CRM stage if we're scoring a sale that hasn't got one.
    //
    // crm_stage is normally captured once, at assembly. Anything assembled
    // before that existed — or mended in place by the backfill, which extends a
    // journey rather than re-assembling it — reaches scoring with a null stage
    // and falls back to guessing the branch from transcript keywords. That guess
    // is the original defect this whole path exists to remove: it decides which
    // checkpoints apply, so a wrong branch both mutes the real branch's items
    // and raises breaches for items that never applied.
    //
    // Measured, not hypothetical: a backfilled Trust Point sale whose CRM says
    // "Referred" was re-scored under 'on_risk' because nothing re-read the
    // stage. Resolving it here rather than in the mend path fixes every route
    // into scoring — backfill, manual re-score, and any historical journey.
    //
    // Only when it could change the answer: the scorecard resolves branches from
    // the CRM, the sale carries a record id, and we have no stage yet.
    if (
      !journey.crm_stage &&
      journey.zoho_record_id &&
      scorecard.branch_config?.detect === 'crm_field'
    ) {
      try {
        const sale = await fetchSaleProducts(journey.organization_id, journey.zoho_record_id);
        // Same rule as assembly: policies disagreeing on stage is not something
        // to silently pick a winner from.
        if (sale.stages.length === 1) {
          journey.crm_stage = sale.stages[0]!;
          await query('UPDATE journeys SET crm_stage = $2 WHERE id = $1', [journeyId, journey.crm_stage]);
          console.log(`[ScoreJourney] ${journeyId}: resolved CRM stage "${journey.crm_stage}" at score time`);
        } else if (sale.stages.length > 1) {
          console.warn(
            `[ScoreJourney] ${journeyId}: policies disagree on stage (${sale.stages.join(' | ')}) — ` +
              `leaving branch to the transcript fallback`
          );
        }
      } catch (err) {
        // Best-effort. A CRM outage must not stop a sale being scored; it just
        // falls back to keywords, which is what it would have done anyway.
        console.warn(`[ScoreJourney] ${journeyId}: CRM stage lookup failed:`, (err as Error).message);
      }
    }

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

    // Conservative BEFORE scoring: a consent quote could have come from any of
    // the calls, and which one is not known until the scorer cites it. So the
    // weakest call gates the lot here, and anything whose evidence turns out to
    // come from a well-attributed call is released again below, once
    // source_call_id is known.
    const confidences = withTranscript
      .map((c) => c.speaker_attribution_confidence)
      .filter((c): c is number => c !== null);
    const journeySpeakerConfidence = confidences.length > 0 ? Math.min(...confidences) : null;

    // Can the wrap-up support a claim about who said something at all?
    //
    // The wrap-up specifically, not the whole set: it is the call the sale's
    // checkpoints are actually judged from, and a scrappy 20-second context call
    // should not withhold a score the wrap-up can carry. If the wrap-up itself is
    // one-sided or its labels are flagged, no checkpoint on this sale may be
    // auto-scored — every one goes to a person with the AI's provisional verdict
    // attached, and the sale reports no score until they work through it.
    const attribution = transcriptSupportsAttribution(
      wrapUp.transcript_text,
      wrapUp.speaker_integrity_flag as SpeakerIntegrityFlag | null
    );
    if (!attribution.ok) {
      console.warn(
        `[ScoreJourney] ${journeyId}: wrap-up cannot be attributed — ${attribution.reason}. ` +
          `Every applicable checkpoint routes to review; the sale reports no score.`
      );
    }

    const { scoreable, na, manualReview, provisional } = classifyItems(
      items,
      branch,
      journeySpeakerConfidence,
      undefined,
      journeyProductIds,
      attribution.ok
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
    const learning = org
      ? await getLearningContext(journey.organization_id, org.plan, scoreable.map((i) => i.id), wrapUp.agent_id)
      : undefined;

    // Journey-level coaching: one brief for the whole sale (strengths /
    // improvements / next actions across all the calls), stored on the journey.
    // Deliberately journey-level, not per-call — a sale can span advisers, so
    // the useful unit is the sale as a whole.
    // Consensus scoring (migration 076). samples=1 is a single pass and the
    // historical behaviour; above 1 the runs vote, and checkpoints they
    // disagree on are routed to manual review below rather than settled by
    // whichever sample happened to be drawn.
    const { items: consensusItems, coaching, coverage: consensusCoverage, usage, model, samples } = await scoreTranscriptConsensus(
      scoringSettings.scoringSamples,
      // Vote against the same bar the pass/fail verdict below is computed on
      // (line ~512) — a run's checkpoint-level "agreed" is meaningless if it
      // was decided against a different threshold than the one that decides
      // the outcome.
      scoringSettings.passThreshold,
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
      // Tell the scorer to judge who spoke from CONTENT rather than the label
      // whenever the labels are not trustworthy. Evidence for a checkpoint can
      // come from any call in the set, so one unsafe call makes the combined
      // transcript unsafe to judge by label.
      //
      // Two distinct cases, and only the first used to count:
      //
      //  - an integrity flag: the labels are actively contradicted by content.
      //  - low attribution confidence: content identification ABSTAINED, so
      //    which cluster is the adviser rests on a positional guess measured at
      //    1 in 3. Nothing is contradicted, because nothing was established.
      //
      // Omitting the second meant a call at 0.45 was scored with the model
      // trusting labels nobody had verified. That matters most on consent
      // gates, whose whole rule is that the CUSTOMER must give the affirmative:
      // if the adviser's words sit under "Customer", the model reads the
      // adviser agreeing with himself as consent. Those gates do route to a
      // human, but the AI's suggested verdict is what the reviewer is shown
      // first, and since migration 077 their ruling is permanent.
      //
      // A NULL confidence must trip this too, not slide past it: NULL means
      // attribution was never established at all, which is strictly LESS
      // trustworthy than a measured low score, not more. Reading NULL as
      // "fully confident" (`!== null` before the floor check) is what let
      // live-streamed calls — no stereo pin, no mono heuristic run, so their
      // confidence column was left NULL — auto-score their consent gates off
      // labels nobody had verified.
      withTranscript.some(
        (c) =>
          c.speaker_integrity_flag !== null ||
          c.speaker_attribution_confidence === null ||
          Number(c.speaker_attribution_confidence) < CONSENT_SPEAKER_CONFIDENCE_FLOOR
      )
    );
    const output: ScoringOutput = { items: consensusItems, coaching };
    // Checkpoints the runs could not agree on. Excluded from the weighted score
    // and sent to a human — the whole point of voting is that an ambiguous
    // checkpoint gets decided by a person rather than by sampling luck.
    const disputedIds = new Set(consensusItems.filter((i) => i.disputed).map((i) => i.scorecard_item_id));
    const agreementById = new Map(consensusItems.map((i) => [i.scorecard_item_id, i.agreement]));

    // A checkpoint a human has already ruled on is not re-decided.
    //
    // This is what makes a score stop moving. The model cannot be made
    // deterministic — it samples, so a genuinely borderline checkpoint can land
    // either way between runs. But a checkpoint settled by a person has a
    // verdict that is simply replayed, and no amount of model variance can
    // touch it. Overlaid BEFORE the weighted score is computed, so the breach
    // register, the pass/fail gate and the CRM write-back all reflect the human
    // verdict rather than the machine's.
    //
    // Keyed on (journey_id, scorecard_item_id) rather than the item-score row,
    // which is dropped and recreated on every run (migration 077).
    const rulings = await query<{ scorecard_item_id: string; corrected_score: string; corrected_pass: boolean }>(
      `SELECT scorecard_item_id, corrected_score::text, corrected_pass
         FROM score_corrections WHERE journey_id = $1`,
      [journeyId]
    );
    const ruledIds = new Set(rulings.map((r) => r.scorecard_item_id));
    if (rulings.length > 0) {
      const byItem = new Map(rulings.map((r) => [r.scorecard_item_id, r]));
      for (const it of consensusItems) {
        const ruling = byItem.get(it.scorecard_item_id);
        if (!ruling) continue;
        it.score = ruling.corrected_pass ? 1 : 0;
        it.confidence = 1;
        it.reasoning = `Ruled by a reviewer: ${ruling.corrected_pass ? 'met' : 'not met'}. ${it.reasoning}`.slice(0, 2000);
        // A human ruling settles a disputed checkpoint — it must not be sent
        // back to the review queue it just came out of.
        disputedIds.delete(it.scorecard_item_id);
      }
      console.log(`[ScoreJourney] ${journeyId}: ${rulings.length} human ruling(s) re-applied over the model's verdicts`);
    }
    if (samples > 1) {
      console.log(
        `[ScoreJourney] ${journeyId}: ${samples} scoring runs, ` +
          `${consensusItems.length - disputedIds.size}/${consensusItems.length} unanimous, ` +
          `${disputedIds.size} disputed -> manual review`
      );
    }

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
    // Per-call speaker confidence, for releasing provisional gates whose
    // evidence came from a call we can actually attribute.
    const speakerConfidenceByCall = new Map(
      withTranscript.map((c) => [c.id, c.speaker_attribution_confidence === null ? 0 : Number(c.speaker_attribution_confidence)])
    );
    const provisionalWrites: typeof itemWrites = [];
    // How many landed in the review queue purely because the model was unsure,
    // for the log line — the tenant's confidence floor is a dial someone tuned,
    // and its effect has to be visible without opening the database.
    let lowConfidenceCount = 0;

    for (const itemScore of output.items) {
      const item = aiItems.find((i) => i.id === itemScore.scorecard_item_id)!;
      const normalized = normalizeScore(itemScore.score, item.score_type);
      const callIndex = resolveSourceCallIndex(itemScore.evidence, callIdsInOrder.length);
      const sourceCallId = callIndex === null ? null : callIdsInOrder[callIndex]!;
      // Release a consent gate whose evidence actually came from a call we CAN
      // attribute. The pre-scoring pass had to assume the worst because it did
      // not know which call the quote would come from; now it does.
      //
      // Without this, one 24-second call at 0.30 drags every consent gate on a
      // 95-minute sale into manual review, including checkpoints quoted from a
      // 57-minute call attributed at 0.80. Measured on a real Trust Point sale,
      // which is what surfaced it.
      //
      // A null sourceCallId means the scorer cited no particular call AND the
      // sale has more than one it could have meant, so there is nothing to
      // release against and the conservative routing stands. On a single-call
      // sale the citation adds nothing — there is one call either way — so
      // those gates now release or hold on that call's real confidence rather
      // than being held by a missing marker.
      const sourceCallConfidence = sourceCallId ? speakerConfidenceByCall.get(sourceCallId) : undefined;
      const evidenceIsWellAttributed =
        sourceCallConfidence !== undefined && sourceCallConfidence >= CONSENT_SPEAKER_CONFIDENCE_FLOOR;

      // A checkpoint the model itself was unsure about (migration 082). Same
      // destination as the two cases below and for the same reason — a marginal
      // judgement belongs to a person — but the trigger is the tenant's own
      // confidence floor rather than anything about the recording or the runs.
      const lowConfidence = routesToReviewOnConfidence(
        itemScore.confidence,
        scoringSettings.reviewConfidenceFloor,
        // Asymmetric below the floor: a low-confidence FAIL is an allegation and
        // is wrong 94% of the time, so it goes to a person; a low-confidence PASS
        // on a non-consent checkpoint has never been overturned. See
        // routesToReviewOnConfidence.
        {
          isPass: isItemPass(normalized, scoringSettings.passThreshold),
          consentGate: item.consent_gate === true,
        }
      );

      // A checkpoint the independent runs disagreed on is genuinely ambiguous.
      // Send it to the reviewer with the majority verdict attached, and keep it
      // out of the weighted score — which is what makes the resulting number
      // stable: it covers only checkpoints every run agreed on. Unlike the
      // speaker case this cannot be released, since the disagreement is about
      // the verdict itself, not about who was speaking.
      // ruledIds wins over both: a checkpoint a person has already settled is
      // scored on their verdict, not sent back to the queue they ruled it out of.
      const stillProvisional = provisionalIds.has(item.id) && !evidenceIsWellAttributed;
      if (!ruledIds.has(item.id) && (stillProvisional || disputedIds.has(item.id) || lowConfidence)) {
        provisionalWrites.push({ item, itemScore, normalized, sourceCallId });
        if (lowConfidence) lowConfidenceCount++;
        continue;
      }
      itemWrites.push({ item, itemScore, normalized, sourceCallId });
      const weight = Number(item.weight);
      totalWeightedScore += normalized * weight;
      totalWeight += weight;
    }

    // Nothing was auto-scored: every checkpoint that applied to this sale went
    // to a human (all disputed, all under the speaker floor, all under the
    // tenant's confidence floor, or a mix). There is no score to report, and
    // reporting the 0 that a zero denominator arithmetically produces would be
    // a fabricated fail on a sale nobody has judged yet — written into the
    // register, the adviser's record and the client's own CRM. So the score
    // stays empty until the review queue fills it in, which resolving each
    // checkpoint does (routes/review.ts recomputes over pass/fail rows).
    const nothingAutoScored = totalWeight === 0;
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

    // Partial-journey coverage (docs/partial-journey-detection.md, Phase 1):
    // does this journey's evidence look like the complete sale, or does it
    // read as a continuation of an earlier, uncaptured call? Detect and
    // persist only — nothing downstream reacts to this yet (see the
    // journey.ts comment above these functions for why). The signal rides the
    // scoring pass above (consensusCoverage) rather than a second call — see
    // scoreTranscriptConsensus's ConsensusCoverage. Skipped when nothing was
    // auto-scored (no score on screen yet for a coverage judgement to
    // qualify) or when the pass returned no coverage signal at all, and
    // best-effort regardless: a coverage failure must never fail the scoring
    // run itself.
    let coverage: JourneyCoverage | null = null;
    let coverageMissingStages: string[] = [];
    let coverageRationale: string | null = null;
    if (!nothingAutoScored && consensusCoverage) {
      try {
        if (consensusCoverage.disputed) {
          console.log(
            `[ScoreJourney] ${journeyId}: coverage runs disagreed on starts_mid_conversation ` +
              `(agreement ${consensusCoverage.agreement.toFixed(2)}) — took the majority verdict`
          );
        }
        const coverageSignal = assessJourneyCoverage(consensusCoverage.raw);
        const structural = await computeStructuralCorroboration({
          organizationId: journey.organization_id,
          journeyId,
          customerId: journey.customer_id,
          earliestCallCreatedAt: withTranscript[0]!.created_at,
          callCount: withTranscript.length,
          itemResults: itemWrites.map(({ item, normalized }) => ({
            sortOrder: item.sort_order,
            pass: isItemPass(normalized, scoringSettings.passThreshold),
          })),
        });
        const resolved = resolveCoverage(coverageSignal, structural);
        coverage = resolved.coverage;
        coverageMissingStages = coverageSignal.missingStages;
        coverageRationale = resolved.rationale;
        if (coverage !== 'complete') {
          console.log(
            `[ScoreJourney] ${journeyId}: coverage=${coverage} (structural: ${structural.agrees ? structural.reasons.join(',') : 'no corroboration'})`
          );
        }
      } catch (err) {
        console.warn(`[ScoreJourney] ${journeyId}: coverage assessment failed (non-fatal):`, (err as Error).message);
      }
    }

    // Why a breach raised from this run might not be settled (migration 078).
    //
    // A compliance register must never assert more than its evidence supports,
    // and it must not suppress a finding either: missing a genuine failure is
    // worse than raising an uncertain one. So every breach carries the specific
    // weaknesses behind it and a reviewer decides, rather than the platform
    // quietly deciding for them.
    //
    // Computed per breach because two checkpoints on the same sale can rest on
    // very different evidence — one quoted from a call whose speakers are
    // unclear, another from a clean one.
    const speakerUnreliableCalls = new Set(
      withTranscript.filter((c) => c.speaker_integrity_flag !== null
        || (c.speaker_attribution_confidence !== null && Number(c.speaker_attribution_confidence) < 0.5))
        .map((c) => c.id)
    );
    const breachCaveats = (
      itemScore: { confidence?: number | null },
      sourceCallId: string | null
    ): string[] => {
      const caveats: string[] = [];
      const agreement = agreementById.get(
        (itemScore as { scorecard_item_id?: string }).scorecard_item_id ?? ''
      );
      if (agreement !== undefined && agreement < 1) caveats.push('low_agreement');
      // 0.7 is the boundary measured between checkpoints that flipped between
      // runs (mean confidence 0.66) and ones that never did (0.72).
      if (typeof itemScore.confidence === 'number' && itemScore.confidence < 0.7) {
        caveats.push('low_confidence');
      }
      if (sourceCallId) {
        if (speakerUnreliableCalls.has(sourceCallId)) caveats.push('unreliable_speakers');
      } else {
        // No source call: the scorer cited none and the sale has more than one
        // it could have meant (services/journey-transcript.ts resolves the
        // single-call case, so a null here is genuine ambiguity).
        //
        // This used to fall through the check above and produce NO caveat at
        // all, which read as "no known weakness" — the register asserting clean
        // provenance precisely where provenance is unknown. Unknown must not
        // score better than known-bad.
        caveats.push('unattributed_evidence');
        // And if ANY call on the sale has unreliable speakers, the quote may
        // have come from it. We cannot rule that out, so we do not.
        if (speakerUnreliableCalls.size > 0) caveats.push('unreliable_speakers');
      }
      // The branch decides whether this checkpoint applied to the sale at all.
      if (branch && branchSource !== 'crm') caveats.push('guessed_branch');
      return caveats;
    };

    // Assigned inside the scoring transaction (it depends on the run number),
    // read afterwards for the log line.
    let runTrigger: ScoreRunTrigger = 'initial';

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
             (journey_id, scorecard_item_id, result, score, normalized_score, confidence, evidence, reasoning, source_call_id, agreement)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (journey_id, scorecard_item_id) DO UPDATE SET
             result = EXCLUDED.result, score = EXCLUDED.score, normalized_score = EXCLUDED.normalized_score,
             confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, reasoning = EXCLUDED.reasoning,
             source_call_id = EXCLUDED.source_call_id, agreement = EXCLUDED.agreement
           RETURNING id`,
          [journeyId, item.id, result, itemScore.score, normalized, itemScore.confidence, itemScore.evidence, itemScore.reasoning, sourceCallId,
           agreementById.get(item.id) ?? null]
        );
        if (result === 'fail') {
          const severity = deriveSeverity(Number(item.weight), item.severity);
          await tx.query(
            `INSERT INTO breaches (organization_id, journey_id, journey_item_score_id, scorecard_item_id, severity, detected_at, evidence_caveats)
             VALUES ($1, $2, $3, $4, $5, now(), $6)
             ON CONFLICT (journey_item_score_id) DO NOTHING`,
            [journey.organization_id, journeyId, inserted[0]!.id, item.id, severity,
             breachCaveats(itemScore, sourceCallId)]
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
             (journey_id, scorecard_item_id, result, score, normalized_score, confidence, evidence, reasoning, source_call_id, agreement)
           VALUES ($1, $2, 'manual_review', $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (journey_id, scorecard_item_id) DO UPDATE SET
             result = 'manual_review', score = EXCLUDED.score, normalized_score = EXCLUDED.normalized_score,
             confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, reasoning = EXCLUDED.reasoning,
             source_call_id = EXCLUDED.source_call_id, agreement = EXCLUDED.agreement`,
          [journeyId, item.id, itemScore.score, normalized, itemScore.confidence, itemScore.evidence, itemScore.reasoning, sourceCallId,
           agreementById.get(item.id) ?? null]
        );
      }

      // Re-point each ruling at the item-score row that now exists. The rows
      // above replaced the ones the ruling was originally attached to, so
      // without this the pointer stays NULL until someone rules again — the
      // ruling still applies (it is keyed on journey + checkpoint), but the UI
      // could not show which row it belongs to.
      if (ruledIds.size > 0) {
        await tx.query(
          `UPDATE score_corrections sc
              SET journey_item_score_id = jis.id
             FROM journey_item_scores jis
            WHERE sc.journey_id = $1
              AND jis.journey_id = $1
              AND jis.scorecard_item_id = sc.scorecard_item_id`,
          [journeyId]
        );
      }

      await tx.query(
        `UPDATE journeys SET
           status = 'scored', branch = $2, branch_source = $3, overall_score = $4, pass = $5,
           model_id = $6, coaching = $7, coverage = $8, coverage_missing_stages = $9,
           coverage_rationale = $10, scored_at = now(), updated_at = now()
         WHERE id = $1`,
        [journeyId, branch, branchSource,
         nothingAutoScored ? null : overallScore, nothingAutoScored ? null : pass, model,
         output.coaching ? JSON.stringify(output.coaching) : null,
         coverage, coverageMissingStages, coverageRationale]
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
      const runNumber = priorRuns?.next ?? 1;

      // Which kind of run this is. Explicit wins; otherwise derive. The
      // prior-runs check is what catches a mended sale re-scored through the
      // deferred hydrate path (maybeScoreJourneyWhenReady), which enqueues
      // without knowing why the journey went back to 'pending' — a journey
      // reaching scoring with runs already on record was extended, not new.
      runTrigger =
        triggerSource ??
        (rescoredBy ? 'rescore' : suppressCrm ? 'bulk' : runNumber > 1 ? 'backfill' : 'initial');
      await tx.query(
        `INSERT INTO journey_score_runs
           (journey_id, organization_id, run_number, overall_score, pass, branch, branch_source,
            model_id, items_passed, items_failed, items_na, items_manual_review, calls_scored,
            triggered_by, trigger_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          journeyId,
          journey.organization_id,
          runNumber,
          nothingAutoScored ? null : overallScore,
          nothingAutoScored ? null : pass,
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
        : nothingAutoScored
          ? ` [was ${priorScore.toFixed(1)}, now unscored pending review via ${runTrigger}]`
          : ` [was ${priorScore.toFixed(1)}, ${overallScore >= priorScore ? '+' : ''}${(overallScore - priorScore).toFixed(1)} via ${runTrigger}]`;
    const reviewFloorNote = lowConfidenceCount
      ? ` [${lowConfidenceCount} to review under confidence floor ${scoringSettings.reviewConfidenceFloor}]`
      : '';
    console.log(
      `[ScoreJourney] Journey ${journeyId} ` +
      (nothingAutoScored
        ? `not scored: all ${provisionalWrites.length + manualReview.length} applicable checkpoint(s) await review`
        : `scored: ${overallScore.toFixed(1)} (${pass ? 'PASS' : 'FAIL'})`) +
      `${branch ? ` [branch: ${branch} via ${branchSource}]` : ''} across ${withTranscript.length} call(s)${delta}${reviewFloorNote}`
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
    } else if (nothingAutoScored) {
      // There is no verdict to push yet. Both downstream paths coerce a missing
      // score to 0/fail (services/score-writeback.ts), so pushing here would put
      // a 0% QA record and a full set of breach tasks in the client's CRM for a
      // sale the platform explicitly declined to judge. The reviewer's first
      // resolution re-pushes with a real number.
      console.log(
        `[ScoreJourney] Holding webhook + Zoho write-back for ${journeyId} — no checkpoint auto-scored, all await review`
      );
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

    // Application reconciliation, likewise after and independently of scoring.
    // Expected to find nothing on this first attempt: the insurer's pack is
    // attached to the CRM record by hand, usually later the same day. The run is
    // opened here so the sale is on the list, and the maintenance sweep
    // ('reconciliation-sweep') keeps looking until the document arrives.
    await maybeStartReconciliation(journey.organization_id, journeyId);
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
