import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { supersededVersionAuthor } from './journeys.js';

// Case-level notes on a sale (CG-9, migration 112).
//
// Two things are worth pinning down here, and neither needs a database.
//
// The first is who may write. A note is evidence that reaches the claims-defence
// pack, so the write path is an action (admin/supervisor) and the read path is
// org-view — the same split every other journey route uses, and the one thing a
// future refactor could silently widen.
//
// The second is attribution of superseded versions, which is pure logic and is
// wrong in a way nobody sees until a SECOND person edits a note in production —
// by which point the history is already misattributed and there is no way to
// tell, from the rows alone, that it ever said anything else.

let server: Server;
let baseUrl: string;

const JOURNEY_ID = '00000000-0000-0000-0000-0000000000cc';
const NOTE_ID = '00000000-0000-0000-0000-0000000000dd';

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

async function post(body: unknown, role?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/notes`, {
    method: 'POST',
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

describe('journey notes — who may read and write', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/notes`);
    expect(res.status).toBe(401);
  });

  it('403s a viewer writing a note — annotating the record is an action, not a read', async () => {
    const res = await post({ body: 'A note' }, 'viewer');
    expect(res.status).toBe(403);
  });

  // Advisers are scoped to themselves everywhere (ORG_WIDE_ROLES excludes them)
  // and must not reach a sale-level record at all, in either direction.
  it('403s an adviser writing a note', async () => {
    const res = await post({ body: 'A note' }, 'adviser');
    expect(res.status).toBe(403);
  });

  it('403s an adviser reading notes', async () => {
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/notes`, {
      headers: { Authorization: `Bearer ${signToken('adviser')}` },
    });
    expect(res.status).toBe(403);
  });

  it('lets a supervisor past the role gate', async () => {
    const res = await post({ body: 'A note' }, 'supervisor');
    expect(res.status).not.toBe(403);
  });
});

describe('journey notes — validation', () => {
  it('rejects a missing body', async () => {
    expect((await post({})).status).toBe(400);
  });

  // Whitespace is not content. Without the trim, a note of three spaces would
  // sit in an evidence pack asserting nothing.
  it('rejects a whitespace-only body', async () => {
    expect((await post({ body: '   \n  ' })).status).toBe(400);
  });

  it('rejects a non-string body', async () => {
    expect((await post({ body: { text: 'nope' } })).status).toBe(400);
  });

  it('rejects a body over the length cap', async () => {
    const res = await post({ body: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { message?: string };
    expect(json.message).toContain('5000');
  });

  it('accepts a body at exactly the cap', async () => {
    const res = await post({ body: 'x'.repeat(5000) });
    expect(res.status).not.toBe(400);
  });

  it('rejects an edit with no body just as an insert does', async () => {
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/notes/${NOTE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${signToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // There is deliberately no delete path (migration 112). Express answers an
  // unrouted method on a matched path with 404, so the absence is observable.
  it('exposes no delete route', async () => {
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/notes/${NOTE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${signToken()}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('supersededVersionAuthor', () => {
  const created = '2026-08-26T09:00:00.000Z';
  const firstEdit = '2026-08-27T11:00:00.000Z';

  it('credits the original author on the first edit', () => {
    expect(
      supersededVersionAuthor({
        author_name: 'Joey Crone',
        created_at: created,
        edited_by_name: null,
        edited_at: null,
      })
    ).toEqual({ author_name: 'Joey Crone', written_at: created });
  });

  // The case that matters. Joey writes, Kim amends, Kim amends again: the
  // version this third write supersedes was Kim's, not Joey's. Crediting Joey
  // would have the evidence pack attribute Kim's wording to him.
  it('credits the previous EDITOR once a note has been amended', () => {
    expect(
      supersededVersionAuthor({
        author_name: 'Joey Crone',
        created_at: created,
        edited_by_name: 'Kim Adeyemi',
        edited_at: firstEdit,
      })
    ).toEqual({ author_name: 'Kim Adeyemi', written_at: firstEdit });
  });

  // author_name is NOT NULL in the schema, so this is defence against a blank
  // rather than a null — an empty string must still fall back to the author,
  // never leave a version unattributed.
  it('falls back to the author when the editor name is blank', () => {
    expect(
      supersededVersionAuthor({
        author_name: 'Joey Crone',
        created_at: created,
        edited_by_name: '',
        edited_at: '',
      })
    ).toEqual({ author_name: 'Joey Crone', written_at: created });
  });
});
