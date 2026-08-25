import { describe, it, expect } from 'vitest';
import { classifyItems, routesToReviewOnConfidence } from './checkpoint-classification.js';
import type { ScorecardItem } from '@callguard/shared';

function makeItem(overrides: Partial<ScorecardItem> = {}): ScorecardItem {
  return {
    id: 'item-1',
    scorecard_id: 'scorecard-1',
    label: 'Consent to proceed',
    description: null,
    score_type: 'binary',
    weight: 1,
    sort_order: 0,
    created_at: new Date().toISOString(),
    item_type: 'ai',
    consent_gate: false,
    ...overrides,
  };
}

// The floor decides how much of a tenant's scorecard the AI is allowed to settle
// on its own, so the off-by-default and the boundary behaviour both matter more
// than they look. A floor that quietly rounded the wrong way would either flood
// a QA team's queue or silently keep marginal verdicts in a compliance register.
describe('routesToReviewOnConfidence', () => {
  it('routes nothing when the floor is off', () => {
    expect(routesToReviewOnConfidence(0.1, 0)).toBe(false);
    expect(routesToReviewOnConfidence(0, 0)).toBe(false);
  });

  it('routes a checkpoint the model was less confident about than the floor', () => {
    expect(routesToReviewOnConfidence(0.6, 0.85)).toBe(true);
  });

  it('leaves a checkpoint at or above the floor auto-scored', () => {
    expect(routesToReviewOnConfidence(0.85, 0.85)).toBe(false);
    expect(routesToReviewOnConfidence(0.9, 0.85)).toBe(false);
  });

  // Absence of a confidence is not evidence of confidence. The scoring schema
  // requires the field, so a missing one means something upstream went wrong —
  // not a reason to write a pass or a fail nobody can account for.
  it('routes a checkpoint whose confidence is missing or unusable', () => {
    expect(routesToReviewOnConfidence(null, 0.85)).toBe(true);
    expect(routesToReviewOnConfidence(undefined, 0.85)).toBe(true);
    expect(routesToReviewOnConfidence(Number.NaN, 0.85)).toBe(true);
  });

  // ...but only when the tenant asked for the floor at all. With it off, a
  // missing confidence keeps the pre-migration-082 behaviour: score it.
  it('does not route a missing confidence when the floor is off', () => {
    expect(routesToReviewOnConfidence(null, 0)).toBe(false);
  });
});

