import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encrypt } from './crypto.js';
import { query, queryOne } from '../db/client.js';
import { notify, recipientsByRole } from './notify.js';
import { alertsQueue } from '../jobs/queue.js';
import type { WebhookCallScoredPayload, ZohoFieldMap, ZohoQAFieldMap } from '@callguard/shared';

// findRecordByPhone/resolveZohoUserIdByEmail hit the DB only indirectly (via
// pushCallScored's getConnectionRow / cache updates), so the db client and the
// notification spine are mocked the same way journey-feedback.test.ts mocks
// db/client.js — no live database or Redis needed for these paths.
vi.mock('../db/client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./notify.js', () => ({
  notify: vi.fn(),
  recipientsByRole: vi.fn(),
}));

// Retry scheduling (scheduleZohoRetry) enqueues on the alerts queue — mocked
// the same way journey.test.ts mocks jobs/queue.js, so a retryable failure in
// these tests never touches a real Redis connection.
vi.mock('../jobs/queue.js', () => ({
  alertsQueue: { add: vi.fn() },
}));

import { findRecordByPhone, resolveZohoUserIdByEmail, pushCallScored } from './zoho.js';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe('findRecordByPhone', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('returns not_found on Zoho 204 (no matches)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204));

    const result = await findRecordByPhone('https://www.zohoapis.eu', 'token', 'Leads', '+447700900123');

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('returns found with the single matched record when exactly one matches', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [{ id: 'lead-1', Modified_Time: '2026-01-01T00:00:00Z', Owner: { id: 'owner-1' } }] })
    );

    const result = await findRecordByPhone('https://www.zohoapis.eu', 'token', 'Leads', '+447700900123');

    expect(result).toEqual({ kind: 'found', match: { id: 'lead-1', ownerId: 'owner-1' } });
  });

  // The important case: several CRM records sharing a phone number (a household
  // or switchboard number) must never be silently narrowed down to one. Picking
  // one — as this used to, by most-recently-modified — writes one customer's
  // compliance breach detail onto a different customer's CRM record.
  it('returns ambiguous — not a guessed match — when more than one record matches, listing every id', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { id: 'lead-1', Modified_Time: '2026-01-01T00:00:00Z' },
          { id: 'lead-2', Modified_Time: '2026-02-01T00:00:00Z' },
          { id: 'lead-3', Modified_Time: '2025-06-01T00:00:00Z' },
        ],
      })
    );

    const result = await findRecordByPhone('https://www.zohoapis.eu', 'token', 'Leads', '+447700900123');

    expect(result).toEqual({ kind: 'ambiguous', recordIds: ['lead-1', 'lead-2', 'lead-3'] });
  });
});

describe('resolveZohoUserIdByEmail — cache keyed by organisation', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  // api_domain is a Zoho DATA CENTRE host, not a tenant boundary — two orgs on
  // the same EU data centre must not read each other's cached Zoho user list.
  it('does not share a cached user list between two organisations on the same api_domain', async () => {
    const domain = 'https://www.zohoapis.eu';
    const orgA = `org-a-${Date.now()}`;
    const orgB = `org-b-${Date.now()}`;

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { users: [{ id: 'user-a', email: 'adviser@example.com' }] })
      )
      .mockResolvedValueOnce(
        // Org B's Zoho account has no user with this email at all.
        jsonResponse(200, { users: [{ id: 'user-other', email: 'someone-else@example.com' }] })
      );

    const idForA = await resolveZohoUserIdByEmail(orgA, domain, 'token-a', 'adviser@example.com');
    const idForB = await resolveZohoUserIdByEmail(orgB, domain, 'token-b', 'adviser@example.com');

    // Two distinct API calls — one per organisation — proves the cache entry
    // wasn't shared just because the api_domain matched.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(idForA).toBe('user-a');
    // If the cache were keyed on api_domain alone, org B would have hit org A's
    // cached map and wrongly resolved to 'user-a' too.
    expect(idForB).toBeNull();
  });

  it('still caches within a single organisation, so a second lookup for the same org makes no extra call', async () => {
    const domain = 'https://www.zohoapis.eu';
    const org = `org-cache-${Date.now()}`;

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { users: [{ id: 'user-1', email: 'agent@example.com' }] })
    );

    const first = await resolveZohoUserIdByEmail(org, domain, 'token', 'agent@example.com');
    const second = await resolveZohoUserIdByEmail(org, domain, 'token', 'agent@example.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe('user-1');
    expect(second).toBe('user-1');
  });
});

