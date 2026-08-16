import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne, withTransaction } from '../db/client.js';
import { scoringQueue, ingestionQueue } from '../jobs/queue.js';
import {
  assembleJourney,
  assessJourneyCoverage,
  computeStructuralCorroboration,
  resolveCoverage,
  type CoverageModelSignal,
  type StructuralCorroboration,
} from './journey.js';
import type { RawCoverageSignal } from './scoring.js';

// assembleJourney is DB-bound top to bottom, so the db client and queues are
// mocked rather than skipped (same pattern as journey-feedback.test.ts). What
// is worth pinning here without a live database: the sale-scoping predicate on
// the calls query (the fix for the cross-sale-absorption bug), and that
// re-running for the SAME sale is still idempotent — the property the fix
// must not regress.
vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../jobs/queue.js', () => ({
  scoringQueue: { add: vi.fn() },
  ingestionQueue: { add: vi.fn() },
}));

const ORG = 'org-1';
const CUSTOMER = 'cust-1';
const SCORECARD = { id: 'sc-1', version: 3 };

function makeCall(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    customer_id: CUSTOMER,
    status: 'transcribed',
    journey_id: null,
    call_date: '2026-08-01T10:00:00.000Z',
    created_at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

interface DbFixture {
  // Calls the (mocked) sale-scoped SELECT should return — the test stands in
  // for what Postgres would filter, since these calls mock the client, not a
  // real database.
  calls: Record<string, unknown>[];
  claimedElsewhereCount?: number;
  lastScoredJourneyId?: string | null;
  lastScoredCallIds?: string[];
}

function setupDb(fixture: DbFixture) {
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    if (sql.includes("status IN ('pending', 'scoring')")) {
      return null; // no in-flight journey racing this run
    }
    if (sql.includes('FROM organizations')) {
      return null; // no org-level window override — falls back to the default
    }
    if (sql.includes('FROM dialer_connections')) {
      return null; // no CloudTalk connection — falls back to the default
    }
    if (sql.includes('SELECT count(*)::int AS n FROM calls')) {
      return { n: fixture.claimedElsewhereCount ?? 0 };
    }
    if (sql.includes("status = 'scored'") && sql.includes('FROM journeys')) {
      return fixture.lastScoredJourneyId ? { id: fixture.lastScoredJourneyId } : null;
    }
    if (sql.includes('FROM scorecards WHERE id')) {
      return SCORECARD;
    }
    return null;
  });

  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM scorecards WHERE organization_id')) {
      return [SCORECARD];
    }
    if (sql.includes('FROM calls') && sql.includes('ORDER BY COALESCE(call_date')) {
      return fixture.calls;
    }
    if (sql.includes('FROM journey_calls WHERE journey_id')) {
      return (fixture.lastScoredCallIds ?? []).map((call_id) => ({ call_id }));
    }
    return [];
  });

  vi.mocked(withTransaction).mockImplementation(async (fn) => {
    const tx = {
      query: vi.fn(async () => []),
      queryOne: vi.fn(async (sql: string) => {
        if (sql.startsWith('INSERT INTO journeys')) {
          return { id: 'new-journey-id' };
        }
        return null;
      }),
    };
    return fn(tx as never);
  });
}

describe('assembleJourney — sale scoping', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(withTransaction).mockReset();
    vi.mocked(scoringQueue.add).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(ingestionQueue.add).mockReset().mockResolvedValue(undefined as never);
  });

  it('scopes the calls query to this sale, so a second sale does not absorb the first sale\'s calls', async () => {
    // call-A already belongs to sale-A's journey and is excluded by the
    // scoping predicate; only call-B (unattached) comes back for sale-B.
    setupDb({
      calls: [makeCall('call-b')],
      lastScoredJourneyId: 'journey-a',
      lastScoredCallIds: ['call-a'],
    });

    const journeyId = await assembleJourney({
      organizationId: ORG,
      customerId: CUSTOMER,
      triggerSource: 'zoho_sale',
      zohoRecordId: 'sale-b',
    });

    expect(journeyId).toBe('new-journey-id');

    // Pin the fix itself: the calls SELECT is parameterised by this sale's
    // zohoRecordId and scoped by it in SQL, not just filtered in JS.
    const callsQueryInvocation = vi.mocked(query).mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM calls') && sql.includes('ORDER BY COALESCE(call_date')
    );
    expect(callsQueryInvocation).toBeDefined();
    const [sql, params] = callsQueryInvocation!;
    expect(sql).toContain('zoho_record_id');
    expect(params).toEqual([ORG, CUSTOMER, expect.any(String), 'sale-b']);

    // A fresh journey was created (not sale-A's reused) and handed to scoring.
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(scoringQueue.add).toHaveBeenCalledWith(
      'score-journey',
      { journeyId: 'new-journey-id' },
      expect.objectContaining({ jobId: 'score-journey-new-journey-id' })
    );
  });

  it('is idempotent: re-assembling the SAME sale returns the existing journey without creating a new one', async () => {
    // Re-firing sale-A's trigger finds exactly the calls already on sale-A's
    // journey (the scoping predicate matches journey_id back to zohoRecordId),
    // and Dedup #2 recognises the identical call set.
    setupDb({
      calls: [makeCall('call-a', { journey_id: 'journey-a' })],
      lastScoredJourneyId: 'journey-a',
      lastScoredCallIds: ['call-a'],
    });

    const journeyId = await assembleJourney({
      organizationId: ORG,
      customerId: CUSTOMER,
      triggerSource: 'zoho_sale',
      zohoRecordId: 'sale-a',
    });

    expect(journeyId).toBe('journey-a');
    expect(withTransaction).not.toHaveBeenCalled();
    expect(scoringQueue.add).not.toHaveBeenCalled();
  });

  it('does not create or score a journey when every call in the window already belongs to a different sale', async () => {
    // Every call for this customer in the window was claimed by sale-A; the
    // scoped SELECT for sale-B legitimately returns nothing.
    setupDb({
      calls: [],
      claimedElsewhereCount: 1,
    });

    const journeyId = await assembleJourney({
      organizationId: ORG,
      customerId: CUSTOMER,
      triggerSource: 'zoho_sale',
      zohoRecordId: 'sale-b',
    });

    expect(journeyId).toBeNull();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(scoringQueue.add).not.toHaveBeenCalled();
    expect(ingestionQueue.add).not.toHaveBeenCalled();
  });
});

