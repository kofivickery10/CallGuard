import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// GET /api/calls — the calls list. It used to select `c.*`, which sent every
// call's transcript and raw transcription payload with each page (27.6 MB for
// twenty transcribed calls on a live tenant). These pin that a list row carries
// only what a list shows, whatever columns the calls table grows later.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const ADVISER_ID = '00000000-0000-0000-0000-0000000000aa';

let server: Server;
let baseUrl: string;

function signToken(role: string, userId = ADVISER_ID): string {
  return jwt.sign({ userId, organizationId: ORG, role, mfa: true }, config.jwt.secret, { expiresIn: '5m' });
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
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue({ count: '0' } as never);
});

function list(role = 'admin'): Promise<Response> {
  return fetch(`${baseUrl}/api/calls`, { headers: { Authorization: `Bearer ${signToken(role)}` } });
}

/** The SQL of the list query (the one that pages through calls). */
function listSql(): string {
  const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('FROM calls c'));
  expect(call).toBeDefined();
  return String(call![0]);
}

describe('GET /api/calls — what a list row carries', () => {
  it('names its columns rather than selecting every column of calls', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(listSql()).not.toMatch(/\bc\.\*/);
  });

  it('never selects a transcript or a storage pointer', async () => {
    await list();
    const sql = listSql();
    for (const column of ['transcript_text', 'transcript_raw', 'file_key', 'recording_pointer']) {
      expect(sql).not.toContain(column);
    }
  });

  it('still returns what the list renders', async () => {
    await list();
    const sql = listSql();
    for (const column of ['c.id', 'c.file_name', 'c.duration_seconds', 'c.status', 'c.agent_name', 'c.call_date', 'c.created_at']) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('cs.overall_score');
    expect(sql).toContain('resolved_agent_name');
  });

  it('keeps an adviser to their own calls', async () => {
    await list('adviser');
    const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('FROM calls c'))!;
    expect(String(call[0])).toContain('c.agent_id = $2');
    expect(call[1]).toContain(ADVISER_ID);
  });
});
