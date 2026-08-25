import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// POST /api/review-items/resolve accepts pass, fail, and — since migration 108 —
// 'na', for a checkpoint that could not apply to the sale.
//
// The accepted verdict set is the contract that matters here, and it is settled
// before any database work, so it can be exercised against a live Express app
// with no database connection (same pattern as insights.route.test.ts). Anything
// past validation reaches the DB and is not this test's business; the assertions
// below only distinguish "rejected by validation" from "accepted and moved on".

let server: Server;
let baseUrl: string;

function signToken(overrides: Partial<{ role: string }> = {}): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      organizationId: '00000000-0000-0000-0000-0000000000bb',
      role: overrides.role ?? 'admin',
      mfa: true,
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

async function resolve(body: unknown, role?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/review-items/resolve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signToken(role ? { role } : {})}`,
      'Content-Type': 'application/json',
    },
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

describe('POST /api/review-items/resolve', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/review-items/resolve`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('403s a viewer — resolving a checkpoint is an action, not a read', async () => {
    const res = await resolve(
      { kind: 'journey', item_score_id: '00000000-0000-0000-0000-0000000000cc', result: 'pass' },
      'viewer'
    );
    expect(res.status).toBe(403);
  });

  it('rejects a verdict outside the accepted set, and names all three', async () => {
    const res = await resolve({
      kind: 'journey',
      item_score_id: '00000000-0000-0000-0000-0000000000cc',
      result: 'maybe',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    const text = `${body.error ?? ''} ${body.message ?? ''}`;
    expect(text).toContain("'na'");
  });

  // The gap migration 108 closes. Before it, a reviewer facing a checkpoint that
  // could not apply had to record a pass, which put "the adviser did this" in the
  // compliance register for something that was never in scope.
  it("accepts 'na' as a verdict rather than rejecting it", async () => {
    const res = await resolve({
      kind: 'journey',
      item_score_id: '00000000-0000-0000-0000-0000000000cc',
      result: 'na',
    });
    expect(res.status).not.toBe(400);
  });

  it('still rejects a missing verdict', async () => {
    const res = await resolve({
      kind: 'journey',
      item_score_id: '00000000-0000-0000-0000-0000000000cc',
    });
    expect(res.status).toBe(400);
  });

  it('still rejects a missing item_score_id', async () => {
    const res = await resolve({ kind: 'journey', result: 'na' });
    expect(res.status).toBe(400);
  });

  it('still rejects an unknown kind', async () => {
    const res = await resolve({
      kind: 'sale',
      item_score_id: '00000000-0000-0000-0000-0000000000cc',
      result: 'na',
    });
    expect(res.status).toBe(400);
  });
});
