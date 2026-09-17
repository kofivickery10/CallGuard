import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { getScoringSettings } from '../../services/tenant-settings.js';
import { assembleJourney, maybeScoreJourneyWhenReady } from '../../services/journey.js';
import { scoringQueue } from '../queue.js';
import { processTranscription } from './transcribe.js';

// What happens to a call once it is transcribed: scored on its own, held for a
// sale, or assembled straight into a sale.
//
// The firm's scoring_scope alone decides (product owner, 17 Sep 2026). This
// used to also ask whether the firm had a working Zoho sale trigger, and score
// every call on its own when it did not — so a sales_only firm whose sales
// arrive some other way was scored call by call without anyone choosing it.
//
// Every call here is already at 'transcribed', so the job's idempotency guard
// skips Deepgram and the cleanup pass and goes straight to routing — the part
// under test — with nothing but the database and queues mocked.

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(),
}));
vi.mock('../../services/tenant-settings.js', () => ({ getScoringSettings: vi.fn() }));
vi.mock('../../services/journey.js', () => ({
  assembleJourney: vi.fn(async () => 'journey-1'),
  maybeScoreJourneyWhenReady: vi.fn(async () => {}),
}));
vi.mock('../queue.js', () => ({ scoringQueue: { add: vi.fn(async () => ({})) } }));
vi.mock('../../services/transcription.js', () => ({
  transcribeCall: vi.fn(),
  resolveTenantRedactCategories: vi.fn(),
}));
vi.mock('../../services/transcript-cleanup.js', () => ({
  cleanupTranscript: vi.fn(),
  resolveSpeakerConfidence: vi.fn(),
}));
vi.mock('../../services/kb.js', () => ({ getKBContext: vi.fn(async () => '') }));
vi.mock('../../services/alert-evaluator.js', () => ({ evaluateAlertsForCall: vi.fn(async () => {}) }));
vi.mock('../../services/usage.js', () => ({ recordUsage: vi.fn(async () => {}) }));

type Scope = 'sales_only' | 'over_threshold' | 'everything';

function settings(scoringScope: Scope) {
  return { scoringScope, fetchRecordingsOnSale: false } as unknown as Awaited<
    ReturnType<typeof getScoringSettings>
  >;
}

function call(extra: Record<string, unknown> = {}) {
  return {
    id: 'call-1',
    organization_id: 'org-1',
    status: 'transcribed',
    sale_flagged: false,
    customer_id: null,
    journey_id: null,
    ...extra,
  };
}

async function route(scope: Scope, callRow: Record<string, unknown>) {
  vi.mocked(getScoringSettings).mockResolvedValue(settings(scope));
  vi.mocked(queryOne).mockImplementation((async (sql: string) =>
    sql.includes('FROM calls') ? callRow : null) as never);
  await processTranscription({
    data: { callId: 'call-1' },
    opts: { attempts: 3 },
    attemptsMade: 0,
  } as unknown as Job<{ callId: string }>);
}

function sqlSeen(): string[] {
  return [...vi.mocked(queryOne).mock.calls, ...vi.mocked(query).mock.calls].map((c) => String(c[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processTranscription routing — scoring follows scoring_scope', () => {
  it('holds a sales_only call for a sale when the firm has no Zoho connection at all', async () => {
    await route('sales_only', call());

    expect(scoringQueue.add).not.toHaveBeenCalled();
    expect(assembleJourney).not.toHaveBeenCalled();
    // The decision must not consult the CRM integration in any form.
    expect(sqlSeen().some((sql) => sql.includes('zoho_connections'))).toBe(false);
  });

  it('scores every call on its own at everything', async () => {
    await route('everything', call());
    expect(scoringQueue.add).toHaveBeenCalledWith('score', { callId: 'call-1' }, { jobId: 'score-call-1' });
  });

  it('scores every call on its own at over_threshold', async () => {
    await route('over_threshold', call());
    expect(scoringQueue.add).toHaveBeenCalledWith('score', { callId: 'call-1' }, { jobId: 'score-call-1' });
  });

  it('assembles a sale straight away for a call flagged as a sale at upload', async () => {
    await route('sales_only', call({ sale_flagged: true, customer_id: 'customer-1' }));

    expect(assembleJourney).toHaveBeenCalledWith({
      organizationId: 'org-1',
      customerId: 'customer-1',
      triggerSource: 'manual',
    });
    expect(scoringQueue.add).not.toHaveBeenCalled();
  });

  it('still holds a sale-flagged call with no customer to attach a sale to', async () => {
    // No phone was given at upload, so there is nothing to assemble — and at
    // sales_only it must not fall through to per-call scoring either.
    await route('sales_only', call({ sale_flagged: true, customer_id: null }));

    expect(assembleJourney).not.toHaveBeenCalled();
    expect(scoringQueue.add).not.toHaveBeenCalled();
  });

  it('leaves a call hydrated into a sale to the sale, whatever the scope', async () => {
    await route('everything', call({ journey_id: 'journey-9' }));

    expect(maybeScoreJourneyWhenReady).toHaveBeenCalledWith('journey-9');
    expect(scoringQueue.add).not.toHaveBeenCalled();
  });
});