describe('classifyItems', () => {
  // The gate that actually decides manual review vs auto-scoring for consent
  // items. NULL means speaker attribution was never established (no
  // stereo-channel pin, mono heuristic never run — e.g. a live-streamed call)
  // and must be treated as strictly worse than a measured low score, not as
  // "fully confident". A regression here auto-scores a consent gate off a
  // speaker split nobody ever checked.
  it('routes a consent_gate item to provisional when speaker confidence is NULL', () => {
    const item = makeItem({ consent_gate: true });
    const result = classifyItems([item], null, null);
    expect(result.provisional).toEqual([item]);
    expect(result.scoreable).toEqual([]);
  });

  it('routes a consent_gate item to provisional when speaker confidence is below the floor', () => {
    const item = makeItem({ consent_gate: true });
    const result = classifyItems([item], null, 0.3);
    expect(result.provisional).toEqual([item]);
    expect(result.scoreable).toEqual([]);
  });

  it('auto-scores a consent_gate item when speaker confidence clears the floor', () => {
    const item = makeItem({ consent_gate: true });
    const result = classifyItems([item], null, 0.8);
    expect(result.scoreable).toEqual([item]);
    expect(result.provisional).toEqual([]);
  });

  // The gap the attribution gate closes. Confidence is a consent-gate rule, so a
  // high-confidence-but-unusable transcript still auto-scored the other ~35
  // checkpoints on the scorecard. Andrew Kerr's sale scored 92.68 that way, off a
  // transcript with no Agent turn in it.
  it('routes EVERY applicable item to provisional when the evidence cannot be attributed', () => {
    const ordinary = makeItem({ id: 'a', consent_gate: false });
    const gate = makeItem({ id: 'b', consent_gate: true });
    const result = classifyItems([ordinary, gate], null, 0.8, undefined, [], false);
    expect(result.scoreable).toEqual([]);
    expect(result.provisional).toEqual([ordinary, gate]);
  });

  // Provisional, not na. na asserts the checkpoint did not apply to this sale,
  // which is a different and false claim — the sale is scoreable by a person.
  it('does not mark unattributable items na', () => {
    const item = makeItem({ consent_gate: false });
    const result = classifyItems([item], null, 0.8, undefined, [], false);
    expect(result.na).toEqual([]);
    expect(result.manualReview).toEqual([]);
  });

  it('still auto-scores normally when the evidence can be attributed', () => {
    const item = makeItem({ consent_gate: false });
    const result = classifyItems([item], null, 0.8, undefined, [], true);
    expect(result.scoreable).toEqual([item]);
    expect(result.provisional).toEqual([]);
  });

  // Branch exclusion is about whether the checkpoint applies at all, so it must
  // still win — an unattributable transcript does not make an inapplicable
  // checkpoint suddenly reviewable.
  it('keeps branch exclusion ahead of the attribution gate', () => {
    const item = makeItem({ applies_when: { branch: 'on_risk' } });
    const result = classifyItems([item], 'referred', 0.8, undefined, [], false);
    expect(result.na).toEqual([item]);
    expect(result.provisional).toEqual([]);
  });

  // A NULL confidence is only a problem for consent gates — an ordinary AI
  // item has nothing that depends on which speaker cluster is which.
  it('does not route a non-consent-gate item to provisional on NULL confidence', () => {
    const item = makeItem({ consent_gate: false });
    const result = classifyItems([item], null, null);
    expect(result.scoreable).toEqual([item]);
    expect(result.provisional).toEqual([]);
  });
});

describe('routesToReviewOnConfidence — asymmetric below the floor', () => {
  const FLOOR = 0.8;

  it('does not route anything when the floor is off', () => {
    expect(routesToReviewOnConfidence(0.1, 0)).toBe(false);
  });

  it('does not route a checkpoint at or above the floor', () => {
    expect(routesToReviewOnConfidence(0.8, FLOOR)).toBe(false);
    expect(routesToReviewOnConfidence(0.95, FLOOR)).toBe(false);
  });

  // "We do not know how sure it was" is not a reason to write a verdict into a
  // compliance register.
  it('routes a missing confidence', () => {
    expect(routesToReviewOnConfidence(null, FLOOR)).toBe(true);
    expect(routesToReviewOnConfidence(undefined, FLOOR)).toBe(true);
    expect(routesToReviewOnConfidence(NaN, FLOOR)).toBe(true);
  });

  // Measured over 594 sub-floor checkpoints: a low-confidence FAIL was overturned
  // 313 of 333 times (94%). It is an allegation against a named adviser and must
  // never auto-score.
  it('always routes a low-confidence fail', () => {
    expect(routesToReviewOnConfidence(0.6, FLOOR, { isPass: false, consentGate: false })).toBe(true);
    expect(routesToReviewOnConfidence(0.75, FLOOR, { isPass: false, consentGate: true })).toBe(true);
  });

  // 0 of 180 non-consent sub-floor passes were overturned.
  it('auto-scores a low-confidence pass on an ordinary checkpoint', () => {
    expect(routesToReviewOnConfidence(0.6, FLOOR, { isPass: true, consentGate: false })).toBe(false);
    expect(routesToReviewOnConfidence(0.5, FLOOR, { isPass: true, consentGate: false })).toBe(false);
  });

  // A false pass on a consent is the worst output this product can produce, so
  // consent gates keep the symmetric floor whatever the sample says.
  it('still routes a low-confidence pass on a consent gate', () => {
    expect(routesToReviewOnConfidence(0.6, FLOOR, { isPass: true, consentGate: true })).toBe(true);
  });

  // Callers that pass no verdict keep the old symmetric behaviour, so nothing
  // changes by omission.
  it('routes both ways when no verdict is supplied', () => {
    expect(routesToReviewOnConfidence(0.6, FLOOR)).toBe(true);
  });
});
