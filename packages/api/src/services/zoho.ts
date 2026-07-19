import crypto from 'crypto';
import { query, queryOne } from '../db/client.js';
import { encrypt, decrypt } from './crypto.js';
import { config } from '../config.js';
import type {
  WebhookCallScoredPayload,
  WebhookJourneyScoredPayload,
  ZohoFieldMap,
  ZohoQAFieldMap,
  ZohoModule,
  ZohoRegion,
} from '@callguard/shared';

type ScoredPayload = WebhookCallScoredPayload | WebhookJourneyScoredPayload;
function isJourneyPayload(p: ScoredPayload): p is WebhookJourneyScoredPayload {
  return p.event === 'journey.scored';
}

// ============================================================
// Zoho CRM write-back. One-way: after a call is scored we find the matching
// Lead/Contact by phone and write the compliance score + a breach task. Never
// blocks scoring — every public entry point is best-effort and records failures
// on the connection row rather than throwing.
// ============================================================

// OAuth host per data centre. The CRM api_domain (www.zohoapis.<region>) is
// returned by the token exchange and stored on the row, so it isn't mapped here.
const ZOHO_ACCOUNTS_HOST: Record<ZohoRegion, string> = {
  eu: 'https://accounts.zoho.eu',
  com: 'https://accounts.zoho.com',
  in: 'https://accounts.zoho.in',
  'com.au': 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp',
  ca: 'https://accounts.zohocloud.ca',
};

// Scopes CallGuard needs:
//  - modules.ALL           : read/update Leads/Contacts, create Tasks, and
//                            read/write the QA custom module records.
//  - settings.modules.READ : the connection Test hits /settings/modules.
//  - users.READ            : resolve an adviser's email to a Zoho user so the
//                            QA record's owner can be set to the agent.
// offline + consent (see buildAuthorizeUrl) guarantee a refresh token on first
// authorisation. NB: widening this list requires reconnecting — an existing
// token only carries the scopes it was granted with.
const OAUTH_SCOPE = 'ZohoCRM.modules.ALL,ZohoCRM.settings.modules.READ,ZohoCRM.users.READ';

interface ZohoConnectionRow {
  id: string;
  organization_id: string;
  dc_region: ZohoRegion;
  client_id: string;
  client_secret_encrypted: string;
  refresh_token_encrypted: string | null;
  access_token_encrypted: string | null;
  token_expires_at: string | null;
  api_domain: string | null;
  module: ZohoModule;
  field_map: ZohoFieldMap;
  inbound_secret_encrypted: string | null;
  sale_phone_field: string;
  qa_module: string | null;
  qa_field_map: ZohoQAFieldMap;
  status: 'pending' | 'active' | 'disabled';
}

const ROW_COLUMNS = `id, organization_id, dc_region, client_id,
  client_secret_encrypted, refresh_token_encrypted, access_token_encrypted,
  token_expires_at, api_domain, module, field_map,
  inbound_secret_encrypted, sale_phone_field, qa_module, qa_field_map, status`;

export function accountsHost(region: ZohoRegion): string {
  return ZOHO_ACCOUNTS_HOST[region] ?? ZOHO_ACCOUNTS_HOST.eu;
}

/**
 * Verify the inbound Zoho "sale" webhook's HMAC signature against the org's
 * configured inbound_secret (spec §9). The org is already known from
 * X-API-Key auth on the route — this is a second, stronger layer on top of
 * key possession, same pattern as CloudTalk's dialer webhook (see
 * services/tenant-settings.ts verifyDialerSignature). Returns true if
 * verification is not yet configured (nothing to check against) OR the
 * signature matches; false only on an explicit mismatch.
 */
export function verifyInboundSaleSignature(
  conn: Pick<ZohoConnectionRow, 'inbound_secret_encrypted'> | null,
  rawBody: Buffer,
  signatureHeader: string | null | undefined
): boolean {
  if (!conn?.inbound_secret_encrypted) return true;
  if (!signatureHeader) return false;
  const secret = decrypt(conn.inbound_secret_encrypted);
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'utf8');
  return expectedBuf.length === gotBuf.length && crypto.timingSafeEqual(expectedBuf, gotBuf);
}

