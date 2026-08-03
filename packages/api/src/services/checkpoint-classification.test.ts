import { describe, it, expect } from 'vitest';
import { routesToReviewOnConfidence } from './checkpoint-classification.js';

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
