import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// The dashboard endpoints. These pin the four things the page was getting
// wrong and could get wrong again:
//  1. a list row carries only what a list shows — /recent used to `SELECT c.*`,
//     shipping transcript_raw (2.7 MB on one measured call) and the customer's
//     phone number to render six columns;
//  2. a scored unit is counted ONCE, however many times it has been re-scored;
//  3. no verdict-derived figure ships to a score_only tenant, in any endpoint;
//  4. the pass rate divides by the units that carry a verdict, not by every
//     scored unit.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const ADVISER_ID = '00000000-0000-0000-0000-0000000000aa';

let server: Server;
let baseUrl: string;

function signToken(role: string, userId = ADVISER_ID): string {
  return jwt.sign({ userId, organizationId: ORG, role, mfa: true }, config.jwt.secret, {
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

let scope: 'sales_only' | 'over_threshold' | 'everything' = 'sales_only';
let scoreOnly = false;
// What the /summary aggregate rows resolve to, so a test can state the shape of
// the data rather than the shape of the SQL.
let scoreStatsRow: Record<string, string | null> = {
  avg_score: '88',
  pass_count: '176',
  verdict_count: '234',
  total_scored: '235',
};
let heldRow: Record<string, string | null> = { n: '130', oldest_days: '42' };

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
  scoreStatsRow = { avg_score: '88', pass_count: '176', verdict_count: '234', total_scored: '235' };
  heldRow = { n: '130', oldest_days: '42' };
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne)
    .mockReset()
    .mockImplementation((async (sql: string) => {
      const s = String(sql);
      if (s.includes('scoring_scope')) return scoringSettingsRow(scope);
      if (s.includes('feature_overrides'))
        return { plan: 'core', feature_overrides: scoreOnly ? { score_only: true } : null };
      if (s.includes('total_calls')) return { total_calls: '8848', scored_calls: '629' };
      if (s.includes('verdict_count')) return scoreStatsRow;
      if (s.includes('manual_review')) return heldRow;
      // Order matters: the leaderboard's unattributed count also selects FROM
      // journeys, inside its units CTE.
      if (s.includes('agent_id IS NULL')) return { n: '10' };
      if (s.includes('FROM journeys j')) return { n: '234' };
      return null;
    }) as never);
});

function headers(role: string, userId = ADVISER_ID) {
  return { Authorization: `Bearer ${signToken(role, userId)}` };
}

function get(path: string, role = 'admin', userId = ADVISER_ID): Promise<Response> {
  return fetch(`${baseUrl}/api/dashboard${path}`, { headers: headers(role, userId) });
}

/** Every SQL statement the request ran, from either client helper. */
function allSql(): string[] {
  return [...vi.mocked(query).mock.calls, ...vi.mocked(queryOne).mock.calls].map(([sql]) =>
    String(sql)
  );
}

describe('GET /api/dashboard/recent — what a row carries', () => {
  it('names its columns rather than selecting every column of calls', async () => {
    scope = 'everything';
    const res = await get('/recent');
    expect(res.status).toBe(200);
    const page = allSql().find((s) => s.includes('FROM calls c'));
    expect(page).toBeDefined();
    expect(page).not.toMatch(/\bc\.\*/);
  });

  it('never selects a transcript, a phone number or a storage pointer, in either mode', async () => {
    for (const s of ['everything', 'sales_only'] as const) {
      scope = s;
      vi.mocked(query).mockClear();
      vi.mocked(queryOne).mockClear();
      await get('/recent');
      for (const sql of allSql()) {
        for (const column of ['transcript_text', 'transcript_raw', 'file_key', 'phone_normalized']) {
          expect(sql).not.toContain(column);
        }
      }
    }
  });

  it('points at sales for a firm that scores sales, and calls for one that scores calls', async () => {
    scope = 'sales_only';
    expect((await (await get('/recent')).json()).mode).toBe('sales');
    scope = 'everything';
    expect((await (await get('/recent')).json()).mode).toBe('calls');
  });

  it('keeps an adviser to their own work', async () => {
    scope = 'everything';
    await get('/recent', 'adviser');
    const page = allSql().find((s) => s.includes('FROM calls c'));
    expect(page).toContain('c.agent_id = $2');
  });

  it('withholds the verdict from a score_only tenant', async () => {
    scoreOnly = true;
    scope = 'sales_only';
    vi.mocked(query).mockResolvedValue([
      {
        id: 'j1',
        customer_name: 'A Customer',
        agent_name: 'An Adviser',
        sale_date: '2026-09-01T00:00:00.000Z',
        status: 'scored',
        overall_score: 71,
        pass: false,
        feedback_status: 'not_fed_back',
        items_to_review: 0,
        items_failed: 2,
      },
    ] as never);
    const body = await (await get('/recent')).json();
    expect(body.data[0].pass).toBeNull();
    // The score itself is not a verdict and still ships.
    expect(body.data[0].overall_score).toBe(71);
  });
});

