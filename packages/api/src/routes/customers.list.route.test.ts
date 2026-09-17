import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// GET /api/customers — who each person is and what came of their calls.
//
// What these pin:
// - the tabs are the firm's (sales or calls, from its scoring setting), each
//   with a count under the current search, from ONE counts query;
// - the page is ONE more query, with no lookup per row and no transcript;
// - search covers name, phone in any format, and CRM ID;
// - the sort options map to what they say;
// - an adviser gets their own customers, the 'all' tab only, and no results,
//   findings or feedback.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const USER = '00000000-0000-0000-0000-0000000000aa';

let server: Server;
let baseUrl: string;

function signToken(role: string): string {
  return jwt.sign({ userId: USER, organizationId: ORG, role, mfa: true }, config.jwt.secret, {
    expiresIn: '5m',
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

interface Fixture {
  scoringScope?: string;
  scoreOnly?: boolean;
  counts?: Record<string, number>;
  rows?: Record<string, unknown>[];
}

function setupDb(f: Fixture = {}) {
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('plan_override')) return { org_plan: 'professional', plan_override: null } as never;
    if (text.includes('scoring_scope')) return { scoring_scope: f.scoringScope ?? 'sales_only' } as never;
    if (text.includes('feature_overrides')) {
      return { plan: 'professional', feature_overrides: f.scoreOnly ? { score_only: true } : null } as never;
    }
    if (text.includes('COUNT(*) FILTER')) return (f.counts ?? {}) as never;
    return null as never;
  });
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (String(sql).includes('page AS (')) return (f.rows ?? []) as never;
    return [] as never;
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

function list(qs = '', role = 'supervisor') {
  return fetch(`${baseUrl}/api/customers${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${signToken(role)}` },
  });
}

/** The data queries a request made, not the settings lookups or the auth touch. */
function dataQueries() {
  const counts = vi.mocked(queryOne).mock.calls.filter(([sql]) => String(sql).includes('COUNT(*) FILTER'));
  const pages = vi.mocked(query).mock.calls.filter(([sql]) => String(sql).includes('FROM customers cust'));
  return { counts, pages };
}

function pageSql() {
  const { pages } = dataQueries();
  if (pages.length !== 1) throw new Error(`expected one page query, got ${pages.length}`);
  return { sql: String(pages[0]![0]), params: pages[0]![1] as unknown[] };
}

const ROW = {
  id: '00000000-0000-0000-0000-0000000000c1',
  name: 'Hannah Whitfield',
  phone_normalized: '+447700900123',
  external_crm_id: null,
  call_count: 8,
  last_call_at: '2026-09-16T10:00:00.000Z',
  last_adviser_name: 'Lewis',
  latest_id: '00000000-0000-0000-0000-00000000005a',
  latest_status: 'scored',
  latest_score: '83.60',
  latest_pass: false,
  latest_date: '2026-08-25T10:00:00.000Z',
  feedback_status: 'not_fed_back',
  has_open: true,
  open_critical: 2,
  open_high: 0,
  open_medium: 1,
  open_low: 0,
};

describe('GET /api/customers — tabs and counts', () => {
  it("gives a firm that scores sales its five tabs, counted in one query under the search", async () => {
    setupDb({ counts: { all: 3391, scored: 232, open_findings: 40, not_fed_back: 12, no_sale: 3150 } });
    const body = await (await list('q=smith')).json();

    expect(body.mode).toBe('sales');
    expect(body.tabs).toEqual(['all', 'scored', 'open_findings', 'not_fed_back', 'no_sale']);
    expect(body.counts).toEqual({ all: 3391, scored: 232, open_findings: 40, not_fed_back: 12, no_sale: 3150 });
    expect(body.total).toBe(3391);

    const { counts, pages } = dataQueries();
    expect(counts).toHaveLength(1);
    expect(pages).toHaveLength(1);
    // The counts see the same search as the page.
    const countSql = String(counts[0]![0]);
    expect(countSql).toContain('cust.name ILIKE');
    expect(countSql).toContain("AS not_fed_back");
    expect(countSql).toContain("THEN 'awaiting_remediation'");
  });

  it('gives a firm that scores calls its own tabs', async () => {
    setupDb({ scoringScope: 'everything', counts: { all: 10, assessed: 4, open_findings: 1, not_fed_back: 2, not_assessed: 6 } });
    const body = await (await list()).json();
    expect(body.mode).toBe('calls');
    expect(body.tabs).toEqual(['all', 'assessed', 'open_findings', 'not_fed_back', 'not_assessed']);
    expect(body.counts.not_assessed).toBe(6);
    // A calls firm's feedback state is the call's own round.
    expect(String(dataQueries().counts[0]![0])).toContain('f.call_id = w.id');
  });

  it("uses the current tab's count as the total", async () => {
    setupDb({ counts: { all: 3391, scored: 232, open_findings: 40, not_fed_back: 12, no_sale: 3150 } });
    const body = await (await list('tab=open_findings')).json();
    expect(body.total).toBe(40);
    expect(pageSql().sql).toContain('ofd.customer_id IS NOT NULL');
  });

  it("narrows the page to 'not fed back' by the latest scored sale's shared feedback state", async () => {
    setupDb();
    await list('tab=not_fed_back');
    const { sql } = pageSql();
    expect(sql).toContain(`lss.feedback_status = 'not_fed_back'`);
    expect(sql).toContain('f.journey_id = j.id');
  });

  it("refuses a tab that is not this firm's", async () => {
    setupDb();
    const res = await list('tab=assessed');
    expect(res.status).toBe(400);
    expect(dataQueries().pages).toHaveLength(0);
  });
});

