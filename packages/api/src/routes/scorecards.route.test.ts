import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { recordAuditEvent } from '../services/audit.js';

// The Scorecards screen and the two actions that change which standard a call
// is judged against.
//
// Three things are worth holding down here.
//
// The list has to say what each scorecard contains and what it has been used to
// score, and it has to do that in a fixed number of queries — a count per row
// is how this page ends up making forty of them. It also must not put a pass
// rate in front of a score_only tenant, which is never shown a verdict anywhere
// else in the product.
//
// Making a scorecard live, or retiring it, changes how every call that names no
// scorecard is scored from that moment on. It is an admin action and it goes in
// the register, on both sides.
//
// Duplicate exists so a firm can draft its next QA manual without touching the
// live one, so the copy must land inactive whatever the original was — two live
// scorecards silently change which one new calls land on.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../services/audit.js', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const SCORECARD = '00000000-0000-0000-0000-0000000000c1';
const COPY = '00000000-0000-0000-0000-0000000000c2';

let server: Server;
let baseUrl: string;

function signToken(role = 'admin'): string {
  return jwt.sign(
    { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: ORG, role, mfa: true },
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
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue(null);
  vi.mocked(withTransaction).mockReset();
  vi.mocked(recordAuditEvent).mockClear();
});

// The scorecards row as the counts query returns it.
function scorecardRow(over: Record<string, unknown> = {}) {
  return {
    id: SCORECARD,
    organization_id: ORG,
    name: 'Protection sales QA',
    description: null,
    is_active: true,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-09-14T00:00:00.000Z',
    version: 3,
    branch_config: null,
    scoring_mode: 'journey',
    checkpoint_count: '42',
    section_count: '26',
    critical_count: '12',
    consent_gate_count: '6',
    ...over,
  };
}

// Route every SELECT the list makes to the right answer, by what it touches.
function stubList(opts: {
  scorecards?: Record<string, unknown>[];
  usage?: Record<string, unknown>[];
  plan?: string;
  featureOverrides?: Record<string, boolean> | null;
} = {}) {
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM scorecards s')) return (opts.scorecards ?? [scorecardRow()]) as never;
    if (sql.includes('WITH units AS')) return (opts.usage ?? []) as never;
    return [] as never;
  });
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    // orgHasFeature reads the org's plan and per-tenant overrides.
    if (sql.includes('FROM organizations')) {
      return { plan: opts.plan ?? 'pro', feature_overrides: opts.featureOverrides ?? null } as never;
    }
    return null as never;
  });
}

function get(path: string, role?: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${signToken(role)}` } });
}

describe('GET /api/scorecards — what each scorecard contains and scores', () => {
  it('returns the checkpoint, section, critical and consent-gate counts as numbers', async () => {
    stubList();
    const res = await get('/scorecards');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data[0]).toMatchObject({
      name: 'Protection sales QA',
      version: 3,
      is_active: true,
      checkpoint_count: 42,
      section_count: 26,
      critical_count: 12,
      consent_gate_count: 6,
    });
  });

  it('counts only live checkpoints — an archived one belongs to the history, not the scorecard', async () => {
    stubList();
    await get('/scorecards');
    const countsSql = vi.mocked(query).mock.calls.map(([sql]) => String(sql)).find((s) => s.includes('FROM scorecards s'));
    expect(countsSql).toContain('archived_at IS NULL');
  });

  it('attaches the scored units and pass rate for the scorecard they belong to', async () => {
    stubList({
      usage: [{ scorecard_id: SCORECARD, scored_units: '107', pass_count: '75' }],
    });
    const res = await get('/scorecards');
    const body = (await res.json()) as { data: { scored_units: number; pass_rate: number }[] };
    expect(body.data[0]!.scored_units).toBe(107);
    expect(Math.round(body.data[0]!.pass_rate)).toBe(70);
  });

  it('says nothing about a pass rate for a scorecard that has scored nothing', async () => {
    stubList({ usage: [] });
    const res = await get('/scorecards');
    const body = (await res.json()) as { data: { scored_units: number; pass_rate: number | null }[] };
    expect(body.data[0]!.scored_units).toBe(0);
    expect(body.data[0]!.pass_rate).toBeNull();
  });

  // score_only tenants are never shown a pass/fail verdict — not on a call, not
  // on a sale, and not here. The key is absent, not a number the client hides.
  it('leaves the pass rate off entirely for a score_only tenant', async () => {
    stubList({
      usage: [{ scorecard_id: SCORECARD, scored_units: '107', pass_count: '75' }],
      featureOverrides: { score_only: true },
    });
    const res = await get('/scorecards');
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data[0]!.scored_units).toBe(107);
    expect(body.data[0]).not.toHaveProperty('pass_rate');
  });

  // The whole point of the two-query shape: a firm with six scorecards must
  // cost the same number of queries as a firm with one.
  it('builds the page from two queries however many scorecards there are', async () => {
    stubList({
      scorecards: [
        scorecardRow(),
        scorecardRow({ id: COPY, name: 'Copy of Protection sales QA', is_active: false }),
        scorecardRow({ id: '00000000-0000-0000-0000-0000000000c3', name: 'Old manual', is_active: false }),
      ],
    });
    await get('/scorecards');
    const listQueries = vi
      .mocked(query)
      .mock.calls.map(([sql]) => String(sql))
      .filter((s) => s.includes('FROM scorecards s') || s.includes('WITH units AS'));
    expect(listQueries).toHaveLength(2);
  });

  // The order is not decoration: score.ts and assemble-journey.ts both take the
  // OLDEST active scorecard when a call names none, so the top row is the one
  // those calls actually land on.
  it('sorts live scorecards first, oldest first — the order scoring resolves them in', async () => {
    stubList();
    await get('/scorecards');
    const countsSql = vi.mocked(query).mock.calls.map(([sql]) => String(sql)).find((s) => s.includes('FROM scorecards s'));
    expect(countsSql).toContain('ORDER BY s.is_active DESC, s.created_at ASC');
  });

  it('refuses an unauthenticated request', async () => {
    const res = await fetch(`${baseUrl}/api/scorecards`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/scorecards/:id — making one live and retiring it', () => {
  function stubExisting(isActive = false) {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scorecards WHERE id')) {
        return {
          id: SCORECARD,
          organization_id: ORG,
          name: 'Protection sales QA',
          is_active: isActive,
          version: 3,
          branch_config: null,
        } as never;
      }
      if (sql.startsWith('UPDATE scorecards SET')) {
        return { id: SCORECARD, is_active: !isActive, version: 3 } as never;
      }
      return null as never;
    });
  }

  function put(body: unknown, role?: string) {
    return fetch(`${baseUrl}/api/scorecards/${SCORECARD}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${signToken(role)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('refuses a supervisor — which scorecard is live is an admin decision', async () => {
    stubExisting();
    const res = await put({ is_active: true }, 'supervisor');
    expect(res.status).toBe(403);
    expect(vi.mocked(recordAuditEvent)).not.toHaveBeenCalled();
  });

  it('refuses a viewer', async () => {
    stubExisting();
    expect((await put({ is_active: true }, 'viewer')).status).toBe(403);
  });

  it('records making a scorecard live in the register', async () => {
    stubExisting(false);
    const res = await put({ is_active: true });
    expect(res.status).toBe(200);
    expect(vi.mocked(recordAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        actionType: 'scorecard.activate',
        entityType: 'scorecard',
        entityId: SCORECARD,
      })
    );
  });

  it('records retiring one as its own event', async () => {
    stubExisting(true);
    const res = await put({ is_active: false });
    expect(res.status).toBe(200);
    expect(vi.mocked(recordAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'scorecard.deactivate', entityId: SCORECARD })
    );
  });

  // A save that happens to carry is_active unchanged is a form edit, not a
  // change of standard, and must not fill the register with noise.
  it('records nothing when is_active is sent unchanged', async () => {
    stubExisting(true);
    const res = await put({ is_active: true, name: 'Protection sales QA' });
    expect(res.status).toBe(200);
    const activationEvents = vi
      .mocked(recordAuditEvent)
      .mock.calls.filter(([e]) => e.actionType === 'scorecard.activate' || e.actionType === 'scorecard.deactivate');
    expect(activationEvents).toHaveLength(0);
  });

  it('404s a scorecard belonging to another organisation', async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    expect((await put({ is_active: true })).status).toBe(404);
  });
});

