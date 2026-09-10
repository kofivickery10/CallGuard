import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// GET /api/journeys/:id/claims-defence is guarded by requireOrgView
// (admin/supervisor/viewer) exactly like every other report route in the app
// (board-pack.route.test.ts, GET /breaches/report), and is scoped to the
// caller's organization_id on its very first query — a journey that exists
// but belongs to another org must 404, not 403, so a probing request cannot
// tell "not yours" from "does not exist" apart (see the route's own comment
// in routes/journeys.ts).
//
// The db client is mocked rather than skipped, and never a live connection:
// this route is DB-bound from its first line, and DATABASE_URL in test is a
// fake local Postgres that is never actually reachable in this environment
// (see src/test/setup.ts) — mocking keeps these tests hermetic and, per the
// brief for this route, guarantees nothing here ever touches a real database
// (which, outside test, is production).

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

const REAL_ORG = '00000000-0000-0000-0000-0000000000bb';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000cc';
const JOURNEY_ID = '00000000-0000-0000-0000-0000000000dd';

let server: Server;
let baseUrl: string;

function signToken(overrides: Partial<{ role: string; organizationId: string }> = {}): string {
  return jwt.sign(
    {
      userId: '00000000-0000-0000-0000-0000000000aa',
      organizationId: overrides.organizationId ?? REAL_ORG,
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

beforeEach(() => {
  // Safe defaults for every query the route (and the auth middleware's
  // fire-and-forget last_active_at touch) might issue, so a test that does
  // not care about the DB shape never hits an unmocked call.
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue(null);
});

describe('GET /api/journeys/:id/claims-defence', () => {
  it('401s with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`);
    expect(res.status).toBe(401);
  });

  it('403s an adviser — this is an org-wide report route, and advisers are self-scoped everywhere else', async () => {
    const token = signToken({ role: 'adviser' });
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('403s a role with no org-view access the same way as every other org-view report route (sanity check on the guard, not a role list)', async () => {
    const token = signToken({ role: 'api' });
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('404s a journey that belongs to another organization, not 403 — cross-org isolation on the org-scoped lookup', async () => {
    // The mocked DB "has" JOURNEY_ID, but only under REAL_ORG. A caller
    // authenticated to OTHER_ORG must be told it does not exist, exactly as
    // GET /api/journeys/:id already does — this route must not regress that.
    vi.mocked(queryOne).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM journeys j')) {
        const [, orgParam] = params ?? [];
        return orgParam === REAL_ORG ? ({ id: JOURNEY_ID } as never) : null;
      }
      return null;
    });

    const token = signToken({ role: 'viewer', organizationId: OTHER_ORG });
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message).toMatch(/not found/i);
  });

  it('lets a viewer in the owning organization past the org-scoped lookup and returns the pack', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM journeys j')) {
        const [journeyId, orgParam] = params ?? [];
        if (journeyId !== JOURNEY_ID || orgParam !== REAL_ORG) return null;
        return {
          id: JOURNEY_ID,
          status: 'scored',
          overall_score: '92.50',
          pass: true,
          scorecard_version: 3,
          customer_id: 'cust-1',
          scorecard_name: 'Protection scorecard',
          sale_date: '2026-07-01T00:00:00.000Z',
        } as never;
      }
      return null;
    });

    const token = signToken({ role: 'viewer', organizationId: REAL_ORG });
    const res = await fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.header.journey_id).toBe(JOURNEY_ID);
    expect(body.header.scorecard_name).toBe('Protection scorecard');
    expect(body.header.overall_score).toBe(92.5);
    // No reconciliation run was mocked in — a normal case, not an error.
    expect(body.reconciliation).toBeNull();
    expect(Array.isArray(body.limitations)).toBe(true);
    expect(body.limitations.length).toBeGreaterThan(0);
  });
});

