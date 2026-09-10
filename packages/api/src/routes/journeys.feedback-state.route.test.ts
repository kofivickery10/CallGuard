import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// The fourth state on the sales list (CG-27): a sale the adviser acknowledged
// that still owes the firm an answer.
//
// The state is a SUBDIVISION of 'acknowledged', not a state beside it, and the
// branch order in the CASE is the whole correctness argument: a sale with an
// unconfirmed round stays 'awaiting' even when an older round left an ask open,
// because chasing an answer from somebody who has not acknowledged is chasing
// the wrong thing. These tests hold that ordering and the tab counts that have
// to sum to the list.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';

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

function list(qs = '') {
  return fetch(`${baseUrl}/api/journeys?${qs}`, {
    headers: { Authorization: `Bearer ${signToken()}` },
  });
}

/** The first call whose SQL matches, with its params. */
function callMatching(fragment: string) {
  const call = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes(fragment));
  if (!call) throw new Error(`no query contained: ${fragment}`);
  return { sql: String(call[0]), params: call[1] as unknown[] };
}

describe('GET /api/journeys — the awaiting-outcome state', () => {
  it("puts the outcome branch after the acknowledgement branch, so an unconfirmed round still reads as 'awaiting'", async () => {
    await list();
    const { sql } = callMatching('awaiting_remediation');
    const awaiting = sql.indexOf("THEN 'awaiting'");
    const remediation = sql.indexOf("THEN 'awaiting_remediation'");
    const acknowledged = sql.indexOf("THEN 'acknowledged'");
    expect(awaiting).toBeGreaterThan(-1);
    expect(remediation).toBeGreaterThan(awaiting);
    expect(acknowledged).toBeGreaterThan(remediation);
  });

  it('counts a sale as owing something only where the firm set a step and the adviser acknowledged', async () => {
    await list();
    const { sql } = callMatching('awaiting_remediation');
    expect(sql).toContain('remediation_guidance IS NOT NULL');
    expect(sql).toContain('remediation_outcome IS NULL');
    expect(sql).toContain('f.confirmed_at IS NOT NULL');
  });

  it('accepts the new state as a filter', async () => {
    await list('feedback=awaiting_remediation');
    // The filter is applied to the list query, so its value reaches the params.
    const { params } = callMatching('FROM journeys j');
    expect(params).toContain('awaiting_remediation');
  });

  it('ignores a feedback state that is not one of the four', async () => {
    await list('feedback=made_up');
    const { params } = callMatching('FROM journeys j');
    expect(params).not.toContain('made_up');
  });

  it('reports the new tab count and its own age, measured from acknowledgement', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (String(sql).includes('GROUP BY 1') && String(sql).includes('oldest_remediation_days')) {
        return [
          { feedback_status: 'awaiting', count: '2', oldest_awaiting_days: '9', oldest_remediation_days: null },
          {
            feedback_status: 'awaiting_remediation',
            count: '3',
            oldest_awaiting_days: null,
            oldest_remediation_days: '21',
          },
          { feedback_status: 'acknowledged', count: '5', oldest_awaiting_days: null, oldest_remediation_days: null },
        ] as never;
      }
      return [] as never;
    });

    const body = await (await list()).json();
    expect(body.feedback_counts).toMatchObject({
      awaiting: 2,
      awaiting_remediation: 3,
      acknowledged: 5,
      not_fed_back: 0,
      oldest_awaiting_days: 9,
      oldest_remediation_days: 21,
    });
  });

  it('reports no remediation age when nothing is outstanding, rather than 0 days', async () => {
    const body = await (await list()).json();
    expect(body.feedback_counts.awaiting_remediation).toBe(0);
    expect(body.feedback_counts.oldest_remediation_days).toBeNull();
  });
});