describe('GET /api/customers — search', () => {
  it('searches by name, phone and CRM ID', async () => {
    setupDb();
    await list('q=ZC-104');
    const { sql, params } = pageSql();
    expect(sql).toContain('cust.name ILIKE');
    expect(sql).toContain('cust.external_crm_id ILIKE');
    expect(sql).toContain('cust.phone_normalized ILIKE');
    expect(params).toContain('%ZC-104%');
  });

  it('normalises a phone number in national format to the stored form', async () => {
    setupDb();
    await list(`q=${encodeURIComponent('07700 900123')}`);
    const { sql, params } = pageSql();
    expect(params).toContain('%+447700900123%');
    // A partial number matches anywhere in the digits, too.
    expect(params).toContain('%07700900123%');
    expect(sql).toContain("REGEXP_REPLACE(cust.phone_normalized, '\\D', '', 'g') LIKE");
  });

  it("escapes LIKE wildcards so a search matches itself", async () => {
    setupDb();
    await list(`q=${encodeURIComponent('50%_off')}`);
    expect(pageSql().params).toContain('%50\\%\\_off%');
  });

  it('refuses an overlong search', async () => {
    setupDb();
    const res = await list(`q=${'a'.repeat(101)}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/customers — sort and page', () => {
  it.each([
    ['', 'last_call_at DESC NULLS LAST, last_seen_at DESC, id'],
    ['sort=last_contact', 'last_call_at DESC NULLS LAST, last_seen_at DESC, id'],
    ['sort=most_calls', 'call_count DESC, last_call_at DESC NULLS LAST, id'],
    ['sort=lowest_score', 'sort_score ASC NULLS LAST, last_call_at DESC NULLS LAST, id'],
  ])('%s orders by %s', async (qs, order) => {
    setupDb();
    await list(qs);
    expect(pageSql().sql).toContain(`ORDER BY ${order}`);
  });

  it('refuses an unknown sort', async () => {
    setupDb();
    expect((await list('sort=name')).status).toBe(400);
  });

  it('pages with LIMIT/OFFSET bound as parameters, capped at 100', async () => {
    setupDb();
    const body = await (await list('page=3&limit=500')).json();
    expect(body.limit).toBe(100);
    const { params } = pageSql();
    expect(params.slice(-2)).toEqual([100, 200]);
  });

  it('never selects a transcript column', async () => {
    setupDb();
    await list();
    expect(pageSql().sql).not.toMatch(/transcript/);
  });
});

describe('GET /api/customers — rows', () => {
  it("shapes a row's latest result, open findings and feedback", async () => {
    setupDb({ rows: [ROW], counts: { all: 1 } });
    const body = await (await list()).json();
    expect(body.data).toEqual([
      {
        id: ROW.id,
        name: 'Hannah Whitfield',
        phone_normalized: '+447700900123',
        external_crm_id: null,
        call_count: 8,
        last_call_at: '2026-09-16T10:00:00.000Z',
        last_adviser_name: 'Lewis',
        latest: {
          kind: 'sale',
          id: ROW.latest_id,
          status: 'scored',
          overall_score: 83.6,
          pass: false,
          date: '2026-08-25T10:00:00.000Z',
        },
        open_findings: { critical: 2, high: 0, medium: 1, low: 0 },
        feedback_status: 'not_fed_back',
      },
    ]);
  });

  it('gives a customer with no sale no latest result, and zero open findings', async () => {
    setupDb({
      rows: [{ ...ROW, latest_id: null, latest_status: null, latest_score: null, latest_pass: null, latest_date: null, feedback_status: null, has_open: false, open_critical: null, open_high: null, open_medium: null, open_low: null }],
    });
    const body = await (await list()).json();
    expect(body.data[0].latest).toBeNull();
    expect(body.data[0].open_findings).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(body.data[0].feedback_status).toBeNull();
  });

  it('does not ship the verdict under score_only', async () => {
    setupDb({ rows: [ROW], scoreOnly: true });
    const body = await (await list()).json();
    expect(body.data[0].latest.pass).toBeNull();
    expect(body.data[0].latest.overall_score).toBe(83.6);
  });

  it("marks a calls firm's latest result as a call", async () => {
    setupDb({ scoringScope: 'everything', rows: [ROW] });
    const body = await (await list()).json();
    expect(body.data[0].latest.kind).toBe('call');
    expect(pageSql().sql).toContain('LEFT JOIN latest_call lc');
  });
});

describe('GET /api/customers — adviser scoping', () => {
  it("gives an adviser their own customers, the 'all' tab only, and no firm findings", async () => {
    setupDb({ rows: [{ ...ROW, latest_id: null, feedback_status: null, open_critical: null }], counts: { all: 5 } });
    const body = await (await list('', 'adviser')).json();
    expect(body.tabs).toEqual(['all']);
    expect(body.counts).toEqual({ all: 5 });
    expect(body.data[0].latest).toBeNull();
    expect(body.data[0].open_findings).toBeNull();
    expect(body.data[0].feedback_status).toBeNull();

    const { sql, params } = pageSql();
    expect(sql).toContain('ac.agent_id = $2');
    expect(sql).not.toContain('open_findings AS');
    expect(sql).not.toContain('journey_feedback');
    expect(params[1]).toBe(USER);
    // Their call counts are their own calls.
    expect(sql).toContain('AND ca.agent_id = $2');
  });

  it('refuses an adviser any other tab', async () => {
    setupDb();
    const res = await list('tab=open_findings', 'adviser');
    expect(res.status).toBe(400);
  });
});
