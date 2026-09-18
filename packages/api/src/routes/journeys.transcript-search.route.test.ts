import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';

// GET /api/journeys/:id/transcript-search — "was this said anywhere in the
// sale?". A search result is a piece of transcript, so everything
// services/transcript-access.ts enforces for reading one has to hold here: a
// user who may not read this firm's transcripts gets no lines AND no counts,
// and the transcripts are never read out of the database for them at all.
// These pin that, the org scope, and the call numbering the sale page shares
// with the scorer.

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

const ORG = '00000000-0000-0000-0000-0000000000bb';
const USER = '00000000-0000-0000-0000-0000000000aa';
const JOURNEY = '00000000-0000-0000-0000-0000000000c1';

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

/** Whether the sale exists for the requesting org. */
let journeyExists = true;
/** The firm's unredacted categories — what makes a transcript sensitive. */
let unredactedCategories: string[] = [];
/** The sale's calls, oldest first, as the route's query returns them. */
let calls: Array<{
  id: string;
  call_date: string;
  agent_name: string | null;
  transcript_text: string | null;
}> = [];

beforeEach(() => {
  journeyExists = true;
  unredactedCategories = [];
  calls = [
    {
      id: 'call-1',
      call_date: '2026-08-14T09:00:00.000Z',
      agent_name: 'George',
      transcript_text:
        'Agent: Good morning, this is [NAME_GIVEN_1] calling.\n' +
        'Customer: Hello there.\n' +
        'Agent: The policy comes with a warranty of twelve months.\n' +
        'Customer: And what does the warranty cover?\n' +
        'Agent: Anything mechanical.',
    },
    {
      id: 'call-2',
      call_date: '2026-08-15T09:00:00.000Z',
      agent_name: 'Lewis',
      transcript_text: 'Agent: Just confirming the warranty we discussed.\nCustomer: Understood.',
    },
  ];

  vi.mocked(query)
    .mockReset()
    .mockImplementation((async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM journey_calls jc')) return calls;
      return [];
    }) as never);

  vi.mocked(queryOne)
    .mockReset()
    .mockImplementation((async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM journeys WHERE id')) return journeyExists ? { id: JOURNEY } : null;
      if (s.includes('pii_unredacted_categories')) return { categories: unredactedCategories };
      return null;
    }) as never);
});

function search(term: string, role = 'admin', journeyId = JOURNEY): Promise<Response> {
  return fetch(
    `${baseUrl}/api/journeys/${journeyId}/transcript-search?q=${encodeURIComponent(term)}`,
    { headers: { Authorization: `Bearer ${signToken(role)}` } }
  );
}

/** Was the transcript-bearing query issued at all? */
function transcriptQueryRan(): boolean {
  return vi
    .mocked(query)
    .mock.calls.some(([sql]) => String(sql).includes('transcript_text'));
}

describe('GET /api/journeys/:id/transcript-search — what it finds', () => {
  it('searches every call in the sale and groups the hits by call', async () => {
    const res = await search('warranty');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.restricted).toBe(false);
    expect(body.total_matches).toBe(3);
    expect(body.searched_calls).toBe(2);
    expect(body.unsearchable_calls).toBe(0);
    expect(body.calls).toHaveLength(2);
    expect(body.calls[0].call_id).toBe('call-1');
    expect(body.calls[0].call_number).toBe(1);
    expect(body.calls[0].match_count).toBe(2);
    expect(body.calls[1].call_number).toBe(2);
  });

  it('returns the matched line with a line either side, and marks which is which', async () => {
    const body = await (await search('mechanical')).json();
    const match = body.calls[0].matches[0];
    expect(match.line_index).toBe(4);
    // The last line of the transcript: one line before it, and nothing after.
    expect(match.lines.map((l: { index: number }) => l.index)).toEqual([3, 4]);
    expect(match.lines.find((l: { is_match: boolean }) => l.is_match).text).toContain('mechanical');
    expect(match.lines[0].speaker).toBe('Customer');
  });

  it('is case-insensitive, and counts a line once however often the term occurs in it', async () => {
    calls = [
      {
        id: 'call-1',
        call_date: '2026-08-14T09:00:00.000Z',
        agent_name: null,
        transcript_text: 'Agent: Warranty, warranty, warranty.',
      },
    ];
    const body = await (await search('WARRANTY')).json();
    expect(body.total_matches).toBe(1);
  });

  it('counts a call with no transcript as unsearchable, and does not give it a number', async () => {
    calls = [
      { id: 'call-0', call_date: '2026-08-13T09:00:00.000Z', agent_name: null, transcript_text: null },
      ...calls,
    ];
    const body = await (await search('warranty')).json();
    expect(body.unsearchable_calls).toBe(1);
    expect(body.searched_calls).toBe(2);
    // Numbering follows the transcribed calls only — the same set the scorer
    // numbered, so "Call 1" here is the AI's "Call 1".
    expect(body.calls[0].call_id).toBe('call-1');
    expect(body.calls[0].call_number).toBe(1);
  });

  it('answers a term nobody said with no matches rather than an error', async () => {
    const res = await search('indemnity');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_matches).toBe(0);
    expect(body.calls).toEqual([]);
  });
});