// docs/partial-journey-detection.md §3.1 — the model-declared coverage
// signal. This used to be its own Anthropic call from journey.ts; it now
// rides the main scoring pass's submit_scores response (services/scoring.ts),
// so assessJourneyCoverage is a pure function over the raw object that call
// already returned — no network mock needed here any more.
describe('assessJourneyCoverage', () => {
  it('parses a well-formed submit_scores coverage object', () => {
    const raw: RawCoverageSignal = {
      starts_mid_conversation: true,
      missing_stages: ['intro', 'fact_find'],
      rationale: 'Opens mid-process at wrap-up; no fact find or intro present.',
    };

    expect(assessJourneyCoverage(raw)).toEqual({
      startsMidConversation: true,
      missingStages: ['intro', 'fact_find'],
      rationale: 'Opens mid-process at wrap-up; no fact find or intro present.',
    });
  });

  it('falls back to safe defaults when the model omits or malforms a field', () => {
    const raw: RawCoverageSignal = {
      starts_mid_conversation: 'yes', // not a boolean — must not be read as truthy
      missing_stages: 'intro', // not an array
      // rationale omitted entirely
    };

    expect(assessJourneyCoverage(raw)).toEqual({
      startsMidConversation: false,
      missingStages: [],
      rationale: '',
    });
  });

  it('falls back to safe defaults, rather than throwing, when no coverage object was returned at all', () => {
    // The scoring pass's schema only requests "coverage" in journeyMode, and
    // even then the model can omit it — coverage assessment is best-effort
    // and must never fail a journey score.
    expect(assessJourneyCoverage(undefined)).toEqual({
      startsMidConversation: false,
      missingStages: [],
      rationale: '',
    });
  });
});

