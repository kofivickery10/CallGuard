import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/client.js';

// GET /api/remediations (CG-27) — what has been asked of advisers and not
// closed, grouped by whoever owes the answer.
//
// The definition is what these tests are really holding. "Open" here is
// narrower than "has no outcome", and every narrowing has a failure behind it:
// unacknowledged rounds belong to a different backlog, a checkpoint with no
// guidance has no step to close, and only the most recent ask on a checkpoint
// counts. Get any of those wrong and the screen is either a graveyard nobody can
// work down or a queue that quietly loses things.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
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
});

// The backlog query, picked out of the calls authenticate also makes.
function backlogSql(): string {
  const call = vi
    .mocked(query)
    .mock.calls.find(([sql]) => String(sql).includes('journey_feedback_items'));
  if (!call) throw new Error('the backlog query never ran');
  return String(call[0]);
}

function get(role?: string) {
  return fetch(`${baseUrl}/api/remediations`, {
    headers: { Authorization: `Bearer ${signToken(role)}` },
  });
}

// One open ask, with the shape the route reads off the row.
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    adviser_key: 'lewis@firm.co.uk',
    adviser_name: 'Lewis Hart',
    adviser_email: 'lewis@firm.co.uk',
    adviser_user_id: null,
    feedback_item_id: '11111111-1111-1111-1111-111111111111',
    journey_id: '22222222-2222-2222-2222-222222222222',
    customer_name: 'A. Customer',
    item_label: 'Told the customer how documents would be sent',
    severity: 'high',
    remediation_guidance: 'Ring the client back and tell them documents come by email.',
    told_at: '2026-08-01T09:00:00.000Z',
    acknowledged_at: '2026-08-02T09:00:00.000Z',
    days_open: 9,
    link_expired: false,
    ...over,
  };
}

describe('GET /api/remediations — access', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await fetch(`${baseUrl}/api/remediations`);
    expect(res.status).toBe(401);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('refuses an adviser: this is an org-wide report, and advisers are scoped to themselves', async () => {
    const res = await get('adviser');
    expect(res.status).toBe(403);
    // authenticate touches users.last_active_at on the way through, so the
    // assertion is that the BACKLOG never ran, not that nothing did.
    const backlogCalls = vi
      .mocked(query)
      .mock.calls.filter(([sql]) => String(sql).includes('journey_feedback_items'));
    expect(backlogCalls).toHaveLength(0);
  });

  it('allows a viewer — a compliance officer reads reports without actioning them', async () => {
    const res = await get('viewer');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/remediations — what counts as open', () => {
  it('counts only acknowledged rounds, only the latest ask per checkpoint, and only checkpoints the firm set a step for', async () => {
    await get();
    const sql = backlogSql();

    // The ask must have carried the firm's instruction. Without this the
    // backlog opens with every finding fed back before CG-24 existed, on links
    // that have since expired — nothing anybody could ever close.
    expect(sql).toContain('remediation_guidance IS NOT NULL');
    // Unanswered, which is what "open" means at all.
    expect(sql).toContain('remediation_outcome IS NULL');
    // Acknowledged only: an unacknowledged round is the feedback backlog (CG-11),
    // and an outcome cannot be written before acknowledgement anyway (116).
    expect(sql).toContain('f.confirmed_at IS NOT NULL');
    // One ask per checkpoint per sale, most recent first — the same rule the
    // board pack's open figure uses.
    expect(sql).toContain('DISTINCT ON (f.journey_id, fi.scorecard_item_id)');
    expect(sql).toContain('f.sent_at DESC');
  });

  it('ages from acknowledgement, not from when the feedback was sent', async () => {
    await get();
    const sql = backlogSql();
    expect(sql).toContain('now() - latest_ask.confirmed_at');
    expect(sql).not.toContain('now() - latest_ask.sent_at');
  });

  it('scopes to the caller organisation', async () => {
    await get();
    const call = vi
      .mocked(query)
      .mock.calls.find(([sql]) => String(sql).includes('journey_feedback_items'))!;
    expect(call[1]).toEqual([ORG]);
  });
});

describe('GET /api/remediations — grouping', () => {
  it('groups by adviser, keeps their oldest age, and orders the worst first', async () => {
    vi.mocked(query).mockResolvedValue([
      row({ adviser_key: 'sam@firm.co.uk', adviser_name: 'Sam Reid', adviser_email: 'sam@firm.co.uk', days_open: 30, feedback_item_id: 'a' }),
      row({ days_open: 9, feedback_item_id: 'b' }),
      row({ days_open: 2, feedback_item_id: 'c', journey_id: '33333333-3333-3333-3333-333333333333' }),
    ] as never);

    const res = await get();
    const body = await res.json();

    expect(body.total_open).toBe(3);
    expect(body.advisers_with_open).toBe(2);
    expect(body.oldest_open_days).toBe(30);

    // Oldest ask first: the one a principal will be asked about.
    expect(body.advisers[0].adviser_name).toBe('Sam Reid');
    expect(body.advisers[0].open_count).toBe(1);

    const lewis = body.advisers[1];
    expect(lewis.open_count).toBe(2);
    // The adviser's own age is their oldest, not their most recent.
    expect(lewis.oldest_open_days).toBe(9);
    expect(lewis.items.map((i: { feedback_item_id: string }) => i.feedback_item_id)).toEqual(['b', 'c']);
  });

  it('keys on the email where the adviser has no login, so they do not all collapse into one pile', async () => {
    vi.mocked(query).mockResolvedValue([
      row({ adviser_key: 'lewis@firm.co.uk', adviser_user_id: null, feedback_item_id: 'a' }),
      row({
        adviser_key: 'jo@firm.co.uk',
        adviser_name: 'Jo Blake',
        adviser_email: 'jo@firm.co.uk',
        adviser_user_id: null,
        feedback_item_id: 'b',
      }),
    ] as never);

    const body = await (await get()).json();
    expect(body.advisers_with_open).toBe(2);
    expect(body.advisers.map((a: { adviser_key: string }) => a.adviser_key).sort()).toEqual([
      'jo@firm.co.uk',
      'lewis@firm.co.uk',
    ]);
  });

  it('says so when the list was cut, rather than letting a partial total read as the total', async () => {
    vi.mocked(query).mockResolvedValue(
      Array.from({ length: 501 }, (_, i) => row({ feedback_item_id: `item-${i}` })) as never
    );

    const body = await (await get()).json();
    expect(body.truncated).toBe(true);
    expect(body.total_open).toBe(500);
  });

  it('returns an empty backlog rather than an error when nothing is outstanding', async () => {
    const body = await (await get()).json();
    expect(body.advisers).toEqual([]);
    expect(body.total_open).toBe(0);
    expect(body.oldest_open_days).toBeNull();
    // The definition travels with the response even when it is empty, so a
    // figure lifted into a board paper carries what it counts.
    expect(body.note).toContain('acknowledged');
  });
});
