import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { query, queryOne } from '../db/client.js';
import { captureCallMetadata } from '../services/ingestion.js';
import { getScoringSettings } from '../services/tenant-settings.js';
import { ingestionQueue } from '../jobs/queue.js';
import { handleCloudTalkWebhook } from './ingestion.js';

// The CloudTalk webhook's one real decision: keep only the call's metadata
// until a sale arrives, or download the recording now.
//
// Metadata-only capture happens exactly when the firm scores sales AND staff
// have set it to fetch recordings on sale (migration 119). It used to be
// inferred from the firm's Zoho connection instead. The two are kept apart now
// because not fetching a recording is the one choice here that can lose data:
// once the dialler's own retention expires, a recording never downloaded is
// gone. So the download path is the default, and no CRM row can turn it off.
//
// The handler is called directly with the database, settings and queue mocked.
// The database mock answers a Zoho lookup with an active, configured trigger,
// so a handler that still consulted Zoho would be caught changing its mind.

vi.mock('../db/client.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(),
}));
vi.mock('../services/tenant-settings.js', () => ({
  getDialerConnection: vi.fn(async () => null),
  verifyDialerSignature: vi.fn(() => true),
  getScoringSettings: vi.fn(),
}));
vi.mock('../services/ingestion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ingestion.js')>()),
  captureCallMetadata: vi.fn(async () => ({ call: { id: 'call-1' }, isDuplicate: false })),
  ingestCall: vi.fn(),
}));
vi.mock('../jobs/queue.js', () => ({
  ingestionQueue: { add: vi.fn(async () => ({})), getJob: vi.fn(async () => null) },
}));

type Scope = 'sales_only' | 'over_threshold' | 'everything';

async function deliver(scoringScope: Scope, fetchRecordingsOnSale: boolean) {
  vi.mocked(getScoringSettings).mockResolvedValue({
    scoringScope,
    fetchRecordingsOnSale,
  } as unknown as Awaited<ReturnType<typeof getScoringSettings>>);

  const req = {
    user: { organizationId: 'org-1', userId: 'key-1', role: 'api' },
    headers: {},
    body: {
      call_uuid: 'ct-123',
      recording_url: 'https://recordings.example/ct-123.mp3',
      external_number: '+447700900123',
      agent_email: 'adviser@example.com',
      talking_time: 240,
    },
  } as unknown as Request;

  const status = vi.fn();
  const json = vi.fn();
  const res = { status, json } as unknown as Response;
  status.mockReturnValue(res);
  const next = vi.fn() as unknown as NextFunction;

  await handleCloudTalkWebhook(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return { status, json };
}

function sqlSeen(): string[] {
  return [...vi.mocked(queryOne).mock.calls, ...vi.mocked(query).mock.calls].map((c) => String(c[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queryOne).mockImplementation((async (sql: string) =>
    sql.includes('zoho_connections')
      ? { id: 'zoho-1', status: 'active', sale_trigger_enabled: true, inbound_secret_encrypted: 'x' }
      : null) as never);
});

describe('CloudTalk webhook — metadata-only capture or download', () => {
  it('captures metadata only for a sales_only firm set to fetch recordings on sale', async () => {
    const { status, json } = await deliver('sales_only', true);

    expect(captureCallMetadata).toHaveBeenCalledTimes(1);
    expect(ingestionQueue.add).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ status: 'captured', external_id: 'ct-123' });
    expect(sqlSeen().some((sql) => sql.includes('zoho_connections'))).toBe(false);
  });

  it('downloads the recording for a sales_only firm not set to fetch on sale, even with a Zoho trigger', async () => {
    const { json } = await deliver('sales_only', false);

    expect(captureCallMetadata).not.toHaveBeenCalled();
    expect(ingestionQueue.add).toHaveBeenCalledWith(
      'ingest-call',
      expect.objectContaining({ organizationId: 'org-1', externalId: 'ct-123' }),
      expect.objectContaining({ jobId: 'ingest-org-1-ct-123' })
    );
    expect(json).toHaveBeenCalledWith({ status: 'accepted', external_id: 'ct-123' });
    expect(sqlSeen().some((sql) => sql.includes('zoho_connections'))).toBe(false);
  });

  it.each<Scope>(['everything', 'over_threshold'])(
    'downloads the recording at %s, even if the flag were somehow set',
    async (scope) => {
      // getScoringSettings already refuses to report the flag outside
      // sales_only; the handler checks the scope as well, so neither alone can
      // stop a call-scoring firm's recordings being fetched.
      await deliver(scope, true);

      expect(captureCallMetadata).not.toHaveBeenCalled();
      expect(ingestionQueue.add).toHaveBeenCalledTimes(1);
    }
  );
});
