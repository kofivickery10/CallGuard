import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// GET /api/board-pack is guarded by requireOrgView (admin/supervisor/viewer)
// exactly like every other org-wide report route, and validates its `from`/
// `to`/`product` query params before touching the database. That validation
// order lets these tests exercise real auth + validation logic against a live
// Express app with no database connection at all.

let server: Server;
let baseUrl: string;

function signToken(overrides: Partial<{ role: string; organizationId: string }> = {}): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      organizationId: overrides.organizationId ?? '00000000-0000-0000-0000-0000000000bb',
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

describe('GET /api/board-pack', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/board-pack?from=2026-01-01&to=2026-01-31`);
    expect(res.status).toBe(401);
  });

  it('403s an adviser — this is org-wide, and advisers are self-scoped everywhere else', async () => {
    const token = signToken({ role: 'adviser' });
    const res = await fetch(`${baseUrl}/api/board-pack?from=2026-01-01&to=2026-01-31`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('403s a viewer-less role the same way as every other org-view report route (sanity check on the guard, not a role list)', async () => {
    const token = signToken({ role: 'api' });
    const res = await fetch(`${baseUrl}/api/board-pack?from=2026-01-01&to=2026-01-31`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('lets a viewer past the role gate — 400s on missing dates, not 403, before any DB call', async () => {
    const token = signToken({ role: 'viewer' });
    const res = await fetch(`${baseUrl}/api/board-pack`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/from/i);
  });

  it('400s when `to` is missing', async () => {
    const token = signToken({ role: 'admin' });
    const res = await fetch(`${baseUrl}/api/board-pack?from=2026-01-01`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/to/i);
  });

  it('400s when `to` is before `from`', async () => {
    const token = signToken({ role: 'admin' });
    const res = await fetch(`${baseUrl}/api/board-pack?from=2026-02-01&to=2026-01-01`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('400s a malformed product id, before any DB call', async () => {
    const token = signToken({ role: 'admin' });
    const res = await fetch(
      `${baseUrl}/api/board-pack?from=2026-01-01&to=2026-01-31&product=not-a-uuid`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/product/i);
  });
});
