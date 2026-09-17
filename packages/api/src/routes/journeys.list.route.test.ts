import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { workStateSql, WORK_STATE_ON_JOURNEY } from './journeys.js';
import { JOURNEY_WORK_TABS } from '@callguard/shared';

// The sales list, rebuilt around what a sale is WAITING FOR (CG-40 design
// review). The register it replaced was ordered newest-first with no sort, no
// search and nothing in the URL, and — the defect that mattered — a row could
// not say whether it needed attention: a checkpoint held for a person is left
// out of the score entirely, so a sale reading 100% could hold four unreviewed
// checkpoints, two of them critical. 130 such checkpoints existed at the main
// client, invisible on this screen.
//
// These tests hold the things a reader has to be able to trust: that a tab
// means what its count says, that the findings on a row are read live off the
// checkpoints rather than off a frozen score run, that the outstanding strip is
// a firm-wide figure rather than a filtered one, and that a tenant who is never
// shown a verdict is never sent one.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000cc';

let server: Server;
let baseUrl: string;

function signToken(role = 'supervisor'): string {
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

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue({ count: '0' } as never);
});

function list(qs = '', role = 'supervisor') {
  return fetch(`${baseUrl}/api/journeys?${qs}`, {
    headers: { Authorization: `Bearer ${signToken(role)}` },
  });
}

/** The first `query` call whose SQL matches, with its params. */
function callMatching(fragment: string) {
  const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes(fragment));
  if (!call) throw new Error(`no query contained: ${fragment}`);
  return { sql: String(call[0]), params: call[1] as unknown[] };
}

/** The first `queryOne` call whose SQL matches. */
function oneMatching(fragment: string) {
  const call = vi.mocked(queryOne).mock.calls.find(([sql]) => String(sql).includes(fragment));
  if (!call) throw new Error(`no single-row query contained: ${fragment}`);
  return { sql: String(call[0]), params: call[1] as unknown[] };
}

/** The list query itself — the only one that reads a page of rows. */
const listQuery = () => callMatching('AS agent_count');

// ── What each tab means ──────────────────────────────────────────────────────

describe('work-state predicates', () => {
  const sql = (tab: Parameters<typeof workStateSql>[0]) =>
    workStateSql(tab, WORK_STATE_ON_JOURNEY);

  it('puts a scored sale in needs_me for a held checkpoint, or for findings nobody has sent', () => {
    const needsMe = sql('needs_me');
    expect(needsMe).toContain("j.status = 'scored'");
    // A checkpoint still held for a person…
    expect(needsMe).toContain("ris.result = 'manual_review'");
    // …or a failed checkpoint that has not been fed back.
    expect(needsMe).toContain("fis.result = 'fail'");
    expect(needsMe).toContain("= 'not_fed_back'");
  });

  it('leaves retired checkpoints out, so a tab agrees with the review queue', () => {
    expect(sql('needs_me')).toContain('rsi.archived_at IS NULL');
    expect(sql('needs_me')).toContain('fsi.archived_at IS NULL');
  });

  it('reads the two waits straight off the feedback state', () => {
    expect(sql('awaiting_adviser')).toContain("= 'awaiting'");
    expect(sql('awaiting_outcome')).toContain("= 'awaiting_remediation'");
  });

  it("keeps a sale out of done while a checkpoint is still held, even once it is acknowledged", () => {
    const done = sql('done');
    expect(done).toContain("j.status = 'scored'");
    expect(done).toContain("= 'acknowledged'");
    expect(done).toContain('NOT EXISTS');
    expect(done).toContain("ris.result = 'manual_review'");
  });

  // NTU sales are deliberately never scored (migration 071); the old tab called
  // them "Not taken up" and meant j.status = 'skipped'. Same meaning kept.
  it('keeps the old meaning of not taken up', () => {
    expect(sql('not_taken_up')).toBe("j.status = 'skipped'");
  });

  // A red "Failed" on a compliance register reads as "this sale failed". It
  // means the scoring run broke, so it sits with the other in-flight states.
  it('puts pending, scoring and failed together under processing', () => {
    expect(sql('processing')).toBe("j.status IN ('pending', 'scoring', 'failed')");
  });

  it('adds nothing for all', () => {
    expect(sql('all')).toBe('TRUE');
  });
});

