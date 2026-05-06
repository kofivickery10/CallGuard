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
  agentName?: string | null;
  agentId?: string | null;
  customerPhone?: string | null;
  callDate?: string | null;
  externalId?: string | null;
  tags?: string[];
  // When set, the caller picks which scorecard the call should be scored
  // against. Useful for BPOs running multiple campaigns / clients.
  // Validated against the org before being persisted; falls back to the
  // org's active scorecard if null.
  scorecardId?: string | null;
}

export interface IngestedCall {
  call: Call;
  isDuplicate: boolean;
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

  const callId = uuid();
  const fileKey = `calls/${params.organizationId}/${callId}/${params.fileName}`;
  await uploadFile(fileKey, params.buffer, params.mimeType);

  const rows = await query<Call>(
    `INSERT INTO calls (
       id, organization_id, uploaded_by, file_name, file_key,
       file_size_bytes, mime_type, agent_id, agent_name,
       customer_phone, call_date, tags, status,
       external_id, ingestion_source, encrypted_at_rest, scorecard_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'uploaded', $13, $14, true, $15)
     RETURNING *`,
    [
      callId,
      params.organizationId,
      params.uploadedBy ?? null,
      params.fileName,
      fileKey,
      params.buffer.length,
      params.mimeType,
      params.agentId ?? null,
      params.agentName ?? null,
      params.customerPhone ?? null,
      params.callDate ?? null,
      params.tags ?? [],
      params.externalId ?? null,
      params.ingestionSource,
      scorecardId,
    ]
  );

  // Auto-match agent by name if no agent_id was set
  if (!params.agentId && params.agentName) {
    await query(
      `UPDATE calls SET agent_id = u.id
         FROM users u
        WHERE calls.id = $1
          AND u.organization_id = $2
          AND u.role = 'member'
          AND lower(trim(u.name)) = lower(trim($3))`,
      [callId, params.organizationId, params.agentName]
    );
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
