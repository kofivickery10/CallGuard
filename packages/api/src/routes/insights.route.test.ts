import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// GET /api/insights/calibration is guarded by requireOrgView (admin/
// supervisor/viewer, applied to the whole insightsRouter), same as
// board-pack. It takes no query params and reads straight from the DB once
// past auth, so these tests can only exercise auth/role gating against a live
// Express app with no database connection — matching
// board-pack.route.test.ts's pattern.

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

describe('GET /api/insights/calibration', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/insights/calibration`);
    expect(res.status).toBe(401);
  });

  it('403s an adviser — this is org-wide, and advisers are self-scoped everywhere else', async () => {
    const token = signToken({ role: 'adviser' });
    const res = await fetch(`${baseUrl}/api/insights/calibration`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('403s a viewer-less role the same way as every other org-view report route (sanity check on the guard, not a role list)', async () => {
    const token = signToken({ role: 'api' });
    const res = await fetch(`${baseUrl}/api/insights/calibration`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('401s an expired/invalid token', async () => {
    const res = await fetch(`${baseUrl}/api/insights/calibration`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });
});