describe('GET /api/journeys — tabs and their counts', () => {
  it('applies the tab to the list as one more filter', async () => {
    await list('tab=awaiting_adviser');
    expect(listQuery().sql).toContain(workStateSql('awaiting_adviser', WORK_STATE_ON_JOURNEY));
  });

  it('refuses a tab it does not have, rather than quietly returning everything', async () => {
    const res = await list('tab=made_up');
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('Unknown tab');
    // Nothing was read for a request that could not be answered.
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('counts every tab under the OTHER filters but not under itself', async () => {
    await list('tab=done&branch=on_risk');
    const counts = oneMatching('tab_needs_me');
    // The branch filter applies to the count…
    expect(counts.params).toContain('on_risk');
    // …and the tab being counted does not, or each tab would report the
    // number of sales in the tab you are already looking at.
    expect(counts.sql).not.toContain(workStateSql('done', WORK_STATE_ON_JOURNEY));
    for (const tab of JOURNEY_WORK_TABS) {
      expect(counts.sql).toContain(`AS tab_${tab}`);
    }
  });

  it('computes each fact once per row and filters the tabs over it', async () => {
    await list();
    const { sql } = oneMatching('tab_needs_me');
    expect(sql).toContain('AS feedback_status');
    expect(sql).toContain('AS has_unreviewed');
    expect(sql).toContain('AS has_findings');
    expect(sql).toContain('COUNT(*) FILTER (WHERE');
  });

  it('reports the counts it read', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (String(sql).includes('tab_needs_me')) {
        return {
          tab_needs_me: '24',
          tab_awaiting_adviser: '6',
          tab_awaiting_outcome: '0',
          tab_done: '70',
          tab_not_taken_up: '3',
          tab_processing: '1',
          tab_all: '104',
        } as never;
      }
      return { count: '104' } as never;
    });

    const body = await (await list()).json();
    expect(body.tab_counts).toEqual({
      needs_me: 24,
      awaiting_adviser: 6,
      awaiting_outcome: 0,
      done: 70,
      not_taken_up: 3,
      processing: 1,
      all: 104,
    });
    expect(body.total).toBe(104);
  });
});

// ── Search ───────────────────────────────────────────────────────────────────

describe('GET /api/journeys — searching by customer', () => {
  it('matches a name against the sale’s customer', async () => {
    await list('q=Kathryn');
    const { sql, params } = listQuery();
    expect(sql).toContain('qc.name ILIKE');
    expect(sql).toContain('qc.phone_normalized ILIKE');
    expect(params).toContain('%Kathryn%');
  });

  // A raw match on "07700" would never find "+447700…", so phone-ish input is
  // normalised to the stored form first — as the customer search does.
  it('normalises a typed number to the stored E.164 form', async () => {
    await list('q=07700%20900123');
    const { params } = listQuery();
    expect(params).toContain('%+447700900123%');
  });

  it('narrows the tab counts too, so a count still says what clicking returns', async () => {
    await list('q=Kathryn');
    expect(oneMatching('tab_needs_me').params).toContain('%Kathryn%');
  });

  it('ignores an empty search', async () => {
    await list('q=%20%20');
    expect(listQuery().sql).not.toContain('qc.name ILIKE');
  });
});

// ── Sorting ──────────────────────────────────────────────────────────────────

