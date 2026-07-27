import { describe, it, expect } from 'vitest';
import { sanitiseJourneyWindowDays, MAX_JOURNEY_WINDOW_DAYS } from './tenant-settings.js';

// The window decides which calls make up a scored "sale". Getting it wrong is
// not a loud failure: too short and assembleJourney silently leaves out the fact
// find and recommendation calls, then scores the case on what's left.
describe('sanitiseJourneyWindowDays', () => {
  it('passes a sensible window straight through', () => {
    expect(sanitiseJourneyWindowDays(120)).toBe(120);
    expect(sanitiseJourneyWindowDays(1)).toBe(1);
    expect(sanitiseJourneyWindowDays(MAX_JOURNEY_WINDOW_DAYS)).toBe(MAX_JOURNEY_WINDOW_DAYS);
  });

  it('treats an unset value as "no opinion" so the caller falls back', () => {
    expect(sanitiseJourneyWindowDays(null)).toBeNull();
    expect(sanitiseJourneyWindowDays(undefined)).toBeNull();
  });

  it('falls back rather than producing a window that matches nothing', () => {
    // A zero or negative window would make the journey find no calls and be
    // skipped without an error — worse than using the default.
    expect(sanitiseJourneyWindowDays(0)).toBeNull();
    expect(sanitiseJourneyWindowDays(-30)).toBeNull();
  });

  it('falls back on a non-finite value', () => {
    expect(sanitiseJourneyWindowDays(NaN)).toBeNull();
    expect(sanitiseJourneyWindowDays(Infinity)).toBeNull();
  });

  it('caps an over-long window instead of honouring it', () => {
    // Guards against a mis-set value sweeping a customer's whole history into
    // one journey.
    expect(sanitiseJourneyWindowDays(5000)).toBe(MAX_JOURNEY_WINDOW_DAYS);
  });

  it('floors a fractional value to whole days', () => {
    expect(sanitiseJourneyWindowDays(90.7)).toBe(90);
  });
});