// ── Remediation on a finding (CG-26) ────────────────────────────────────────
//
// Phase 3 of the CG-6 scope: the sixth step of the evidence chain — reviewed →
// evidenced → verified → communicated → acknowledged → remediated — reaching
// the one document in the product that leaves the building.
describe('GET /api/journeys/:id/claims-defence — remediation', () => {
  // The journey lookup the route starts with, so every test below gets past it.
  function mockJourney() {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM journeys j')) {
        return {
          id: JOURNEY_ID,
          status: 'scored',
          overall_score: '71.00',
          pass: false,
          scorecard_version: 3,
          customer_id: 'cust-1',
          scorecard_name: 'Protection scorecard',
          sale_date: '2026-07-01T00:00:00.000Z',
        } as never;
      }
      return null;
    });
  }

  // A findings row as the route's own SELECT returns it: the breach columns
  // flattened together with the feedback item's, which the route then splits.
  const FINDING_ID = '00000000-0000-0000-0000-0000000000f1';
  function findingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: FINDING_ID,
      scorecard_item_label: 'Documents by email confirmed',
      severity: 'high',
      status: 'new',
      evidence_caveats: [],
      confirmed_at: null,
      detected_at: '2026-07-02T09:00:00.000Z',
      confirmed_by_name: null,
      remediation_guidance: 'Ring the client back and tell them documents come by email.',
      remediation_outcome: 'done',
      remediation_note: 'Called Thursday, confirmed the email address with him.',
      remediated_at: '2026-07-06T11:00:00.000Z',
      adviser_name: 'Sam Adviser',
      told_at: '2026-07-03T08:00:00.000Z',
      acknowledged_at: '2026-07-03T17:30:00.000Z',
      ...overrides,
    };
  }

  function get() {
    const token = signToken({ role: 'admin', organizationId: REAL_ORG });
    return fetch(`${baseUrl}/api/journeys/${JOURNEY_ID}/claims-defence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("carries the firm's instruction, the adviser's answer, and who was told, onto the finding", async () => {
    mockJourney();
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM breaches b')) return [findingRow()] as never;
      return [] as never;
    });

    const body = await (await get()).json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].remediation).toEqual({
      guidance: 'Ring the client back and tell them documents come by email.',
      adviser_name: 'Sam Adviser',
      told_at: '2026-07-03T08:00:00.000Z',
      acknowledged_at: '2026-07-03T17:30:00.000Z',
      outcome: 'done',
      note: 'Called Thursday, confirmed the email address with him.',
      recorded_at: '2026-07-06T11:00:00.000Z',
      earlier_answers: [],
    });
  });

  it('says plainly that the answer is the adviser\'s own and unverified — this pack reaches insurers and the Ombudsman', async () => {
    mockJourney();
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM breaches b')) return [findingRow()] as never;
      return [] as never;
    });

    const body = await (await get()).json();
    const text = body.limitations.join(' ');
    expect(text).toMatch(/adviser's own account/i);
    expect(text).toMatch(/has not verified/i);
    // "No answer" must never be readable as "no action was needed" — the
    // difference between those two is the reason the field has three values.
    expect(text).toMatch(/never that no action was needed/i);
  });

  it('leaves remediation null on a finding that was never fed back, and says nothing about self-attestation', async () => {
    mockJourney();
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM breaches b')) {
        return [
          findingRow({
            remediation_guidance: null,
            remediation_outcome: null,
            remediation_note: null,
            remediated_at: null,
            adviser_name: null,
            told_at: null,
            acknowledged_at: null,
          }),
        ] as never;
      }
      return [] as never;
    });

    const body = await (await get()).json();
    expect(body.findings[0].remediation).toBeNull();
    expect(body.limitations.join(' ')).not.toMatch(/adviser's own account/i);
  });

  it('shows a fed-back finding the adviser has not answered as awaiting an answer, not as needing nothing', async () => {
    mockJourney();
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM breaches b')) {
        return [
          findingRow({ remediation_outcome: null, remediation_note: null, remediated_at: null }),
        ] as never;
      }
      return [] as never;
    });

    const body = await (await get()).json();
    expect(body.findings[0].remediation.outcome).toBeNull();
    expect(body.findings[0].remediation.told_at).toBe('2026-07-03T08:00:00.000Z');
  });

  it('shows the answers an adviser gave before the current one, and does not repeat the current one among them', async () => {
    mockJourney();
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM breaches b')) return [findingRow()] as never;
      if (sql.includes('FROM breach_events')) {
        // Oldest first, as the route's own ORDER BY returns them. The last is
        // the answer already shown on the finding itself.
        return [
          { breach_id: FINDING_ID, outcome: 'customer_unreachable', created_at: '2026-07-04T10:00:00.000Z' },
          { breach_id: FINDING_ID, outcome: 'done', created_at: '2026-07-06T11:00:00.000Z' },
        ] as never;
      }
      return [] as never;
    });

    const body = await (await get()).json();
    expect(body.findings[0].remediation.earlier_answers).toEqual([
      { outcome: 'customer_unreachable', recorded_at: '2026-07-04T10:00:00.000Z' },
    ]);
    expect(body.limitations.join(' ')).toMatch(/earlier answers are shown/i);
  });

  it('joins the answer to the finding by checkpoint, not by breach id — a re-score must not erase it', async () => {
    // The load-bearing decision of this phase, asserted on the SQL itself
    // because it cannot be observed from a mocked result. breach_id on
    // journey_feedback_items is ON DELETE SET NULL (087) and a re-score deletes
    // and recreates every breach on the sale, so a join through it would drop
    // the adviser's answer out of the pack the first time anybody re-scored —
    // silently, with the answer still in the database.
    mockJourney();
    let findingsSql = '';
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM breaches b')) findingsSql = sql;
      return [] as never;
    });

    await get();
    expect(findingsSql).toContain('fi.scorecard_item_id = b.scorecard_item_id');
    expect(findingsSql).not.toContain('fi.breach_id');
  });
});
