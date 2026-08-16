import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// GET /api/journeys/:id/claims-defence is guarded by requireOrgView
// (admin/supervisor/viewer) exactly like every other report route in the app
// (board-pack.route.test.ts, GET /breaches/report), and is scoped to the
// caller's organization_id on its very first query — a journey that exists
// but belongs to another org must 404, not 403, so a probing request cannot
// tell "not yours" from "does not exist" apart (see the route's own comment
// in routes/journeys.ts).
//
// The db client is mocked rather than skipped, and never a live connection:
// this route is DB-bound from its first line, and DATABASE_URL in test is a
// fake local Postgres that is never actually reachable in this environment
// (see src/test/setup.ts) — mocking keeps these tests hermetic and, per the
// brief for this route, guarantees nothing here ever touches a real database
// (which, outside test, is production).

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

const REAL_ORG = '00000000-0000-0000-0000-0000000000bb';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000cc';
const JOURNEY_ID = '00000000-0000-0000-0000-0000000000dd';

let server: Server;
let baseUrl: string;

function signToken(overrides: Partial<{ role: string; organizationId: string }> = {}): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      organizationId: overrides.organizationId ?? REAL_ORG,
      role: overrides.role ?? 'admin',
      mfa: true,
    },
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
  // Safe defaults for every query the route (and the auth middleware's
  // fire-and-forget last_active_at touch) might issue, so a test that does
  // not care about the DB shape never hits an unmocked call.
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue(null);
});

describe('GET /api/journeys/:id/claims-defence', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`);
    expect(res.status).toBe(401);
  });

  it('403s an adviser — this is an org-wide report route, and advisers are self-scoped everywhere else', async () => {
    const token = signToken({ role: 'adviser' });
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('403s a role with no org-view access the same way as every other org-view report route (sanity check on the guard, not a role list)', async () => {
    const token = signToken({ role: 'api' });
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('404s a journey that belongs to another organization, not 403 — cross-org isolation on the org-scoped lookup', async () => {
    // The mocked DB "has" JOURNEY_ID, but only under REAL_ORG. A caller
    // authenticated to OTHER_ORG must be told it does not exist, exactly as
    // GET /api/journeys/:id already does — this route must not regress that.
    vi.mocked(queryOne).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM journeys j')) {
        const [, orgParam] = params ?? [];
        return orgParam === REAL_ORG ? ({ id: JOURNEY_ID } as never) : null;
      }
      return null;
    });

    const token = signToken({ role: 'viewer', organizationId: OTHER_ORG });
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message).toMatch(/not found/i);
  });

  it('lets a viewer in the owning organization past the org-scoped lookup and returns the pack', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM journeys j')) {
        const [journeyId, orgParam] = params ?? [];
        if (journeyId !== JOURNEY_ID || orgParam !== REAL_ORG) return null;
        return {
          id: JOURNEY_ID,
          status: 'scored',
          overall_score: '92.50',
          pass: true,
          scorecard_version: 3,
          customer_id: 'cust-1',
          scorecard_name: 'Protection scorecard',
          sale_date: '2026-07-01T00:00:00.000Z',
        } as never;
      }
      return null;
    });

    const token = signToken({ role: 'viewer', organizationId: REAL_ORG });
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.header.journey_id).toBe(JOURNEY_ID);
    expect(body.header.scorecard_name).toBe('Protection scorecard');
    expect(body.header.overall_score).toBe(92.5);
    // No reconciliation run was mocked in — a normal case, not an error.
    expect(body.reconciliation).toBeNull();
    expect(Array.isArray(body.limitations)).toBe(true);
    expect(body.limitations.length).toBeGreaterThan(0);
  });
});
