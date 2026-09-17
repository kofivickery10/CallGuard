import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { orgHasFeature } from '../services/tenant-settings.js';
import { recordAuditEvent } from '../services/audit.js';

// GET /api/review-items — the review queue, rebuilt around the work it holds.
//
// What these pin:
//   * oldest first, and whole sales kept together, because the screen groups by
//     sale and a page boundary through the middle of one would make that a lie;
//   * a page is a number of SALES, not of checkpoints (one live sale holds 41);
//   * the summary counts the whole queue whatever the filters say — a backlog
//     figure that shrinks when you filter is one nobody can plan around;
//   * both queries are bounded and ordered, where before there was no LIMIT at
//     all and the newest rows came first, landing the 37-day-old checkpoints at
//     row 111 of 130.
//
// And on POST /resolve: the reviewer's note reaches both the audit trail and
// the stored reason for the correction, rather than being accepted and dropped.

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

// A shape of queue modelled on the live one: a small sale that has waited a
// month, a big sale raised later, and one per-call checkpoint.
interface Row {
  kind: 'call' | 'journey';
  item_score_id: string;
  label: string;
  section: string | null;
  severity: string | null;
  parent_id: string;
  customer_name: string | null;
  agent_name: string | null;
  detected_at: string;
  source_call_name?: string | null;
}

function row(over: Partial<Row> & Pick<Row, 'item_score_id' | 'parent_id' | 'detected_at'>): Row {
  return {
    kind: 'journey',
    label: 'Explained data sharing',
    section: 'Regulatory',
    severity: 'critical',
    customer_name: 'Drew Smith',
    agent_name: 'Heena Fazel',
    source_call_name: null,
    ...over,
  } as Row;
}

const OLD_SALE = 'sale-old';
const BIG_SALE = 'sale-big';
const CALL = 'call-1';

// Ordered as the SQL orders it: oldest first.
const journeyRows: Row[] = [
  row({ item_score_id: 'a1', parent_id: OLD_SALE, detected_at: '2026-08-11T09:00:00.000Z' }),
  row({ item_score_id: 'a2', parent_id: OLD_SALE, detected_at: '2026-08-11T09:05:00.000Z', severity: 'low' }),
  row({
    item_score_id: 'b1',
    parent_id: BIG_SALE,
    detected_at: '2026-09-04T09:00:00.000Z',
    customer_name: 'Mark Thompson',
    agent_name: 'Ash Jagia',
    severity: 'medium',
  }),
  row({
    item_score_id: 'b2',
    parent_id: BIG_SALE,
    detected_at: '2026-09-04T09:01:00.000Z',
    customer_name: 'Mark Thompson',
    agent_name: 'Ash Jagia',
    severity: 'high',
  }),
  row({
    item_score_id: 'b3',
    parent_id: BIG_SALE,
    detected_at: '2026-09-04T09:02:00.000Z',
    customer_name: 'Mark Thompson',
    agent_name: 'Ash Jagia',
    severity: 'critical',
  }),
];

const callRows: Row[] = [
  row({
    kind: 'call',
    item_score_id: 'c1',
    parent_id: CALL,
    detected_at: '2026-08-20T09:00:00.000Z',
    customer_name: null,
    source_call_name: 'inbound-4491.wav',
    agent_name: 'George Griffiths',
    severity: null,
  }),
];

function mockQueue(journeys = journeyRows, calls = callRows) {
  vi.mocked(query).mockImplementation((async (sql: string) =>
    String(sql).includes('FROM journey_item_scores') ? journeys : calls) as never);
}

interface Body {
  data: Array<Record<string, unknown>>;
  total: number;
  total_sales: number;
  page: number;
  limit: number;
  summary: {
    checkpoints: number;
    sales: number;
    oldest_days: number | null;
    by_severity: Record<string, number>;
    largest: { parent_id: string; count: number; name: string | null } | null;
  };
  advisers: string[];
}

