import crypto from 'crypto';
import { query, queryOne } from '../db/client.js';
import { encrypt, decrypt } from './crypto.js';
import { config } from '../config.js';
import { notify, recipientsByRole } from './notify.js';
import { alertsQueue } from '../jobs/queue.js';
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
// settings.fields.READ       : read a picklist field's allowed values, to sync
//                              the product catalogue from Zoho (fetchProductPicklist).
// settings.related_lists.READ : discover related-list API names during setup
//                              (zoho introspection), so a tenant needn't dig
//                              them out of the Zoho UI.
// NB: adding scopes requires the tenant to RECONNECT — an existing refresh
// token only carries the scopes it was granted with, so the new metadata reads
// 401 (OAUTH_SCOPE_MISMATCH) until they re-authorise.
const OAUTH_SCOPE =
  'ZohoCRM.modules.ALL,ZohoCRM.settings.modules.READ,ZohoCRM.settings.fields.READ,ZohoCRM.settings.related_lists.READ,ZohoCRM.users.READ';

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
  sale_module: string | null;
  policies_related_list: string | null;
  policy_product_field: string | null;
  // API name of the stage/status field on the policies related list (Zoho
  // Deals' standard "Stage"). Read on the same related-list GET as the product
  // field, so it costs no extra CRM call. Null = not configured; journey branch
  // resolution then falls back to transcript keywords (migration 071).
  policy_stage_field: string | null;
  policies_module: string | null;
  status: 'pending' | 'active' | 'disabled';
}

const ROW_COLUMNS = `id, organization_id, dc_region, client_id,
  client_secret_encrypted, refresh_token_encrypted, access_token_encrypted,
  token_expires_at, api_domain, module, field_map,
  inbound_secret_encrypted, sale_phone_field, qa_module, qa_field_map,
  sale_module, policies_related_list, policy_product_field, policy_stage_field,
  policies_module, status`;

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
  // On errors Zoho names the offending field here, e.g.
  // { api_name: 'Score', json_path: '$.data[0].Score', expected_data_type: 'integer' }.
  // Without it, INVALID_DATA is undiagnosable — surface it in the thrown error.
  details?: Record<string, unknown>;
}