// Full write-back path: an ambiguous phone match must skip the CRM write and
// raise a notification instead of guessing — see findRecordByPhone.
describe('pushCallScored — ambiguous phone match', () => {
  const fetchMock = vi.fn();

  const fieldMap: ZohoFieldMap = {
    score: 'AI_Score',
    result: 'AI_Result',
    last_scored: 'AI_Last_Scored',
    link: 'AI_Review_Link',
  };
  const qaFieldMap: ZohoQAFieldMap = {
    score: 'AI_Call_Score',
    client_name: 'Client_Name',
    customer_lookup: 'Customer',
  };

  function connRow(organizationId: string) {
    return {
      id: 'conn-1',
      organization_id: organizationId,
      dc_region: 'eu',
      client_id: 'client-id',
      client_secret_encrypted: encrypt('secret'),
      refresh_token_encrypted: encrypt('refresh'),
      access_token_encrypted: encrypt('access'),
      // Far in the future so ensureAccessToken treats it as still valid and
      // never hits the token endpoint — only the search call should fire.
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      api_domain: 'https://www.zohoapis.eu',
      module: 'Leads' as const,
      field_map: fieldMap,
      inbound_secret_encrypted: null,
      sale_phone_field: 'Phone',
      qa_module: null,
      qa_field_map: qaFieldMap,
      sale_module: null,
      policies_related_list: null,
      policy_product_field: null,
      policy_stage_field: null,
      policies_module: null,
      status: 'active' as const,
    };
  }

  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(notify).mockReset();
    vi.mocked(recipientsByRole).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(query).mockResolvedValue([]);
    vi.mocked(recipientsByRole).mockResolvedValue([{ userId: 'admin-1', email: 'admin@example.com' }]);
  });

  it('writes nothing back to Zoho and notifies admins when the phone search is ambiguous', async () => {
    const organizationId = `org-ambiguous-${Date.now()}`;
    vi.mocked(queryOne).mockResolvedValueOnce(connRow(organizationId));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ id: 'lead-1' }, { id: 'lead-2' }],
      })
    );

    const payload: WebhookCallScoredPayload = {
      event: 'call.scored',
      call_id: 'call-1',
      external_id: null,
      agent_name: 'Jo Adviser',
      scorecard_id: 'sc-1',
      overall_score: 91,
      pass: true,
      scored_at: new Date().toISOString(),
      customer_id: 'cust-1',
      customer_phone: '+447700900123',
      customer_external_crm_id: null,
      breaches: [],
    };

    await pushCallScored(organizationId, payload);

    // Only the search call fires — no PUT to update a Lead/Contact, no Tasks POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method ?? 'GET').not.toBe('PUT');

    // No customer row is stamped with a resolved external_crm_id off a guess.
    const customerUpdateCalls = vi
      .mocked(query)
      .mock.calls.filter(([sql]) => String(sql).includes('external_crm_id'));
    expect(customerUpdateCalls).toHaveLength(0);

    // A human is told, with enough detail to resolve it.
    expect(notify).toHaveBeenCalledTimes(1);
    const notifyArg = vi.mocked(notify).mock.calls[0]![0];
    expect(notifyArg.type).toBe('zoho.ambiguous_phone_match');
    expect(notifyArg.body).toContain('+447700900123');
    expect(notifyArg.body).toContain('lead-1');
    expect(notifyArg.body).toContain('lead-2');
  });
});

