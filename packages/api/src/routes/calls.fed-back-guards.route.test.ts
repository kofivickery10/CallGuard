import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { scoringQueue } from '../jobs/queue.js';
import { deleteFile } from '../services/storage.js';

// What an admin may no longer do to a call once it has been fed back
// (migration 118).
//
// Re-score: the per-call twin of the guard on a sale's re-score. A re-score
// replaces the call's breaches, so once the adviser has been sent the findings
// it would rewrite what they were told about, after they were told.
//
// Delete: worse. journey_feedback.call_id cascades, so deleting the call would
// erase the record of what the adviser was told, their confirmation and every
// outcome they recorded. That cascade is for retention and erasure, not for a
// delete button.
//
// Both refuse from the moment of sending, not of confirmation: the email is
// already in the adviser's inbox.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../services/storage.js', async () => {
  const actual = await vi.importActual<typeof import('../services/storage.js')>('../services/storage.js');
  return { ...actual, deleteFile: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../jobs/queue.js', async () => {
  const actual = await vi.importActual<typeof import('../jobs/queue.js')>('../jobs/queue.js');
  return { ...actual, scoringQueue: { add: vi.fn().mockResolvedValue(undefined) } };
});

const ORG = '00000000-0000-0000-0000-0000000000bb';
const CALL_ID = '00000000-0000-0000-0000-0000000000cc';

let server: Server;
let baseUrl: string;

function signToken(role = 'admin'): string {
  return jwt.sign(
    { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: ORG, role, mfa: true },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
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

let latestRound: { adviser_name: string; confirmed_at: string | null } | null;

beforeEach(() => {
  latestRound = null;
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(scoringQueue.add).mockClear();
  vi.mocked(deleteFile).mockClear();
  vi.mocked(queryOne).mockReset().mockImplementation((async (sql: string) => {
    if (sql.includes('SELECT * FROM calls')) {
      return { id: CALL_ID, organization_id: ORG, transcript_text: 'Agent: hello' };
    }
    if (sql.includes('SELECT id, file_key FROM calls')) {
      return { id: CALL_ID, file_key: 'audio/key.enc' };
    }
    if (sql.includes('FROM journey_feedback')) return latestRound;
    return null;
  }) as never);
});

function rescore(): Promise<Response> {
  return fetch(`${baseUrl}/api/calls/${CALL_ID}/rescore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signToken()}` },
  });
}

function statusWrites(): number {
  return vi.mocked(query).mock.calls.filter(([sql]) => String(sql).includes("SET status = 'scoring'")).length;
}

describe('POST /api/calls/:id/rescore — after feedback', () => {
  it('refuses a call whose feedback the adviser has confirmed, and changes nothing', async () => {
    latestRound = { adviser_name: 'Jo Adviser', confirmed_at: '2026-09-01T09:00:00.000Z' };

    const res = await rescore();

    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe(
      'This call has been fed back to Jo Adviser, and they confirmed receipt. ' +
        'Re-scoring would change the findings they were told about, after they were told. ' +
        'Ask CallGuard support if this call genuinely needs re-scoring.'
    );
    expect(statusWrites()).toBe(0);
    expect(scoringQueue.add).not.toHaveBeenCalled();
  });

  it('refuses from the moment it is sent, before any confirmation', async () => {
    latestRound = { adviser_name: 'Jo Adviser', confirmed_at: null };

    const res = await rescore();

    expect(res.status).toBe(409);
    const { message } = await res.json();
    expect(message).toContain('This call has been fed back to Jo Adviser.');
    expect(message).not.toContain('confirmed receipt');
    expect(scoringQueue.add).not.toHaveBeenCalled();
  });

  it("looks the round up by the call's own column", async () => {
    await rescore();

    const [sql, params] = vi.mocked(queryOne).mock.calls.find(([q]) => String(q).includes('FROM journey_feedback'))!;
    expect(sql).toContain('WHERE call_id = $1');
    expect(params).toEqual([CALL_ID]);
  });

  it('re-scores a call that has never been fed back, as before', async () => {
    const res = await rescore();

    expect(res.status).toBe(200);
    expect(statusWrites()).toBe(1);
    expect(scoringQueue.add).toHaveBeenCalledTimes(1);
  });
});

function remove(): Promise<Response> {
  return fetch(`${baseUrl}/api/calls/${CALL_ID}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${signToken()}` },
  });
}

function callDeletes(): number {
  return vi.mocked(query).mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM calls')).length;
}

describe('DELETE /api/calls/:id — after feedback', () => {
  it('refuses a call whose feedback the adviser has confirmed, before touching the audio or the row', async () => {
    latestRound = { adviser_name: 'Jo Adviser', confirmed_at: '2026-09-01T09:00:00.000Z' };

    const res = await remove();

    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe(
      'This call has been fed back to Jo Adviser, and they confirmed receipt. ' +
        'Deleting it would also delete the record of what they were told, and anything they recorded about what they did. ' +
        'Ask CallGuard support if this call genuinely needs deleting.'
    );
    expect(callDeletes()).toBe(0);
    // Audio is deleted first on the happy path, so a refusal after it would
    // leave a call with no recording. The check comes before.
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('refuses from the moment it is sent, before any confirmation', async () => {
    latestRound = { adviser_name: 'Jo Adviser', confirmed_at: null };

    const res = await remove();

    expect(res.status).toBe(409);
    const { message } = await res.json();
    expect(message).toContain('This call has been fed back to Jo Adviser.');
    expect(message).not.toContain('confirmed receipt');
    expect(callDeletes()).toBe(0);
  });

  it("looks the round up by the call's own column", async () => {
    await remove();

    const [sql, params] = vi.mocked(queryOne).mock.calls.find(([q]) => String(q).includes('FROM journey_feedback'))!;
    expect(sql).toContain('WHERE call_id = $1');
    expect(params).toEqual([CALL_ID]);
  });

  it('deletes a call that has never been fed back, as before', async () => {
    const res = await remove();

    expect(res.status).toBe(200);
    expect(deleteFile).toHaveBeenCalledWith('audio/key.enc');
    expect(callDeletes()).toBe(1);
  });
});