async function list(qs = ''): Promise<Body> {
  const res = await fetch(`${baseUrl}/api/review-items${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${signToken()}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orgHasFeature).mockResolvedValue(false);
  mockQueue();
});

describe('GET /api/review-items — the backlog first', () => {
  it('puts the longest-waiting sale first', async () => {
    const body = await list();
    expect(body.data.map((i) => i.item_score_id)).toEqual(['a1', 'a2', 'c1', 'b1', 'b2', 'b3']);
  });

  it('reverses the sales, not the checkpoints, on sort=newest', async () => {
    const body = await list('sort=newest');
    expect(body.data.map((i) => i.item_score_id)).toEqual(['b1', 'b2', 'b3', 'c1', 'a1', 'a2']);
  });

  it('bounds and orders both queries — no unlimited read, oldest never dropped', async () => {
    await list();
    const sqls = vi.mocked(query).mock.calls.map(([sql]) => String(sql));
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) {
      expect(sql).toMatch(/LIMIT \d+/);
      expect(sql).toMatch(/ORDER BY[\s\S]*created_at ASC/);
    }
  });
});

describe('GET /api/review-items — a page is a number of sales', () => {
  it('keeps every checkpoint of a sale on the same page', async () => {
    const body = await list('limit=1');
    // The one oldest sale, both of its checkpoints, and nothing from the next.
    expect(body.data.map((i) => i.item_score_id)).toEqual(['a1', 'a2']);
    expect(body.limit).toBe(1);
    expect(body.total_sales).toBe(3);
    expect(body.total).toBe(6);
  });

  it('pages over sales', async () => {
    const second = await list('limit=1&page=2');
    expect(second.data.map((i) => i.item_score_id)).toEqual(['c1']);
    const third = await list('limit=1&page=3');
    expect(third.data.map((i) => i.item_score_id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('returns an empty page rather than wrapping round when asked past the end', async () => {
    const body = await list('limit=1&page=9');
    expect(body.data).toEqual([]);
    expect(body.total_sales).toBe(3);
  });
});

describe('GET /api/review-items — filters', () => {
  it('narrows to one adviser', async () => {
    const body = await list('agent=Ash%20Jagia');
    expect(body.data.map((i) => i.item_score_id)).toEqual(['b1', 'b2', 'b3']);
    expect(body.total).toBe(3);
    expect(body.total_sales).toBe(1);
  });

  it('narrows to one severity', async () => {
    const body = await list('severity=critical');
    expect(body.data.map((i) => i.item_score_id)).toEqual(['a1', 'b3']);
    expect(body.total_sales).toBe(2);
  });

  it('ignores a severity it does not recognise rather than returning nothing', async () => {
    const body = await list('severity=urgent');
    expect(body.total).toBe(6);
  });

  it('offers only advisers that actually have something in the queue', async () => {
    const body = await list('agent=Ash%20Jagia');
    expect(body.advisers).toEqual(['Ash Jagia', 'George Griffiths', 'Heena Fazel']);
  });
});

describe('GET /api/review-items — the summary states the whole backlog', () => {
  it('counts every checkpoint, sale, severity and the oldest wait', async () => {
    const body = await list();
    expect(body.summary.checkpoints).toBe(6);
    expect(body.summary.sales).toBe(3);
    expect(body.summary.by_severity).toEqual({
      critical: 2,
      high: 1,
      medium: 1,
      low: 1,
      unrated: 1,
    });
    // Whole days since the oldest row, floored — not a fixed number, so the
    // test does not rot, but it must be a real age and not zero.
    const expected = Math.floor((Date.now() - Date.parse('2026-08-11T09:00:00.000Z')) / 86_400_000);
    expect(body.summary.oldest_days).toBe(Math.max(0, expected));
  });

  it('does not shrink when the reader filters', async () => {
    const all = await list();
    const narrowed = await list('agent=Ash%20Jagia&severity=critical');
    expect(narrowed.summary).toEqual(all.summary);
    expect(narrowed.advisers).toEqual(all.advisers);
    // …while the filtered figures do move.
    expect(narrowed.total).toBe(1);
  });

  it('names the sale holding the most, so the screen can link to it', async () => {
    const body = await list();
    expect(body.summary.largest).toEqual({
      kind: 'journey',
      parent_id: BIG_SALE,
      name: 'Mark Thompson',
      count: 3,
    });
  });

  it('falls back to the recording when nobody has a name for the customer', async () => {
    mockQueue([], callRows);
    const body = await list();
    expect(body.summary.largest).toEqual({
      kind: 'call',
      parent_id: CALL,
      name: 'inbound-4491.wav',
      count: 1,
    });
  });

  it('reports an empty queue as empty, not as unknown', async () => {
    mockQueue([], []);
    const body = await list();
    expect(body.summary).toEqual({
      checkpoints: 0,
      sales: 0,
      oldest_days: null,
      by_severity: { critical: 0, high: 0, medium: 0, low: 0, unrated: 0 },
      largest: null,
    });
    expect(body.data).toEqual([]);
  });

  it('still withholds the AI verdict from a score-only tenant, filtered or not', async () => {
    vi.mocked(orgHasFeature).mockResolvedValue(true);
    mockQueue(
      [row({ item_score_id: 'a1', parent_id: OLD_SALE, detected_at: '2026-08-11T09:00:00.000Z' })].map(
        (r) => ({ ...r, normalized_score: 0 }) as Row
      ),
      []
    );
    const body = await list('severity=critical');
    expect(body.data[0]!.normalized_score).toBeNull();
    expect(JSON.stringify(body)).not.toContain('"normalized_score":0');
  });
});

describe('POST /api/review-items/resolve — the reviewer says why', () => {
  function transactionThatSucceeds(): string[][] {
    const calls: string[][] = [];
    vi.mocked(queryOne).mockResolvedValue({
      journey_id: 'journey-1',
      scorecard_item_id: 'item-1',
      weight: '2.0',
      severity: null,
      evidence: 'the quoted line',
      normalized_score: null,
    } as never);
    vi.mocked(withTransaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          calls.push([String(sql), JSON.stringify(params)]);
          return String(sql).includes('RETURNING id') ? [{ id: 'x' }] : [];
        },
        queryOne: async () => null,
      })) as never);
    return calls;
  }

  function resolveWith(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/review-items/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'journey', item_score_id: 'item-score-1', result: 'fail', ...body }),
    });
  }

  function correctionParams(calls: string[][]): unknown[] {
    const found = calls.find(([sql]) => sql.includes('INSERT INTO score_corrections'));
    expect(found).toBeDefined();
    return JSON.parse(found![1]!) as unknown[];
  }

  it('stores the note as the reason for the ruling', async () => {
    const calls = transactionThatSucceeds();
    const res = await resolveWith({ note: 'Adviser said it on call 2 at 4:12 — heard it myself.' });
    expect(res.status).toBe(200);
    expect(correctionParams(calls)).toContain('Adviser said it on call 2 at 4:12 — heard it myself.');
  });

  it('puts the note on the audit trail too', async () => {
    transactionThatSucceeds();
    await resolveWith({ note: '  Consent never given.  ' });
    const event = vi.mocked(recordAuditEvent).mock.calls.at(-1)?.[0];
    // Trimmed, so trailing whitespace does not become part of the record.
    expect(event?.metadata).toMatchObject({ note: 'Consent never given.' });
  });

  it('falls back to the boilerplate reason when no note is given', async () => {
    const calls = transactionThatSucceeds();
    await resolveWith({});
    expect(correctionParams(calls)).toContain('Confirmed on manual review');
    expect(vi.mocked(recordAuditEvent).mock.calls.at(-1)?.[0].metadata).toMatchObject({ note: null });
  });

  it('treats a whitespace-only note as no note at all', async () => {
    const calls = transactionThatSucceeds();
    await resolveWith({ note: '   ' });
    expect(correctionParams(calls)).toContain('Confirmed on manual review');
  });

  it('bounds the note rather than storing a pasted transcript', async () => {
    const calls = transactionThatSucceeds();
    await resolveWith({ note: 'x'.repeat(5000) });
    const stored = (correctionParams(calls) as string[]).find((p) => typeof p === 'string' && p.startsWith('xxx'));
    expect(stored).toHaveLength(2000);
  });

  it("keeps a not-applicable ruling's own wording when there is no note", async () => {
    const calls = transactionThatSucceeds();
    const res = await fetch(`${baseUrl}/api/review-items/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'journey', item_score_id: 'item-score-1', result: 'na' }),
    });
    expect(res.status).toBe(200);
    expect(correctionParams(calls)).toContain('Not applicable to this sale');
  });
});