export async function getConnectionRow(
  organizationId: string
): Promise<ZohoConnectionRow | null> {
  return queryOne<ZohoConnectionRow>(
    `SELECT ${ROW_COLUMNS} FROM zoho_connections WHERE organization_id = $1`,
    [organizationId]
  );
}

// Consent URL the admin is redirected to. `state` is a signed token the callback
// verifies to recover the org (see routes/integrations.ts).
export function buildAuthorizeUrl(opts: {
  region: ZohoRegion;
  clientId: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    scope: OAUTH_SCOPE,
    client_id: opts.clientId,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    redirect_uri: config.zoho.redirectUri,
    state: opts.state,
  });
  return `${accountsHost(opts.region)}/oauth/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  api_domain?: string;
  expires_in?: number;
  error?: string;
}

async function postToken(
  region: ZohoRegion,
  body: Record<string, string>
): Promise<TokenResponse> {
  const res = await fetch(`${accountsHost(region)}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`Zoho token request failed: ${json.error || res.status}`);
  }
  return json;
}

// Exchange the authorization code from the OAuth callback and persist the
// resulting tokens, flipping the connection to active. Called by the callback route.
export async function exchangeCodeAndStore(
  organizationId: string,
  code: string
): Promise<void> {
  const conn = await getConnectionRow(organizationId);
  if (!conn) throw new Error('No Zoho connection to complete');

  const token = await postToken(conn.dc_region, {
    grant_type: 'authorization_code',
    client_id: conn.client_id,
    client_secret: decrypt(conn.client_secret_encrypted),
    redirect_uri: config.zoho.redirectUri,
    code,
  });

  if (!token.refresh_token) {
    throw new Error(
      'Zoho did not return a refresh token. Remove CallGuard under Connected Apps in Zoho and reconnect.'
    );
  }

  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);
  await query(
    `UPDATE zoho_connections SET
       refresh_token_encrypted = $2,
       access_token_encrypted  = $3,
       token_expires_at        = $4,
       api_domain              = $5,
       status                  = 'active',
       last_error              = NULL,
       updated_at              = now()
     WHERE organization_id = $1`,
    [
      organizationId,
      encrypt(token.refresh_token),
      encrypt(token.access_token!),
      expiresAt.toISOString(),
      token.api_domain ?? null,
    ]
  );
}

// Return a usable access token + api_domain, refreshing if the cached one is
// within 60s of expiry. Persists the refreshed token.
async function ensureAccessToken(
  conn: ZohoConnectionRow
): Promise<{ accessToken: string; apiDomain: string }> {
  const stillValid =
    conn.access_token_encrypted &&
    conn.token_expires_at &&
    new Date(conn.token_expires_at).getTime() - Date.now() > 60_000;

  if (stillValid && conn.api_domain) {
    return {
      accessToken: decrypt(conn.access_token_encrypted!),
      apiDomain: conn.api_domain,
    };
  }

  if (!conn.refresh_token_encrypted) {
    throw new Error('Zoho connection is not authorised (no refresh token)');
  }

  const token = await postToken(conn.dc_region, {
    grant_type: 'refresh_token',
    client_id: conn.client_id,
    client_secret: decrypt(conn.client_secret_encrypted),
    refresh_token: decrypt(conn.refresh_token_encrypted),
  });

  const apiDomain = token.api_domain ?? conn.api_domain;
  if (!apiDomain) throw new Error('Zoho did not return an api_domain');
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);

  await query(
    `UPDATE zoho_connections SET
       access_token_encrypted = $2,
       token_expires_at       = $3,
       api_domain             = $4,
       updated_at             = now()
     WHERE organization_id = $1`,
    [
      conn.organization_id,
      encrypt(token.access_token!),
      expiresAt.toISOString(),
      apiDomain,
    ]
  );

  return { accessToken: token.access_token!, apiDomain };
}

const ZOHO_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const ZOHO_MAX_RETRIES = 2;

