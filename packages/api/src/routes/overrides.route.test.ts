import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// The override register (CG-7).
//
// Every time a person overturned the AI: who, when, on what, from what, to
// what, and why. Trust Point's QA score feeds adviser commission, so this is
// the record that makes the score defensible.
//
// Two properties are worth pinning, and both are about access rather than
// content. Advisers are scoped to themselves everywhere and must not see an
// org-wide register of their colleagues' rulings. And unlike /insights next
// door, this is NOT gated behind the Pro plan's `insights` feature: a firm that
// cannot produce its own override history for a regulator does not have a
// defensible record, and that must not depend on a plan tier. A refactor that
// quietly moved this under the insights gate would be a regression nothing else
// would catch.

let server: Server;
let baseUrl: string;

function signToken(role = 'admin'): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      organizationId: '00000000-0000-0000-0000-0000000000bb',
      role,
      mfa: true,
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

async function get(path: string, role?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${signToken(role)}` },
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

describe('GET /api/overrides', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/overrides`);
    expect(res.status).toBe(401);
  });

  // Advisers are scoped to themselves (ORG_WIDE_ROLES excludes them). An
  // org-wide register of who overturned what is not theirs to read.
  it('403s an adviser', async () => {
    expect((await get('/api/overrides', 'adviser')).status).toBe(403);
  });

  it('403s an adviser on the summary too', async () => {
    expect((await get('/api/overrides/summary', 'adviser')).status).toBe(403);
  });

  // Read-only record: a viewer is exactly who needs it, so this is org-view
  // rather than actioner. Past the guard is all this can assert without a
  // database — the handler queries immediately.
  it('lets a viewer past the role gate', async () => {
    expect((await get('/api/overrides', 'viewer')).status).not.toBe(403);
  });

  it('lets a supervisor past the role gate', async () => {
    expect((await get('/api/overrides', 'supervisor')).status).not.toBe(403);
  });

  it('lets an admin past the role gate', async () => {
    expect((await get('/api/overrides', 'admin')).status).not.toBe(403);
  });

  // The register is a compliance record, not an analytics extra. /insights
  // answers 403 "AI Insights requires the Pro plan" for a tenant without the
  // feature; this must never do that, whatever the org's plan.
  it('never answers with the Pro-plan gate that /insights uses', async () => {
    for (const path of ['/api/overrides', '/api/overrides/summary']) {
      const res = await get(path);
      expect(res.status).not.toBe(403);
      const body = await res.text();
      expect(body).not.toContain('Pro plan');
    }
  });

  // There is deliberately no write path: entries appear only as a side effect
  // of an actual override, which is what stops the register being editable.
  it('exposes no write route', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${baseUrl}/api/overrides`, {
        method,
        headers: { Authorization: `Bearer ${signToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    }
  });
});