// docs/partial-journey-detection.md §3.2 — free, computed corroboration.
describe('computeStructuralCorroboration', () => {
  const BASE_ITEM_RESULTS = [
    { sortOrder: 1, pass: false },
    { sortOrder: 2, pass: false },
    { sortOrder: 3, pass: false },
    { sortOrder: 4, pass: true },
    { sortOrder: 5, pass: true },
    { sortOrder: 6, pass: true },
  ];

  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
  });

  it('flags front_fail_back_pass when the opening half all failed and the closing half largely passed', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM customers WHERE id')) {
        // Miles apart from the earliest call — no_prior_history must not fire.
        return { first_seen_at: '2020-01-01T00:00:00.000Z' };
      }
      return null;
    });

    const result = await computeStructuralCorroboration({
      organizationId: ORG,
      journeyId: 'journey-1',
      customerId: CUSTOMER,
      earliestCallCreatedAt: '2026-08-01T09:52:16.000Z',
      callCount: 2, // not 1 — the median check must not fire either
      itemResults: BASE_ITEM_RESULTS,
    });

    expect(result.agrees).toBe(true);
    expect(result.reasons).toEqual(['front_fail_back_pass']);
  });

  it('does not flag front_fail_back_pass on a shape that is not front-fail/back-pass', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM customers WHERE id')) {
        return { first_seen_at: '2020-01-01T00:00:00.000Z' };
      }
      return null;
    });

    const result = await computeStructuralCorroboration({
      organizationId: ORG,
      journeyId: 'journey-1',
      customerId: CUSTOMER,
      earliestCallCreatedAt: '2026-08-01T09:52:16.000Z',
      callCount: 2,
      itemResults: [
        { sortOrder: 1, pass: true },
        { sortOrder: 2, pass: false },
        { sortOrder: 3, pass: true },
        { sortOrder: 4, pass: false },
        { sortOrder: 5, pass: true },
        { sortOrder: 6, pass: false },
      ],
    });

    expect(result.agrees).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('flags no_prior_history when the customer was created the same instant as their only call, on a tenant live materially longer', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM customers WHERE id')) {
        // The Jimara case exactly: customer created 09:52:16, its only call
        // created 09:52:16.
        return { first_seen_at: '2026-08-01T09:52:16.000Z' };
      }
      if (sql.includes('FROM calls WHERE organization_id')) {
        // Capture live since 17 July — well over the 14-day bar.
        return { earliest: '2026-07-17T00:00:00.000Z' };
      }
      return null;
    });

    const result = await computeStructuralCorroboration({
      organizationId: ORG,
      journeyId: 'journey-1',
      customerId: CUSTOMER,
      earliestCallCreatedAt: '2026-08-01T09:52:16.000Z',
      callCount: 2,
      itemResults: [],
    });

    expect(result.agrees).toBe(true);
    expect(result.reasons).toEqual(['no_prior_history']);
  });

  it('does not flag no_prior_history when the tenant itself is too new for "materially longer" to mean anything', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM customers WHERE id')) {
        return { first_seen_at: '2026-08-01T09:52:16.000Z' };
      }
      if (sql.includes('FROM calls WHERE organization_id')) {
        // Org's own earliest call is only 2 days before this one.
        return { earliest: '2026-07-30T09:52:16.000Z' };
      }
      return null;
    });

    const result = await computeStructuralCorroboration({
      organizationId: ORG,
      journeyId: 'journey-1',
      customerId: CUSTOMER,
      earliestCallCreatedAt: '2026-08-01T09:52:16.000Z',
      callCount: 2,
      itemResults: [],
    });

    expect(result.agrees).toBe(false);
  });

  it('flags single_call_below_median when the sale has one call and the tenant median spans more', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM customers WHERE id')) {
        return { first_seen_at: '2020-01-01T00:00:00.000Z' };
      }
      if (sql.includes('FROM journey_score_runs')) {
        return { median: '3' };
      }
      return null;
    });

    const result = await computeStructuralCorroboration({
      organizationId: ORG,
      journeyId: 'journey-1',
      customerId: CUSTOMER,
      earliestCallCreatedAt: '2026-08-01T09:52:16.000Z',
      callCount: 1,
      itemResults: [],
    });

    expect(result.agrees).toBe(true);
    expect(result.reasons).toEqual(['single_call_below_median']);
  });

  it('agrees is false when none of the three structural signals fire', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM customers WHERE id')) {
        return { first_seen_at: '2020-01-01T00:00:00.000Z' };
      }
      return null;
    });

    const result = await computeStructuralCorroboration({
      organizationId: ORG,
      journeyId: 'journey-1',
      customerId: CUSTOMER,
      earliestCallCreatedAt: '2026-08-01T09:52:16.000Z',
      callCount: 3,
      itemResults: BASE_ITEM_RESULTS.map((r) => ({ ...r, pass: true })), // uniform pass, no shape
    });

    expect(result.agrees).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});

// docs/partial-journey-detection.md §3.3 — the table combining both signals.
describe('resolveCoverage', () => {
  const midConversation: CoverageModelSignal = {
    startsMidConversation: true,
    missingStages: ['intro'],
    rationale: 'Opens mid-process.',
  };
  const complete: CoverageModelSignal = {
    startsMidConversation: false,
    missingStages: [],
    rationale: 'All stages present.',
  };
  const agrees: StructuralCorroboration = { agrees: true, reasons: ['front_fail_back_pass'] };
  const disagrees: StructuralCorroboration = { agrees: false, reasons: [] };

  it('model mid-conversation + structure agrees -> partial', () => {
    const result = resolveCoverage(midConversation, agrees);
    expect(result.coverage).toBe('partial');
    expect(result.rationale).toBe('Opens mid-process.');
  });

  it('model mid-conversation + structure disagrees -> still partial, but flagged for review', () => {
    const result = resolveCoverage(midConversation, disagrees);
    expect(result.coverage).toBe('partial');
    expect(result.rationale).toMatch(/flagged for review/);
  });

  it('model complete + structure agrees -> unknown, never partial (structure alone cannot override the model)', () => {
    const result = resolveCoverage(complete, agrees);
    expect(result.coverage).toBe('unknown');
  });

  it('model complete + structure disagrees -> complete — the adviser-skipped-everything case must keep scoring at face value', () => {
    const result = resolveCoverage(complete, disagrees);
    expect(result.coverage).toBe('complete');
    expect(result.rationale).toBe('All stages present.');
  });
});
