import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// PUT /api/superadmin/tenants/:id/scoring-settings — fetch_recordings_on_sale
// (migration 119), and GET /api/organization/sale-arrival, the tenant-side
// figures that replaced the silent Zoho fallback.
//
// Same approach as superadmin.prospects.route.test.ts: a live Express app with
// no database. Everything asserted here is decided before the first query —
// who may call the route, and what the body alone makes invalid. Whether a
// change fits the tenant's STORED scope and flag needs the row, and is covered
// by resolveFetchRecordingsOnSale's unit tests.

let server: Server;
let baseUrl: string;

const TENANT = '00000000-0000-0000-0000-0000000000bb';

function signToken(role = 'superadmin'): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      // Superadmins carry no organization_id (see middleware/auth.ts).
      organizationId: role === 'superadmin' ? '' : TENANT,
      role,
      mfa: true,
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

async function putSettings(body: unknown, role?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/superadmin/tenants/${TENANT}/scoring-settings`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${signToken(role)}`, 'Content-Type': 'application/json' },
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

describe('PUT /api/superadmin/tenants/:id/scoring-settings — fetch_recordings_on_sale', () => {
  it('403s a tenant admin: when recordings are fetched is set by CallGuard staff', async () => {
    expect((await putSettings({ fetch_recordings_on_sale: true }, 'admin')).status).toBe(403);
  });

  it('400s a flag that is not a boolean, before any DB call', async () => {
    const res = await putSettings({ fetch_recordings_on_sale: 'yes' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/fetch_recordings_on_sale/);
  });

  it.each(['everything', 'over_threshold'])(
    '400s turning it on in the same change that sets scoring_scope to %s',
    async (scope) => {
      const res = await putSettings({ scoring_scope: scope, fetch_recordings_on_sale: true });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message?: string };
      expect(body.message).toMatch(/sales_only/);
    }
  );
});

describe('GET /api/organization/sale-arrival', () => {
  async function get(role?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/organization/sale-arrival`, {
      headers: role ? { Authorization: `Bearer ${signToken(role)}` } : {},
    });
  }

  it('401s with no Authorization header', async () => {
    expect((await get()).status).toBe(401);
  });

  // Admins and supervisors can act on it; an org-wide count is not an
  // adviser's to read, and a viewer cannot score a sale.
  it('403s a viewer', async () => {
    expect((await get('viewer')).status).toBe(403);
  });

  it('403s an adviser', async () => {
    expect((await get('adviser')).status).toBe(403);
  });
});
