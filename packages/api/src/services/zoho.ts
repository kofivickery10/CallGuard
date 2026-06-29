import { query, queryOne } from '../db/client.js';
import { encrypt, decrypt } from './crypto.js';
import { config } from '../config.js';
import type {
  WebhookCallScoredPayload,
  ZohoFieldMap,
  ZohoModule,
  ZohoRegion,
} from '@callguard/shared';

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

// modules.ALL covers read/update on Leads/Contacts and creating Tasks. offline +
// consent guarantee a refresh token comes back on first authorisation.
const OAUTH_SCOPE = 'ZohoCRM.modules.ALL';

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
  status: 'pending' | 'active' | 'disabled';
}

const ROW_COLUMNS = `id, organization_id, dc_region, client_id,
  client_secret_encrypted, refresh_token_encrypted, access_token_encrypted,
  token_expires_at, api_domain, module, field_map, status`;

export function accountsHost(region: ZohoRegion): string {
  return ZOHO_ACCOUNTS_HOST[region] ?? ZOHO_ACCOUNTS_HOST.eu;
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

async function zohoApi(
  apiDomain: string,
  accessToken: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${apiDomain}${path}`, {
    ...init,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
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
    `/crm/v6/${module}/search?criteria=${encodeURIComponent(criteria)}`
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

async function updateRecordScore(
  apiDomain: string,
  accessToken: string,
  module: ZohoModule,
  fieldMap: ZohoFieldMap,
  recordId: string,
  payload: WebhookCallScoredPayload
): Promise<void> {
  const record: Record<string, unknown> = {
    id: recordId,
    [fieldMap.score]: Number(payload.overall_score.toFixed(1)),
    [fieldMap.result]: payload.pass ? 'Pass' : 'Fail',
    [fieldMap.last_scored]: toZohoDateTime(payload.scored_at),
    [fieldMap.link]: `${config.appUrl}/calls/${payload.call_id}`,
  };

  const res = await zohoApi(apiDomain, accessToken, `/crm/v6/${module}`, {
    method: 'PUT',
    body: JSON.stringify({ data: [record] }),
  });
  if (!res.ok) {
    throw new Error(`Zoho update failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

async function createBreachTask(
  apiDomain: string,
  accessToken: string,
  match: ZohoMatch,
  payload: WebhookCallScoredPayload
): Promise<void> {
  const severities = payload.breaches.map((b) => b.severity);
  const highPriority = severities.some((s) => s === 'critical' || s === 'high');
  const lines = payload.breaches.map(
    (b) => `• [${b.severity.toUpperCase()}] ${b.scorecard_item_label}${b.evidence ? ` — ${b.evidence}` : ''}`
  );

  const due = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const task: Record<string, unknown> = {
    Subject: `Compliance breach on call${payload.agent_name ? ` (${payload.agent_name})` : ''} — ${payload.breaches.length} issue${payload.breaches.length === 1 ? '' : 's'}`,
    Status: 'Not Started',
    Priority: highPriority ? 'High' : 'Normal',
    Due_Date: due,
    Description: [
      `CallGuard scored this call ${payload.overall_score.toFixed(1)} (${payload.pass ? 'PASS' : 'FAIL'}).`,
      '',
      ...lines,
      '',
      `Review: ${config.appUrl}/calls/${payload.call_id}`,
    ].join('\n'),
    // Leads and Contacts both relate to a Task via Who_Id.
    Who_Id: { id: match.id },
  };
  if (match.ownerId) task.Owner = { id: match.ownerId };

  const res = await zohoApi(apiDomain, accessToken, '/crm/v6/Tasks', {
    method: 'POST',
    body: JSON.stringify({ data: [task] }),
  });
  if (!res.ok) {
    throw new Error(`Zoho task create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Push a scored call into the org's Zoho CRM, if connected. Best-effort: matches
 * the customer by phone, writes the compliance fields, and raises a breach task.
 * Records outcome on the connection row; never throws to the caller.
 */
export async function pushCallScored(
  organizationId: string,
  payload: WebhookCallScoredPayload
): Promise<void> {
  const conn = await getConnectionRow(organizationId);
  if (!conn || conn.status !== 'active') return;

  if (!payload.customer_phone) {
    // Nothing to match on — leave a breadcrumb but don't treat as an error.
    await query(
      `UPDATE zoho_connections SET last_synced_at = now() WHERE organization_id = $1`,
      [organizationId]
    );
    return;
  }

  try {
    const { accessToken, apiDomain } = await ensureAccessToken(conn);
    const match = await findRecordByPhone(
      apiDomain,
      accessToken,
      conn.module,
      payload.customer_phone
    );

    if (!match) {
      console.log(
        `[Zoho] no ${conn.module} match for ${payload.customer_phone} (org ${organizationId}); skipping write-back`
      );
      await query(
        `UPDATE zoho_connections SET last_synced_at = now(), last_error = NULL WHERE organization_id = $1`,
        [organizationId]
      );
      return;
    }

    await updateRecordScore(
      apiDomain,
      accessToken,
      conn.module,
      conn.field_map,
      match.id,
      payload
    );

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

    await query(
      `UPDATE zoho_connections SET last_synced_at = now(), last_error = NULL WHERE organization_id = $1`,
      [organizationId]
    );
    console.log(`[Zoho] wrote score for call ${payload.call_id} → ${conn.module} ${match.id}`);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Zoho] write-back failed for call ${payload.call_id}:`, message);
    await query(
      `UPDATE zoho_connections SET last_error = $2, updated_at = now() WHERE organization_id = $1`,
      [organizationId, message.slice(0, 500)]
    ).catch(() => {});
  }
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
    const res = await zohoApi(apiDomain, accessToken, `/crm/v6/settings/modules`);
    if (!res.ok) {
      return { ok: false, message: `Zoho returned ${res.status}` };
    }
    return { ok: true, message: `Connected to ${apiDomain.replace('https://', '')}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
