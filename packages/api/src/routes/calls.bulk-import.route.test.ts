import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { ingestionQueue } from '../jobs/queue.js';
import { fetchRemoteAudio } from '../services/ingestion.js';

// Bulk import used to download up to 200 recordings inside one HTTP request —
// minutes of work the browser gave up on, leaving the operator unable to tell
// which rows had landed. It now validates the rows, creates a 'captured' call
// for each and hands the fetching to the ingestion queue's existing
// 'hydrate-call' job, returning at once.
//
// Also covered here: the `uploaded_by=me` filter the Upload page's "Your recent
// uploads" rail reads, which must stay org-scoped and carry no transcript.
//
// Database, storage and the queues are mocked; auth and the routes are real.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));
vi.mock('../services/storage.js', () => ({
  uploadFile: vi.fn(async () => {}),
  deleteFile: vi.fn(async () => {}),
  readFile: vi.fn(),
}));
vi.mock('../jobs/queue.js', () => ({
  transcriptionQueue: { add: vi.fn(async () => ({})) },
  scoringQueue: { add: vi.fn(async () => ({})) },
  ingestionQueue: { add: vi.fn(async () => ({})), getJob: vi.fn(async () => null) },
  alertsQueue: { add: vi.fn(async () => ({})) },
  maintenanceQueue: { add: vi.fn(async () => ({})) },
  stuckRepairQueue: { add: vi.fn(async () => ({})) },
}));
// The real ingestion service, except for the network fetch — which must never
// be reached from this request at all.
vi.mock('../services/ingestion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ingestion.js')>()),
  fetchRemoteAudio: vi.fn(async () => {
    throw new Error('the request must not download recordings');
  }),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const USER = '00000000-0000-0000-0000-0000000000aa';

let server: Server;
let baseUrl: string;

function signToken(role: string): string {
  return jwt.sign({ userId: USER, organizationId: ORG, role, mfa: true }, config.jwt.secret, {
    expiresIn: '5m',
  });
}

beforeAll(async () => {
  const { app } = await import('../app.js');
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  // No existing call, no matching adviser, no scorecard lookup hit.
  vi.mocked(queryOne).mockResolvedValue(null);
  vi.mocked(query).mockImplementation((async (sql: string) =>
    String(sql).includes('INSERT INTO calls')
      ? [{ id: 'call-1', external_id: 'crm-1', status: 'captured' }]
      : []) as never);
});

interface ImportRow {
  row?: number;
  audio_url: string;
  external_id?: string;
  call_date?: string;
  agent_name?: string;
}

