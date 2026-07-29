import { describe, it, expect } from 'vitest';
import {
  classifyJourneyAction,
  buildStuckSummary,
  STUCK_QUEUED_AFTER_MINUTES,
  STUCK_INFLIGHT_AFTER_MINUTES,
} from './stuck.js';

// These two functions decide what the superadmin health panel reports AND what
// the repair sweep re-enqueues. Over-reporting puts a permanent unfixable
// backlog on the dashboard; over-repairing spends money re-running work that was
// only slow, or fetching audio for calls we deliberately never fetched.

describe('classifyJourneyAction', () => {
  it('hydrates when a linked call still has no audio', () => {
    expect(classifyJourneyAction(['captured', 'transcribed'])).toBe('hydrate');
  });

  it('waits while a linked call is mid-flight', () => {
    // Its own completion drives scoring — re-enqueueing here would double-spend
    // on transcription for a call that is merely slow.
    expect(classifyJourneyAction(['transcribing', 'transcribed'])).toBe('wait');
    expect(classifyJourneyAction(['uploaded'])).toBe('wait');
  });

  it('scores once every linked call is terminal', () => {
    expect(classifyJourneyAction(['transcribed', 'transcribed'])).toBe('score');
    expect(classifyJourneyAction(['transcribed', 'skipped', 'failed'])).toBe('score');
    expect(classifyJourneyAction(['scored'])).toBe('score');
  });

  it('prefers hydration over waiting when both apply', () => {
    // A missing hydrate job blocks the journey indefinitely; the mid-flight call
    // will still finish on its own, so the hydration is the fault to fix.
    expect(classifyJourneyAction(['captured', 'transcribing'])).toBe('hydrate');
  });

  it('scores a journey with no linked calls rather than waiting forever', () => {
    expect(classifyJourneyAction([])).toBe('score');
  });
});

describe('buildStuckSummary', () => {
  const at = (iso: string) => ({ updated_at: iso });

  it('counts calls and journeys separately and breaks down by status', () => {
    const summary = buildStuckSummary(
      [
        { status: 'uploaded', ...at('2026-07-28T10:00:00.000Z') },
        { status: 'uploaded', ...at('2026-07-28T10:05:00.000Z') },
        { status: 'scoring', ...at('2026-07-28T09:00:00.000Z') },
      ],
      [{ status: 'pending', action: 'score', ...at('2026-07-28T11:00:00.000Z') }]
    );

    expect(summary.calls).toBe(3);
    expect(summary.journeys).toBe(1);
    expect(summary.by_status).toEqual({ uploaded: 2, scoring: 1, 'journey:pending': 1 });
  });

  it('excludes journeys the sweep would skip', () => {
    // The whole point: the panel must never report work nothing will act on.
    const summary = buildStuckSummary(
      [],
      [
        { status: 'pending', action: 'wait', ...at('2026-07-28T10:00:00.000Z') },
        { status: 'pending', action: 'wait', ...at('2026-07-28T10:01:00.000Z') },
      ]
    );

    expect(summary.journeys).toBe(0);
    expect(summary.by_status).toEqual({});
    expect(summary.oldest_at).toBeNull();
  });

  it('reports the oldest timestamp across both calls and journeys', () => {
    const summary = buildStuckSummary(
      [{ status: 'uploaded', ...at('2026-07-28T10:00:00.000Z') }],
      [{ status: 'scoring', action: 'score', ...at('2026-04-19T18:53:41.650Z') }]
    );
    expect(summary.oldest_at).toBe('2026-04-19T18:53:41.650Z');
  });

  it('is empty, not null-ish, when nothing is stuck', () => {
    const summary = buildStuckSummary([], []);
    expect(summary).toEqual({ calls: 0, journeys: 0, by_status: {}, oldest_at: null });
  });

  it('ignores an unparseable timestamp instead of reporting NaN', () => {
    const summary = buildStuckSummary([{ status: 'uploaded', updated_at: 'not a date' }], []);
    expect(summary.calls).toBe(1);
    expect(summary.oldest_at).toBeNull();
  });
});

describe('grace periods', () => {
  it('gives in-flight work longer than never-queued work', () => {
    // Re-enqueueing a job that never started is free; re-enqueueing one that is
    // merely slow pays Deepgram or Claude twice.
    expect(STUCK_INFLIGHT_AFTER_MINUTES).toBeGreaterThan(STUCK_QUEUED_AFTER_MINUTES);
  });
});
