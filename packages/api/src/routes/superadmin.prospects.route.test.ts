import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// /api/superadmin/prospects is guarded by authenticate + requireSuperadmin,
// exactly like every other route in routes/superadmin.ts, and validates its
// enums (status, source, fit_score) before touching the database. That
// validation order lets these tests exercise real auth + validation logic
// against a live Express app with no database connection at all — same
// approach as board-pack.route.test.ts.

let server: Server;
let baseUrl: string;

function signToken(overrides: Partial<{ role: string; organizationId: string }> = {}): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      // Superadmins carry no organization_id (see middleware/auth.ts,
      // requireSuperadmin) — '' is the real shape of that token, not a stand-in.
      organizationId: overrides.organizationId ?? '',
      role: overrides.role ?? 'superadmin',
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

describe('GET /api/superadmin/prospects', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`);
    expect(res.status).toBe(401);
  });

  it('403s a tenant admin — this is platform-level, not tenant-scoped', async () => {
    const token = signToken({ role: 'admin', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('403s a tenant viewer the same way', async () => {
    const token = signToken({ role: 'viewer', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('403s a tenant adviser the same way', async () => {
    const token = signToken({ role: 'adviser', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('403s a superadmin-shaped role claim that still carries an organization_id — defence in depth', async () => {
    const token = signToken({ role: 'superadmin', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('lets a superadmin past the role gate — 400s on an unknown status filter, not 403, before any DB call', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects?status=not-a-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/status/i);
  });
});

describe('GET /api/superadmin/prospects/export.csv', () => {
  it('403s a non-superadmin', async () => {
    const token = signToken({ role: 'admin', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects/export.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('400s an unknown status filter for a superadmin, before any DB call', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects/export.csv?status=bogus`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/superadmin/prospects', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firm_name: 'Acme Protection Ltd' }),
    });
    expect(res.status).toBe(401);
  });

  it('403s a non-superadmin', async () => {
    const token = signToken({ role: 'admin', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firm_name: 'Acme Protection Ltd' }),
    });
    expect(res.status).toBe(403);
  });

  it('400s a missing firm_name for a superadmin, before any DB call', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/firm_name/i);
  });

  it('400s an invalid pipeline status', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firm_name: 'Acme Protection Ltd', status: 'nurturing' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/status/i);
  });

  it('400s an invalid source', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firm_name: 'Acme Protection Ltd', source: 'linkedin' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/source/i);
  });

  it('400s a fit_score out of range', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firm_name: 'Acme Protection Ltd', fit_score: 150 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/fit_score/i);
  });
});

describe('PUT /api/superadmin/prospects/:id', () => {
  it('403s a non-superadmin', async () => {
    const token = signToken({ role: 'supervisor', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects/00000000-0000-0000-0000-0000000000cc`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'won' }),
    });
    expect(res.status).toBe(403);
  });

  it('400s an invalid pipeline status for a superadmin, before any DB call', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects/00000000-0000-0000-0000-0000000000cc`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'nurturing' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/superadmin/prospects/:id', () => {
  it('403s a non-superadmin', async () => {
    const token = signToken({ role: 'admin', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects/00000000-0000-0000-0000-0000000000cc`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/superadmin/prospects/import', () => {
  it('403s a non-superadmin', async () => {
    const token = signToken({ role: 'admin', organizationId: '00000000-0000-0000-0000-0000000000bb' });
    const res = await fetch(`${baseUrl}/api/superadmin/prospects/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'firm_name\nAcme Protection Ltd' }),
    });
    expect(res.status).toBe(403);
  });

  it('400s a missing csv body for a superadmin, before any DB call', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/csv/i);
  });

  it('400s a csv with no firm_name column', async () => {
    const token = signToken();
    const res = await fetch(`${baseUrl}/api/superadmin/prospects/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'frn,status\n123456,new' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/firm_name/i);
  });
});