function bulkImport(rows: ImportRow[], role = 'admin'): Promise<Response> {
  return fetch(`${baseUrl}/api/calls/bulk-import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signToken(role)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
}

function insertedCalls(): unknown[][] {
  return vi
    .mocked(query)
    .mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO calls'))
    .map(([, params]) => params as unknown[]);
}

describe('POST /api/calls/bulk-import — queues instead of downloading', () => {
  it('creates a call per row, enqueues hydration and returns straight away', async () => {
    const res = await bulkImport([
      { row: 2, audio_url: 'https://archive.example.com/call-001.mp3', external_id: 'crm-1' },
      { row: 3, audio_url: 'https://archive.example.com/call-002.mp3', external_id: 'crm-2' },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 2, accepted: 2, skipped: 0, errors: [] });
    expect(fetchRemoteAudio).not.toHaveBeenCalled();
    expect(insertedCalls()).toHaveLength(2);
    expect(vi.mocked(ingestionQueue.add).mock.calls.map(([name]) => name)).toEqual([
      'hydrate-call',
      'hydrate-call',
    ]);
  });

  it("stores the row as 'captured' with the recording link to hydrate from", async () => {
    await bulkImport([
      { row: 2, audio_url: 'https://archive.example.com/call-001.mp3', external_id: 'crm-1' },
    ]);

    const [sql] = vi
      .mocked(query)
      .mock.calls.find(([s]) => String(s).includes('INSERT INTO calls'))!;
    expect(String(sql)).toContain("'captured'");
    expect(insertedCalls()[0]).toContain('https://archive.example.com/call-001.mp3');
  });

  it('reports a bad row against the line number the client sent, and imports the rest', async () => {
    const res = await bulkImport([
      { row: 7, audio_url: 'http://archive.example.com/insecure.mp3' },
      { row: 8, audio_url: 'https://archive.example.com/call-002.mp3', call_date: '29/04/2026' },
      { row: 9, audio_url: '' },
      { row: 10, audio_url: 'https://archive.example.com/call-003.mp3' },
    ]);

    const body = (await res.json()) as {
      accepted: number;
      errors: { row: number; error: string }[];
    };
    expect(body.accepted).toBe(1);
    expect(body.errors).toEqual([
      { row: 7, audio_url: 'http://archive.example.com/insecure.mp3', error: 'Only https:// URLs are allowed' },
      {
        row: 8,
        audio_url: 'https://archive.example.com/call-002.mp3',
        error: 'The date must be written as YYYY-MM-DD',
      },
      { row: 9, audio_url: '', error: 'A recording link is required' },
    ]);
    expect(insertedCalls()).toHaveLength(1);
  });

  it('skips a row repeating an external id already claimed in the same file', async () => {
    const res = await bulkImport([
      { row: 2, audio_url: 'https://archive.example.com/call-001.mp3', external_id: 'crm-1' },
      { row: 3, audio_url: 'https://archive.example.com/call-001.mp3', external_id: 'crm-1' },
    ]);

    expect(await res.json()).toMatchObject({ accepted: 1, skipped: 1 });
    expect(insertedCalls()).toHaveLength(1);
  });

  it('skips a row whose external id is already on file, creating nothing', async () => {
    vi.mocked(queryOne).mockImplementation((async (sql: string) =>
      String(sql).includes('FROM calls') ? { id: 'existing-call', external_id: 'crm-1' } : null) as never);

    const res = await bulkImport([
      { row: 2, audio_url: 'https://archive.example.com/call-001.mp3', external_id: 'crm-1' },
    ]);

    expect(await res.json()).toMatchObject({ accepted: 0, skipped: 1 });
    expect(insertedCalls()).toHaveLength(0);
    expect(ingestionQueue.add).not.toHaveBeenCalled();
  });

  it('still refuses more than 200 rows', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      row: i + 2,
      audio_url: `https://archive.example.com/call-${i}.mp3`,
    }));

    const res = await bulkImport(rows);

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Maximum 200 rows per request');
    expect(insertedCalls()).toHaveLength(0);
  });

  it('is still admin only', async () => {
    for (const role of ['viewer', 'supervisor', 'adviser']) {
      const res = await bulkImport(
        [{ row: 2, audio_url: 'https://archive.example.com/call-001.mp3' }],
        role
      );
      expect(res.status).toBe(403);
    }
    expect(insertedCalls()).toHaveLength(0);
    expect(ingestionQueue.add).not.toHaveBeenCalled();
  });
});

describe('GET /api/calls?uploaded_by=me', () => {
  function listCalls(role = 'supervisor', params = 'uploaded_by=me&limit=5'): Promise<Response> {
    return fetch(`${baseUrl}/api/calls?${params}`, {
      headers: { Authorization: `Bearer ${signToken(role)}` },
    });
  }

  beforeEach(() => {
    vi.mocked(queryOne).mockImplementation((async (sql: string) =>
      String(sql).includes('COUNT(*)') ? { count: '1' } : null) as never);
    vi.mocked(query).mockImplementation((async (sql: string) =>
      String(sql).includes('FROM calls c')
        ? [
            {
              id: 'call-1',
              status: 'scored',
              transcript_text: 'every word of the call',
              transcript_raw: { words: [] },
            },
          ]
        : []) as never);
  });

  it('filters to the calls this user uploaded, still scoped to their org', async () => {
    const res = await listCalls();
    expect(res.status).toBe(200);

    const listQuery = vi
      .mocked(query)
      .mock.calls.find(([sql]) => String(sql).includes('FROM calls c'))!;
    expect(String(listQuery[0])).toContain('c.uploaded_by = $2');
    expect(String(listQuery[0])).toContain('c.organization_id = $1');
    expect(listQuery[1] as unknown[]).toEqual([ORG, USER, 5, 0]);
  });

  it('never asks the database for a transcript, let alone returns one', async () => {
    const res = await listCalls('admin');

    const listQuery = vi
      .mocked(query)
      .mock.calls.find(([sql]) => String(sql).includes('FROM calls c'))!;
    expect(String(listQuery[0])).not.toContain('transcript_text');
    expect(String(listQuery[0])).not.toContain('transcript_raw');

    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data[0]).not.toHaveProperty('transcript_text');
    expect(body.data[0]).not.toHaveProperty('transcript_raw');
  });

  it('is ignored for any other value, leaving the list unfiltered', async () => {
    await listCalls('admin', 'uploaded_by=someone-else');

    const listQuery = vi
      .mocked(query)
      .mock.calls.find(([sql]) => String(sql).includes('FROM calls c'))!;
    expect(String(listQuery[0])).not.toContain('c.uploaded_by');
  });
});
