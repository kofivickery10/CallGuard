import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { callStatsFrom } from './customers.js';

// The customer profile: its honest compliance state, the timeline it is built
// from, and who may do what on it.
//
// - GET /api/customers/:id returns the counts the three states are built from
//   (not yet assessed / no open findings / N open), the firm's scoring mode,
//   every sale with its calls and findings, every call, and — for someone who
//   can act — what "Score calls as a sale" would do.
// - An adviser gets their own calls and nothing that describes the firm's
//   assessment: no findings, no sales, no call results.
// - Editing a customer's name or CRM ID is admin/supervisor only and leaves an
//   audit record.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const USER = '00000000-0000-0000-0000-0000000000aa';
const CUSTOMER = '00000000-0000-0000-0000-0000000000c1';
const LINKED = '00000000-0000-0000-0000-0000000000c2';
const SALE_A = '00000000-0000-0000-0000-00000000005a';
const SALE_B = '00000000-0000-0000-0000-00000000005b';

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

const CUSTOMER_ROW = {
  id: CUSTOMER,
  phone_normalized: '+447700900123',
  name: 'Hannah Whitfield',
  external_crm_id: 'ZC-1',
  first_seen_at: '2026-07-27T10:00:00.000Z',
  last_seen_at: '2026-09-16T10:00:00.000Z',
};

const ZERO_BREACHES = {
  open_critical: 0,
  open_high: 0,
  open_medium: 0,
  open_low: 0,
  closed_critical: 0,
  closed_high: 0,
  closed_medium: 0,
  closed_low: 0,
};

interface Fixture {
  scoringScope?: string;
  scoreOnly?: boolean;
  reconciliation?: boolean;
  compliance?: Record<string, number>;
  customer?: Record<string, unknown> | null;
  adviserLinked?: boolean;
  updateRow?: Record<string, unknown> | null;
  calls?: Record<string, unknown>[];
  sales?: Record<string, unknown>[];
  saleCalls?: Record<string, unknown>[];
  previewCalls?: Record<string, unknown>[];
  inFlight?: string | null;
  lastScored?: string | null;
  lastScoredCalls?: string[];
}

function setupDb(f: Fixture = {}) {
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    const text = String(sql);
    // The router's plan gate.
    if (text.includes('plan_override')) return { org_plan: 'professional', plan_override: null } as never;
    if (text.includes('scoring_scope')) return { scoring_scope: f.scoringScope ?? 'sales_only' } as never;
    if (text.includes('feature_overrides')) {
      return { plan: 'professional', feature_overrides: f.scoreOnly ? { score_only: true } : null } as never;
    }
    if (text.includes('reconciliation_enabled')) return { reconciliation_enabled: f.reconciliation ?? false } as never;
    if (text.includes('journey_window_days')) return { journey_window_days: 90 } as never;
    if (text.includes('FROM dialer_connections')) return null as never;
    if (text.includes('FROM breaches b')) {
      return {
        scored_sales: 0,
        scored_calls: 0,
        ...ZERO_BREACHES,
        resolved: 0,
        noted: 0,
        ...f.compliance,
      } as never;
    }
    if (text.includes('FROM customers c')) {
      return (f.customer === undefined ? CUSTOMER_ROW : f.customer) as never;
    }
    if (text.includes('SELECT id FROM calls')) return (f.adviserLinked === false ? null : { id: 'call-1' }) as never;
    if (text.includes("status IN ('pending', 'scoring')")) return (f.inFlight ? { id: f.inFlight } : null) as never;
    if (text.includes("customer_id = $2 AND status = 'scored'")) {
      return (f.lastScored ? { id: f.lastScored } : null) as never;
    }
    return null as never;
  });
  vi.mocked(query).mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('UPDATE customers c')) return (f.updateRow === null ? [] : [f.updateRow]) as never;
    if (text.includes('FROM calls ca') && text.includes('ORDER BY COALESCE(ca.call_date')) return (f.calls ?? []) as never;
    if (text.includes('sale_breaches')) return (f.sales ?? []) as never;
    if (text.includes('FROM journey_calls jc')) return (f.saleCalls ?? []) as never;
    if (text.includes('ORDER BY COALESCE(call_date::timestamptz, created_at) ASC')) return (f.previewCalls ?? []) as never;
    if (text.includes('SELECT call_id FROM journey_calls WHERE journey_id')) {
      return (f.lastScoredCalls ?? []).map((call_id) => ({ call_id })) as never;
    }
    return [] as never;
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

