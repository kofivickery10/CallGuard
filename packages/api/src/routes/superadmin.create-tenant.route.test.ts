import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// POST /api/superadmin/tenants — how the firm is scored is required.
//
// Owner decision (17 Sep 2026): a firm's scoring setting is chosen at setup,
// with no silent default. The column still defaults to 'sales_only', which
// used to be harmless because a firm without a Zoho trigger quietly scored
// every call anyway. That fallback is gone, so a firm created at the default
// would score nothing until a sale arrived, with nobody having chosen that.
//
// Same approach as superadmin.prospects.route.test.ts: a live app, no
// database. Every refusal here happens before the first query.

let server: Server;
let baseUrl: string;

function signToken(role = 'superadmin'): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      organizationId: role === 'superadmin' ? '' : '00000000-0000-0000-0000-0000000000bb',
      role,
      mfa: true,
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

const BASE = { org_name: 'Acme Protection Ltd', admin_name: 'Ada Admin', admin_email: 'ada@acme.example' };

function create(body: unknown, role?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/superadmin/tenants`, {
    method: 'POST',
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

describe('POST /api/superadmin/tenants — scoring_scope is chosen, not defaulted', () => {
  it('403s a tenant admin', async () => {
    expect((await create({ ...BASE, scoring_scope: 'everything' }, 'admin')).status).toBe(403);
  });

  it('refuses a firm with no scoring_scope, explaining both choices', async () => {
    const res = await create(BASE);
    expect(res.status).toBe(400);
    const { message } = (await res.json()) as { message: string };
    expect(message).toMatch(/there is no default/i);
    expect(message).toMatch(/"sales_only" scores sales/);
    expect(message).toMatch(/"everything" scores calls/);
  });

  it('refuses an unrecognised scoring_scope the same way', async () => {
    const res = await create({ ...BASE, scoring_scope: 'sales' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/there is no default/i);
  });

  it('refuses downloading recordings only on a sale for a firm that scores calls', async () => {
    const res = await create({ ...BASE, scoring_scope: 'everything', fetch_recordings_on_sale: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/sales_only/);
  });

  it('refuses a fetch_recordings_on_sale that is not a boolean', async () => {
    const res = await create({ ...BASE, scoring_scope: 'sales_only', fetch_recordings_on_sale: 'yes' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/true or false/);
  });
});