// Per-call delivery tracking (zoho_deliveries, migration 097) and the queued
// retry it drives. Three outcomes, each recorded distinctly rather than only
// overwriting zoho_connections.last_error:
//   - a transport/5xx-style failure records 'failed'+retryable and schedules
//     a queued retry via the alerts queue;
//   - a success records 'delivered' and schedules nothing;
//   - an ambiguous phone match (see the describe block above) records its own
//     'skipped' outcome — never 'failed', and never retried.
describe('pushCallScored — zoho_deliveries tracking + retry', () => {
  const fetchMock = vi.fn();

  const fieldMap: ZohoFieldMap = {
    score: 'AI_Score',
    result: 'AI_Result',
    last_scored: 'AI_Last_Scored',
    link: 'AI_Review_Link',
  };
  const qaFieldMap: ZohoQAFieldMap = {
    score: 'AI_Call_Score',
    client_name: 'Client_Name',
    customer_lookup: 'Customer',
  };

  function connRow(organizationId: string) {
    return {
      id: 'conn-1',
      organization_id: organizationId,
      dc_region: 'eu',
      client_id: 'client-id',
      client_secret_encrypted: encrypt('secret'),
      refresh_token_encrypted: encrypt('refresh'),
      access_token_encrypted: encrypt('access'),
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      api_domain: 'https://www.zohoapis.eu',
      module: 'Leads' as const,
      field_map: fieldMap,
      inbound_secret_encrypted: null,
      sale_phone_field: 'Phone',
      // No QA module configured — these tests exercise only the
      // customer-record ('record') delivery target.
      qa_module: null,
      qa_field_map: qaFieldMap,
      sale_module: null,
      policies_related_list: null,
      policy_product_field: null,
      policy_stage_field: null,
      policies_module: null,
      status: 'active' as const,
    };
  }

  function callPayload(callId: string): WebhookCallScoredPayload {
    return {
      event: 'call.scored',
      call_id: callId,
      external_id: null,
      agent_name: 'Jo Adviser',
      scorecard_id: 'sc-1',
      overall_score: 88,
      pass: true,
      scored_at: new Date().toISOString(),
      customer_id: null,
      customer_phone: '+447700900123',
      customer_external_crm_id: null,
      breaches: [],
    };
  }

  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(notify).mockReset();
    vi.mocked(recipientsByRole).mockReset();
    vi.mocked(alertsQueue.add).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(query).mockResolvedValue([]);
    vi.mocked(recipientsByRole).mockResolvedValue([{ userId: 'admin-1', email: 'admin@example.com' }]);
    vi.mocked(alertsQueue.add).mockResolvedValue(undefined as never);
  });

  it('records a delivered outcome and schedules no retry on a successful write-back', async () => {
    const organizationId = `org-delivery-ok-${Date.now()}`;
    const payload = callPayload('call-ok-1');

    vi.mocked(queryOne)
      .mockResolvedValueOnce(connRow(organizationId)) // getConnectionRow
      .mockResolvedValueOnce({ id: 'delivery-ok-1' }); // zoho_deliveries INSERT ... RETURNING id

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'lead-1', Owner: { id: 'owner-1' } }] })) // search: one match
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ status: 'success' }] })); // PUT update

    await pushCallScored(organizationId, payload);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The delivery row was opened before the attempt and carries the payload
    // that was (about to be) written.
    const insertCall = vi.mocked(queryOne).mock.calls[1]!;
    expect(String(insertCall[0])).toContain('INSERT INTO zoho_deliveries');
    const insertParams = insertCall[1] as unknown[];
    expect(insertParams[3]).toBe('record'); // kind
    expect(JSON.parse(insertParams[5] as string)).toEqual(payload); // payload

    const deliveryUpdateCalls = vi
      .mocked(query)
      .mock.calls.filter(([sql]) => String(sql).includes('UPDATE zoho_deliveries'));
    expect(deliveryUpdateCalls).toHaveLength(1);
    const [, updateParams] = deliveryUpdateCalls[0]!;
    expect(updateParams).toEqual(['delivery-ok-1', 'delivered', 'Leads:lead-1', false, null]);

    // A clean success schedules nothing.
    expect(alertsQueue.add).not.toHaveBeenCalled();
  });

  it('records a failed+retryable outcome and schedules a queued retry on a transport failure', async () => {
    const organizationId = `org-delivery-retry-${Date.now()}`;
    const payload = callPayload('call-retry-1');

    vi.mocked(queryOne)
      .mockResolvedValueOnce(connRow(organizationId)) // getConnectionRow
      .mockResolvedValueOnce({ id: 'delivery-retry-1' }); // zoho_deliveries INSERT ... RETURNING id

    // The search call never gets a response at all — a network-level failure,
    // not an HTTP error status. This is exactly the kind of failure a delayed
    // retry can plausibly ride out.
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await pushCallScored(organizationId, payload);

    const deliveryUpdateCalls = vi
      .mocked(query)
      .mock.calls.filter(([sql]) => String(sql).includes('UPDATE zoho_deliveries'));
    expect(deliveryUpdateCalls).toHaveLength(1);
    const [, updateParams] = deliveryUpdateCalls[0]!;
    expect(updateParams[0]).toBe('delivery-retry-1');
    expect(updateParams[1]).toBe('failed');
    expect(updateParams[3]).toBe(true); // retryable
    expect(String(updateParams[4])).toContain('fetch failed');

    // A queued retry was scheduled, first attempt, on the alerts queue.
    expect(alertsQueue.add).toHaveBeenCalledTimes(1);
    expect(alertsQueue.add).toHaveBeenCalledWith(
      'zoho-retry',
      { deliveryId: 'delivery-retry-1', attempt: 1 },
      { delay: 2 * 60_000 }
    );
  });

  it('records an ambiguous match as its own skipped outcome, distinct from a failure, and does not retry', async () => {
    const organizationId = `org-delivery-ambiguous-${Date.now()}`;
    const payload = callPayload('call-ambiguous-1');

    vi.mocked(queryOne)
      .mockResolvedValueOnce(connRow(organizationId)) // getConnectionRow
      .mockResolvedValueOnce({ id: 'delivery-ambiguous-1' }); // zoho_deliveries INSERT ... RETURNING id

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'lead-1' }, { id: 'lead-2' }] }));

    await pushCallScored(organizationId, payload);

    // Only the search fires — no PUT is attempted for an ambiguous match.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const deliveryUpdateCalls = vi
      .mocked(query)
      .mock.calls.filter(([sql]) => String(sql).includes('UPDATE zoho_deliveries'));
    expect(deliveryUpdateCalls).toHaveLength(1);
    const [, updateParams] = deliveryUpdateCalls[0]!;
    expect(updateParams[0]).toBe('delivery-ambiguous-1');
    // Distinct from 'failed': nothing here is broken, a person just needs to
    // resolve the duplicate/shared number in Zoho first.
    expect(updateParams[1]).toBe('skipped');
    expect(updateParams[3]).toBe(false); // never retryable
    expect(String(updateParams[4])).toContain('ambiguous phone match');

    // Never retried — see findRecordByPhone for why guessing would be worse
    // than doing nothing.
    expect(alertsQueue.add).not.toHaveBeenCalled();
  });
});
