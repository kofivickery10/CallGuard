import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// GET /api/calls/:id/positions — where every checkpoint's evidence sits in
// this call, and the time of each transcript line. It exists so the call
// detail page can cue playback and a running clock for a user whose
// transcript is restricted (services/transcript-access.ts) as well as one
// who can read it in full, which only holds if the response never carries
// transcript text of any kind — only positions and times.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const CALL_ID = '00000000-0000-0000-0000-0000000000cc';
const ADVISER_ID = '00000000-0000-0000-0000-0000000000aa';

let server: Server;
let baseUrl: string;

function signToken(role: string, userId = ADVISER_ID): string {
  return jwt.sign(
    { userId, organizationId: ORG, role, mfa: true },
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

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue(null as never);
});

function positions(role = 'admin', userId = ADVISER_ID): Promise<Response> {
  return fetch(`${baseUrl}/api/calls/${CALL_ID}/positions`, {
    headers: { Authorization: `Bearer ${signToken(role, userId)}` },
  });
}

/** The first mocked `queryOne` call whose SQL matches, with its params. */
function queryOneCallMatching(fragment: string) {
  const call = vi.mocked(queryOne).mock.calls.find(([sql]) => String(sql).includes(fragment));
  if (!call) throw new Error(`no queryOne call contained: ${fragment}`);
  return { sql: String(call[0]), params: (call[1] ?? []) as unknown[] };
}

describe('GET /api/calls/:id/positions', () => {
  it("scopes an adviser to their own calls, and 404s when the lookup finds none", async () => {
    // Simulates a call belonging to a different adviser: the org+id+agent_id
    // scoped lookup a real database would run finds no matching row.
    vi.mocked(queryOne).mockResolvedValueOnce(null as never);

    const res = await positions('adviser', ADVISER_ID);

    expect(res.status).toBe(404);
    const { sql, params } = queryOneCallMatching('FROM calls');
    expect(sql).toContain('agent_id = $3');
    expect(params[2]).toBe(ADVISER_ID);
  });

  it('does not scope an admin to a single adviser', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null as never);

    await positions('admin');

    const { sql } = queryOneCallMatching('FROM calls');
    expect(sql).not.toContain('agent_id');
  });

  it('returns empty lines and items for a call with no transcript', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: CALL_ID,
      transcript_text: null,
      transcript_raw: null,
    } as never);

    const res = await positions('admin');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lines: [], items: [] });
    // No further DB work once there is nothing to place.
    expect(query).not.toHaveBeenCalled();
  });

  it('reports an unmatched checkpoint as matched: false with a null position', async () => {
    const transcript = [
      'Agent: Hello there, thanks so much for calling today.',
      'Customer: Hi, thanks for having me.',
    ].join('\n\n');

    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM calls')) {
        return { id: CALL_ID, transcript_text: transcript, transcript_raw: null } as never;
      }
      if (String(sql).includes('FROM call_scores')) {
        return null as never; // no per-call score run for this journey call
      }
      return null as never;
    });
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM journey_item_scores')) {
        return [
          {
            id: 'item-1',
            evidence: 'Something entirely different that was never said on this call.',
          },
        ] as never;
      }
      return [] as never;
    });

    const res = await positions('admin');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toEqual([
      {
        item_score_id: 'item-1',
        kind: 'journey',
        matched: false,
        line_index: null,
        timestamp_seconds: null,
      },
    ]);
  });

  it('never carries transcript text in the response', async () => {
    const transcript = [
      'Agent: Hello there, thanks so much for calling today, this is a distinctive opening line.',
      'Customer: Hi, thanks for having me, this is an equally distinctive reply.',
    ].join('\n\n');

    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM calls')) {
        return { id: CALL_ID, transcript_text: transcript, transcript_raw: null } as never;
      }
      return null as never;
    });
    vi.mocked(query).mockResolvedValue([] as never);

    const res = await positions('admin');
    const raw = await res.text();

    expect(raw).not.toContain('distinctive opening line');
    expect(raw).not.toContain('distinctive reply');
    expect(raw).not.toContain('Agent:');
    expect(raw).not.toContain('Customer:');
  });
});
