import { describe, it, expect } from 'vitest';
import {
  resolveSpeakerConfidence,
  isCleanupContentLoss,
  CLEANUP_MIN_RETAINED_RATIO,
} from './transcript-cleanup.js';
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

describe('isCleanupContentLoss', () => {
  const raw = 'Agent: '.padEnd(1000, 'x'); // 1000-char raw transcript

  it('flags a cleaned transcript that dropped a large chunk', () => {
    // The observed failure: a long call cleaned down to ~72% of the raw length.
    const cleaned = raw.slice(0, 720);
    expect(isCleanupContentLoss(raw, cleaned)).toBe(true);
  });

  it('passes a faithful cleanup of roughly the same length', () => {
    const cleaned = raw.slice(0, 950); // minor tidy-up, 95% retained
    expect(isCleanupContentLoss(raw, cleaned)).toBe(false);
  });

  it('passes a cleanup that grew slightly (added punctuation)', () => {
    expect(isCleanupContentLoss(raw, raw + ' extra punctuation.')).toBe(false);
  });

  it('sits exactly on the configured retention threshold', () => {
    const justUnder = 'y'.repeat(Math.floor(1000 * CLEANUP_MIN_RETAINED_RATIO) - 1);
    const justOver = 'y'.repeat(Math.ceil(1000 * CLEANUP_MIN_RETAINED_RATIO) + 1);
    expect(isCleanupContentLoss(raw, justUnder)).toBe(true);
    expect(isCleanupContentLoss(raw, justOver)).toBe(false);
  });

  it('never flags when the raw transcript is empty (nothing to lose)', () => {
    expect(isCleanupContentLoss('', '')).toBe(false);
    expect(isCleanupContentLoss('   ', 'anything')).toBe(false);
  });
});

// The 'partial' verdict. Added after a real Trust Point call had the adviser's
// own compliance script attributed to the customer while turns either side were
// labelled correctly. With only swapped/confirmed/unclear on offer the model
// answered 'confirmed', which is one of only two verdicts that LIFTS attribution
// confidence — the most dangerous possible answer on a mislabelled transcript.
describe('partial speaker verdict', () => {
  it('does NOT lift attribution confidence, unlike confirmed or swapped', () => {
    // The whole-transcript swap cannot fix a partial inversion, so knowing part
    // of the call is wrong is no basis for trusting any of it.
    expect(resolveSpeakerConfidence(0.3, 'partial')).toBe(0.3);
    expect(resolveSpeakerConfidence(0.3, 'unclear')).toBe(0.3);
    expect(resolveSpeakerConfidence(0.3, 'confirmed')).toBe(0.75);
    expect(resolveSpeakerConfidence(0.3, 'swapped')).toBe(0.75);
  });
});

// The lift is what carries a mono call over CONSENT_SPEAKER_CONFIDENCE_FLOOR,
// so it is the single most consequential number in the speaker pipeline.
describe('confidence lift requires independent corroboration', () => {
  it('does NOT lift a "confirmed" when the content check abstained', () => {
    // The cleanup model is reading the same weak signal that already failed to
    // separate the clusters, so its agreement is not independent evidence.
    // Measured on a real call: content abstained, cleanup said confirmed,
    // confidence rose 0.6 -> 0.75, and the transcript was inverted.
    expect(resolveSpeakerConfidence(0.45, 'confirmed', false)).toBe(0.45);
  });

  it('lifts a "confirmed" when the content check agreed', () => {
    expect(resolveSpeakerConfidence(0.8, 'confirmed', true)).toBe(0.8);
    expect(resolveSpeakerConfidence(0.45, 'confirmed', true)).toBe(0.75);
  });

  it('lifts a "swapped" either way — an active correction, not an all-clear', () => {
    expect(resolveSpeakerConfidence(0.45, 'swapped', false)).toBe(0.75);
  });

  it('keeps an abstained call below the consent-gate floor', () => {
    // The point of the whole change: a call we cannot attribute sends its
    // consent gates to a person rather than guessing at them.
    expect(resolveSpeakerConfidence(0.45, 'confirmed', false))
      .toBeLessThan(CONSENT_SPEAKER_CONFIDENCE_FLOOR);
    expect(resolveSpeakerConfidence(0.45, 'unclear', false))
      .toBeLessThan(CONSENT_SPEAKER_CONFIDENCE_FLOOR);
  });
});
