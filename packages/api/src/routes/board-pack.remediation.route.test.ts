import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// The remediation section of GET /api/board-pack (CG-26) — whether what was
// asked of advisers actually got done.
//
// Its own file rather than more cases in board-pack.route.test.ts, which is
// deliberately built with no database mock at all: every test there is answered
// by auth or by query-param validation before the route reaches a query, and
// that is the property the file exists to hold. This one needs the DB mocked,
// so it keeps its own.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const PERIOD = 'from=2026-07-01&to=2026-07-31';

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

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue(null);
});

function get(extra = '') {
  return fetch(`${baseUrl}/api/board-pack?${PERIOD}${extra}`, {
    headers: { Authorization: `Bearer ${signToken()}` },
  });
}

describe('GET /api/board-pack — remediation', () => {
  it('reports what was fed back, what was answered, and what is still open', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM journey_feedback_items fi') && sql.includes('with_guidance')) {
        return { total: '18', with_guidance: '11' } as never;
      }
      if (sql.includes('DISTINCT ON (COALESCE(jf.journey_id, jf.call_id), fi.scorecard_item_id)')) {
        return { n: '4' } as never;
      }
      return null;
    });
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('fi.remediation_outcome AS outcome')) {
        return [
          { outcome: 'done', count: '9' },
          { outcome: 'customer_unreachable', count: '2' },
        ] as never;
      }
      return [] as never;
    });

    const body = await (await get()).json();
    expect(body.remediation.findings_fed_back).toBe(18);
    expect(body.remediation.fed_back_with_guidance).toBe(11);
    expect(body.remediation.outcomes_recorded).toEqual([
      { outcome: 'done', count: 9 },
      { outcome: 'customer_unreachable', count: 2 },
    ]);
    expect(body.remediation.awaiting_outcome).toBe(4);
  });

  it('is all zeroes, not absent, on a firm that has never fed anything back', async () => {
    const body = await (await get()).json();
    expect(body.remediation).toMatchObject({
      findings_fed_back: 0,
      fed_back_with_guidance: 0,
      outcomes_recorded: [],
      awaiting_outcome: 0,
    });
  });

  it('warns against reading the three figures as a completion rate, and says the answers are self-attested', async () => {
    const body = await (await get()).json();
    expect(body.remediation.note).toMatch(/not verified by CallGuard/i);
    expect(body.remediation.note).toMatch(/must not be divided/i);
    expect(body.methodology.join(' ')).toMatch(/self-attested/i);
  });

  it('counts only acknowledged findings as awaiting an answer — an unacknowledged one is a feedback backlog, and cannot be answered anyway', async () => {
    let awaitingSql = '';
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('DISTINCT ON (COALESCE(jf.journey_id, jf.call_id), fi.scorecard_item_id)')) awaitingSql = sql;
      return null;
    });

    await get();
    expect(awaitingSql).toContain('jf.confirmed_at IS NOT NULL');
    // A stock, not a flow: it must not be bounded to the reporting period, or
    // it would answer a different question from the one its label asks.
    expect(awaitingSql).not.toContain('::date');
    // One outstanding ask per checkpoint per subject. A sale (or call) fed back
    // twice with the same checkpoint unanswered both times is one thing
    // outstanding, and the answer that counts is the one against the most
    // recent ask.
    expect(awaitingSql).toContain(
      'ORDER BY COALESCE(jf.journey_id, jf.call_id), fi.scorecard_item_id, jf.sent_at DESC'
    );
  });

  it('narrows every remediation figure to the product filter, through the sale the feedback belongs to', async () => {
    const PRODUCT = '00000000-0000-0000-0000-0000000000ee';
    const seen: string[] = [];
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM products')) return { id: PRODUCT, name: 'Life cover' } as never;
      if (sql.includes('FROM journey_feedback_items fi')) seen.push(sql);
      return null;
    });
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('fi.remediation_outcome AS outcome')) seen.push(sql);
      return [] as never;
    });

    await get(`&product=${PRODUCT}`);
    expect(seen).toHaveLength(3);
    for (const sql of seen) {
      expect(sql).toContain('jp.journey_id = jf.journey_id');
    }
  });

  it('counts call rounds as well as sale rounds across the organisation, grouped per call rather than into one', async () => {
    // A firm whose setting is not sales_only feeds back almost entirely on
    // calls. Filtering to sale rounds reported "0 findings fed back" beside a
    // non-empty backlog; grouping on jf.journey_id folded every call round
    // (journey_id NULL) into one group per checkpoint.
    const seen: string[] = [];
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM journey_feedback_items fi')) seen.push(sql);
      return null;
    });
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('fi.remediation_outcome AS outcome')) seen.push(sql);
      return [] as never;
    });

    const body = await (await get()).json();

    expect(seen).toHaveLength(3);
    for (const sql of seen) {
      expect(sql).not.toContain('jf.journey_id IS NOT NULL');
      expect(sql).not.toContain('DISTINCT ON (jf.journey_id');
      // No product filter, so nothing narrows through the sale either.
      expect(sql).not.toContain('journey_products');
    }
    expect(body.remediation.note).toMatch(/feedback on sales and feedback on calls/);
    expect(body.remediation.note).not.toMatch(/Filtered to a product/);
  });

  it('says that call rounds drop out under a product filter, since calls carry no product', async () => {
    const PRODUCT = '00000000-0000-0000-0000-0000000000ee';
    vi.mocked(queryOne).mockImplementation(async (sql: string) =>
      sql.includes('FROM products') ? ({ id: PRODUCT, name: 'Life cover' } as never) : null
    );

    const body = await (await get(`&product=${PRODUCT}`)).json();

    expect(body.remediation.note).toMatch(
      /Filtered to a product: calls carry no product, so feedback given on calls is left out of all three figures here\./
    );
    // And the pack-wide scope note does not claim call-level remediation is
    // counted for the whole organisation, as it does for other call figures.
    expect(body.product_scope_note).toMatch(/Remediation is the exception/);
  });
});
