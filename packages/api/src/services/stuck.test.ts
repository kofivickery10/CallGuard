import { describe, it, expect } from 'vitest';
import {
  classifyJourneyAction,
  buildStuckSummary,
  STUCK_QUEUED_AFTER_MINUTES,
  STUCK_INFLIGHT_AFTER_MINUTES,
  STUCK_CALL_SQL,
  LINKED_TO_ANY_JOURNEY,
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

describe('STUCK_CALL_SQL — resting transcribed calls', () => {
  // A 'transcribed' call at a sales_only firm is waiting for a sale, not stuck:
  // re-enqueueing a score would score a call the firm never asked to have
  // scored. At any other scope the same call is waiting on a lost score job.
  // The firm's scope is the whole test (17 Sep 2026). It used to also require
  // a working Zoho sale trigger, which reported every resting call at a
  // sales_only firm without Zoho as stuck, and the sweep then scored them.
  //
  // The tests run against mocks, not Postgres, so they pin the SQL itself:
  // which clause excludes a transcribed call, and that nothing in it looks at
  // the CRM integration.
  const transcribedClause = STUCK_CALL_SQL.slice(
    STUCK_CALL_SQL.indexOf("c.status = 'transcribed'"),
    STUCK_CALL_SQL.indexOf("c.status = 'scoring'")
  );

  it('excludes transcribed calls at every sales_only firm, by scope alone', () => {
    expect(transcribedClause).toContain('AND c.organization_id NOT IN (');
    expect(transcribedClause).toMatch(/SELECT o\.id FROM organizations o\s+WHERE o\.scoring_scope = 'sales_only'\s*\)/);
  });

  it('does not consult Zoho, so a sales_only firm without it is not reported stuck', () => {
    expect(STUCK_CALL_SQL).not.toContain('zoho_connections');
    expect(STUCK_CALL_SQL).not.toContain('sale_trigger_enabled');
    expect(STUCK_CALL_SQL).not.toContain('inbound_secret_encrypted');
  });

  it('still reports a transcribed call at any other scope, once past the grace period', () => {
    // No other exclusion on the scope: an 'everything' firm's unlinked
    // transcribed call falls through to stuck.
    expect(transcribedClause).toContain("c.updated_at < now() - interval '1 minute' * $1");
    expect(transcribedClause).toContain(`NOT ${LINKED_TO_ANY_JOURNEY}`);
    expect(transcribedClause).not.toMatch(/everything|over_threshold/);
  });
});

describe('grace periods', () => {
  it('gives in-flight work longer than never-queued work', () => {
    // Re-enqueueing a job that never started is free; re-enqueueing one that is
    // merely slow pays Deepgram or Claude twice.
    expect(STUCK_INFLIGHT_AFTER_MINUTES).toBeGreaterThan(STUCK_QUEUED_AFTER_MINUTES);
  });
});
