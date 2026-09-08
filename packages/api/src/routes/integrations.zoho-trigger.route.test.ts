import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// PUT /api/integrations/zoho/writeback-trigger — when the Zoho QA write-back
// fires (CG-4, migration 113).
//
// The value set here decides whether an adviser's score reaches the CRM (and so
// their commission process) automatically, or only once a supervisor has
// reviewed the sale and released it. Two things are worth pinning down, and
// neither needs a database: only an admin may change it, and only the two
// recognised values are accepted.
//
// The second matters more than it looks. The reader treats anything it does not
// recognise as 'on_scoring' — deliberately, so a bad row never silently stops a
// tenant's records reaching Zoho. That fallback makes the WRITE path the only
// thing standing between a typo and a setting that reads as its opposite.

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

async function setTrigger(body: unknown, role?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/integrations/zoho/writeback-trigger`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${signToken(role)}`,
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

describe('PUT /api/integrations/zoho/writeback-trigger', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/integrations/zoho/writeback-trigger`, { method: 'PUT' });
    expect(res.status).toBe(401);
  });

  // Admin-only, like the rest of the Zoho connection surface: this decides what
  // leaves the platform for a tenant's CRM.
  it('403s a supervisor', async () => {
    expect((await setTrigger({ trigger: 'on_feedback' }, 'supervisor')).status).toBe(403);
  });

  it('403s a viewer', async () => {
    expect((await setTrigger({ trigger: 'on_feedback' }, 'viewer')).status).toBe(403);
  });

  it('rejects an unrecognised trigger, naming both accepted values', async () => {
    const res = await setTrigger({ trigger: 'whenever' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain('on_scoring');
    expect(body.message).toContain('on_feedback');
  });

  it('rejects a missing trigger', async () => {
    expect((await setTrigger({})).status).toBe(400);
  });

  // A near-miss must not be accepted and then read back as its opposite: the
  // reader's fallback treats anything unrecognised as 'on_scoring', so a stored
  // typo would silently mean "push automatically" on a tenant that asked for
  // the exact opposite.
  it('rejects near-misses rather than coercing them', async () => {
    for (const trigger of ['on_Feedback', 'ON_FEEDBACK', 'feedback', 'on-feedback', ' on_feedback']) {
      expect((await setTrigger({ trigger })).status).toBe(400);
    }
  });

  it('rejects a non-string trigger', async () => {
    expect((await setTrigger({ trigger: true })).status).toBe(400);
    expect((await setTrigger({ trigger: ['on_feedback'] })).status).toBe(400);
  });

  it('accepts both recognised values past validation', async () => {
    for (const trigger of ['on_scoring', 'on_feedback']) {
      expect((await setTrigger({ trigger })).status).not.toBe(400);
    }
  });
});