describe('GET /api/dashboard/summary', () => {
  it('divides the pass rate by the units that carry a verdict, not by every scored unit', async () => {
    const body = await (await get('/summary')).json();
    // 176 of 234, not 176 of 235: the 235th is still holding a checkpoint for a
    // person and has no verdict to be counted against.
    expect(body.units_with_verdict).toBe(234);
    expect(body.scored_units).toBe(235);
    expect(body.pass_rate).toBeCloseTo((176 / 234) * 100, 6);
  });

  it('counts the latest score per call, so a re-scored call is one unit', async () => {
    await get('/summary');
    const units = allSql().find((s) => s.includes('verdict_count'));
    expect(units).toContain('DISTINCT ON (cs.call_id)');
  });

  it('reports the checkpoints waiting on a person, and the age of the oldest', async () => {
    const body = await (await get('/summary')).json();
    expect(body.items_to_review).toBe(130);
    expect(body.oldest_review_days).toBe(42);
  });

  it('says which scope it applied: an adviser sees their own, a supervisor the firm', async () => {
    expect((await (await get('/summary', 'adviser')).json()).scope).toBe('own');
    expect((await (await get('/summary', 'supervisor')).json()).scope).toBe('organisation');
    expect((await (await get('/summary', 'admin')).json()).scope).toBe('organisation');
    expect((await (await get('/summary?agent_id=' + ADVISER_ID)).json()).scope).toBe('adviser');
  });

  it('ships no pass rate at all to a score_only tenant', async () => {
    scoreOnly = true;
    const body = await (await get('/summary')).json();
    expect(body.pass_rate).toBeNull();
    expect(body.units_with_verdict).toBeNull();
    // The score, and what it is measured over, are not verdicts.
    expect(body.average_score).toBe(88);
    expect(body.items_to_review).toBe(130);
  });
});

describe('GET /api/dashboard/agent-leaderboard', () => {
  beforeEach(() => {
    vi.mocked(query).mockResolvedValue([
      { id: 'u1', name: 'An Adviser', scored_units: '81', average_score: '86.5', pass_rate: '77.7' },
    ] as never);
  });

  it('counts the units behind the average, and says how many are credited to nobody', async () => {
    const body = await (await get('/agent-leaderboard')).json();
    expect(body.data[0].scored_units).toBe(81);
    expect(body.unattributed_units).toBe(10);
  });

  it('keeps units with no adviser in the population rather than dropping them', async () => {
    await get('/agent-leaderboard');
    const units = allSql().find((s) => s.includes('journey_calls jc'));
    expect(units).toBeDefined();
    expect(units).not.toContain('wc.agent_id IS NOT NULL');
    expect(units).not.toContain('c.agent_id IS NOT NULL');
  });

  it('withholds a per-adviser pass rate from a score_only tenant', async () => {
    scoreOnly = true;
    const body = await (await get('/agent-leaderboard')).json();
    expect(body.data[0].pass_rate).toBeNull();
    expect(body.data[0].average_score).toBe(86.5);
  });

  it('admits a supervisor and a viewer, and refuses an adviser', async () => {
    expect((await get('/agent-leaderboard', 'supervisor')).status).toBe(200);
    expect((await get('/agent-leaderboard', 'viewer')).status).toBe(200);
    expect((await get('/agent-leaderboard', 'adviser')).status).toBe(403);
  });
});

describe('GET /api/dashboard/trends/scores-over-time', () => {
  it('counts the latest score per call, so a re-scored call is not two points', async () => {
    await get('/trends/scores-over-time?weeks=12');
    const series = allSql().find((s) => s.includes('week_start'));
    expect(series).toContain('DISTINCT ON (cs.call_id)');
  });

  it('dates both halves by when the conversation happened, not when it was scored', async () => {
    await get('/trends/scores-over-time?weeks=12');
    const series = allSql().find((s) => s.includes('week_start'))!;
    expect(series).toContain("COALESCE(c.call_date, c.created_at)");
    // scored_at moves a sale to whichever week it was last re-scored in.
    expect(series).not.toContain('j.scored_at');
  });

  it('returns every week in the window, not only the weeks holding a score', async () => {
    vi.mocked(query).mockResolvedValue([] as never);
    const body = await (await get('/trends/scores-over-time?weeks=12')).json();
    expect(body.data).toHaveLength(12);
    expect(body.data.every((p: { unit_count: number }) => p.unit_count === 0)).toBe(true);
    // Consecutive Mondays, oldest first.
    const gaps = body.data
      .slice(1)
      .map(
        (p: { week_start: string }, i: number) =>
          (Date.parse(p.week_start) - Date.parse(body.data[i].week_start)) / 86_400_000
      );
    expect(new Set(gaps)).toEqual(new Set([7]));
  });

  it('ships no weekly pass rate to a score_only tenant', async () => {
    scoreOnly = true;
    vi.mocked(query).mockResolvedValue([
      {
        week_start: '2026-09-14',
        unit_count: '4',
        avg_score: '91',
        pass_count: '3',
        verdict_count: '4',
      },
    ] as never);
    const body = await (await get('/trends/scores-over-time?weeks=12')).json();
    const week = body.data.find((p: { week_start: string }) => p.week_start === '2026-09-14');
    expect(week.avg_score).toBe(91);
    expect(week.pass_rate).toBeNull();
  });
});

describe('GET /api/dashboard/trends/by-scorecard', () => {
  it('counts scored units, not scores — a unit scored without an overall score still counts', async () => {
    await get('/trends/by-scorecard');
    const sql = allSql().find((s) => s.includes('breach_counts'))!;
    expect(sql).toContain('COUNT(*)::text as unit_count');
    expect(sql).not.toContain('COUNT(u.score)');
  });

  it('qualifies "critical": open on the tile\'s definition, alongside the total ever raised', async () => {
    vi.mocked(query).mockResolvedValue([
      {
        id: 'sc1',
        name: 'Protection QA',
        unit_count: '234',
        avg_score: '88',
        flags_per_unit: '2.5',
        critical_open: '6',
        critical_total: '148',
      },
    ] as never);
    const sql = await get('/trends/by-scorecard');
    const body = await sql.json();
    expect(body.data[0].critical_open).toBe(6);
    expect(body.data[0].critical_total).toBe(148);
    const q = allSql().find((s) => s.includes('breach_counts'))!;
    expect(q).toContain("b.status NOT IN ('resolved', 'noted')");
  });
});