describe('POST /api/scorecards/:id/duplicate', () => {
  function stubSource() {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scorecards WHERE id')) {
        return {
          id: SCORECARD,
          organization_id: ORG,
          name: 'Protection sales QA',
          description: 'The live manual',
          is_active: true,
          version: 3,
          branch_config: null,
          scoring_mode: 'journey',
        } as never;
      }
      return null as never;
    });
  }

  // Captures the statements the transaction runs, so the copy's shape can be
  // asserted without a database.
  function stubTransaction(): { sql: string[]; params: unknown[][] } {
    const seen = { sql: [] as string[], params: [] as unknown[][] };
    vi.mocked(withTransaction).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        query: async (sql: string, params: unknown[]) => {
          seen.sql.push(sql);
          seen.params.push(params);
          if (sql.includes('INSERT INTO scorecards')) {
            return [{ id: COPY, name: 'Copy of Protection sales QA', is_active: false }];
          }
          return [{ id: 'item-1' }, { id: 'item-2' }];
        },
        queryOne: async () => null,
      };
      return fn(tx) as never;
    });
    return seen;
  }

  function post(role?: string) {
    return fetch(`${baseUrl}/api/scorecards/${SCORECARD}/duplicate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(role)}` },
    });
  }

  it('refuses a supervisor', async () => {
    stubSource();
    expect((await post('supervisor')).status).toBe(403);
  });

  it('copies the scorecard as "Copy of …", inactive, whatever the original was', async () => {
    stubSource();
    const seen = stubTransaction();
    const res = await post();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; is_active: boolean };
    expect(body.id).toBe(COPY);
    expect(body.is_active).toBe(false);

    const insert = seen.sql.find((s) => s.includes('INSERT INTO scorecards'))!;
    expect(insert).toContain('is_active');
    expect(insert).toContain('false');
    expect(seen.params[0]).toContain('Copy of Protection sales QA');
  });

  it('copies the checkpoints too, and only the live ones', async () => {
    stubSource();
    const seen = stubTransaction();
    const res = await post();
    expect(res.status).toBe(201);
    const itemInsert = seen.sql.find((s) => s.includes('INSERT INTO scorecard_items'))!;
    expect(itemInsert).toContain('FROM scorecard_items');
    expect(itemInsert).toContain('archived_at IS NULL');
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it('records the copy in the register, naming what it came from', async () => {
    stubSource();
    stubTransaction();
    await post();
    expect(vi.mocked(recordAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'scorecard.duplicate',
        entityId: COPY,
        metadata: expect.objectContaining({ copied_from: SCORECARD, item_count: 2 }),
      })
    );
  });

  it('404s a scorecard belonging to another organisation', async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    expect((await post()).status).toBe(404);
  });
});
