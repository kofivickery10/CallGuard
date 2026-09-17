import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { orgHasFeature } from '../services/tenant-settings.js';

// Two defects this file exists to keep fixed.
//
// 1. score_only hides the verdict, and the review queue was the one tenant-facing
//    score surface that did not honour it: it shipped the AI's normalized_score,
//    which the evidence panel renders as the words "AI suggests: Pass" / "Fail".
//
// 2. Resolving a checkpoint read it outside the transaction and then wrote it
//    unconditionally, so two reviewers ruling at once silently overwrote one
//    another — and on the fail path the loser's DELETE of the breach row could
//    land after the winner's INSERT, leaving a human-confirmed failure off the
//    compliance register.
//
// Database and tenant settings are mocked; auth and the routes are real.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/tenant-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/tenant-settings.js')>()),
  orgHasFeature: vi.fn(async () => false),
  getScoringSettings: vi.fn(async () => ({ passThreshold: 80 })),
}));
vi.mock('../services/score-writeback.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/score-writeback.js')>()),
  pushCallScoreUpdate: vi.fn(async () => {}),
  pushJourneyScoreUpdate: vi.fn(async () => {}),
}));
vi.mock('../services/alert-evaluator.js', () => ({
  evaluateAlertsForResolvedItem: vi.fn(async () => {}),
}));
vi.mock('../services/audit.js', () => ({ recordAuditEvent: vi.fn(async () => {}) }));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const USER = '00000000-0000-0000-0000-0000000000aa';
const ITEM = '00000000-0000-0000-0000-0000000000cc';

let server: Server;
let baseUrl: string;

function signToken(role = 'admin'): string {
  return jwt.sign({ userId: USER, organizationId: ORG, role, mfa: true }, config.jwt.secret, {
    expiresIn: '5m',
  });
}

beforeAll(async () => {
  const { app } = await import('../app.js');
  await new Promise<void>((done) => {
    server = app.listen(0, done);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orgHasFeature).mockResolvedValue(false);
});

describe('GET /api/review-items — score_only', () => {
  function listWithItem() {
    vi.mocked(query).mockImplementation((async (sql: string) =>
      String(sql).includes('journey_item_scores')
        ? [
            {
              kind: 'journey',
              item_score_id: ITEM,
              label: 'Obtained clear affirmative consent',
              normalized_score: 0,
              confidence: 0.75,
              detected_at: '2026-08-11T10:00:00.000Z',
            },
          ]
        : []) as never);
    return fetch(`${baseUrl}/api/review-items`, { headers: { Authorization: `Bearer ${signToken()}` } });
  }

  it('withholds the AI verdict from a score-only tenant', async () => {
    vi.mocked(orgHasFeature).mockResolvedValue(true);
    const res = await listWithItem();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    // Not merely hidden in the client: the number itself must not cross the wire.
    expect(body.data[0]!.normalized_score).toBeNull();
    expect(JSON.stringify(body)).not.toContain('"normalized_score":0');
  });

  it('still sends it to a tenant that is shown verdicts', async () => {
    const res = await listWithItem();
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]!.normalized_score).toBe(0);
  });
});

describe('POST /api/review-items/resolve — two reviewers at once', () => {
  // The transaction a losing reviewer runs: the parent locks, then the
  // conditional UPDATE matches nothing because the winner already ruled.
  function transactionWhereTheItemIsAlreadyRuledOn() {
    vi.mocked(queryOne).mockResolvedValue({
      journey_id: 'journey-1',
      scorecard_item_id: 'item-1',
      weight: '2.0',
      severity: null,
      evidence: null,
      normalized_score: null,
    } as never);

    const statements: string[] = [];
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string) => {
          statements.push(String(sql));
          // The claim finds no row still in manual_review.
          return String(sql).includes('RETURNING id') ? [] : [];
        },
        queryOne: async () => null,
      })) as never);
    return statements;
  }

  async function resolveIt() {
    return fetch(`${baseUrl}/api/review-items/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'journey', item_score_id: ITEM, result: 'fail' }),
    });
  }

  it('refuses rather than overwriting the reviewer who ruled first', async () => {
    transactionWhereTheItemIsAlreadyRuledOn();
    const res = await resolveIt();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { message?: string }; message?: string };
    expect(JSON.stringify(body)).toContain('already ruled');
  });

  it('locks the sale before touching the checkpoint, so two rulings cannot interleave', async () => {
    const statements = transactionWhereTheItemIsAlreadyRuledOn();
    await resolveIt();

    const lock = statements.findIndex((s) => s.includes('FOR UPDATE'));
    const claim = statements.findIndex((s) => s.includes('UPDATE journey_item_scores'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(lock);
    // The write is conditional — an unguarded UPDATE is what let the loser win.
    expect(statements[claim]).toContain("result = 'manual_review'");
  });

  it('writes nothing else once the claim fails — no breach, no recomputed score', async () => {
    const statements = transactionWhereTheItemIsAlreadyRuledOn();
    await resolveIt();

    expect(statements.some((s) => s.includes('INSERT INTO breaches'))).toBe(false);
    expect(statements.some((s) => s.includes('DELETE FROM breaches'))).toBe(false);
    expect(statements.some((s) => s.includes('UPDATE journeys SET overall_score'))).toBe(false);
  });
});
