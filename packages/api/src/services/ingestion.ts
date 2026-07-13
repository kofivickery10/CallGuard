import { v4 as uuid } from 'uuid';
import path from 'path';
import { query, queryOne } from '../db/client.js';
import { uploadFile } from './storage.js';
import { transcriptionQueue } from '../jobs/queue.js';
import { AppError } from '../middleware/errors.js';
import { assertSafeRemoteUrl } from './url-safety.js';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from '@callguard/shared';
import type { Call } from '@callguard/shared';

export interface IngestCallParams {
  organizationId: string;
  uploadedBy?: string | null;  // null for API/SFTP
  fileName: string;
  buffer: Buffer;
  mimeType: string;
  ingestionSource: 'upload' | 'api' | 'sftp' | 'dialer_webhook';
  dialerConnectionId?: string | null;
  // Agent attribution. Any of these may be supplied by a dialler; they are
  // resolved to a CallGuard adviser in precedence order (see resolveAgent).
  agentName?: string | null;
  agentId?: string | null;        // CallGuard user id
  agentEmail?: string | null;     // adviser's email (most diallers send this)
  agentExternalId?: string | null; // the dialler's own agent id (mapped via users.external_agent_id)
  customerPhone?: string | null;
  customerName?: string | null;
  customerExternalCrmId?: string | null;
  callDate?: string | null;
  externalId?: string | null;
  tags?: string[];
  // When set, the caller picks which scorecard the call should be scored
  // against. Useful for BPOs running multiple campaigns / clients.
  // Validated against the org before being persisted; falls back to the
  // org's active scorecard if null.
  scorecardId?: string | null;
}

/**
 * Normalise a phone number to E.164 (best-effort, UK-biased).
 * Returns null if the input is empty/whitespace-only.
 *
 * Must produce the SAME output for the same real number regardless of source
 * format — CloudTalk and Zoho send the same customer in different shapes
 * ("00447…", "+44 (0)7…", "07…"), and journey matching keys off the result,
 * so any divergence silently strands a sale's journey (never scored).
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // "+" and the "00" international access prefix both mean an international
  // number follows. Collapse "00" to the "+" form, then normalise once.
  if (trimmed.startsWith('+') || digits.startsWith('00')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    // A national trunk '0' written after the UK country code, e.g.
    // "+44 (0)7911 123456" -> 4407911123456 -> 447911123456.
    if (digits.startsWith('440')) digits = `44${digits.slice(3)}`;
    return `+${digits}`;
  }

  // National format with a trunk 0 (07xxx / 01xxx / 02xxx / 03xxx) -> UK.
  if (digits.startsWith('0')) return `+44${digits.slice(1)}`;

  // No '+', no '00', no leading '0'. Ambiguous. UK-bias (UK product): a
  // 10-digit number is a UK subscriber number with the trunk 0 dropped;
  // anything else is assumed to already carry a country code.
  if (digits.length === 10) return `+44${digits}`;
  return `+${digits}`;
}

/**
 * Upsert a customer record based on normalised phone. Returns the customer id.
 */
async function upsertCustomer(
  organizationId: string,
  phone: string,
  name?: string | null,
  externalCrmId?: string | null
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO customers (organization_id, phone_normalized, name, external_crm_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, phone_normalized)
     DO UPDATE SET
       last_seen_at     = now(),
       name             = COALESCE(EXCLUDED.name, customers.name),
       external_crm_id  = COALESCE(EXCLUDED.external_crm_id, customers.external_crm_id)
     RETURNING id`,
    [organizationId, phone, name ?? null, externalCrmId ?? null]
  );
  return rows[0]!.id;
}

export interface IngestedCall {
  call: Call;
  isDuplicate: boolean;
}

/**
 * Resolve a dialler-supplied agent identifier to a CallGuard adviser, so calls
 * attribute correctly regardless of which dialler / CRM the customer uses.
 * Precedence: explicit CallGuard user id > email > the dialler's external agent
 * id (users.external_agent_id) > display name. All scoped to the org. Returns
 * the linked user id (or null) plus a display name to store on the call.
 */
async function resolveAgent(
  organizationId: string,
  p: Pick<IngestCallParams, 'agentId' | 'agentEmail' | 'agentExternalId' | 'agentName'>
): Promise<{ agentId: string | null; agentName: string | null }> {
  const lookups: Array<[string, string] | null> = [
    p.agentId ? ['id = $2', p.agentId] : null,
    p.agentEmail ? ['lower(email) = lower($2)', p.agentEmail] : null,
    p.agentExternalId ? ['external_agent_id = $2', p.agentExternalId] : null,
    p.agentName ? ['lower(trim(name)) = lower(trim($2))', p.agentName] : null,
  ];

  for (const lookup of lookups) {
    if (!lookup) continue;
    const [clause, value] = lookup;
    const user = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE organization_id = $1 AND ${clause} LIMIT 1`,
      [organizationId, value]
    );
    if (user) return { agentId: user.id, agentName: user.name };
  }

  // No adviser matched - keep the supplied name for display, leave unlinked.
  return { agentId: null, agentName: p.agentName ?? null };
}

/**
 * Unified call ingestion: store the file, create the calls row, auto-match agent,
 * enqueue transcription. Used by manual upload, API ingestion, and SFTP polling.
 * Idempotent by externalId - re-ingesting with the same (org, externalId) returns
 * the existing call instead of creating a duplicate.
 */
