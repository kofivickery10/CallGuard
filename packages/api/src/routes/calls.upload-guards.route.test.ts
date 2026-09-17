import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { uploadFile } from '../services/storage.js';

// Upload/bulk-import guards found by the Upload page critique:
//
//  - A sale ticked without a usable phone used to be accepted, then rested at
//    'transcribed' forever (deferToSale in jobs/processors/transcribe.ts has
//    no customer_id to assemble a journey against). The route now 400s before
//    anything is written to storage.
//  - Single upload had no role check at all, so a viewer could reach it by
//    typing the URL. Bulk import stays admin-only, as it already was.
//  - A supervisor may attribute an upload to any adviser; an adviser's own
//    upload is always forced to themselves.
//  - Multer's own MulterError (over the stated size limit) used to fall
//    through to the generic 500 handler instead of a 413 naming the limits.
//    The byte ceilings are mocked down here so the over-limit cases don't
//    require allocating real 100MB/500MB buffers.
//
// Database, storage and the queue are mocked; multipart parsing, auth and the
// route itself are real.

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
// Small stand-in ceilings so the over-limit tests don't need real 100MB/500MB
// buffers. MAX_FILE_SIZE_MB/MAX_VIDEO_FILE_SIZE_MB (the numbers in the 413
// message) are left untouched — the message must still read "100 MB"/"500 MB"
// regardless of what the test enforces against.
vi.mock('@callguard/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@callguard/shared')>()),
  MAX_FILE_SIZE_BYTES: 20,
  MAX_UPLOAD_FILE_SIZE_BYTES: 40,
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

function upload(
  role: string,
  fields: Record<string, string>,
  file: { bytes?: Buffer; mimeType?: string } = {}
): Promise<Response> {
  const form = new FormData();
  form.append(
    'audio',
    new Blob([file.bytes ?? Buffer.from('fake-mp3-bytes')], { type: file.mimeType ?? 'audio/mpeg' }),
    'call.mp3'
  );
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${baseUrl}/api/calls/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signToken(role)}` },
    body: form,
  });
}

function bulkImport(role: string): Promise<Response> {
  return fetch(`${baseUrl}/api/calls/bulk-import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signToken(role)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [{ audio_url: 'https://example.com/call.mp3' }] }),
  });
}

function insertCallsCalled(): boolean {
  return vi.mocked(query).mock.calls.some(([sql]) => String(sql).includes('INSERT INTO calls'));
}

const SALE_NEEDS_PHONE_MESSAGE =
  "To score this call as a sale, add the customer's phone number — it's how the call is matched to the customer's other calls.";

describe('POST /api/calls/upload — a sale flagged without a usable phone', () => {
  it('400s and stores nothing when no phone was given at all', async () => {
    const res = await upload('admin', { mark_as_sale: 'true' });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(SALE_NEEDS_PHONE_MESSAGE);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(insertCallsCalled()).toBe(false);
  });

  it("400s and stores nothing when the phone doesn't normalise", async () => {
    const res = await upload('admin', { mark_as_sale: 'true', customer_phone: 'not a phone' });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(SALE_NEEDS_PHONE_MESSAGE);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(insertCallsCalled()).toBe(false);
  });

  it('still accepts the sale flag with a phone that normalises', async () => {
    const res = await upload('admin', { mark_as_sale: 'true', customer_phone: '07700 900123' });

    expect(res.status).toBe(201);
    expect(insertCallsCalled()).toBe(true);
  });
});

describe('POST /api/calls/upload — who may upload', () => {
  it('403s a viewer', async () => {
    const res = await upload('viewer', {});

    expect(res.status).toBe(403);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(insertCallsCalled()).toBe(false);
  });

  it.each(['admin', 'supervisor', 'adviser'])('allows a %s to upload', async (role) => {
    const res = await upload(role, {});
    expect(res.status).toBe(201);
  });
});

describe('POST /api/calls/bulk-import — admin only', () => {
  it.each(['viewer', 'supervisor', 'adviser'])('403s a %s', async (role) => {
    const res = await bulkImport(role);
    expect(res.status).toBe(403);
  });

  it('does not 403 an admin', async () => {
    const res = await bulkImport('admin');
    expect(res.status).not.toBe(403);
  });
});

describe('POST /api/calls/upload — who the call is assigned to', () => {
  function insertParams(): unknown[] {
    const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('INSERT INTO calls'));
    expect(call).toBeDefined();
    return call![1] as unknown[];
  }

  it('lets a supervisor choose the adviser', async () => {
    await upload('supervisor', { agent_id: 'adviser-42', agent_name: 'Jo Adviser' });
    expect(insertParams()[7]).toBe('adviser-42'); // agent_id
  });

  it("forces an adviser's upload to themselves, even if another id was sent", async () => {
    await upload('adviser', { agent_id: 'someone-else' });
    expect(insertParams()[7]).toBe(USER); // agent_id
  });
});

describe('POST /api/calls/upload — over the size limit', () => {
  it('413s an over-limit audio file, naming both limits', async () => {
    // Mocked MAX_FILE_SIZE_BYTES is 20; MAX_UPLOAD_FILE_SIZE_BYTES (multer's
    // own ceiling) is 40 — this sits between the two, so it clears multer and
    // is refused by the route's own audio-specific check.
    const res = await upload('admin', {}, { bytes: Buffer.alloc(30, 'a'), mimeType: 'audio/mpeg' });

    expect(res.status).toBe(413);
    expect((await res.json()).message).toBe(
      'Recordings can be up to 100 MB for audio or 500 MB for a Teams or Zoom video.'
    );
    expect(uploadFile).not.toHaveBeenCalled();
    expect(insertCallsCalled()).toBe(false);
  });

  it("413s a file over multer's own ceiling, instead of the generic 500", async () => {
    const res = await upload('admin', {}, { bytes: Buffer.alloc(50, 'a'), mimeType: 'video/mp4' });

    expect(res.status).toBe(413);
    expect((await res.json()).message).toBe(
      'Recordings can be up to 100 MB for audio or 500 MB for a Teams or Zoom video.'
    );
    expect(uploadFile).not.toHaveBeenCalled();
    expect(insertCallsCalled()).toBe(false);
  });
});
