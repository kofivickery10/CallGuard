import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// GET /api/calls — the calls list. It used to select `c.*`, which sent every
// call's transcript and raw transcription payload with each page (27.6 MB for
// twenty transcribed calls on a live tenant). These pin that a list row carries
// only what a list shows, whatever columns the calls table grows later, and
// that the list's shape (tabs, counts, mode) follows the org's scoring_scope
// (services/tenant-settings.ts's scoresCallsIndividually) rather than Zoho.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const ADVISER_ID = '00000000-0000-0000-0000-0000000000aa';
const OTHER_ADVISER_ID = '00000000-0000-0000-0000-0000000000dd';

let server: Server;
let baseUrl: string;

function signToken(role: string, userId = ADVISER_ID): string {
  return jwt.sign({ userId, organizationId: ORG, role, mfa: true }, config.jwt.secret, { expiresIn: '5m' });
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

// Controls what getScoringSettings/orgHasFeature/the counts query resolve to,
// without re-mocking the services themselves — the route imports them from
// tenant-settings.ts, which itself only ever calls queryOne.
let scope: 'sales_only' | 'over_threshold' | 'everything' = 'sales_only';
let scoreOnly = false;
let countsRow: Record<string, string> = {};

function scoringSettingsRow(s: typeof scope) {
  return {
    scoring_scope: s,
    min_scoreable_seconds: 30,
    min_scoreable_words: 50,
    pass_threshold: '80',
    retention_days: 1825,
    transcription_mode: 'mono_diarize',
    mono_first_speaker: 'agent',
    deepgram_region: 'eu',
    deepgram_mip_opt_out: true,
    scoring_samples: 1,
    review_confidence_floor: '0',
    zoho_writeback_trigger: 'on_scoring',
    fetch_recordings_on_sale: false,
  };
}

beforeEach(() => {
  scope = 'sales_only';
  scoreOnly = false;
  countsRow = {};
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne)
    .mockReset()
    .mockImplementation((async (sql: string) => {
      const s = String(sql);
      if (s.includes('scoring_scope')) return scoringSettingsRow(scope);
      if (s.includes('feature_overrides')) return { plan: 'core', feature_overrides: scoreOnly ? { score_only: true } : null };
      if (s.includes('FILTER (WHERE')) return countsRow;
      return null;
    }) as never);
});

function headers(role: string, userId = ADVISER_ID) {
  return { Authorization: `Bearer ${signToken(role, userId)}` };
}

function list(qs = '', role = 'admin', userId = ADVISER_ID): Promise<Response> {
  return fetch(`${baseUrl}/api/calls${qs ? `?${qs}` : ''}`, { headers: headers(role, userId) });
}

/** The SQL + params of the page query (the one that pages through calls). */
function pageCall(): [string, unknown[]] {
  const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('FROM calls c'));
  expect(call).toBeDefined();
  return [String(call![0]), call![1] as unknown[]];
}

describe('GET /api/calls — what a list row carries', () => {
  it('names its columns rather than selecting every column of calls', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const [sql] = pageCall();
    expect(sql).not.toMatch(/\bc\.\*/);
  });

  it('never selects a transcript or a storage pointer, in the page query or the counts query', async () => {
    scope = 'over_threshold';
    await list();
    const forbidden = ['transcript_text', 'transcript_raw', 'file_key', 'recording_pointer'];
    for (const [sql] of vi.mocked(query).mock.calls) {
      for (const column of forbidden) expect(String(sql)).not.toContain(column);
    }
    for (const [sql] of vi.mocked(queryOne).mock.calls) {
      for (const column of forbidden) expect(String(sql)).not.toContain(column);
    }
  });

  it('still returns what the list renders', async () => {
    await list();
    const [sql] = pageCall();
    for (const column of ['c.id', 'c.file_name', 'c.duration_seconds', 'c.status', 'c.agent_name', 'c.call_date', 'c.created_at', 'c.direction']) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('adviser_name');
  });

  it('keeps an adviser to their own calls', async () => {
    await list('', 'adviser');
    const [sql, params] = pageCall();
    expect(sql).toContain('c.agent_id = $2');
    expect(params).toContain(ADVISER_ID);
  });

  it('orders stably, tie-breaking on c.id', async () => {
    await list();
    const [sql] = pageCall();
    expect(sql).toMatch(/ORDER BY[^;]*c\.id (ASC|DESC)/);
  });
});