// Retries rate-limits/transient 5xxs with backoff (honouring Retry-After when
// Zoho sends one). Without this, a 429 during a scoring burst just drops that
// call's write-back forever — pushCallScored is fire-and-forget from score.ts
// with no other retry mechanism.
async function zohoApi(
  apiDomain: string,
  accessToken: string,
  path: string,
  init: RequestInit = {},
  attempt = 0
): Promise<Response> {
  const res = await fetch(`${apiDomain}${path}`, {
    ...init,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (ZOHO_RETRYABLE_STATUSES.has(res.status) && attempt < ZOHO_MAX_RETRIES) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 5000)));
    return zohoApi(apiDomain, accessToken, path, init, attempt + 1);
  }

  return res;
}

// Zoho v6 write APIs return 2xx with per-record status inside the body — a
// record-level failure (e.g. a field_map entry that isn't a real field on the
// module) shows up as `data[0].status === 'error'`, not an HTTP error status.
// Checking res.ok alone lets these fail silently ("succeeds", clears
// last_error, nothing is actually written in Zoho).
interface ZohoWriteResult {
  status?: string;
  code?: string;
  message?: string;
}

async function checkZohoWriteResult(res: Response, action: string): Promise<void> {
  const body = (await res.json().catch(() => null)) as { data?: ZohoWriteResult[] } | null;
  const result = body?.data?.[0];
  if (!res.ok || result?.status === 'error') {
    throw new Error(
      `${action} failed: ${res.status} ${result?.code ?? ''} ${result?.message ?? ''}`.trim()
    );
  }
}

// UK-aware phone variants so a +44… call still matches a Zoho record that stores
// the number as 07…. Returns de-duplicated, non-empty forms.
function phoneVariants(phone: string): string[] {
  const variants = new Set<string>([phone]);
  const digits = phone.replace(/[^\d+]/g, '');
  variants.add(digits);
  if (digits.startsWith('+44')) variants.add('0' + digits.slice(3));
  if (digits.startsWith('0')) variants.add('+44' + digits.slice(1));
  return [...variants].filter(Boolean);
}

interface ZohoMatch {
  id: string;
  ownerId: string | null;
}

