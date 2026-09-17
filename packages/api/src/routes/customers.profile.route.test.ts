import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// The customer profile's honest compliance state, and who may do what on it.
//
// - GET /api/customers/:id returns the counts the three states are built from
//   (not yet assessed / no open findings / N open), and the firm's scoring mode.
// - An adviser gets neither the findings nor the sale result: both describe the
//   firm's assessment across every adviser's calls.
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
  call_count: 8,
  journey_count: 2,
  last_journey_score: '83.40',
  last_journey_pass: true,
  last_journey_at: '2026-08-25T10:00:00.000Z',
};

interface Fixture {
  scoringScope?: string;
  compliance?: Record<string, number>;
  customer?: Record<string, unknown> | null;
  adviserLinked?: boolean;
  updateRow?: Record<string, unknown> | null;
}

function setupDb(f: Fixture = {}) {
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    const text = String(sql);
    // The router's plan gate.
    if (text.includes('plan_override')) return { org_plan: 'professional', plan_override: null } as never;
    if (text.includes('scoring_scope')) return { scoring_scope: f.scoringScope ?? 'sales_only' } as never;
    if (text.includes('FROM breaches b')) {
      return {
        scored_sales: 0,
        scored_calls: 0,
        open_critical: 0,
        open_high: 0,
        open_medium: 0,
        open_low: 0,
        closed_critical: 0,
        closed_high: 0,
        closed_medium: 0,
        closed_low: 0,
        resolved: 0,
        noted: 0,
        ...f.compliance,
      } as never;
    }
    if (text.includes('FROM customers c')) {
      return (f.customer === undefined ? CUSTOMER_ROW : f.customer) as never;
    }
    if (text.includes('SELECT id FROM calls')) return (f.adviserLinked === false ? null : { id: 'call-1' }) as never;
    return null as never;
  });
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (String(sql).includes('UPDATE customers c')) {
      return (f.updateRow === null ? [] : [f.updateRow]) as never;
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
});

describe('GET /api/customers/:id — adviser scoping', () => {
  it('withholds the findings and the sale result from an adviser', async () => {
    setupDb();
    const res = await get('adviser');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.compliance).toBeNull();
    expect(body.customer.journey_count).toBeNull();
    expect(body.customer.last_journey_score).toBeNull();
    expect(body.customer.last_journey_pass).toBeNull();
    expect(body.customer.last_journey_at).toBeNull();
    // Not merely nulled after the fact: the firm-wide breach query never runs.
    expect(sqlCalls(queryOne, 'FROM breaches b')).toHaveLength(0);
  });

  it("counts only the adviser's own calls", async () => {
    setupDb();
    await get('adviser');
    const [[sql, params]] = sqlCalls(queryOne, 'FROM customers c');
    expect(String(sql)).toContain('ca.agent_id = $3::uuid');
    expect(params).toEqual([CUSTOMER, ORG, USER]);
  });

  it('does not narrow the call count for anyone else', async () => {
    setupDb();
    await get('supervisor');
    const [[, params]] = sqlCalls(queryOne, 'FROM customers c');
    expect(params).toEqual([CUSTOMER, ORG, null]);
  });

  it("still refuses an adviser a customer they never spoke to", async () => {
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