async function checkZohoWriteResult(res: Response, action: string): Promise<void> {
  // Read the body as text first so we can fall back to the raw response when
  // Zoho names no field: a bare "INVALID_DATA / invalid data" with empty
  // details is otherwise undiagnosable.
  const raw = await res.text().catch(() => '');
  let body: { data?: ZohoWriteResult[] } | null = null;
  try {
    body = raw ? (JSON.parse(raw) as { data?: ZohoWriteResult[] }) : null;
  } catch {
    body = null;
  }
  const result = body?.data?.[0];
  if (!res.ok || result?.status === 'error') {
    // Zoho puts the rejected field's api_name (and expected type) in `details`;
    // include it so an INVALID_DATA points at the exact field to fix. When
    // details is empty (Zoho sometimes returns none), fall back to the raw body
    // so the failure is still diagnosable rather than a bare "invalid data".
    const details =
      result?.details && Object.keys(result.details).length > 0
        ? ` (${JSON.stringify(result.details)})`
        : ` [raw: ${raw.slice(0, 600)}]`;
    throw new Error(
      `${action} failed: ${res.status} ${result?.code ?? ''} ${result?.message ?? ''}${details}`.trim()
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

// Outcome of a phone search against Leads/Contacts. Deliberately three-valued
// rather than `ZohoMatch | null`: a caller must not be able to collapse "more
// than one record matched" into "no record matched" — see findRecordByPhone.
export type PhoneMatchResult =
  | { kind: 'found'; match: ZohoMatch }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; recordIds: string[] };

// Search the module by Phone/Mobile across every phone variant.
//
// This used to break a multi-match tie by picking the most recently modified
// record. That is a data-protection defect, not just an accuracy one: shared
// household numbers and company switchboards make multiple matches routine,
// and picking one writes one customer's compliance breach detail — pass/fail
// score, breach evidence — onto a completely different customer's CRM record.
// A wrong guess here is worse than no write at all, because it looks correct:
// nothing fails, nothing retries, and the mistake sits silently on someone
// else's record until a person happens to notice. So an ambiguous search is
// reported to the caller instead of resolved by picking one; the caller must
// skip the write-back and flag it for a human (see pushScoredPayload).
export async function findRecordByPhone(
  apiDomain: string,
  accessToken: string,
  module: ZohoModule,
  phone: string
): Promise<PhoneMatchResult> {
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
  if (res.status === 204) return { kind: 'not_found' }; // Zoho returns 204 for no matches
  if (!res.ok) {
    throw new Error(`Zoho search failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    data?: Array<{ id: string; Modified_Time?: string; Owner?: { id?: string } }>;
  };
  const rows = body.data ?? [];
  if (rows.length === 0) return { kind: 'not_found' };
  if (rows.length > 1) return { kind: 'ambiguous', recordIds: rows.map((r) => r.id) };

  const only = rows[0]!;
  return { kind: 'found', match: { id: only.id, ownerId: only.Owner?.id ?? null } };
}

// Tell admins a phone search matched more than one CRM record, so a person can
// work out which (if any) is the right customer and update it by hand.
// Deduped per organisation+phone so a persistently ambiguous number (e.g. a
// shared office line every call comes in on) raises one notification, not one
// per scored call. Best-effort, matching every other notification path here:
// a failure to notify must not stop the rest of pushScoredPayload running.
async function notifyAmbiguousPhoneMatch(
  organizationId: string,
  module: ZohoModule,
  phone: string,
  recordIds: string[],
  label: string
): Promise<void> {
  try {
    const recipients = await recipientsByRole(organizationId, ['admin']);
    if (recipients.length === 0) return;
    await notify({
      organizationId,
      recipients,
      type: 'zoho.ambiguous_phone_match',
      severity: 'warning',
      title: 'Zoho phone match is ambiguous — nothing was written',
      body:
        `${recordIds.length} ${module} records in Zoho share the phone number ${phone}, found while ` +
        `writing back the compliance score for ${label}. CallGuard does not guess which one is the right ` +
        `customer, so no score or breach task was written. Record ids: ${recordIds.join(', ')}. ` +
        'Resolve the duplicate/shared number in Zoho, then re-run the write-back if needed.',
      dedupeKey: `zoho-ambiguous-${organizationId}-${phone}`,
    });
  } catch (err) {
    console.warn(`[Zoho] could not notify ambiguous phone match: ${(err as Error).message}`);
  }
}

// A related-record field can be a plain picklist/text value or a lookup object
// ({ id, name }). Normalise to the human string we map to products.external_key.
function relatedFieldValue(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (typeof raw === 'object' && 'name' in (raw as Record<string, unknown>)) {
    const name = (raw as { name?: unknown }).name;
    return typeof name === 'string' ? name.trim() || null : null;
  }
  return null;
}

export interface SaleProductsResult {
  // False when the org hasn't configured product resolution (sale_module /
  // policies_related_list / policy_product_field). The caller then skips
  // product-aware scoring entirely rather than polling.
  configured: boolean;
  // Distinct product values read off the related list. Empty with
  // configured=true means the related records don't exist yet (keep polling)
  // — the caller distinguishes this from "not configured".
  products: string[];
  // Distinct stage values off the same records (policy_stage_field), used to
  // resolve the journey's scoring branch. Empty when the field isn't configured
  // or the records carry no value. Multiple policies on one sale can disagree
  // (one on risk, one referred) — the caller decides what to do with that
  // rather than this silently picking one.
  stages: string[];
}

/**
 * Read the products a sale covered off a related module (e.g. Zoho "Policies
 * Sold" linked to the "Customers Sold" record the sale trigger fired from).
 * Best-effort: returns configured=false when the org isn't set up for product
 * resolution, and throws only on an unexpected Zoho error so the caller's poll
 * can retry. The related-list records are read fresh each call — a policy
 * added after the sale trigger fired shows up on a later poll.
 */
export async function fetchSaleProducts(
  organizationId: string,
  recordId: string
): Promise<SaleProductsResult> {
  const conn = await getConnectionRow(organizationId);
  if (
    !conn ||
    conn.status !== 'active' ||
    !conn.sale_module ||
    !conn.policies_related_list ||
    !conn.policy_product_field
  ) {
    return { configured: false, products: [], stages: [] };
  }

  // The stage field rides along on the same request when configured — the
  // journey's scoring branch comes from the CRM's own record of whether the
  // policy went on risk, not from paraphrases in the transcript (migration 071).
  const requestedFields = [conn.policy_product_field, conn.policy_stage_field].filter(
    (f): f is string => !!f
  );

  const { accessToken, apiDomain } = await ensureAccessToken(conn);
  // v8 makes `fields` mandatory on a related-records GET (unlike v2) — omitting
  // it 400s with REQUIRED_PARAM_MISSING rather than defaulting to all fields.
  const res = await zohoApi(
    apiDomain,
    accessToken,
    `/crm/v8/${encodeURIComponent(conn.sale_module)}/${encodeURIComponent(recordId)}/` +
      `${encodeURIComponent(conn.policies_related_list)}?fields=${encodeURIComponent(requestedFields.join(','))}`
  );
  // 204 = the related list exists but has no records yet (policies not created
  // yet — the common case in the gap between the sale and its policies).
  if (res.status === 204) return { configured: true, products: [], stages: [] };
  if (!res.ok) {
    throw new Error(
      `Zoho related-list fetch failed: ${res.status} ${(await res.text()).slice(0, 300)}`
    );
  }

  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const field = conn.policy_product_field;
  const stageField = conn.policy_stage_field;
  const products = new Set<string>();
  const stages = new Set<string>();
  for (const rec of body.data ?? []) {
    const value = relatedFieldValue(rec[field]);
    if (value) products.add(value);
    if (stageField) {
      const stage = relatedFieldValue(rec[stageField]);
      if (stage) stages.add(stage);
    }
  }
  return { configured: true, products: [...products], stages: [...stages] };
}

/**
 * Read the client's name straight off the sale record in the CRM.
 *
 * The sale-trigger webhook is supposed to carry the name, but whether it does
 * depends entirely on how the tenant built their Zoho workflow. Trust Point's
 * sends exactly two fields — `id` and `Phone` — so `client_name` was null on
 * every sale they have ever pushed. The visible consequences: customers showed
 * as a bare phone number in CallGuard, and every QA record written back to
 * their CRM carried the literal fallback "Unknown" (see pushQARecord).
 *
 * We already hold the sale record's id and already call the CRM at assembly for
 * products and stage, so the name costs one more GET against a record we know
 * exists. Reading it here rather than depending on the webhook makes it work for
 * every tenant regardless of how their workflow was configured, and takes the
 * name from the system of record rather than from a payload.
 *
 * Tries the standard Zoho name fields in order of specificity. Returns null
 * rather than throwing on any failure: a missing name must never stop a sale
 * being assembled and scored.
 */
export async function fetchSaleClientName(
  organizationId: string,
  recordId: string
): Promise<string | null> {
  try {
    const conn = await getConnectionRow(organizationId);
    if (!conn || conn.status !== 'active' || !conn.sale_module) return null;

    const { accessToken, apiDomain } = await ensureAccessToken(conn);
    // v8 requires an explicit field list. Full_Name is a Zoho system field on
    // Contacts/Leads; Account_Name covers a sale module keyed to a company, and
    // Name covers custom modules whose primary field is literally "Name".
    const fields = 'Full_Name,First_Name,Last_Name,Name,Account_Name';
    const res = await zohoApi(
      apiDomain,
      accessToken,
      `/crm/v8/${encodeURIComponent(conn.sale_module)}/${encodeURIComponent(recordId)}?fields=${encodeURIComponent(fields)}`
    );
    if (!res.ok) {
      console.warn(`[Zoho] client-name lookup for ${recordId} returned ${res.status}`);
      return null;
    }

    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rec = body.data?.[0];
    if (!rec) return null;

    const direct = relatedFieldValue(rec.Full_Name) ?? relatedFieldValue(rec.Name) ?? relatedFieldValue(rec.Account_Name);
    if (direct) return direct;

    // Fall back to assembling it, for modules that expose the parts but not the
    // composite (custom modules rarely define Full_Name).
    const composed = [relatedFieldValue(rec.First_Name), relatedFieldValue(rec.Last_Name)]
      .filter((p): p is string => !!p)
      .join(' ')
      .trim();
    return composed || null;
  } catch (err) {
    console.warn(`[Zoho] client-name lookup for ${recordId} failed:`, (err as Error).message);
    return null;
  }
}

// ── Attachments (Data Forms reconciliation) ───────────────────────────────────
// The submitted insurer application arrives as a PDF attached to the sale record.
// Reconciliation needs to list what is attached and pull down the one that is
// actually the application — see services/application-pdf.ts for why that choice
// must be made on content rather than filename.

export interface ZohoAttachment {
  id: string;
  file_name: string;
  size: number | null;
  created_time: string | null;
}

export interface SaleAttachmentsResult {
  configured: boolean;
  attachments: ZohoAttachment[];
}

/**
 * List the files attached to a sale record, newest first.
 *
 * Returns `configured: false` rather than throwing when the tenant has no active
 * connection or no sale module set, matching fetchSaleProducts — a tenant part
 * way through Zoho setup should not generate reconciliation failures.
 */
export async function listSaleAttachments(
  organizationId: string,
  recordId: string
): Promise<SaleAttachmentsResult> {
  const conn = await getConnectionRow(organizationId);
  if (!conn || conn.status !== 'active' || !conn.sale_module) {
    return { configured: false, attachments: [] };
  }

  const { accessToken, apiDomain } = await ensureAccessToken(conn);
  const res = await zohoApi(
    apiDomain,
    accessToken,
    // v8 requires `fields` on a related-list read. Without it the call is
    // rejected outright with REQUIRED_PARAM_MISSING, which is how this was found
    // — the first real attachment read against a tenant's CRM returned a 400
    // rather than a list.
    `/crm/v8/${encodeURIComponent(conn.sale_module)}/${encodeURIComponent(recordId)}` +
      `/Attachments?fields=id,File_Name,Size,Created_Time`
  );

  // 204 = the record exists but has nothing attached yet. Expected: the pack is
  // uploaded after the call, so a sale scored promptly will legitimately have no
  // application to reconcile against for a while.
  if (res.status === 204) return { configured: true, attachments: [] };

  // A token issued before a scope widening reads 401 rather than 403. Surface it
  // as a reconnect prompt instead of a generic failure, as the metadata reads do.
  if (res.status === 401) {
    throw new ZohoScopeError(
      'Zoho rejected the attachment read (401). The stored token may predate the ' +
        'scopes needed to read attachments — the tenant needs to reconnect.'
    );
  }
  if (!res.ok) {
    throw new Error(
      `Zoho attachment list failed: ${res.status} ${(await res.text()).slice(0, 300)}`
    );
  }

  const body = (await res.json()) as {
    data?: Array<{
      id?: string;
      File_Name?: string;
      Size?: string | number | null;
      Created_Time?: string | null;
    }>;
  };

  const attachments: ZohoAttachment[] = (body.data ?? [])
    .filter((a): a is { id: string; File_Name: string } & typeof a => !!a.id && !!a.File_Name)
    .map((a) => ({
      id: a.id,
      file_name: a.File_Name,
      size: a.Size == null ? null : Number(a.Size) || null,
      created_time: a.Created_Time ?? null,
    }));

  // Newest first: where an application has been amended and re-uploaded, the
  // latest is the one that was actually submitted. Reconciling against a
  // superseded copy would report mismatches that were already corrected.
  attachments.sort((a, b) => (b.created_time ?? '').localeCompare(a.created_time ?? ''));

  return { configured: true, attachments };
}

/**
 * Download one attachment as a Buffer.
 *
 * Unlike every other Zoho call in this file the response body is binary, not
 * JSON, so it is read with arrayBuffer(). `maxBytes` guards against pulling
 * something unexpectedly large into memory — application packs run to tens of
 * pages, not hundreds of megabytes.
 */
export async function downloadSaleAttachment(
  organizationId: string,
  recordId: string,
  attachmentId: string,
  maxBytes = 25 * 1024 * 1024
): Promise<Buffer> {
  const conn = await getConnectionRow(organizationId);
  if (!conn || conn.status !== 'active' || !conn.sale_module) {
    throw new Error('Zoho connection is not configured for attachment download');
  }

  const { accessToken, apiDomain } = await ensureAccessToken(conn);
  const res = await zohoApi(
    apiDomain,
    accessToken,
    `/crm/v8/${encodeURIComponent(conn.sale_module)}/${encodeURIComponent(recordId)}/` +
      `Attachments/${encodeURIComponent(attachmentId)}`
  );

  if (res.status === 401) {
    throw new ZohoScopeError(
      'Zoho rejected the attachment download (401) — the tenant may need to reconnect.'
    );
  }
  if (!res.ok) {
    throw new Error(
      `Zoho attachment download failed: ${res.status} ${(await res.text()).slice(0, 300)}`
    );
  }

  const declared = Number(res.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Attachment ${attachmentId} is ${declared} bytes, over the ${maxBytes} limit`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  // Content-Length is advisory; check what actually arrived too.
  if (buf.byteLength > maxBytes) {
    throw new Error(`Attachment ${attachmentId} is ${buf.byteLength} bytes, over the ${maxBytes} limit`);
  }
  return buf;
}

// Raised when a metadata read fails because the token predates the widened
// scope (OAUTH_SCOPE) — the tenant must reconnect. Surfaced distinctly so the
// UI can prompt for a reconnect rather than showing a generic error.
export class ZohoScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZohoScopeError';
  }
}

export interface PicklistValue {
  // The stored value (matches products.external_key / a sale's Product value).
  value: string;
  // The human label shown in Zoho (used as the product display name).
  label: string;
}

export interface ProductPicklistResult {
  // False when the org hasn't configured the picklist source (policies_module /
  // policy_product_field) — the caller skips catalogue sync.
  configured: boolean;
  values: PicklistValue[];
}

/**
 * Read the allowed values of the product picklist field off its module's
 * metadata (`/settings/fields`), so the product catalogue can mirror Zoho.
 * Distinct from fetchSaleProducts (which reads a specific sale's policies):
 * this is the full set of possible products. Throws ZohoScopeError when the
 * connection needs reconnecting for the widened metadata scope.
 */
export async function fetchProductPicklist(
  organizationId: string
): Promise<ProductPicklistResult> {
  const conn = await getConnectionRow(organizationId);
  if (!conn || conn.status !== 'active' || !conn.policies_module || !conn.policy_product_field) {
    return { configured: false, values: [] };
  }

  const { accessToken, apiDomain } = await ensureAccessToken(conn);
  const res = await zohoApi(
    apiDomain,
    accessToken,
    `/crm/v8/settings/fields?module=${encodeURIComponent(conn.policies_module)}`
  );
  if (res.status === 401) {
    const text = (await res.text()).slice(0, 300);
    throw new ZohoScopeError(
      `Zoho denied field metadata (401) — the connection likely needs reconnecting to grant products read access. ${text}`
    );
  }
  if (!res.ok) {
    throw new Error(`Zoho fields metadata fetch failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    fields?: Array<{
      api_name?: string;
      pick_list_values?: Array<{ display_value?: string; actual_value?: string }>;
    }>;
  };
  const field = (body.fields ?? []).find((f) => f.api_name === conn.policy_product_field);
  if (!field) {
    throw new Error(`Field "${conn.policy_product_field}" not found on module "${conn.policies_module}"`);
  }

  const values: PicklistValue[] = [];
  const seen = new Set<string>();
  for (const pv of field.pick_list_values ?? []) {
    // actual_value is what a record stores (our external_key); fall back to
    // display_value for fields where they coincide. Skip Zoho's "-None-".
    const value = (pv.actual_value ?? pv.display_value ?? '').trim();
    const label = (pv.display_value ?? pv.actual_value ?? '').trim();
    if (!value || value === '-None-' || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push({ value, label: label || value });
  }
  return { configured: true, values };
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
    // Rounded to an integer: a Zoho number field typed as Integer rejects a
    // decimal (400 INVALID_DATA), and an integer is valid for a decimal field
    // too — so rounding is safe whatever the tenant's field type.
    [fieldMap.score]: Math.round(payload.overall_score),
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
// list is cached for an hour. Returns null if the email is absent or has no
// matching Zoho user — the caller then leaves the owner defaulting rather than
// failing.
const USER_CACHE_TTL_MS = 60 * 60 * 1000;
// Keyed by organisation, composed with api_domain — NOT api_domain alone.
// api_domain is a Zoho data-centre host (www.zohoapis.eu, www.zohoapis.com,
// …), not a tenant boundary: every EU tenant's connection resolves to the same
// domain, so keying the cache on it alone meant one org's cached user list —
// and its hour-long TTL window — was silently served to every other org on
// that data centre. api_domain still rides along in the key alongside the org
// id because a connection's data centre can change on reconnect; dropping it
// would let a stale cross-region cache entry survive that.
const userCaches = new Map<string, { at: number; byEmail: Map<string, string> }>();

export async function resolveZohoUserIdByEmail(
  organizationId: string,
  apiDomain: string,
  accessToken: string,
  email: string | null
): Promise<string | null> {
  if (!email) return null;
  const key = email.trim().toLowerCase();
  if (!key) return null;

  const cacheKey = `${organizationId}:${apiDomain}`;
  let cache = userCaches.get(cacheKey);
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
    userCaches.set(cacheKey, cache);
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
    // Integer: the QA score field may be typed Integer in Zoho (e.g. Trust
    // Point's AI_Call_Score), which rejects a decimal. Safe for a decimal field too.
    [qa.score]: Math.round(payload.overall_score),
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
  const ownerId = await resolveZohoUserIdByEmail(conn.organization_id, apiDomain, accessToken, payload.agent_email);
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

// ── Per-call/journey delivery tracking + retry ────────────────────────────────
// zoho_connections.last_error only ever holds the LATEST problem across the
// whole connection — a failed write-back for one call is silently overwritten
// by the next call's success. zoho_deliveries (migration 097) fixes that: one
// row per call/journey per write-back target (`kind`), recording every
// attempt's outcome rather than just the connection's current state. Mirrors
// webhook_deliveries (migration 013) — same column shape, same "insert
// pending, update in place as attempts happen" pattern.

type ZohoDeliveryKind = 'record' | 'qa';

interface ZohoDeliveryOutcome {
  status: 'delivered' | 'failed' | 'skipped';
  // Updated target description — e.g. the resolved Leads/Contacts id once a
  // match is found. Falls back to the row's original target when omitted.
  target?: string;
  retryable: boolean;
  errorMessage?: string;
}

// Buckets a write-back failure into "worth retrying later" or "needs a
// person". Deliberately conservative: only a transport error (fetch never got
// a response) or the same statuses zohoApi already retries inline (429, 5xx)
// count as retryable. Everything else — an expired/revoked token (401/403), a
// rejected field or a record that no longer exists (4xx from
// checkZohoWriteResult) — would just fail the same way again, so retrying
// blindly would only delay a person finding out. classify* never sees the
// 'ambiguous' phone-match outcome: that is not an error at all (see
// findRecordByPhone) and is recorded as 'skipped', not run through this.
function classifyZohoFailure(err: unknown): { retryable: boolean } {
  if (err instanceof ZohoScopeError) return { retryable: false };
  const message = (err as Error)?.message ?? String(err);
  if (/not authorised|no refresh token/i.test(message)) return { retryable: false };

  const statusMatch = message.match(/\b(\d{3})\b/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 429 || (status !== null && status >= 500 && status < 600)) {
    return { retryable: true };
  }
  if (status !== null && status >= 400 && status < 500) return { retryable: false };

  // No status code in the message at all means the fetch itself threw
  // (DNS/connection reset/timeout) before a response ever came back — exactly
  // the kind of blip a delayed retry can ride out.
  return { retryable: true };
}

// Widening backoff (minutes) for queued retries of a failed delivery: 2, 10,
// then 30 minutes — three attempts beyond the original, generous enough to
// ride out a Zoho outage or a temporarily-exhausted rate limit without
// hammering it. Capped, not unbounded: past this a delivery is left 'failed'
// for a person to find via zoho_deliveries rather than retried forever.
const ZOHO_RETRY_BACKOFF_MINUTES = [2, 10, 30];

async function startZohoDelivery(params: {
  organizationId: string;
  callId: string | null;
  journeyId: string | null;
  kind: ZohoDeliveryKind;
  target: string;
  payload: ScoredPayload;
}): Promise<string | null> {
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO zoho_deliveries
         (organization_id, call_id, journey_id, kind, target, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [
        params.organizationId,
        params.callId,
        params.journeyId,
        params.kind,
        params.target,
        JSON.stringify(params.payload),
      ]
    );
    return row?.id ?? null;
  } catch (err) {
    console.warn(`[Zoho] could not record delivery start (${params.kind}):`, (err as Error).message);
    return null;
  }
}

async function finishZohoDelivery(deliveryId: string | null, outcome: ZohoDeliveryOutcome): Promise<void> {
  if (!deliveryId) return;
  await query(
    `UPDATE zoho_deliveries
        SET status = $2,
            target = COALESCE($3, target),
            retryable = $4,
            last_error = $5,
            attempts = attempts + 1,
            last_attempt_at = now(),
            delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END
      WHERE id = $1`,
    [deliveryId, outcome.status, outcome.target ?? null, outcome.retryable, outcome.errorMessage ?? null]
  ).catch((err) => {
    console.warn(`[Zoho] could not record delivery outcome for ${deliveryId}:`, (err as Error).message);
  });
}

// Enqueue the next retry attempt on the alerts queue (same home as every
// other best-effort delivery job here — notify-email, alert-rule delivery).
// `nextAttempt` is 1-indexed into ZOHO_RETRY_BACKOFF_MINUTES; past the end of
// the schedule this is a no-op and the delivery is left 'failed' for a
// person to find.
async function scheduleZohoRetry(deliveryId: string, nextAttempt: number): Promise<void> {
  if (nextAttempt > ZOHO_RETRY_BACKOFF_MINUTES.length) return;
  const delayMs = ZOHO_RETRY_BACKOFF_MINUTES[nextAttempt - 1]! * 60_000;
  await alertsQueue
    .add('zoho-retry', { deliveryId, attempt: nextAttempt }, { delay: delayMs })
    .catch((err) => {
      console.warn(`[Zoho] failed to schedule delivery retry ${deliveryId}:`, (err as Error).message);
    });
}

// Attempts the customer-record (Leads/Contacts) write-back: match by phone,
// write the score fields, and (if there are breaches) create a task. Factored
// out of pushScoredPayload so retryZohoDelivery can run exactly the same
// logic against a stored payload, rather than a parallel copy that could
// drift from what the original attempt did.
async function attemptRecordWriteBack(
  apiDomain: string,
  accessToken: string,
  conn: ZohoConnectionRow,
  payload: ScoredPayload,
  label: string
): Promise<ZohoDeliveryOutcome> {
  try {
    const result = await findRecordByPhone(apiDomain, accessToken, conn.module, payload.customer_phone!);
    if (result.kind === 'found') {
      const match = result.match;
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
      return { status: 'delivered', target: `${conn.module}:${match.id}`, retryable: false };
    }

    if (result.kind === 'ambiguous') {
      // Do NOT write back and do NOT pick one — see findRecordByPhone for why
      // guessing is worse than doing nothing here. Recorded as 'skipped', not
      // 'failed': there is nothing a retry could resolve on its own, this
      // needs a person to sort out the duplicate/shared number in Zoho first.
      console.warn(
        `[Zoho] ${result.recordIds.length} ${conn.module} records matched ${payload.customer_phone} ` +
          `for ${label}; skipping write-back rather than guessing which customer it is`
      );
      await notifyAmbiguousPhoneMatch(conn.organization_id, conn.module, payload.customer_phone!, result.recordIds, label);
      return {
        status: 'skipped',
        target: `${conn.module} (ambiguous match: ${result.recordIds.length} records)`,
        retryable: false,
        errorMessage: `ambiguous phone match (${result.recordIds.length} ${conn.module} records) — skipped, needs manual resolution`,
      };
    }

    console.log(`[Zoho] no ${conn.module} match for ${payload.customer_phone} (org ${conn.organization_id}); skipping customer-record write-back`);
    return { status: 'skipped', target: `${conn.module} (no match for phone)`, retryable: false };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Zoho] customer-record write-back failed for ${label}:`, message);
    return {
      status: 'failed',
      target: `${conn.module} (phone ${payload.customer_phone})`,
      retryable: classifyZohoFailure(err).retryable,
      errorMessage: message,
    };
  }
}

// Attempts the QA-module write-back. Thin wrapper around pushQARecord so
// retryZohoDelivery can re-run it from a stored payload the same way
// attemptRecordWriteBack does for the customer-record side.
async function attemptQAWriteBack(
  apiDomain: string,
  accessToken: string,
  conn: ZohoConnectionRow,
  payload: ScoredPayload,
  label: string
): Promise<ZohoDeliveryOutcome> {
  try {
    await pushQARecord(apiDomain, accessToken, conn, payload);
    return { status: 'delivered', target: conn.qa_module ?? 'qa', retryable: false };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Zoho] QA write-back failed for ${label}:`, message);
    return {
      status: 'failed',
      target: conn.qa_module ?? 'qa',
      retryable: classifyZohoFailure(err).retryable,
      errorMessage: message,
    };
  }
}

function deliveryCallAndJourneyIds(payload: ScoredPayload): { callId: string | null; journeyId: string | null } {
  return isJourneyPayload(payload)
    ? { callId: null, journeyId: payload.journey_id }
    : { callId: payload.call_id, journeyId: null };
}

/**
 * Re-attempt a previously failed Zoho write-back, enqueued by
 * scheduleZohoRetry with backoff. Reads the original payload straight off the
 * delivery row rather than recomputing the score, so a retry writes exactly
 * what the original attempt tried to. Never throws — a bad retry must not
 * crash the alerts worker; it records the outcome and, if still retryable
 * with attempts left in the schedule, queues the next one.
 */
export async function retryZohoDelivery(deliveryId: string, attempt: number): Promise<void> {
  const row = await queryOne<{
    id: string;
    organization_id: string;
    call_id: string | null;
    journey_id: string | null;
    kind: ZohoDeliveryKind;
    status: string;
    payload: ScoredPayload;
  }>(
    `SELECT id, organization_id, call_id, journey_id, kind, status, payload
       FROM zoho_deliveries WHERE id = $1`,
    [deliveryId]
  );
  if (!row) return;
  // Already resolved — by this same retry racing a concurrent one, or by a
  // fresh push for a rescored call/journey. Nothing to do.
  if (row.status === 'delivered' || row.status === 'skipped') return;

  const label = row.journey_id ? `journey ${row.journey_id}` : `call ${row.call_id}`;

  const conn = await getConnectionRow(row.organization_id);
  if (!conn || conn.status !== 'active') {
    await finishZohoDelivery(deliveryId, {
      status: 'failed',
      retryable: false,
      errorMessage: 'Zoho connection is no longer active',
    });
    return;
  }

  let accessToken: string;
  let apiDomain: string;
  try {
    ({ accessToken, apiDomain } = await ensureAccessToken(conn));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Zoho] retry ${deliveryId}: token refresh failed for ${label}:`, message);
    const { retryable } = classifyZohoFailure(err);
    await finishZohoDelivery(deliveryId, { status: 'failed', retryable, errorMessage: message });
    if (retryable) await scheduleZohoRetry(deliveryId, attempt + 1);
    return;
  }

  const outcome =
    row.kind === 'record'
      ? await attemptRecordWriteBack(apiDomain, accessToken, conn, row.payload, label)
      : await attemptQAWriteBack(apiDomain, accessToken, conn, row.payload, label);

  await finishZohoDelivery(deliveryId, outcome);

  if (outcome.status === 'failed' && outcome.retryable) {
    await scheduleZohoRetry(deliveryId, attempt + 1);
  }
}