describe('GET /api/journeys/:id/transcript-search — who may read the result', () => {
  it('gives a supervisor nothing at all when the firm keeps personal data unredacted', async () => {
    unredactedCategories = ['phi'];
    const res = await search('warranty', 'supervisor');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.restricted).toBe(true);
    expect(body.calls).toEqual([]);
    // Not a count either: "warranty — 3 matches" tells the reader the word was
    // used, which is the content the restriction exists to withhold.
    expect(body.total_matches).toBe(0);
    expect(body.searched_calls).toBe(0);
    expect(JSON.stringify(body)).not.toContain('warranty of twelve months');
    // …and the transcripts were never read out of the database for them.
    expect(transcriptQueryRan()).toBe(false);
  });

  it('still searches for a supervisor at a firm whose transcripts are redacted at source', async () => {
    unredactedCategories = [];
    const body = await (await search('warranty', 'supervisor')).json();
    expect(body.restricted).toBe(false);
    expect(body.total_matches).toBe(3);
  });

  it('lets an admin search a firm that keeps personal data unredacted', async () => {
    unredactedCategories = ['phi'];
    const body = await (await search('warranty', 'admin')).json();
    expect(body.restricted).toBe(false);
    expect(body.total_matches).toBe(3);
  });

  it('refuses an adviser, who is scoped to their own calls and never sees a sale', async () => {
    const res = await search('warranty', 'adviser');
    expect(res.status).toBe(403);
    expect(transcriptQueryRan()).toBe(false);
  });
});

describe('GET /api/journeys/:id/transcript-search — what it refuses', () => {
  it('scopes the sale to the caller’s organisation', async () => {
    journeyExists = false;
    const res = await search('warranty');
    expect(res.status).toBe(404);
    expect(transcriptQueryRan()).toBe(false);
    const lookup = vi
      .mocked(queryOne)
      .mock.calls.find(([sql]) => String(sql).includes('FROM journeys WHERE id'));
    expect(lookup).toBeDefined();
    expect(lookup![1]).toEqual([JOURNEY, ORG]);
  });

  it('refuses a one-character term, which would match most lines of most calls', async () => {
    const res = await search('w');
    expect(res.status).toBe(400);
    expect(transcriptQueryRan()).toBe(false);
  });

  it('refuses an empty term', async () => {
    const res = await search('   ');
    expect(res.status).toBe(400);
    expect(transcriptQueryRan()).toBe(false);
  });

  it('scopes the calls query to the organisation as well as to the sale', async () => {
    await search('warranty');
    const call = vi
      .mocked(query)
      .mock.calls.find(([sql]) => String(sql).includes('FROM journey_calls jc'));
    expect(call).toBeDefined();
    expect(String(call![0])).toContain('c.organization_id = $2');
    expect(call![1]).toEqual([JOURNEY, ORG]);
  });
});
