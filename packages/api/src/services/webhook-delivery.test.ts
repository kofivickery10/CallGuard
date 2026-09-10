import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query, queryOne } from '../db/client.js';
import type { WebhookBreachPayload, WebhookScoredPayload } from '@callguard/shared';

vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./crypto.js', () => ({
  decrypt: vi.fn(() => 'webhook-secret'),
}));

import { deliverWebhook } from './webhook-delivery.js';

// ── DPIA R5, action 8 ────────────────────────────────────────────────────────
//
// The filter lives in deliverWebhook rather than in deliverCallScored, because
// deliverWebhook is the function that actually leaves. Three producers reach
// it: the batch call.scored/journey.scored path AND the two live-session
// events from services/stream-worker.ts. Those two carry the same verbatim
// transcript quote and never pass through deliverCallScored — gating there
// would have left the control complete on `core` and absent on the tiers that
// have live streaming, which is not a property a compliance control may have.
//
// These tests use the live-session payload shapes for exactly that reason.

const QUOTE = 'I was diagnosed with atrial fibrillation in 2019.';

function keyRow() {
  return {
    api_key_id: 'key-1',
    organization_id: 'org-1',
    webhook_url: 'https://partner.example.test/hook',
    webhook_secret_encrypted: 'ciphertext',
  };
}

/** The JSON body actually POSTed to the partner. */
function bodySent(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('partner.example.test'));
  return JSON.parse(String(call![1]!.body));
}

describe('deliverWebhook — DPIA R5', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(query).mockResolvedValue([]);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  });

  /** categories → what the organisations lookup returns for this tenant. */
  function arrange(categories: string[] | null) {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(keyRow()) // api_keys lookup
      .mockResolvedValueOnce({ categories }) // organisationKeepsUnredacted
      .mockResolvedValueOnce({ id: 'delivery-1' }); // webhook_deliveries INSERT
  }

  const breachFrame: WebhookBreachPayload = {
    event: 'session.breach_detected',
    session_id: 's-1',
    external_id: null,
    ts: new Date().toISOString(),
    severity: 'high',
    scorecard_item_id: 'i-1',
    scorecard_item_label: 'Pre-existing conditions explored',
    evidence: QUOTE,
  };

  const scoredFrame: WebhookScoredPayload = {
    event: 'session.scored',
    session_id: 's-1',
    external_id: null,
    call_id: 'c-1',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_seconds: 610,
    overall_score: 61,
    pass: false,
    breaches: [
      {
        scorecard_item_id: 'i-1',
        scorecard_item_label: 'Pre-existing conditions explored',
        severity: 'high',
        evidence: QUOTE,
      },
    ],
  };

  // The live-session events are the ones a gate in deliverCallScored would
  // have missed entirely. session.breach_detected carries its quote at the top
  // level rather than inside breaches[], so the filter has to handle both
  // shapes or this one sails through.
  it('withholds the quote on a live breach frame, which carries it at the top level', async () => {
    arrange(['phi']);

    await deliverWebhook('key-1', 's-1', breachFrame);

    const body = bodySent(fetchMock);
    expect(body.evidence).toBe('');
    expect(body.evidence_withheld).toBe(true);
    // The question and the fact of the breach still travel — R5's shape.
    expect(body.scorecard_item_label).toBe('Pre-existing conditions explored');
    expect(body.severity).toBe('high');
  });

  it('withholds the quote on a live scored frame, which carries it in breaches[]', async () => {
    arrange(['phi']);

    await deliverWebhook('key-1', 's-1', scoredFrame);

    const body = bodySent(fetchMock);
    expect((body.breaches as Array<{ evidence: string }>)[0]!.evidence).toBe('');
    expect(body.evidence_withheld).toBe(true);
  });

  // The broad gate, and the reason it is broader than Zoho's. A webhook_url is
  // whatever endpoint the tenant typed, so the argument that narrows the CRM
  // gate — "their CRM already holds their name and address" — says nothing
  // about a destination we cannot see. A quote carrying an unredacted date of
  // birth goes nowhere either.
  it('withholds on any permitted category, not health alone', async () => {
    arrange(['dob', 'name']);

    await deliverWebhook('key-1', 's-1', breachFrame);

    expect(bodySent(fetchMock).evidence).toBe('');
  });

  it('sends the quote unchanged for a tenant redacted at source', async () => {
    arrange(null);

    await deliverWebhook('key-1', 's-1', breachFrame);

    const body = bodySent(fetchMock);
    expect(body.evidence).toBe(QUOTE);
    expect(body.evidence_withheld).toBeUndefined();
  });

  it('persists the withheld payload, so a replay cannot resend the quote', async () => {
    arrange(['phi']);

    await deliverWebhook('key-1', 's-1', scoredFrame);

    // [0] api_keys, [1] the redaction lookup, [2] the delivery INSERT.
    const insertParams = vi.mocked(queryOne).mock.calls[2]![1] as unknown[];
    const stored = JSON.parse(insertParams[5] as string) as WebhookScoredPayload;
    expect(stored.breaches[0]!.evidence).toBe('');
  });

  it('signs the body that was actually sent, not the one before withholding', async () => {
    // A signature computed over the unfiltered payload would fail verification
    // at the partner, so the filter has to run before the HMAC — not after.
    arrange(['phi']);

    await deliverWebhook('key-1', 's-1', breachFrame);

    const call = fetchMock.mock.calls[0]!;
    const headers = call[1]!.headers as Record<string, string>;
    const crypto = await import('crypto');
    const expected = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(String(call[1]!.body))
      .digest('hex');
    expect(headers['X-CallGuardAI-Signature']).toBe(`sha256=${expected}`);
  });
});
