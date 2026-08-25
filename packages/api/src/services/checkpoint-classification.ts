import { itemAppliesToBranch, productAppliesToItem } from '@callguard/shared';
import type { ScorecardItem } from '@callguard/shared';

// Below this speaker-attribution-confidence floor, a consent_gate item's
// evidence utterance can't be trusted to actually be the customer speaking
// (spec §6) — auto-scoring it risks a false pass on a mislabelled speaker,
// so it goes to manual_review instead.
export const CONSENT_SPEAKER_CONFIDENCE_FLOOR = 0.5;

/**
 * Whether a checkpoint the AI did score should nonetheless be handed to a human
 * because the model was not confident enough about it (migration 082).
 *
 * Applied AFTER scoring, unlike the classification below: the confidence is
 * part of the verdict, so the checkpoint is scored first and then routed to
 * manual_review carrying that provisional verdict, its evidence and its
 * reasoning. The reviewer confirms or overturns; nothing is thrown away.
 *
 * A missing confidence routes as well when the floor is on. The scoring schema
 * requires the field, so its absence means something went wrong upstream rather
 * than that the model was sure — and "we don't know how sure it was" is not a
 * reason to write a pass or a fail into a compliance register.
 */
export function routesToReviewOnConfidence(
  confidence: number | null | undefined,
  floor: number,
  // The AI's provisional verdict, and whether this checkpoint guards a consent.
  // Both default so existing callers keep the symmetric behaviour.
  verdict?: { isPass: boolean; consentGate: boolean }
): boolean {
  if (!(floor > 0)) return false;
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return true;
  if (confidence >= floor) return false;

  // Below the floor. Whether that needs a person depends on which way the
  // verdict went, and the difference is not marginal.
  //
  // Measured over 594 sub-floor checkpoints a reviewer worked on the first
  // deploying firm:
  //
  //   AI said PASS   261 items -> reviewer agreed 261, overturned   0   (0.0%)
  //   AI said FAIL   333 items -> reviewer agreed  20, overturned 313  (94.0%)
  //
  // So the model's uncertainty is real, and it is almost entirely on the FAIL
  // side. A low-confidence fail is wrong 94% of the time and must never be
  // written into a compliance register unseen — it is an allegation against a
  // named adviser. A low-confidence pass has not been overturned once.
  //
  // Lowering the floor instead, which is the obvious move from the queue's
  // volume, would have auto-scored 390 items and turned 153 of them into
  // recorded failures a human had already overturned. The queue is not wasteful;
  // it is catching the over-failing that D-03 is about. What it does not need is
  // the pass side.
  //
  // CONSENT GATES ARE EXEMPT. A false pass on a consent is the worst output this
  // product can produce, so they keep the symmetric floor whatever the numbers
  // say — 0 of 81 is a measurement of reviewer behaviour, not a proof, and this
  // is not the place to spend it.
  if (verdict && verdict.isPass && !verdict.consentGate) return false;
  return true;
}

export interface ClassifiedItems {
  // Sent to Claude and auto-scored normally.
  scoreable: ScorecardItem[];
  // Branch- or product-excluded — never scored, excluded from the denominator.
  na: ScorecardItem[];
  // item_type='manual' — never auto-scored, excluded from the AI-scored
  // denominator, surfaced for a human reviewer.
  manualReview: ScorecardItem[];
  // consent_gate items whose speaker attribution is below the floor: still
  // sent to Claude (score everything we can), but the result is stored as
  // manual_review WITH the AI's provisional verdict/evidence attached — the
  // human confirms rather than scoring from scratch. Excluded from the
  // auto-score denominator and the breach register until confirmed, so an
  // unreliable speaker split can't mint a false consent pass on its own.
  provisional: ScorecardItem[];
}

/**
 * Split a scorecard's items into what actually gets sent to Claude vs what
 * resolves to a terminal na/manual_review state up front (spec §8.2/§8.6).
 */
export function classifyItems(
  items: ScorecardItem[],
  branch: string | null,
  speakerAttributionConfidence: number | null,
  confidenceFloor: number = CONSENT_SPEAKER_CONFIDENCE_FLOOR,
  // The product ids the sale covered. Empty = product unknown/not configured;
  // product-restricted items then still score (conservative — see
  // productAppliesToItem). An item is scored only when it applies to BOTH the
  // resolved branch and the sale's products.
  journeyProductIds: string[] = [],
  // False when the evidence cannot support a claim about who said something at
  // all — the transcript is one-sided, or its labels are flagged as untrustworthy
  // (services/speaker-integrity.ts transcriptSupportsAttribution). Defaults true
  // so existing callers keep their behaviour.
  evidenceAttributable: boolean = true
): ClassifiedItems {
  const na: ScorecardItem[] = [];
  const manualReview: ScorecardItem[] = [];
  const provisional: ScorecardItem[] = [];
  const scoreable: ScorecardItem[] = [];

  for (const item of items) {
    if (!itemAppliesToBranch(item.applies_when, branch)) {
      na.push(item);
      continue;
    }
    if (!productAppliesToItem(item.applies_to_products, journeyProductIds)) {
      na.push(item);
      continue;
    }
    if (item.item_type === 'manual') {
      manualReview.push(item);
      continue;
    }
    // NULL confidence must trip a consent gate, not slide past it: NULL means
    // speaker attribution was never established at all (no stereo-channel pin
    // and the mono heuristic never ran, e.g. live-streamed calls), which is
    // strictly less trustworthy than a measured low score, not more. Reading
    // NULL as "fully confident" (`!== null` before the floor check) is exactly
    // how "we never established who was speaking" was auto-scored as if the
    // customer's own voice had given consent — a false pass on consent is the
    // worst output this product can produce, so an unknown speaker split
    // routes to a human the same as a known-unreliable one.
    const unreliableSpeakerSplit =
      item.consent_gate &&
      (speakerAttributionConfidence === null || speakerAttributionConfidence < confidenceFloor);
    // Nothing on this transcript can be attributed, so nothing on it may be
    // auto-scored — not just the consent gates.
    //
    // The confidence floor above is a consent-gate rule, and that was the whole
    // gap: it protects the checkpoints that ask WHO said something and leaves
    // every other checkpoint scoring off the same unusable evidence. On a
    // 41-item scorecard that is roughly 35 checkpoints judged against a
    // transcript the platform has already concluded it cannot read.
    //
    // Provisional rather than na: the words are all there, so a person with the
    // recording can score the sale, and their verdicts produce the score. na
    // would assert the checkpoints did not apply, which is a different and false
    // claim.
    if (unreliableSpeakerSplit || !evidenceAttributable) {
      provisional.push(item);
      continue;
    }
    scoreable.push(item);
  }

  return { scoreable, na, manualReview, provisional };
}