describe('GET /api/journeys — sorting', () => {
  it('orders by when the sale happened unless asked otherwise', async () => {
    await list();
    expect(listQuery().sql).toContain('ORDER BY sale_date DESC');
  });

  it('orders by score, and by how long the next step has waited', async () => {
    await list('sort=score');
    expect(listQuery().sql).toContain('ORDER BY overall_score DESC');

    vi.mocked(query).mockClear();
    await list('sort=waiting');
    expect(listQuery().sql).toContain('ORDER BY waiting_days DESC');
  });

  it('turns the order round on request', async () => {
    await list('sort=score&dir=asc');
    expect(listQuery().sql).toContain('ORDER BY overall_score ASC');
  });

  // Sorting on a second copy of the expression could order the list by
  // something other than the number on screen, so the sort names the column
  // the row already carries.
  it('sorts on the row’s own waiting figure', async () => {
    await list('sort=waiting');
    expect(listQuery().sql).toContain('AS waiting_days');
  });

  it('keeps the sale date as the tie-break, so a re-score never moves a row', async () => {
    await list('sort=score');
    expect(listQuery().sql).toContain('sale_date DESC, j.created_at DESC');
  });

  it('refuses a sort it does not have', async () => {
    const res = await list('sort=customer_name');
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('Unknown sort');
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('refuses a direction it does not have', async () => {
    const res = await list('sort=score&dir=sideways');
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('Unknown sort direction');
  });
});

// ── What a row says it found ─────────────────────────────────────────────────

describe('GET /api/journeys — the findings on a row', () => {
  const journeyRow = {
    id: '00000000-0000-0000-0000-00000000f001',
    organization_id: ORG,
    status: 'scored',
    overall_score: '100.00',
    pass: true,
    feedback_status: 'not_fed_back',
    agent_count: 1,
  };

  function withRow(items: Array<Record<string, unknown>>) {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (String(sql).includes('AS agent_count')) return [journeyRow] as never;
      if (String(sql).includes('FROM journey_item_scores jis')) return items as never;
      return [] as never;
    });
  }

  // The defect this column exists for: a held checkpoint is left out of the
  // score, so the sale reads 100% while two critical checkpoints wait on a
  // person. The row must never read as clean.
  it('reports checkpoints held for a person on a sale scoring 100%', async () => {
    withRow([
      { journey_id: journeyRow.id, result: 'manual_review', severity: 'critical', weight: '2.0' },
      { journey_id: journeyRow.id, result: 'manual_review', severity: null, weight: '1.0' },
    ]);
    const body = await (await list()).json();
    expect(body.data[0]).toMatchObject({
      overall_score: '100.00',
      items_failed: 0,
      items_to_review: 2,
      worst_failed_severity: null,
    });
  });

  it('counts failures and leads with the worst severity', async () => {
    withRow([
      { journey_id: journeyRow.id, result: 'fail', severity: 'medium', weight: '1.0' },
      { journey_id: journeyRow.id, result: 'fail', severity: 'critical', weight: '1.0' },
      { journey_id: journeyRow.id, result: 'manual_review', severity: null, weight: '1.0' },
    ]);
    const body = await (await list()).json();
    expect(body.data[0]).toMatchObject({
      items_failed: 2,
      items_to_review: 1,
      worst_failed_severity: 'critical',
    });
  });

  // A scorecard need not set a severity per checkpoint: scoring, the pass gate
  // and the breach register all fall back to the item's weight, so a row must
  // not show "no severity" for a failure the rest of the system calls critical.
  it('falls back to the checkpoint’s weight where no severity is set', async () => {
    withRow([{ journey_id: journeyRow.id, result: 'fail', severity: null, weight: '2.0' }]);
    const body = await (await list()).json();
    expect(body.data[0].worst_failed_severity).toBe('critical');
  });

  it('reads them live off the checkpoints, not off the frozen score run', async () => {
    withRow([]);
    await list();
    const { sql } = callMatching('FROM journey_item_scores jis');
    expect(sql).toContain("jis.result IN ('fail', 'manual_review')");
    expect(sql).toContain('si.archived_at IS NULL');
    // Only this page's sales, not the whole firm's checkpoints.
    expect(sql).toContain('jis.journey_id = ANY($1::uuid[])');
    expect(sql).not.toContain('journey_score_runs');
  });

  it('says nothing was found rather than nothing at all', async () => {
    withRow([]);
    const body = await (await list()).json();
    expect(body.data[0]).toMatchObject({ items_failed: 0, items_to_review: 0, worst_failed_severity: null });
  });

  it('asks nothing when the page is empty', async () => {
    await list();
    expect(
      vi.mocked(query).mock.calls.some(([sql]) => String(sql).includes('FROM journey_item_scores jis'))
    ).toBe(false);
  });
});