describe('GET /api/calls — mode follows scoring_scope, not Zoho', () => {
  it('is "sales" for a sales_only org, with the sales tabs and counts', async () => {
    scope = 'sales_only';
    countsRow = { all: '5', in_sale: '2', not_in_sale: '2', processing: '1', failed: '0' };
    const res = await list();
    const body = await res.json();
    expect(body.mode).toBe('sales');
    expect(body.counts).toEqual({ all: 5, in_sale: 2, not_in_sale: 2, processing: 1, failed: 0 });
    expect(body.total).toBe(5);
  });

  it('is "calls" for an org scoring every call, with the calls tabs and counts', async () => {
    scope = 'everything';
    countsRow = { all: '9', attention: '3', failed_checks: '2', passed: '4', processing: '1', failed: '0' };
    const res = await list();
    const body = await res.json();
    expect(body.mode).toBe('calls');
    expect(body.counts).toEqual({ all: 9, attention: 3, failed_checks: 2, passed: 4, processing: 1, failed: 0 });
  });

  it('decides mode from scoring_scope alone, never a Zoho/CRM table', async () => {
    scope = 'over_threshold';
    await list();
    // getScoringSettings legitimately reads the org's zoho_writeback_trigger
    // column (an unrelated setting on the same row) — what must never happen
    // is the mode being decided off a Zoho table or delivery record.
    for (const [sql] of [...vi.mocked(query).mock.calls, ...vi.mocked(queryOne).mock.calls]) {
      expect(String(sql).toLowerCase()).not.toContain('zoho_deliveries');
      expect(String(sql).toLowerCase()).not.toContain('zoho_record_id');
    }
  });

  it('under score_only, hides failed_checks and passed from counts entirely', async () => {
    scope = 'everything';
    scoreOnly = true;
    countsRow = { all: '9', attention: '3', processing: '1', failed: '0' };
    const res = await list();
    const body = await res.json();
    expect(body.counts).toEqual({ all: 9, attention: 3, processing: 1, failed: 0 });
    expect(body.counts).not.toHaveProperty('failed_checks');
    expect(body.counts).not.toHaveProperty('passed');
  });
});

