import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { upsertCustomer } from '../services/ingestion.js';
import { transcriptionQueue } from '../jobs/queue.js';

// POST /api/calls/upload — the "this call resulted in a sale" flag.
//
// At a sales_only firm nothing is scored until a sale arrives, and this flag is
// one of the three ways one does (with a CRM webhook and "Score sale"). The
// Upload page used to offer it to admins only; it is now offered to everyone
// who can upload. These pin that the route records the flag, and the customer
// it belongs to, whichever of those roles sent it — transcribe.ts then
// assembles and scores the sale.
//
// Database, storage, queue and the customer upsert are mocked; the multipart
// parsing, auth and the route itself are real.

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
vi.mock('../services/ingestion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ingestion.js')>()),
  upsertCustomer: vi.fn(async () => 'customer-1'),
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
  vi.mocked(queryOne).mockResolvedValue(null);
  vi.mocked(query).mockImplementation((async (sql: string) =>
    sql.includes('INSERT INTO calls') ? [{ id: 'call-1' }] : []) as never);
});

async function upload(role: string, fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  form.append('audio', new Blob([Buffer.from('fake-mp3-bytes')], { type: 'audio/mpeg' }), 'call.mp3');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${baseUrl}/api/calls/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signToken(role)}` },
    body: form,
  });
}

function insertParams(): unknown[] {
  const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('INSERT INTO calls'));
  expect(call).toBeDefined();
  return call![1] as unknown[];
}

describe('POST /api/calls/upload — mark_as_sale', () => {
  it.each(['admin', 'supervisor', 'adviser'])('records the sale flag and the customer for a %s', async (role) => {
    const res = await upload(role, { customer_phone: '07700 900123', mark_as_sale: 'true' });
    expect(res.status).toBe(201);

    expect(upsertCustomer).toHaveBeenCalledWith(ORG, expect.any(String));
    const params = insertParams();
    expect(params[10]).toBe('customer-1'); // customer_id
    expect(params[14]).toBe(true); // sale_flagged
    expect(transcriptionQueue.add).toHaveBeenCalledWith('transcribe', { callId: params[0] }, { jobId: params[0] });
  });

  it('assigns an adviser their own upload, with the flag still recorded', async () => {
    await upload('adviser', { customer_phone: '07700 900123', mark_as_sale: 'true', agent_id: 'someone-else' });
    const params = insertParams();
    expect(params[7]).toBe(USER); // agent_id
    expect(params[14]).toBe(true);
  });

  it('does not flag a sale that was not ticked', async () => {
    await upload('supervisor', { customer_phone: '07700 900123' });
    expect(insertParams()[14]).toBe(false);
  });
});