// ── The outstanding strip ────────────────────────────────────────────────────

describe('GET /api/journeys — what is outstanding across the firm', () => {
  beforeEach(() => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (String(sql).includes('oldest_awaiting_days')) {
        return [
          { feedback_status: 'awaiting', count: '6', oldest_awaiting_days: '37', oldest_remediation_days: null },
          { feedback_status: 'acknowledged', count: '70', oldest_awaiting_days: null, oldest_remediation_days: null },
        ] as never;
      }
      return [] as never;
    });
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (String(sql).includes('COUNT(DISTINCT jis.journey_id)')) {
        return { checkpoints: '130', sales: '24' } as never;
      }
      return { count: '0' } as never;
    });
  });

  it('reports the confirmation backlog, the outcome backlog and the review backlog', async () => {
    const body = await (await list()).json();
    expect(body.outstanding).toEqual({
      awaiting_confirmation: 6,
      oldest_awaiting_days: 37,
      awaiting_outcome: 0,
      oldest_outcome_days: null,
      review_checkpoints: 130,
      review_sales: 24,
    });
  });

  // The two banners this replaced were counted under the active filter, so each
  // vanished on the very click that filtered to it.
  it('counts across every sale, not under the list’s filters', async () => {
    await list('tab=done&branch=on_risk&q=Kathryn');
    expect(callMatching('oldest_awaiting_days').params).toEqual([ORG]);
    expect(oneMatching('COUNT(DISTINCT jis.journey_id)').params).toEqual([ORG]);
  });

  // The customer profile reads this endpoint for one person's sales. Neither
  // "how many sales in the firm need me" nor a firm-wide backlog answers that
  // question, and both are org-wide scans — so that page does not pay for them.
  it('leaves the register’s summary out of a request for one customer', async () => {
    const body = await (await list('customer_id=00000000-0000-0000-0000-0000000000c1')).json();
    expect(body.tab_counts).toBeUndefined();
    expect(body.outstanding).toBeUndefined();
    expect(body.feedback_counts).toBeUndefined();
    expect(
      vi.mocked(query).mock.calls.some(([sql]) => String(sql).includes('oldest_awaiting_days'))
    ).toBe(false);
    expect(
      vi.mocked(queryOne).mock.calls.some(([sql]) => String(sql).includes('tab_needs_me'))
    ).toBe(false);
  });

  it('counts only checkpoints a reviewer could actually rule on', async () => {
    await list();
    const { sql } = oneMatching('COUNT(DISTINCT jis.journey_id)');
    expect(sql).toContain("jis.result = 'manual_review'");
    expect(sql).toContain('si.archived_at IS NULL');
    expect(sql).toContain('j.organization_id = $1');
  });
});

// ── Score-only tenants ───────────────────────────────────────────────────────

// score_only is a display mode, but the value has to be gated too: the client
// hiding a badge is not the same as the verdict never being sent (the precedent
// is routes/share.ts, and services/tenant-settings.ts says so in as many words).
describe('GET /api/journeys — a tenant that is never shown a verdict', () => {
  beforeEach(() => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM organizations')) {
        return { plan: 'enterprise', feature_overrides: { score_only: true } } as never;
      }
      return { count: '1' } as never;
    });
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (String(sql).includes('AS agent_count')) {
        return [
          {
            id: '00000000-0000-0000-0000-00000000f002',
            status: 'scored',
            overall_score: '64.00',
            pass: false,
            agent_count: 1,
          },
        ] as never;
      }
      return [] as never;
    });
  });

  it('withholds the pass/fail verdict from the row', async () => {
    const body = await (await list()).json();
    expect(body.data[0].pass).toBeNull();
    // The score itself is theirs to see — it is the verdict that is withheld.
    expect(body.data[0].overall_score).toBe('64.00');
  });

  it('will not filter by a verdict it does not disclose', async () => {
    await list('result=fail');
    expect(listQuery().sql).not.toContain('j.pass IS FALSE');
  });
});
