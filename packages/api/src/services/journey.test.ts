import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne, withTransaction } from '../db/client.js';
import { scoringQueue, ingestionQueue } from '../jobs/queue.js';
import { chooseWrapUpCall, MIN_WRAP_UP_SECONDS } from './wrap-up.js';
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
    // The customer parameter is a LIST since CG-8 (migration 114): a customer
    // who rings from a second number is a second `customers` row, and assembly
    // now gathers across every row linked as the same person. An unlinked
    // customer — the normal case, and this one — is a list of one, so the sale
    // scoping this test pins is unchanged.
    expect(params).toEqual([ORG, [CUSTOMER], expect.any(String), 'sale-b']);

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
describe('chooseWrapUpCall', () => {
  // A call leg as the dialler webhook stores it: no call_date, timed by arrival.
  function leg(id: string, minutes: number | null, at: string) {
    return {
      id,
      duration_seconds: minutes === null ? null : Math.round(minutes * 60),
      call_date: null,
      created_at: at,
    };
  }

  it('skips a sub-minute call made straight after the sales call', () => {
    // Trust Point b4f8336d: a 26.7-minute sale, then a 0.7-minute leg 84s later.
    const sale = leg('sale', 26.7, '2026-08-29T11:42:02Z');
    const trailing = leg('trailing', 0.7, '2026-08-29T11:43:26Z');
    expect(chooseWrapUpCall([sale, trailing])?.id).toBe('sale');
  });

  it('keeps the latest substantial call, not the longest, so a later close beats an earlier advice call', () => {
    const advice = leg('advice', 64.5, '2026-08-12T10:37:18Z');
    const close = leg('close', 7.6, '2026-08-18T08:57:43Z');
    const voicemail = leg('voicemail', 0.8, '2026-08-19T15:21:57Z');
    expect(chooseWrapUpCall([advice, close, voicemail])?.id).toBe('close');
  });

  it('counts a call of exactly the minimum as substantial', () => {
    const earlier = leg('earlier', 30, '2026-08-01T10:00:00Z');
    const boundary = { ...leg('boundary', null, '2026-08-01T11:00:00Z'), duration_seconds: MIN_WRAP_UP_SECONDS };
    expect(chooseWrapUpCall([earlier, boundary])?.id).toBe('boundary');
  });

  it('falls back to the longest call when none is long enough', () => {
    const longer = leg('longer', 1.5, '2026-08-21T10:08:00Z');
    const later = leg('later', 0.4, '2026-08-24T15:08:14Z');
    expect(chooseWrapUpCall([longer, later])?.id).toBe('longer');
  });

  it('does not pass over a later call whose length is not known yet', () => {
    // An SFTP close still transcribing when scoring runs: holding the sale on it
    // beats scoring the sale from Monday's advice call alone.
    const advice = leg('advice', 30, '2026-08-03T10:00:00Z');
    const untranscribedClose = leg('close', null, '2026-08-06T15:00:00Z');
    expect(chooseWrapUpCall([advice, untranscribedClose])?.id).toBe('close');
  });

  it('falls back to the latest call when no duration is known yet', () => {
    const first = leg('first', null, '2026-08-01T10:00:00Z');
    const last = leg('last', null, '2026-08-02T10:00:00Z');
    expect(chooseWrapUpCall([last, first])?.id).toBe('last');
  });

  it('prefers call_date over created_at, and reads pg numeric durations', () => {
    const backfilled = { id: 'backfilled', duration_seconds: '900.5', call_date: '2026-08-05T09:00:00Z', created_at: '2026-08-20T09:00:00Z' };
    const newer = { id: 'newer', duration_seconds: '600', call_date: '2026-08-10T09:00:00Z', created_at: '2026-08-10T09:00:00Z' };
    expect(chooseWrapUpCall([backfilled, newer])?.id).toBe('newer');
  });

  it('returns null for no calls', () => {
    expect(chooseWrapUpCall([])).toBeNull();
  });
});

describe('assembleJourney — wrap-up choice', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(withTransaction).mockReset();
    vi.mocked(scoringQueue.add).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(ingestionQueue.add).mockReset().mockResolvedValue(undefined as never);
  });

  it('marks the sales call as the wrap-up, not the short call logged after it', async () => {
    setupDb({
      calls: [
        makeCall('call-sale', { call_date: null, created_at: '2026-08-29T11:42:02Z', duration_seconds: 1602 }),
        makeCall('call-trailing', { call_date: null, created_at: '2026-08-29T11:43:26Z', duration_seconds: 42 }),
      ],
    });
    const roles = new Map<string, string>();
    vi.mocked(withTransaction).mockImplementation(async (fn) =>
      fn({
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.startsWith('INSERT INTO journey_calls')) roles.set(params![1] as string, params![2] as string);
          return [];
        }),
        queryOne: vi.fn(async (sql: string) => (sql.startsWith('INSERT INTO journeys') ? { id: 'new-journey-id' } : null)),
      } as never)
    );

    await assembleJourney({ organizationId: ORG, customerId: CUSTOMER, triggerSource: 'zoho_sale', zohoRecordId: 'sale-1' });

    expect(roles.get('call-sale')).toBe('wrap_up');
    expect(roles.get('call-trailing')).toBe('context');
  });
});

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
