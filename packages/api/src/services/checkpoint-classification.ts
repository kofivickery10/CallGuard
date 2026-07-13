import { itemAppliesToBranch } from '@callguard/shared';
import type { ScorecardItem } from '@callguard/shared';

// Below this speaker-attribution-confidence floor, a consent_gate item's
// evidence utterance can't be trusted to actually be the customer speaking
// (spec §6) — auto-scoring it risks a false pass on a mislabelled speaker,
// so it goes to manual_review instead.
export const CONSENT_SPEAKER_CONFIDENCE_FLOOR = 0.5;

export interface ClassifiedItems {
  // Sent to Claude for scoring.
  scoreable: ScorecardItem[];
  // Branch-excluded — never scored, excluded from the denominator.
  na: ScorecardItem[];
  // item_type='manual', or a consent_gate item whose speaker attribution is
  // too unreliable to trust — never auto-scored, excluded from the AI-scored
  // denominator, surfaced for a human reviewer instead.
  manualReview: ScorecardItem[];
}

/**
 * Split a scorecard's items into what actually gets sent to Claude vs what
 * resolves to a terminal na/manual_review state up front (spec §8.2/§8.6).
 */
export function classifyItems(
  items: ScorecardItem[],
  branch: string | null,
  speakerAttributionConfidence: number | null,
  confidenceFloor: number = CONSENT_SPEAKER_CONFIDENCE_FLOOR
): ClassifiedItems {
  const na: ScorecardItem[] = [];
  const manualReview: ScorecardItem[] = [];
  const scoreable: ScorecardItem[] = [];

  for (const item of items) {
    if (!itemAppliesToBranch(item.applies_when, branch)) {
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
      manualReview.push(item);
      continue;
    }
    scoreable.push(item);
  }

  return { scoreable, na, manualReview };
}