function get(role: string) {
  return fetch(`${baseUrl}/api/customers/${CUSTOMER}`, {
    headers: { Authorization: `Bearer ${signToken(role)}` },
  });
}

function put(role: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/customers/${CUSTOMER}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${signToken(role)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sqlCalls(mock: typeof query | typeof queryOne, fragment: string) {
  return vi.mocked(mock).mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

function call(id: string, at: string, adviser: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    called_at: at,
    adviser_name: adviser,
    duration_seconds: '300',
    status: 'transcribed',
    in_sale: false,
    ...extra,
  };
}

describe('GET /api/customers/:id — compliance counts', () => {
  it('returns the counts for a customer nobody has assessed, not a clean bill', async () => {
    setupDb();
    const res = await get('supervisor');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('sales');
    expect(body.compliance).toEqual({
      scored_sales: 0,
      scored_calls: 0,
      open: { critical: 0, high: 0, medium: 0, low: 0 },
      closed: { critical: 0, high: 0, medium: 0, low: 0 },
      resolved: 0,
      noted: 0,
    });
    // The retired shape must be gone, so nothing can go on reading total === 0 as clean.
    expect(body.breaches).toBeUndefined();
  });

  it('splits open from closed by severity, treating noted as closed', async () => {
    setupDb({
      compliance: { scored_sales: 2, closed_critical: 7, closed_medium: 20, resolved: 25, noted: 2 },
    });
    const body = await (await get('viewer')).json();
    expect(body.compliance.open).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(body.compliance.closed).toEqual({ critical: 7, high: 0, medium: 20, low: 0 });
    expect(body.compliance.resolved).toBe(25);
    expect(body.compliance.noted).toBe(2);

    const [[sql]] = sqlCalls(queryOne, 'FROM breaches b');
    expect(String(sql)).toContain("b.status NOT IN ('resolved', 'noted')");
    expect(String(sql)).toContain("b.status IN ('resolved', 'noted')");
  });

  it('reports open findings by severity', async () => {
    setupDb({ compliance: { scored_sales: 1, open_critical: 2, open_low: 1 } });
    const body = await (await get('admin')).json();
    expect(body.compliance.open).toEqual({ critical: 2, high: 0, medium: 0, low: 1 });
  });

  it("names the firm's mode from its scoring setting, not from any integration", async () => {
    setupDb({ scoringScope: 'everything' });
    const body = await (await get('supervisor')).json();
    expect(body.mode).toBe('calls');
  });

  it('404s an id that is not a uuid without querying', async () => {
    setupDb();
    const res = await fetch(`${baseUrl}/api/customers/not-a-uuid`, {
      headers: { Authorization: `Bearer ${signToken('admin')}` },
    });
    expect(res.status).toBe(404);
    expect(sqlCalls(queryOne, 'FROM customers c')).toHaveLength(0);
  });
});

describe('GET /api/customers/:id — the timeline payload', () => {
  const SALES = [
    {
      id: SALE_B,
      status: 'scored',
      sale_date: '2026-08-25T10:00:00.000Z',
      scored_at: '2026-08-26T09:00:00.000Z',
      overall_score: '83.60',
      pass: true,
      feedback_status: 'not_fed_back',
      feedback_sent_at: null,
      oldest_remediation_days: null,
      closing_adviser_name: 'Lewis',
      adviser_count: 3,
      reconciliation_status: 'completed',
      ...ZERO_BREACHES,
      closed_critical: 7,
      closed_medium: 20,
    },
    {
      id: SALE_A,
      status: 'pending',
      sale_date: '2026-08-01T10:00:00.000Z',
      scored_at: null,
      overall_score: null,
      pass: null,
      feedback_status: null,
      feedback_sent_at: null,
      oldest_remediation_days: null,
      closing_adviser_name: 'George',
      adviser_count: 1,
      reconciliation_status: null,
      open_critical: null,
      open_high: null,
      open_medium: null,
      open_low: null,
      closed_critical: null,
      closed_high: null,
      closed_medium: null,
      closed_low: null,
    },
  ];
  const SALE_CALLS = [
    { journey_id: SALE_A, role: 'wrap_up', ...call('call-1', '2026-07-30T10:00:00.000Z', 'George') },
    { journey_id: SALE_B, role: 'context', ...call('call-2', '2026-08-20T10:00:00.000Z', 'George') },
    { journey_id: SALE_B, role: 'wrap_up', ...call('call-3', '2026-08-25T10:00:00.000Z', 'Lewis') },
  ];

  it('returns every sale with its own calls, findings, feedback and closing adviser', async () => {
    setupDb({ sales: SALES, saleCalls: SALE_CALLS, reconciliation: true });
    const body = await (await get('viewer')).json();

    expect(body.sales).toHaveLength(2);
    const [b, a] = body.sales;
    expect(b).toMatchObject({
      id: SALE_B,
      status: 'scored',
      overall_score: 83.6,
      pass: true,
      feedback_status: 'not_fed_back',
      closing_adviser_name: 'Lewis',
      adviser_count: 3,
      open: { critical: 0, high: 0, medium: 0, low: 0 },
      closed: { critical: 7, high: 0, medium: 20, low: 0 },
      reconciliation_status: 'completed',
    });
    expect(b.calls.map((c: { id: string; role: string }) => [c.id, c.role])).toEqual([
      ['call-2', 'context'],
      ['call-3', 'wrap_up'],
    ]);
    // A sale with no breaches reads as zeros, never nulls.
    expect(a.open).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(a.calls).toHaveLength(1);

    // One query for every sale's calls, not one per sale.
    const saleCallQueries = sqlCalls(query, 'FROM journey_calls jc');
    expect(saleCallQueries).toHaveLength(1);
    expect(saleCallQueries[0]![1]).toEqual([[SALE_B, SALE_A], ORG]);
  });

  it('computes each sale\'s feedback state with the shared SQL, only on a scored sale', async () => {
    setupDb({ sales: SALES });
    await get('supervisor');
    const [[sql]] = sqlCalls(query, 'sale_breaches');
    expect(String(sql)).toContain("WHEN j.status = 'scored' THEN CASE");
    expect(String(sql)).toContain("THEN 'awaiting_remediation'");
    expect(String(sql)).not.toMatch(/transcript/);
  });

  it('leaves out the reconciliation status for a firm that does not use it', async () => {
    setupDb({ sales: SALES, reconciliation: false });
    const body = await (await get('supervisor')).json();
    expect(body.reconciliation_enabled).toBe(false);
    expect(body.sales[0].reconciliation_status).toBeNull();
    const [[sql]] = sqlCalls(query, 'sale_breaches');
    expect(String(sql)).not.toContain('capture_reconciliation_runs');
  });

  it('does not ship a verdict under score_only', async () => {
    setupDb({ sales: SALES, scoreOnly: true });
    const body = await (await get('supervisor')).json();
    expect(body.score_only).toBe(true);
    expect(body.sales[0].pass).toBeNull();
    expect(body.sales[0].overall_score).toBe(83.6);
  });

  it('returns every call with whether it is in a sale, and the header figures from them', async () => {
    setupDb({
      calls: [
        call('call-3', '2026-09-16T10:00:00.000Z', 'Lewis', { in_sale: true }),
        call('call-2', '2026-08-20T10:00:00.000Z', 'George'),
        call('call-1', '2026-07-27T10:00:00.000Z', null),
      ],
    });
    const body = await (await get('supervisor')).json();
    expect(body.calls.map((c: { id: string; in_sale: boolean }) => [c.id, c.in_sale])).toEqual([
      ['call-3', true],
      ['call-2', false],
      ['call-1', false],
    ]);
    expect(body.calls[0].duration_seconds).toBe(300);
    // A firm that scores sales carries no per-call result.
    expect(body.calls[0].score).toBeNull();
    expect(body.calls[0].open).toBeNull();
    expect(body.stats).toEqual({
      call_count: 3,
      first_call_at: '2026-07-27T10:00:00.000Z',
      last_call_at: '2026-09-16T10:00:00.000Z',
      adviser_count: 2,
    });
    const [[sql]] = sqlCalls(query, 'ORDER BY COALESCE(ca.call_date');
    expect(String(sql)).not.toContain('transcript');
    expect(String(sql)).not.toContain('call_scores');
  });

  it("gives a calls firm each call's latest score, findings and own feedback state", async () => {
    setupDb({
      scoringScope: 'everything',
      calls: [
        call('call-2', '2026-08-20T10:00:00.000Z', 'George', {
          status: 'scored',
          latest_score_id: 'score-2',
          overall_score: '64.00',
          pass: false,
          ...ZERO_BREACHES,
          open_high: 2,
          feedback_status: 'awaiting',
          feedback_sent_at: '2026-08-21T10:00:00.000Z',
        }),
        // Scored but part of a sale: fed back from the sale, never on its own.
        call('call-1', '2026-07-27T10:00:00.000Z', 'George', {
          status: 'scored',
          in_sale: true,
          latest_score_id: 'score-1',
          overall_score: '90.00',
          pass: true,
          ...ZERO_BREACHES,
          feedback_status: 'not_fed_back',
        }),
      ],
    });
    const body = await (await get('supervisor')).json();
    expect(body.calls[0]).toMatchObject({
      score: { overall_score: 64, pass: false },
      open: { critical: 0, high: 2, medium: 0, low: 0 },
      feedback_status: 'awaiting',
      feedback_sent_at: '2026-08-21T10:00:00.000Z',
    });
    expect(body.calls[1].feedback_status).toBeNull();
    const [[sql]] = sqlCalls(query, 'ORDER BY COALESCE(ca.call_date');
    expect(String(sql)).toContain('f.call_id = ca.id');
    // The calls firm's sale preview does not exist: it only scores sales.
    expect(body.sale_preview).toBeNull();
  });

  it('computes the header adviser count case-insensitively and ignores unknown advisers', () => {
    expect(
      callStatsFrom([
        { called_at: '2026-08-01T10:00:00.000Z', adviser_name: 'Lewis' },
        { called_at: '2026-08-02T10:00:00.000Z', adviser_name: 'lewis ' },
        { called_at: '2026-08-03T10:00:00.000Z', adviser_name: null },
      ]).adviser_count
    ).toBe(1);
    expect(callStatsFrom([])).toEqual({ call_count: 0, first_call_at: null, last_call_at: null, adviser_count: 0 });
  });
});

describe('GET /api/customers/:id — what "Score calls as a sale" would do', () => {
  const PREVIEW = [
    { id: 'call-1', called_at: '2026-08-20T10:00:00.000Z', adviser_name: 'George', duration_seconds: 600, status: 'transcribed', journey_id: SALE_A, customer_id: CUSTOMER },
    { id: 'call-2', called_at: '2026-08-25T10:00:00.000Z', adviser_name: 'Lewis', duration_seconds: 40, status: 'captured', journey_id: null, customer_id: LINKED },
  ];

  it('lists the calls the trigger would group, using the same selection as assembly', async () => {
    setupDb({ previewCalls: PREVIEW });
    const body = await (await get('admin')).json();
    expect(body.sale_preview).toEqual({
      window_days: 90,
      calls: [
        { id: 'call-1', called_at: '2026-08-20T10:00:00.000Z', adviser_name: 'George', duration_seconds: 600, status: 'transcribed', sale_id: SALE_A, from_linked_number: false },
        { id: 'call-2', called_at: '2026-08-25T10:00:00.000Z', adviser_name: 'Lewis', duration_seconds: 40, status: 'captured', sale_id: null, from_linked_number: true },
      ],
      in_flight_sale_id: null,
      covered_by_sale_id: null,
    });
    const [[sql, params]] = sqlCalls(query, 'ORDER BY COALESCE(call_date::timestamptz, created_at) ASC');
    // A manual trigger carries no CRM sale id, so the sale-scoping predicate is off.
    expect((params as unknown[])[3]).toBeNull();
    expect(String(sql)).not.toContain('SELECT *');
  });

  it('says when the latest scored sale already covers exactly these calls', async () => {
    setupDb({ previewCalls: PREVIEW, lastScored: SALE_B, lastScoredCalls: ['call-2', 'call-1'] });
    const body = await (await get('supervisor')).json();
    expect(body.sale_preview.covered_by_sale_id).toBe(SALE_B);
  });

  it('says when a sale is already being scored', async () => {
    setupDb({ previewCalls: PREVIEW, inFlight: SALE_A });
    const body = await (await get('admin')).json();
    expect(body.sale_preview.in_flight_sale_id).toBe(SALE_A);
  });

  it('is not offered to a viewer', async () => {
    setupDb({ previewCalls: PREVIEW });
    const body = await (await get('viewer')).json();
    expect(body.sale_preview).toBeNull();
    expect(sqlCalls(query, 'ORDER BY COALESCE(call_date::timestamptz, created_at) ASC')).toHaveLength(0);
  });
});

describe('GET /api/customers/:id — adviser scoping', () => {
  it('withholds the findings, the sales and every call result from an adviser', async () => {
    setupDb({ scoringScope: 'everything', calls: [call('call-1', '2026-08-20T10:00:00.000Z', 'Me')] });
    const res = await get('adviser');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.compliance).toBeNull();
    expect(body.sales).toBeNull();
    expect(body.sale_preview).toBeNull();
    expect(body.calls[0].score).toBeNull();
    expect(body.calls[0].open).toBeNull();
    expect(body.calls[0].feedback_status).toBeNull();
    // Not merely nulled after the fact: the firm-wide queries never run.
    expect(sqlCalls(queryOne, 'FROM breaches b')).toHaveLength(0);
    expect(sqlCalls(query, 'sale_breaches')).toHaveLength(0);
    const [[sql]] = sqlCalls(query, 'ORDER BY COALESCE(ca.call_date');
    expect(String(sql)).not.toContain('call_scores');
  });

  it("lists only the adviser's own calls, and counts from them", async () => {
    setupDb({ calls: [call('call-1', '2026-08-20T10:00:00.000Z', 'Me')] });
    const body = await (await get('adviser')).json();
    const [[sql, params]] = sqlCalls(query, 'ORDER BY COALESCE(ca.call_date');
    expect(String(sql)).toContain('ca.agent_id = $3');
    expect(params).toEqual([CUSTOMER, ORG, USER]);
    expect(body.stats.call_count).toBe(1);
  });

  it('does not narrow the calls for anyone else', async () => {
    setupDb();
    await get('supervisor');
    const [[sql, params]] = sqlCalls(query, 'ORDER BY COALESCE(ca.call_date');
    expect(String(sql)).not.toContain('ca.agent_id = $3');
    expect(params).toEqual([CUSTOMER, ORG]);
  });

  it('still refuses an adviser a customer they never spoke to', async () => {
    setupDb({ adviserLinked: false });
    const res = await get('adviser');
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/customers/:id — who may edit, and the record it leaves', () => {
  it.each(['viewer', 'adviser'])('refuses the %s role and changes nothing', async (role) => {
    setupDb();
    const res = await put(role, { name: 'Someone Else', external_crm_id: 'ZC-2' });
    expect(res.status).toBe(403);
    expect(sqlCalls(query, 'UPDATE customers')).toHaveLength(0);
    expect(sqlCalls(query, 'INSERT INTO audit_log')).toHaveLength(0);
  });

  it.each(['admin', 'supervisor'])('lets the %s role edit', async (role) => {
    setupDb({
      updateRow: {
        id: CUSTOMER,
        name: 'Hannah Whitfield',
        external_crm_id: 'ZC-2',
        before_name: 'Hannah Whitfield',
        before_external_crm_id: 'ZC-1',
      },
    });
    const res = await put(role, { name: 'Hannah Whitfield', external_crm_id: 'ZC-2' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: CUSTOMER, name: 'Hannah Whitfield', external_crm_id: 'ZC-2' });
  });

  it('writes an audit event with the CRM ID before and after, and whether a name was set — never the name', async () => {
    setupDb({
      updateRow: {
        id: CUSTOMER,
        name: 'Hannah Whitfield-Jones',
        external_crm_id: null,
        before_name: 'Hannah Whitfield',
        before_external_crm_id: 'ZC-1',
      },
    });
    const res = await put('supervisor', { name: 'Hannah Whitfield-Jones', external_crm_id: '' });
    expect(res.status).toBe(200);

    const audits = sqlCalls(query, 'INSERT INTO audit_log');
    expect(audits).toHaveLength(1);
    const params = audits[0]![1] as unknown[];
    expect(params[0]).toBe(ORG);
    expect(params[1]).toBe(USER);
    expect(params[2]).toBe('customer.update');
    expect(params[3]).toBe('customer');
    expect(params[4]).toBe(CUSTOMER);
    expect(params[5]).toBe("Edited a customer's CRM ID and name");
    const metadata = JSON.parse(String(params[6]));
    expect(metadata).toEqual({
      changes: {
        external_crm_id: { before: 'ZC-1', after: null },
        name: { before_present: true, after_present: true },
      },
    });
    // The register is append-only and outlives an erasure request.
    expect(String(params[6])).not.toContain('Whitfield');
    expect(String(params[5])).not.toContain('Whitfield');
  });

  it('records nothing when the save changed nothing', async () => {
    setupDb({
      updateRow: {
        id: CUSTOMER,
        name: 'Hannah Whitfield',
        external_crm_id: 'ZC-1',
        before_name: 'Hannah Whitfield',
        before_external_crm_id: 'ZC-1',
      },
    });
    const res = await put('admin', { name: 'Hannah Whitfield', external_crm_id: 'ZC-1' });
    expect(res.status).toBe(200);
    expect(sqlCalls(query, 'INSERT INTO audit_log')).toHaveLength(0);
  });

  it('404s a customer outside the organisation without an audit record', async () => {
    setupDb({ updateRow: null });
    const res = await put('admin', { name: 'x' });
    expect(res.status).toBe(404);
    expect(sqlCalls(query, 'INSERT INTO audit_log')).toHaveLength(0);
  });
});
