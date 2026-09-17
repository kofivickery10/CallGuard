import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// PUT /api/superadmin/tenants/:id/scoring-settings when two staff save at once.
//
// The route checks fetch_recordings_on_sale against the row it has just read.
// Two saves can both pass that check — one turning the flag on for a sales_only
// firm, the other moving the same firm to scoring calls — and whichever UPDATE
// lands second breaks the organizations CHECK (migration 119). That is the
// same mistake the validation exists to catch, so it must come back as the
// same 400 with the same sentence, not a 500 that reads as a platform fault.
//
// Its own file because it needs the database mocked; the neighbouring
// superadmin.scoring-settings.route.test.ts deliberately runs with none.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

const TENANT = '00000000-0000-0000-0000-0000000000bb';

let server: Server;
let baseUrl: string;

function superadminToken(): string {
  return jwt.sign(
    { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: '', role: 'superadmin', mfa: true },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

function put(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/superadmin/tenants/${TENANT}/scoring-settings`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${superadminToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  vi.mocked(query).mockReset().mockResolvedValue([]);
  // What this save read: a sales_only firm with the flag off, so turning it on
  // passes validation.
  vi.mocked(queryOne)
    .mockReset()
    .mockImplementation((async (sql: string) =>
      sql.includes('SELECT scoring_scope, fetch_recordings_on_sale FROM organizations')
        ? { scoring_scope: 'sales_only', fetch_recordings_on_sale: false }
        : null) as never);
});

function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error(`new row for relation "organizations" violates check constraint "${constraint}"`), {
    code,
    constraint,
  });
}

describe('PUT /api/superadmin/tenants/:id/scoring-settings — concurrent saves', () => {
  it('turns the fetch-on-sale CHECK violation into the validation 400', async () => {
    // Meanwhile another save moved the firm to 'everything'.
    vi.mocked(query).mockImplementation((async (sql: string) => {
      if (sql.includes('UPDATE organizations SET')) {
        throw pgError('23514', 'organizations_fetch_recordings_on_sale_scope_check');
      }
      return [];
    }) as never);

    const res = await put({ fetch_recordings_on_sale: true });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toBe('fetch_recordings_on_sale can only be on when scoring_scope is sales_only');
  });

  it('leaves any other constraint failure as a server error', async () => {
    vi.mocked(query).mockImplementation((async (sql: string) => {
      if (sql.includes('UPDATE organizations SET')) {
        throw pgError('23514', 'organizations_review_confidence_floor_check');
      }
      return [];
    }) as never);

    const res = await put({ fetch_recordings_on_sale: true });
    expect(res.status).toBe(500);
  });
});
