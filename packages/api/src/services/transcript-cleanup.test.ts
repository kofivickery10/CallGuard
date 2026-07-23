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
