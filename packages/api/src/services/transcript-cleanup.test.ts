import { describe, it, expect } from 'vitest';
import { resolveSpeakerConfidence } from './transcript-cleanup.js';
import { CONSENT_SPEAKER_CONFIDENCE_FLOOR } from './checkpoint-classification.js';

describe('resolveSpeakerConfidence', () => {
  it('raises a low mono confidence above the consent-gate floor when labels are swapped', () => {
    const raised = resolveSpeakerConfidence(0.3, 'swapped');
    expect(raised).toBe(0.75);
    expect(raised).toBeGreaterThanOrEqual(CONSENT_SPEAKER_CONFIDENCE_FLOOR);
  });

  it('raises a low mono confidence above the floor when labels are positively confirmed', () => {
    // The bug this fixes: a content-confirmed mono call used to stay at 0.3 and
    // route every consent gate to manual review.
    const raised = resolveSpeakerConfidence(0.3, 'confirmed');
    expect(raised).toBe(0.75);
    expect(raised).toBeGreaterThanOrEqual(CONSENT_SPEAKER_CONFIDENCE_FLOOR);
  });

  it('leaves confidence untouched when the split is unclear', () => {
    expect(resolveSpeakerConfidence(0.3, 'unclear')).toBe(0.3);
  });

  it('leaves confidence untouched when the check was skipped (exact channel pin)', () => {
    expect(resolveSpeakerConfidence(1.0, 'not_checked')).toBe(1.0);
  });

  it('never lowers an already-high confidence', () => {
    expect(resolveSpeakerConfidence(1.0, 'confirmed')).toBe(1.0);
    expect(resolveSpeakerConfidence(0.9, 'swapped')).toBe(0.9);
  });
});