export async function ingestCall(params: IngestCallParams): Promise<IngestedCall> {
  // Idempotency check
  if (params.externalId) {
    const existing = await queryOne<Call>(
      'SELECT * FROM calls WHERE organization_id = $1 AND external_id = $2',
      [params.organizationId, params.externalId]
    );
    if (existing) return { call: existing, isDuplicate: true };
  }

  // Validate scorecard_id (if provided) belongs to this org
  let scorecardId: string | null = null;
  if (params.scorecardId) {
    const scorecard = await queryOne<{ id: string }>(
      'SELECT id FROM scorecards WHERE id = $1 AND organization_id = $2',
      [params.scorecardId, params.organizationId]
    );
    if (!scorecard) {
      throw new Error(`Scorecard ${params.scorecardId} not found for this organization`);
    }
    scorecardId = scorecard.id;
  }

  // Resolve the agent (dialler-agnostic) before inserting.
  const { agentId, agentName } = await resolveAgent(params.organizationId, params);

  // Upsert customer by normalised phone if one was provided.
  let customerId: string | null = null;
  if (params.customerPhone) {
    const normalised = normalizePhone(params.customerPhone);
    if (normalised) {
      customerId = await upsertCustomer(
        params.organizationId,
        normalised,
        params.customerName,
        params.customerExternalCrmId
      );
    }
  }

  const callId = uuid();
  // path.basename strips any directory component a crafted/dialler-supplied
  // filename (e.g. "../../../etc/x") would otherwise carry into the storage
  // key — this is the shared entry point for API, CloudTalk and SFTP ingest.
  const safeFileName = path.basename(params.fileName);
  const fileKey = `calls/${params.organizationId}/${callId}/${safeFileName}`;
  await uploadFile(fileKey, params.buffer, params.mimeType);

  let rows: Call[];
  try {
    rows = await query<Call>(
      `INSERT INTO calls (
         id, organization_id, uploaded_by, file_name, file_key,
         file_size_bytes, mime_type, agent_id, agent_name,
         customer_phone, customer_id, call_date, tags, status,
         external_id, ingestion_source, encrypted_at_rest, scorecard_id,
         dialer_connection_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'uploaded', $14, $15, true, $16, $17)
       RETURNING *`,
      [
        callId,
        params.organizationId,
        params.uploadedBy ?? null,
        safeFileName,
        fileKey,
        params.buffer.length,
        params.mimeType,
        agentId,
        agentName,
        params.customerPhone ?? null,
        customerId,
        params.callDate ?? null,
        params.tags ?? [],
        params.externalId ?? null,
        params.ingestionSource,
        scorecardId,
        params.dialerConnectionId ?? null,
      ]
    );
  } catch (err) {
    // Two concurrent deliveries of the same webhook both pass the
    // idempotency SELECT above before either INSERTs (TOCTOU) — the second
    // hits idx_calls_org_external_id instead of erroring out to the caller.
    // Treat that race the same as the idempotency check: return the row the
    // other request just created.
    if (params.externalId && (err as { code?: string }).code === '23505') {
      const existing = await queryOne<Call>(
        'SELECT * FROM calls WHERE organization_id = $1 AND external_id = $2',
        [params.organizationId, params.externalId]
      );
      if (existing) return { call: existing, isDuplicate: true };
    }
    throw err;
  }

  await transcriptionQueue.add('transcribe', { callId }, { jobId: callId });

  return { call: rows[0]!, isDuplicate: false };
}

// Infer a content type from a filename extension
export function inferMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'm4a':
      return 'audio/x-m4a';
    default:
      return 'application/octet-stream';
  }
}

// Read a fetch Response body, aborting once it exceeds maxBytes. A
// Content-Length check alone isn't enough — it can be absent or lie; this
// enforces the cap against the actual bytes received.
async function readWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > maxBytes) {
    throw new AppError(400, `Remote file exceeds the ${MAX_FILE_SIZE_MB}MB limit`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new AppError(400, `Remote file exceeds the ${MAX_FILE_SIZE_MB}MB limit`);
    }
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AppError(400, `Remote file exceeds the ${MAX_FILE_SIZE_MB}MB limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a caller-supplied audio URL (API ingest, bulk-import, CloudTalk
 * recording_url) safely: HTTPS + public-address only (see url-safety.ts), no
 * redirect-following (an attacker-controlled 3xx could otherwise point at an
 * internal address after the check already passed), and a hard size cap
 * enforced against the actual stream, not just a trusted Content-Length.
 */
export async function fetchRemoteAudio(
  rawUrl: string,
  headers: Record<string, string> = {}
): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const url = await assertSafeRemoteUrl(rawUrl);

  const res = await fetch(url, {
    ...(Object.keys(headers).length ? { headers } : {}),
    redirect: 'manual',
  });

  if (res.status >= 300 && res.status < 400) {
    throw new AppError(400, 'Redirects are not followed for remote audio URLs');
  }
  if (!res.ok) {
    throw new AppError(400, `Failed to download audio from URL: ${res.status} ${res.statusText}`);
  }

  const buffer = await readWithLimit(res, MAX_FILE_SIZE_BYTES);

  const pathParts = url.pathname.split('/');
  const lastPart = pathParts[pathParts.length - 1] || 'call.mp3';
  const fileName = lastPart.includes('.') ? lastPart : `${lastPart}.mp3`;
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || inferMimeType(fileName);

  return { buffer, fileName, mimeType };
}
