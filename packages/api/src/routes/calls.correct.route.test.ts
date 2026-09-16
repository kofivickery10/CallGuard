import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// POST /api/calls/:id/scores/items/:itemScoreId/correct
//
// The call page draws a binary checkpoint's badge from call_item_scores.result.
// The route used to move score and normalized_score but leave result alone, so
// a checkpoint a reviewer corrected to a pass still showed "Fail" next to a call
// score that had gone up. These tests hold result moving with the verdict, and
// the route refusing rows that were never an AI pass/fail.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));
vi.mock('../services/tenant-settings.js', async (orig) => ({
  ...(await orig<typeof import('../services/tenant-settings.js')>()),
  getScoringSettings: vi.fn().mockResolvedValue({ passThreshold: 70 }),
}));
vi.mock('../services/audit.js', () => ({ recordAuditEvent: vi.fn() }));
vi.mock('../services/alert-evaluator.js', () => ({ evaluateAlertsForResolvedItem: vi.fn() }));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const CALL = '00000000-0000-0000-0000-0000000000c1';
const ITEM = '00000000-0000-0000-0000-0000000000d1';

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

function stubItem(result: string, normalized: number) {
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM calls WHERE id')) return { id: CALL, organization_id: ORG } as never;
    if (sql.includes('FROM call_item_scores cis')) {
      return {
        id: ITEM, call_score_id: 's1', scorecard_item_id: 'i1', score: normalized ? 1 : 0,
        normalized_score: normalized, evidence: null, result,
      } as never;
    }
    if (sql.includes('FROM scorecard_items WHERE id')) return { weight: '1', severity: 'critical' } as never;
    return null as never;
  });
}

function correct(corrected_pass: boolean) {
  return fetch(`${baseUrl}/api/calls/${CALL}/scores/items/${ITEM}/correct`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ corrected_pass, reason: 'test' }),
  });
}

function itemUpdate() {
  return vi.mocked(query).mock.calls.find(([sql]) => String(sql).startsWith('UPDATE call_item_scores'));
}

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset();
});

describe('correcting a checkpoint verdict', () => {
  it('sets result to pass when a fail is corrected to a pass', async () => {
    stubItem('fail', 0);
    const res = await correct(true);
    expect(res.status).toBe(200);
    const update = itemUpdate();
    expect(String(update?.[0])).toContain('result = $3');
    expect(update?.[1]).toEqual([1, 100, 'pass', ITEM]);
  });

  it('sets result to fail when a pass is corrected to a fail', async () => {
    stubItem('pass', 100);
    const res = await correct(false);
    expect(res.status).toBe(200);
    expect(itemUpdate()?.[1]).toEqual([0, 0, 'fail', ITEM]);
  });

  it.each(['na', 'manual_review'])('refuses to correct a %s row', async (result) => {
    stubItem(result, 0);
    const res = await correct(true);
    expect(res.status).toBe(400);
    expect(itemUpdate()).toBeUndefined();
  });
});