/**
 * Push a scored call or journey into the org's Zoho CRM, if connected.
 * Best-effort: matches the customer by phone, writes the compliance fields
 * and a breach task on the matched Lead/Contact, and independently pushes a
 * QA module record (if configured) regardless of whether a match was found.
 * Records outcome on the connection row (last_error — the connection's most
 * recent problem) and, per target, on zoho_deliveries (every attempt, not
 * just the latest — see the section above). Never throws to the caller.
 */
async function pushScoredPayload(organizationId: string, payload: ScoredPayload): Promise<void> {
  const conn = await getConnectionRow(organizationId);
  if (!conn || conn.status !== 'active') return;

  const label = isJourneyPayload(payload) ? `journey ${payload.journey_id}` : `call ${payload.call_id}`;
  const { callId, journeyId } = deliveryCallAndJourneyIds(payload);

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

  if (payload.customer_phone) {
    const deliveryId = await startZohoDelivery({
      organizationId,
      callId,
      journeyId,
      kind: 'record',
      target: `${conn.module} (phone ${payload.customer_phone})`,
      payload,
    });

    const outcome = await attemptRecordWriteBack(apiDomain, accessToken, conn, payload, label);
    await finishZohoDelivery(deliveryId, outcome);
    if (outcome.errorMessage) errors.push(`record: ${outcome.errorMessage}`);
    if (outcome.status === 'failed' && outcome.retryable && deliveryId) {
      await scheduleZohoRetry(deliveryId, 1);
    }
  }

  // Same three preconditions pushQARecord checks itself — gated here too so a
  // delivery row is only created for a write-back that was actually attempted
  // (matches webhook_deliveries: no row when nothing was configured to send).
  const qaZohoRecordId = isJourneyPayload(payload) ? payload.zoho_record_id : null;
  if (conn.qa_module && qaZohoRecordId) {
    const deliveryId = await startZohoDelivery({
      organizationId,
      callId,
      journeyId,
      kind: 'qa',
      target: `${conn.qa_module} (customer ${qaZohoRecordId})`,
      payload,
    });

    const outcome = await attemptQAWriteBack(apiDomain, accessToken, conn, payload, label);
    await finishZohoDelivery(deliveryId, outcome);
    if (outcome.errorMessage) errors.push(`qa: ${outcome.errorMessage}`);
    if (outcome.status === 'failed' && outcome.retryable && deliveryId) {
      await scheduleZohoRetry(deliveryId, 1);
    }
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
