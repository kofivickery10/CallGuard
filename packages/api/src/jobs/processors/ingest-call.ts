import { Job } from 'bullmq';
import { queryOne } from '../../db/client.js';
import { getDialerConnection } from '../../services/tenant-settings.js';
import { fetchRecordingUrlByCallId, cloudTalkBasicAuthHeader } from '../../services/cloudtalk.js';
import { fetchRemoteAudio, ingestCall } from '../../services/ingestion.js';

export interface IngestCallJobData {
  organizationId: string;
  provider: 'cloudtalk';
  dialerConnectionId: string | null;
  recordingUrl: string | null;
  cloudtalkCallId: string | null;
  externalId: string;
  agentEmail: string | null;
  agentExternalId: string | null;
  agentName: string | null;
  customerPhone: string | null;
  direction: 'inbound' | 'outbound' | null;
}

/**
 * Delayed pull of a dialer recording (spec §4). The webhook route enqueues
 * this with a delay (per-tenant dialer_connections.recording_fetch_delay_seconds,
 * default 60s) rather than fetching inline, since the recording is often
 * still processing on the dialer's side when the "Call Ended" event fires.
 */
export async function processIngestCall(job: Job<IngestCallJobData>) {
  const data = job.data;
  console.log(`[IngestCall] Processing ${data.provider} call ${data.externalId} for org ${data.organizationId}`);

  // Re-check idempotency: a webhook retry that landed before the first
  // delivery's job had run (and thus created no `calls` row yet for the
  // dedup check in routes/ingestion.ts to find) still shares the same
  // BullMQ jobId and is deduped there, but a retry that arrives after this
  // job already completed goes through the same check here.
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM calls WHERE organization_id = $1 AND external_id = $2',
    [data.organizationId, data.externalId]
  );
  if (existing) {
    console.log(`[IngestCall] ${data.externalId} already ingested as ${existing.id}, skipping`);
    return;
  }

  const conn = data.dialerConnectionId
    ? await getDialerConnection(data.organizationId, data.provider)
    : null;

  let recordingUrl = data.recordingUrl;
  if (!recordingUrl && conn && data.cloudtalkCallId) {
    recordingUrl = await fetchRecordingUrlByCallId(conn, data.cloudtalkCallId);
  }
  if (!recordingUrl) {
    // BullMQ will retry (see queue.ts defaultJobOptions) — the recording may
    // simply still be processing on CloudTalk's side.
    throw new Error(
      `No recording URL available yet for ${data.provider} call ${data.externalId}`
    );
  }

  const headers = conn ? cloudTalkBasicAuthHeader(conn) ?? {} : {};
  const downloaded = await fetchRemoteAudio(recordingUrl, headers);

  const { call, isDuplicate } = await ingestCall({
    organizationId: data.organizationId,
    uploadedBy: null,
    fileName: downloaded.fileName,
    buffer: downloaded.buffer,
    mimeType: downloaded.mimeType,
    ingestionSource: 'dialer_webhook',
    agentEmail: data.agentEmail,
    agentExternalId: data.agentExternalId,
    agentName: data.agentName,
    customerPhone: data.customerPhone,
    externalId: data.externalId,
    dialerConnectionId: data.dialerConnectionId,
    direction: data.direction,
  });

  console.log(
    `[IngestCall] ${data.externalId} -> call ${call.id}${isDuplicate ? ' (duplicate)' : ''}`
  );
}