// Search the module by Phone/Mobile across every phone variant; if several match,
// return the most recently modified one.
async function findRecordByPhone(
  apiDomain: string,
  accessToken: string,
  module: ZohoModule,
  phone: string
): Promise<ZohoMatch | null> {
  const clauses = phoneVariants(phone).flatMap((v) => [
    `(Phone:equals:${v})`,
    `(Mobile:equals:${v})`,
  ]);
  const criteria = `(${clauses.join('or')})`;

  const res = await zohoApi(
    apiDomain,
    accessToken,
    `/crm/v8/${module}/search?criteria=${encodeURIComponent(criteria)}`
  );
  if (res.status === 204) return null; // Zoho returns 204 for no matches
  if (!res.ok) {
    throw new Error(`Zoho search failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    data?: Array<{ id: string; Modified_Time?: string; Owner?: { id?: string } }>;
  };
  const rows = body.data ?? [];
  if (rows.length === 0) return null;

  rows.sort(
    (a, b) =>
      new Date(b.Modified_Time ?? 0).getTime() - new Date(a.Modified_Time ?? 0).getTime()
  );
  const best = rows[0]!;
  return { id: best.id, ownerId: best.Owner?.id ?? null };
}

// Zoho datetime fields want an offset (…+00:00), not a trailing Z.
function toZohoDateTime(iso: string): string {
  return iso.replace(/\.\d+Z$/, 'Z').replace(/Z$/, '+00:00');
}

// Where the "review this in CallGuard" link on a Zoho record should point —
// a single call, or the journey it belongs to (spec §9/§11).
function reviewLink(payload: ScoredPayload): string {
  return isJourneyPayload(payload)
    ? `${config.appUrl}/journeys/${payload.journey_id}`
    : `${config.appUrl}/calls/${payload.call_id}`;
}

async function updateRecordScore(
  apiDomain: string,
  accessToken: string,
  module: ZohoModule,
  fieldMap: ZohoFieldMap,
  recordId: string,
  payload: ScoredPayload
): Promise<void> {
  const record: Record<string, unknown> = {
    id: recordId,
    [fieldMap.score]: Number(payload.overall_score.toFixed(1)),
    [fieldMap.result]: payload.pass ? 'Pass' : 'Fail',
    [fieldMap.last_scored]: toZohoDateTime(payload.scored_at),
    [fieldMap.link]: reviewLink(payload),
  };

  const res = await zohoApi(apiDomain, accessToken, `/crm/v8/${module}`, {
    method: 'PUT',
    body: JSON.stringify({ data: [record] }),
  });
  await checkZohoWriteResult(res, 'Zoho update');
}

async function createBreachTask(
  apiDomain: string,
  accessToken: string,
  match: ZohoMatch,
  payload: ScoredPayload
): Promise<void> {
  const severities = payload.breaches.map((b) => b.severity);
  const highPriority = severities.some((s) => s === 'critical' || s === 'high');
  const lines = payload.breaches.map(
    (b) => `• [${b.severity.toUpperCase()}] ${b.scorecard_item_label}${b.evidence ? ` — ${b.evidence}` : ''}`
  );
  const subject = isJourneyPayload(payload)
    ? `Compliance breach on journey${payload.agent_name ? ` (${payload.agent_name})` : ''} — ${payload.breaches.length} issue${payload.breaches.length === 1 ? '' : 's'}`
    : `Compliance breach on call${payload.agent_name ? ` (${payload.agent_name})` : ''} — ${payload.breaches.length} issue${payload.breaches.length === 1 ? '' : 's'}`;

  const due = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const task: Record<string, unknown> = {
    Subject: subject,
    Status: 'Not Started',
    Priority: highPriority ? 'High' : 'Normal',
    Due_Date: due,
    Description: [
      `CallGuard scored this ${isJourneyPayload(payload) ? 'customer journey' : 'call'} ${payload.overall_score.toFixed(1)} (${payload.pass ? 'PASS' : 'FAIL'}).`,
      '',
      ...lines,
      '',
      `Review: ${reviewLink(payload)}`,
    ].join('\n'),
    // Leads and Contacts both relate to a Task via Who_Id.
    Who_Id: { id: match.id },
  };
  if (match.ownerId) task.Owner = { id: match.ownerId };

  const res = await zohoApi(apiDomain, accessToken, '/crm/v8/Tasks', {
    method: 'POST',
    body: JSON.stringify({ data: [task] }),
  });
  await checkZohoWriteResult(res, 'Zoho task create');
}

// Resolve a CallGuard adviser's email to a Zoho CRM user id, so the QA record's
// owner can be set to the agent. Users change rarely, so the full active-user
// list is cached per Zoho account (api_domain) for an hour. Returns null if the
// email is absent or has no matching Zoho user — the caller then leaves the
// owner defaulting rather than failing.
const USER_CACHE_TTL_MS = 60 * 60 * 1000;
const userCaches = new Map<string, { at: number; byEmail: Map<string, string> }>();

async function resolveZohoUserIdByEmail(
  apiDomain: string,
  accessToken: string,
  email: string | null
): Promise<string | null> {
  if (!email) return null;
  const key = email.trim().toLowerCase();
  if (!key) return null;

  let cache = userCaches.get(apiDomain);
  if (!cache || Date.now() - cache.at > USER_CACHE_TTL_MS) {
    const res = await zohoApi(apiDomain, accessToken, `/crm/v8/users?type=ActiveUsers`);
    if (!res.ok) {
      console.warn(`[Zoho] user lookup returned ${res.status}; leaving QA owner default`);
      return null;
    }
    const body = (await res.json().catch(() => null)) as { users?: Array<{ id: string; email?: string }> } | null;
    const byEmail = new Map<string, string>();
    for (const u of body?.users ?? []) {
      if (u.email) byEmail.set(u.email.trim().toLowerCase(), u.id);
    }
    cache = { at: Date.now(), byEmail };
    userCaches.set(apiDomain, cache);
  }
  return cache.byEmail.get(key) ?? null;
}

// Find an existing QA record already linked to this sold-customer record, so we
// update it (adding the AI score to the tenant's human QA marks) rather than
// creating a duplicate. Returns null (→ create) on no match or a search error.
async function findQARecordByCustomer(
  apiDomain: string,
  accessToken: string,
  module: string,
  lookupField: string,
  recordId: string
): Promise<string | null> {
  const criteria = `(${lookupField}:equals:${recordId})`;
  const res = await zohoApi(
    apiDomain,
    accessToken,
    `/crm/v8/${module}/search?criteria=${encodeURIComponent(criteria)}`
  );
  if (res.status === 204) return null;
  if (!res.ok) {
    console.warn(`[Zoho] QA record search returned ${res.status}; will create instead`);
    return null;
  }
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id: string }> } | null;
  return body?.data?.[0]?.id ?? null;
}

// Human-readable "what happened" summary for the QA record's notes field.
function buildQASummary(payload: WebhookJourneyScoredPayload): string {
  const header = `CallGuard AI scored this sale ${payload.overall_score.toFixed(1)}/100 — ${payload.pass ? 'PASS' : 'FAIL'}.`;
  const review = `Review: ${reviewLink(payload)}`;
  if (payload.breaches.length === 0) {
    return [header, 'No compliance breaches detected.', '', review].join('\n');
  }
  const lines = payload.breaches.map(
    (b) => `• [${b.severity.toUpperCase()}] ${b.scorecard_item_label}${b.evidence ? ` — ${b.evidence}` : ''}`
  );
  return [header, '', 'Breaches:', ...lines, '', review].join('\n');
}

/**
 * Write CallGuard's AI compliance score into the tenant's QA module (spec §11).
 * CallGuard fills only its own component — the AI score (and, if configured, a
 * summary) — linked to the sold-customer record; the tenant's formula averages
 * it with their human QA marks. Upserts so it adds to, never duplicates, an
 * existing QA record. Journey/sale-scoped: needs the sold-customer record id
 * carried from the sale trigger, so it no-ops for per-call scores.
 */
async function pushQARecord(
  apiDomain: string,
  accessToken: string,
  conn: ZohoConnectionRow,
  payload: ScoredPayload
): Promise<void> {
  if (!conn.qa_module) return;
  if (!isJourneyPayload(payload)) return;
  const zohoRecordId = payload.zoho_record_id;
  if (!zohoRecordId) return;

  const qa = conn.qa_field_map;
  const record: Record<string, unknown> = {
    [qa.score]: Number(payload.overall_score.toFixed(1)),
    [qa.client_name]: payload.client_name ?? 'Unknown',
    [qa.customer_lookup]: { id: zohoRecordId },
  };
  // Notes field is opt-in — only write the summary if the tenant has configured
  // a field API name for it.
  if (qa.notes) record[qa.notes] = buildQASummary(payload);

  // Agent-name field is opt-in — writes the dialler's agent name as plain text.
  // Unlike Owner (below) this works even when the agent isn't a Zoho user, so
  // the agent is attributed on the QA record regardless. Guarded on both the
  // configured field and a non-null name (older stored field maps lack `agent`).
  if (qa.agent && payload.agent_name) record[qa.agent] = payload.agent_name;

  // Owner = the closing agent, if we can resolve them to a Zoho user.
  const ownerId = await resolveZohoUserIdByEmail(apiDomain, accessToken, payload.agent_email);
  if (ownerId) record.Owner = { id: ownerId };

  const existingId = await findQARecordByCustomer(
    apiDomain,
    accessToken,
    conn.qa_module,
    qa.customer_lookup,
    zohoRecordId
  );
  if (existingId) {
    record.id = existingId;
    const res = await zohoApi(apiDomain, accessToken, `/crm/v8/${conn.qa_module}`, {
      method: 'PUT',
      body: JSON.stringify({ data: [record] }),
    });
    await checkZohoWriteResult(res, 'Zoho QA record update');
  } else {
    const res = await zohoApi(apiDomain, accessToken, `/crm/v8/${conn.qa_module}`, {
      method: 'POST',
      body: JSON.stringify({ data: [record] }),
    });
    await checkZohoWriteResult(res, 'Zoho QA record create');
  }
}

/**
 * Push a scored call or journey into the org's Zoho CRM, if connected.
 * Best-effort: matches the customer by phone, writes the compliance fields
 * and a breach task on the matched Lead/Contact, and independently pushes a
 * QA module record (if configured) regardless of whether a match was found.
 * Records outcome on the connection row; never throws to the caller.
 */
async function pushScoredPayload(organizationId: string, payload: ScoredPayload): Promise<void> {
  const conn = await getConnectionRow(organizationId);
  if (!conn || conn.status !== 'active') return;

  const label = isJourneyPayload(payload) ? `journey ${payload.journey_id}` : `call ${payload.call_id}`;

  let accessToken: string;
  let apiDomain: string;
  try {
    ({ accessToken, apiDomain } = await ensureAccessToken(conn));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Zoho] token refresh failed for ${label}:`, message);
    await query(
      `UPDATE zoho_connections SET last_error = $2, updated_at = now() WHERE organization_id = $1`,
      [organizationId, message.slice(0, 500)]
    ).catch(() => {});
    return;
  }

  // The customer-record (Leads/Contacts) write-back and the QA-module write-back
  // are INDEPENDENT: a tenant may use one, the other, or both. Run each in its
  // own try/catch so, e.g., a Lead missing the compliance custom fields doesn't
  // stop the QA record being written (or vice versa).
  const errors: string[] = [];

  try {
    if (payload.customer_phone) {
      const match = await findRecordByPhone(apiDomain, accessToken, conn.module, payload.customer_phone);
      if (match) {
        await updateRecordScore(apiDomain, accessToken, conn.module, conn.field_map, match.id, payload);

        // Cache the resolved Zoho id so future calls from this number skip the search.
        if (payload.customer_id) {
          await query(
            `UPDATE customers SET external_crm_id = $2
               WHERE id = $1 AND (external_crm_id IS NULL OR external_crm_id = '')`,
            [payload.customer_id, match.id]
          ).catch(() => {});
        }

        if (payload.breaches.length > 0) {
          await createBreachTask(apiDomain, accessToken, match, payload);
        }
        console.log(`[Zoho] wrote score for ${label} → ${conn.module} ${match.id}`);
      } else {
        console.log(`[Zoho] no ${conn.module} match for ${payload.customer_phone} (org ${organizationId}); skipping customer-record write-back`);
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Zoho] customer-record write-back failed for ${label}:`, message);
    errors.push(`record: ${message}`);
  }

  try {
    await pushQARecord(apiDomain, accessToken, conn, payload);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Zoho] QA write-back failed for ${label}:`, message);
    errors.push(`qa: ${message}`);
  }

  if (errors.length > 0) {
    await query(
      `UPDATE zoho_connections SET last_error = $2, updated_at = now() WHERE organization_id = $1`,
      [organizationId, errors.join(' | ').slice(0, 500)]
    ).catch(() => {});
  } else {
    await query(
      `UPDATE zoho_connections SET last_synced_at = now(), last_error = NULL WHERE organization_id = $1`,
      [organizationId]
    ).catch(() => {});
  }
}

export async function pushCallScored(organizationId: string, payload: WebhookCallScoredPayload): Promise<void> {
  return pushScoredPayload(organizationId, payload);
}

export async function pushJourneyScored(organizationId: string, payload: WebhookJourneyScoredPayload): Promise<void> {
  return pushScoredPayload(organizationId, payload);
}

// Lightweight credential check for the UI: refresh the token and hit a cheap
// endpoint. Returns a friendly result rather than throwing.
export async function testConnection(
  organizationId: string
): Promise<{ ok: boolean; message: string }> {
  const conn = await getConnectionRow(organizationId);
  if (!conn) return { ok: false, message: 'No Zoho connection configured' };
  if (conn.status !== 'active') {
    return { ok: false, message: 'Connection not authorised yet — click Connect' };
  }
  try {
    const { accessToken, apiDomain } = await ensureAccessToken(conn);
    const res = await zohoApi(apiDomain, accessToken, `/crm/v8/settings/modules`);
    if (!res.ok) {
      return { ok: false, message: `Zoho returned ${res.status}` };
    }
    return { ok: true, message: `Connected to ${apiDomain.replace('https://', '')}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
