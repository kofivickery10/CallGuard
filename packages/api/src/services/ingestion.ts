import { v4 as uuid } from 'uuid';
import { query, queryOne } from '../db/client.js';
import { uploadFile } from './storage.js';
import { transcriptionQueue } from '../jobs/queue.js';
import type { Call } from '@callguard/shared';

export interface IngestCallParams {
  organizationId: string;
  uploadedBy?: string | null;  // null for API/SFTP
  fileName: string;
  buffer: Buffer;
  mimeType: string;
  ingestionSource: 'upload' | 'api' | 'sftp';
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
 */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // Already international (caller passed +44...)
  if (raw.trim().startsWith('+')) return `+${digits}`;
  // UK mobile/landline: 07xxx, 01xxx, 02xxx, 03xxx
  if (digits.length === 11 && digits.startsWith('0')) return `+44${digits.slice(1)}`;
  // Assume already without leading 0 / country code prefix
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
  const fileKey = `calls/${params.organizationId}/${callId}/${params.fileName}`;
  await uploadFile(fileKey, params.buffer, params.mimeType);

  const rows = await query<Call>(
    `INSERT INTO calls (
       id, organization_id, uploaded_by, file_name, file_key,
       file_size_bytes, mime_type, agent_id, agent_name,
       customer_phone, customer_id, call_date, tags, status,
       external_id, ingestion_source, encrypted_at_rest, scorecard_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'uploaded', $15, $16, true, $17)
     RETURNING *`,
    [
      callId,
      params.organizationId,
      params.uploadedBy ?? null,
      params.fileName,
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
    ]
  );

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
