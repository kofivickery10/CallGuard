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
  floor: number
): boolean {
  if (!(floor > 0)) return false;
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return true;
  return confidence < floor;
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
  journeyProductIds: string[] = []
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
    const unreliableSpeakerSplit =
      item.consent_gate &&
      speakerAttributionConfidence !== null &&
      speakerAttributionConfidence < confidenceFloor;
    if (unreliableSpeakerSplit) {
      provisional.push(item);
      continue;
    }
    scoreable.push(item);
  }

  return { scoreable, na, manualReview, provisional };
}