describe('GET /api/calls — tab validation', () => {
  it('accepts every sales-mode tab', async () => {
    scope = 'sales_only';
    for (const tab of ['all', 'in_sale', 'not_in_sale', 'processing', 'failed']) {
      const res = await list(`tab=${tab}`);
      expect(res.status).toBe(200);
    }
  });

  it('rejects a calls-mode tab in sales mode', async () => {
    scope = 'sales_only';
    const res = await list('tab=attention');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/tab must be one of/);
  });

  it('accepts every calls-mode tab, including the verdict ones, when not score_only', async () => {
    scope = 'everything';
    for (const tab of ['all', 'attention', 'failed_checks', 'passed', 'processing', 'failed']) {
      const res = await list(`tab=${tab}`);
      expect(res.status).toBe(200);
    }
  });

  it('rejects a sales-mode tab in calls mode', async () => {
    scope = 'everything';
    const res = await list('tab=in_sale');
    expect(res.status).toBe(400);
  });

  it('refuses failed_checks and passed under score_only', async () => {
    scope = 'everything';
    scoreOnly = true;
    for (const tab of ['failed_checks', 'passed']) {
      const res = await list(`tab=${tab}`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toMatch(/verdict/);
    }
  });

  it('still allows attention, all, processing, failed under score_only', async () => {
    scope = 'everything';
    scoreOnly = true;
    for (const tab of ['all', 'attention', 'processing', 'failed']) {
      const res = await list(`tab=${tab}`);
      expect(res.status).toBe(200);
    }
  });

  it('narrows attention to manual_review only under score_only', async () => {
    scope = 'everything';
    scoreOnly = true;
    await list('tab=attention');
    const [sql] = pageCall();
    expect(sql).not.toContain('latest.pass IS FALSE');
    expect(sql).toContain('latest.has_manual_review IS TRUE');
  });

  it('rejects an unknown tab with a plain sentence', async () => {
    const res = await list('tab=bogus');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/calls — adviser filter', () => {
  it('lets a supervisor filter by adviser', async () => {
    const res = await list(`adviser=${OTHER_ADVISER_ID}`, 'supervisor');
    expect(res.status).toBe(200);
    const [, params] = pageCall();
    expect(params).toContain(OTHER_ADVISER_ID);
  });

  it('lets a viewer filter by adviser', async () => {
    const res = await list(`adviser=${OTHER_ADVISER_ID}`, 'viewer');
    expect(res.status).toBe(200);
    const [, params] = pageCall();
    expect(params).toContain(OTHER_ADVISER_ID);
  });

  it('rejects a non-UUID adviser value', async () => {
    const res = await list('adviser=not-a-uuid', 'admin');
    expect(res.status).toBe(400);
  });

  it('ignores the adviser query param for an adviser, scoping to self instead', async () => {
    const res = await list(`adviser=${OTHER_ADVISER_ID}`, 'adviser', ADVISER_ID);
    expect(res.status).toBe(200);
    const [, params] = pageCall();
    expect(params).toContain(ADVISER_ID);
    expect(params).not.toContain(OTHER_ADVISER_ID);
  });
});

describe('GET /api/calls — q search', () => {
  it('escapes % and _ before wrapping in wildcards', async () => {
    await list(`q=${encodeURIComponent('50% off_er')}`);
    const [, params] = pageCall();
    expect(params).toContain('%50\\% off\\_er%');
  });

  it('requires at least 3 digits before treating q as a phone search', async () => {
    await list(`q=${encodeURIComponent('12')}`);
    const [sql] = pageCall();
    // resolved_customer_phone (a row's own output column) always joins
    // phone_normalized — REGEXP_REPLACE is what's unique to the phone-search
    // clause, and must be absent below 3 digits.
    expect(sql).not.toContain('REGEXP_REPLACE');
  });

  it('treats 3+ digits as a phone search alongside the name search', async () => {
    await list(`q=${encodeURIComponent('123')}`);
    const [sql, params] = pageCall();
    expect(sql).toContain('REGEXP_REPLACE');
    expect(params).toContain('%123%');
  });

  it('rejects q over 100 characters', async () => {
    const res = await list(`q=${'a'.repeat(101)}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/calls — date range', () => {
  it('rejects a malformed from date', async () => {
    const res = await list('from=17-09-2026');
    expect(res.status).toBe(400);
  });

  it('rejects a malformed to date', async () => {
    const res = await list('to=2026/09/17');
    expect(res.status).toBe(400);
  });

  it('accepts a valid ISO range and filters on the call date', async () => {
    const res = await list('from=2026-09-01&to=2026-09-17');
    expect(res.status).toBe(200);
    const [sql, params] = pageCall();
    expect(sql).toContain("AT TIME ZONE 'Europe/London'");
    expect(params).toContain('2026-09-01');
    expect(params).toContain('2026-09-17');
  });
});

describe('GET /api/calls — sort', () => {
  it('rejects an unrecognised sort value', async () => {
    const res = await list('sort=random');
    expect(res.status).toBe(400);
  });

  it('sorts oldest-first on request', async () => {
    await list('sort=oldest');
    const [sql] = pageCall();
    expect(sql).toMatch(/ORDER BY[^;]*ASC/);
  });
});

describe('GET /api/calls/advisers', () => {
  function advisers(role: string): Promise<Response> {
    return fetch(`${baseUrl}/api/calls/advisers`, { headers: headers(role) });
  }

  it('is org-scoped', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: ADVISER_ID, name: 'Pat' }]);
    const res = await advisers('admin');
    expect(res.status).toBe(200);
    const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('FROM users u'));
    expect(call).toBeDefined();
    expect(call![1]).toEqual([ORG]);
    const body = await res.json();
    expect(body.data).toEqual([{ id: ADVISER_ID, name: 'Pat' }]);
  });

  it('is allowed for admin, supervisor and viewer', async () => {
    for (const role of ['admin', 'supervisor', 'viewer']) {
      const res = await advisers(role);
      expect(res.status).toBe(200);
    }
  });

  it('is refused for an adviser', async () => {
    const res = await advisers('adviser');
    expect(res.status).toBe(403);
  });

  it('is not shadowed by /:id', async () => {
    const res = await advisers('admin');
    expect(res.status).toBe(200);
    // If Express had matched /:id instead, this query (the advisers list)
    // would never have been issued at all.
    const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('FROM users u'));
    expect(call).toBeDefined();
  });
});
