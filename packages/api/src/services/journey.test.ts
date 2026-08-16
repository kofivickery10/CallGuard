import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne, withTransaction } from '../db/client.js';
import { scoringQueue, ingestionQueue } from '../jobs/queue.js';
import { assembleJourney } from './journey.js';

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
