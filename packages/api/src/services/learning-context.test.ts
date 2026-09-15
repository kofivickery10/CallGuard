import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query } from '../db/client.js';
import { getLearningContext } from './learning-context.js';

// The learning context is what a firm's own history puts in front of the scoring
// model: its reviewers' corrections, and the coaching an adviser has already had.
// These tests hold the two ways that history went missing.
//
// No database here. The mocked query stands in for score_corrections by
// honouring whichever cap the SQL asks for (a per-criterion LIMIT in a LATERAL
// lookup, or one global LIMIT), so the test fails against the old single
// LIMIT 50 query and passes against the per-criterion one.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const AGENT = '00000000-0000-0000-0000-0000000000aa';
const RARE = '00000000-0000-0000-0000-000000000001';
const BUSY = '00000000-0000-0000-0000-000000000002';

interface CorrectionRow {
  organization_id: string;
  scorecard_item_id: string;
  corrected_pass: boolean | null;
  reason: string | null;
  transcript_excerpt: string | null;
  created_at: string;
}

function day(n: number): string {
  return new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
}

function fakeCorrections(sql: string, params: unknown[], table: CorrectionRow[]) {
  const [org, itemIds] = params as [string, string[]];
  const skipNa = /corrected_pass IS NOT NULL/.test(sql);
  const eligible = table
    .filter((r) => r.organization_id === org && itemIds.includes(r.scorecard_item_id))
    .filter((r) => !skipNa || r.corrected_pass !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (/CROSS JOIN LATERAL/.test(sql) && /LIMIT \$3/.test(sql)) {
    const perItem = params[2] as number;
    return itemIds.flatMap((id) => eligible.filter((r) => r.scorecard_item_id === id).slice(0, perItem));
  }
  const global = sql.match(/LIMIT (\d+)/);
  return global ? eligible.slice(0, Number(global[1])) : eligible;
}

function coaching(summary: string) {
  return { summary, strengths: [], improvements: [], next_actions: [] };
}

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([]);
});

describe('getLearningContext — calibration examples per criterion', () => {
  it('gives a rarely-corrected criterion its examples even behind 50 newer corrections on another', async () => {
    const table: CorrectionRow[] = [
      // Six old corrections on the rare criterion, the newest being N/A.
      ...Array.from({ length: 5 }, (_, i) => ({
        organization_id: ORG,
        scorecard_item_id: RARE,
        corrected_pass: i % 2 === 0,
        reason: `rare ${i + 1}`,
        transcript_excerpt: null,
        created_at: day(i),
      })),
      {
        organization_id: ORG,
        scorecard_item_id: RARE,
        corrected_pass: null,
        reason: 'Not applicable to this sale',
        transcript_excerpt: null,
        created_at: day(6),
      },
      // Sixty newer corrections on a criterion the queue sees every day.
      ...Array.from({ length: 60 }, (_, i) => ({
        organization_id: ORG,
        scorecard_item_id: BUSY,
        corrected_pass: false,
        reason: `busy ${i + 1}`,
        transcript_excerpt: null,
        created_at: day(100 + i),
      })),
    ];
    vi.mocked(query).mockImplementation((async (sql: string, params: unknown[]) =>
      sql.includes('score_corrections') ? fakeCorrections(sql, params, table) : []) as never);

    const ctx = await getLearningContext(ORG, 'enterprise', [RARE, BUSY], null);

    const rare = ctx!.correctionsByItem[RARE]!;
    expect(rare).toHaveLength(5);
    // Most recent first, and the N/A ruling neither appears nor takes a slot.
    expect(rare.map((c) => c.reason)).toEqual(['rare 5', 'rare 4', 'rare 3', 'rare 2', 'rare 1']);
    expect(rare.every((c) => c.corrected_pass !== null)).toBe(true);

    const busy = ctx!.correctionsByItem[BUSY]!;
    expect(busy).toHaveLength(5);
    expect(busy[0]!.reason).toBe('busy 60');
  });

  it('keeps a not-applicable ruling out even if the database returns one', async () => {
    vi.mocked(query).mockImplementation((async (sql: string) =>
      sql.includes('score_corrections')
        ? [
            { scorecard_item_id: RARE, corrected_pass: null, reason: 'Not applicable to this sale', transcript_excerpt: null },
            { scorecard_item_id: RARE, corrected_pass: false, reason: 'Not done', transcript_excerpt: null },
          ]
        : []) as never);

    const ctx = await getLearningContext(ORG, 'enterprise', [RARE], null);
    expect(ctx!.correctionsByItem[RARE]).toEqual([
      { corrected_pass: false, reason: 'Not done', transcript_excerpt: null },
    ]);
  });
});

describe('getLearningContext — prior coaching from calls and sales', () => {
  it('combines call and sale coaching, most recent first, capped at three', async () => {
    let saleParams: unknown[] = [];
    let saleSql = '';
    vi.mocked(query).mockImplementation((async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM call_scores')) {
        return [
          { coaching: coaching('call, day 40'), created_at: day(40) },
          { coaching: coaching('call, day 10'), created_at: day(10) },
        ];
      }
      if (sql.includes('JOIN journeys j')) {
        saleSql = sql;
        saleParams = params;
        return [
          { coaching: coaching('sale, day 50'), created_at: day(50) },
          { coaching: coaching('sale, day 30'), created_at: day(30) },
          { coaching: coaching('sale, day 20'), created_at: day(20) },
        ];
      }
      return [];
    }) as never);

    const ctx = await getLearningContext(ORG, 'enterprise', [], AGENT, { excludeJourneyId: 'journey-now' });

    expect(ctx!.priorCoaching.map((p) => p.coaching.summary)).toEqual([
      'sale, day 50',
      'call, day 40',
      'sale, day 30',
    ]);
    // Attributed to the wrap-up adviser, and never the sale being scored.
    expect(saleParams).toEqual([AGENT, ORG, 'journey-now']);
    expect(saleSql).toMatch(/jc2\.role = 'wrap_up'/);
    expect(saleSql).toMatch(/j\.id <> \$3::uuid/);
  });

  it('gives a sales-only firm its coaching memory from journeys alone', async () => {
    vi.mocked(query).mockImplementation((async (sql: string) =>
      sql.includes('JOIN journeys j')
        ? [{ coaching: coaching('sale brief'), created_at: day(5) }]
        : []) as never);

    const ctx = await getLearningContext(ORG, 'enterprise', [], AGENT);
    expect(ctx!.priorCoaching).toHaveLength(1);
    expect(ctx!.priorCoaching[0]!.coaching.summary).toBe('sale brief');
  });

  it('reads no coaching without an adviser', async () => {
    const ctx = await getLearningContext(ORG, 'enterprise', [], null);
    expect(ctx!.priorCoaching).toEqual([]);
    const sqls = vi.mocked(query).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('call_scores') || s.includes('JOIN journeys j'))).toBe(false);
  });
});
