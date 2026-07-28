import { v4 as uuid } from 'uuid';
import path from 'path';
import { query, queryOne } from '../db/client.js';
import { uploadFile } from './storage.js';
import { transcriptionQueue } from '../jobs/queue.js';
import { AppError } from '../middleware/errors.js';
import { assertSafeRemoteUrl } from './url-safety.js';
import { isVideoMedia, prepareMediaForIngest } from './media.js';
import { MAX_FILE_SIZE_BYTES, MAX_VIDEO_FILE_SIZE_BYTES } from '@callguard/shared';
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
  // The dialler's own numeric call id (migration 075). Recorded alongside
  // externalId so a call captured live and the same call seen later through the
  // history API resolve to one row — the two routes disagree on what goes in
  // externalId. Null for non-dialler sources.
  dialerCallId?: string | null;
  tags?: string[];
  // Call direction, when the dialler's payload carries it (see
  // routes/ingestion.ts's DialerFieldMap.direction) — null when absent/
  // unrecognised, in which case transcription falls back to the org's
  // mono_first_speaker default for the mono-diarisation speaker guess.
  direction?: 'inbound' | 'outbound' | null;
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

  // Resolve to bare international digits (no '+'), then collapse once below.
  if (trimmed.startsWith('+') || digits.startsWith('00')) {
    // "+" and the "00" access prefix both mean an international number follows.
    if (digits.startsWith('00')) digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    // National format with a trunk 0 (07xxx / 01xxx / 02xxx / 03xxx) -> UK.
    digits = `44${digits.slice(1)}`;
  } else if (digits.length === 10) {
    // No '+', no '00', no leading '0'. UK-bias (UK product): a 10-digit number
    // is a UK subscriber number with the trunk 0 dropped. Anything longer is
    // assumed to already carry a country code (handled by the collapse below).
    digits = `44${digits}`;
  }

  // Collapse a spurious UK trunk '0' written after the country code, however
  // it arrived — "+44 (0)7911…" -> 4407911… , or a CRM that stored the number
  // as "44" + the full national number without stripping the leading 0
  // ("4407800728124"). A real UK national significant number never starts with
  // 0, so a leading "440" is always a mis-inserted trunk zero. Without this,
  // such a number normalises to "+4407800728124" and never matches the same
  // customer's CloudTalk calls (which come through as "+447800728124").
  if (digits.startsWith('440')) digits = `44${digits.slice(3)}`;

  return `+${digits}`;
}

// Find the first non-empty string at any of the candidate keys, checking the
// body and one level of common nesting (call / Call / data / payload). Used to
// read loosely-shaped external webhook payloads (dialler + Zoho sale trigger)
// where the same value can arrive under different key names.
export function pickField(body: Record<string, unknown>, keys: string[]): string | null {
  const containers: Record<string, unknown>[] = [body];
  for (const c of ['call', 'Call', 'data', 'payload']) {
    const nested = body[c];
    if (nested && typeof nested === 'object') containers.push(nested as Record<string, unknown>);
  }
  for (const container of containers) {
    for (const key of keys) {
      const v = container[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
  }
  return null;
}

/**
 * Upsert a customer record based on normalised phone. Returns the customer id.
 */
export async function upsertCustomer(
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
 * Find a call already on file under either identity key.
 *
 * A CloudTalk call has two identifiers and which one we hold depends on how it
 * reached us: the live webhook records `call_uuid` in external_id, the history
 * API records the numeric CDR id. Checking only external_id is what made
 * backfilling duplicate every call already captured live (migration 075).
 *
 * The NULL guards matter: without them a null parameter would match every row
 * whose column is also null.
 */
async function findExistingCall(
  organizationId: string,
  externalId: string | null | undefined,
  dialerCallId: string | null | undefined
): Promise<Call | null> {
  if (!externalId && !dialerCallId) return null;
  return queryOne<Call>(
    `SELECT * FROM calls
      WHERE organization_id = $1
        AND (($2::text IS NOT NULL AND external_id = $2)
          OR ($3::text IS NOT NULL AND dialer_call_id = $3))
      LIMIT 1`,
    [organizationId, externalId ?? null, dialerCallId ?? null]
  );
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

  // Last resort on the name: diallers frequently send a short display name
  // ("Lewis") where the CallGuard user is registered under their full name
  // ("Lewis Moore"). The exact-match pass above leaves every such call
  // unlinked, so the adviser's own calls never appear under them in reporting
  // and per-agent learning context misses them.
  //
  // Only accept a first-name match when it is UNAMBIGUOUS — exactly one
  // adviser in the org whose name starts with that word. Two Lewises means we
  // genuinely cannot tell, and mis-attributing a compliance breach to the
  // wrong adviser is far worse than leaving it unlinked.
  if (p.agentName?.trim()) {
    const firstWord = p.agentName.trim().split(/\s+/)[0]!;
    // Guard against a one- or two-letter token matching half the org.
    if (firstWord.length >= 3) {
      const candidates = await query<{ id: string; name: string }>(
        `SELECT id, name FROM users
           WHERE organization_id = $1
             AND lower(name) LIKE lower($2) || ' %'
           LIMIT 2`,
        [organizationId, firstWord]
      );
      if (candidates.length === 1) {
        const match = candidates[0]!;
        console.log(
          `[Ingestion] Linked dialler agent "${p.agentName}" to adviser "${match.name}" by unique first-name match`
        );
        return { agentId: match.id, agentName: match.name };
      }
      if (candidates.length > 1) {
        console.warn(
          `[Ingestion] Dialler agent "${p.agentName}" matches more than one adviser in org ${organizationId} — leaving unlinked`
        );
      }
    }
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
  // Idempotency check — on either identity key, so a backfill of a call already
  // captured live is recognised rather than duplicated.
  const existing = await findExistingCall(params.organizationId, params.externalId, params.dialerCallId);
  if (existing) return { call: existing, isDuplicate: true };

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
  // Reduce a video container (a Teams/Zoom appointment recording) to audio
  // before storage. A no-op for audio, and idempotent, so a caller that already
  // went through fetchRemoteAudio is not converted twice.
  const media = await prepareMediaForIngest({
    buffer: params.buffer,
    fileName: params.fileName,
    mimeType: params.mimeType,
  });

  // path.basename strips any directory component a crafted/dialler-supplied
  // filename (e.g. "../../../etc/x") would otherwise carry into the storage
  // key — this is the shared entry point for API, CloudTalk and SFTP ingest.
  const safeFileName = path.basename(media.fileName);
  const fileKey = `calls/${params.organizationId}/${callId}/${safeFileName}`;
  await uploadFile(fileKey, media.buffer, media.mimeType);

  let rows: Call[];
  try {
    rows = await query<Call>(
      `INSERT INTO calls (
         id, organization_id, uploaded_by, file_name, file_key,
         file_size_bytes, mime_type, agent_id, agent_name,
         customer_phone, customer_id, call_date, tags, status,
         external_id, ingestion_source, encrypted_at_rest, scorecard_id,
         dialer_connection_id, direction, dialer_call_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'uploaded', $14, $15, true, $16, $17, $18, $19)
       RETURNING *`,
      [
        callId,
        params.organizationId,
        params.uploadedBy ?? null,
        safeFileName,
        fileKey,
        // The stored audio, not the container it may have arrived in.
        media.buffer.length,
        media.mimeType,
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
        params.direction ?? null,
        params.dialerCallId ?? null,
      ]
    );
  } catch (err) {
    // Two concurrent deliveries of the same webhook both pass the
    // idempotency SELECT above before either INSERTs (TOCTOU) — the second
    // hits idx_calls_org_external_id (or idx_calls_org_dialer_call_id) instead
    // of erroring out to the caller. Treat that race the same as the
    // idempotency check: return the row the other request just created.
    if ((err as { code?: string }).code === '23505') {
      const raced = await findExistingCall(params.organizationId, params.externalId, params.dialerCallId);
      if (raced) return { call: raced, isDuplicate: true };
    }
    throw err;
  }

  await transcriptionQueue.add('transcribe', { callId }, { jobId: callId });

  return { call: rows[0]!, isDuplicate: false };
}

export interface CaptureCallParams {
  organizationId: string;
  externalId: string;
  // The CloudTalk call UUID, used to re-fetch the recording at sale time.
  cloudtalkCallId: string | null;
  // The dialler's numeric call id (migration 075) — the key shared with the
  // history API, so a backfill recognises this call instead of duplicating it.
  dialerCallId?: string | null;
  // The webhook's recording URL if it carried one — stored as a hint only;
  // hydration prefers a fresh fetch by cloudtalkCallId to dodge URL expiry.
  recordingPointer: string | null;
  agentEmail?: string | null;
  agentExternalId?: string | null;
  agentName?: string | null;
  customerPhone?: string | null;
  customerName?: string | null;
  callDate?: string | null;
  direction?: 'inbound' | 'outbound' | null;
  durationSeconds?: number | null;
  dialerConnectionId?: string | null;
}

/**
 * Metadata-only capture for sales_only tenants (see routes/ingestion.ts
 * handleCloudTalkWebhook). Records the call's identity, agent, customer and
 * recording pointer as a 'captured' row WITHOUT downloading audio or
 * transcribing — that is deferred until a Zoho sale trigger hydrates the
 * customer's journey. Idempotent by (org, externalId), same as ingestCall.
 */
export async function captureCallMetadata(
  params: CaptureCallParams
): Promise<IngestedCall> {
  // On either identity key — this is the path the backfill script drives, so it
  // is the one that must recognise a call already captured live (migration 075).
  const existing = await findExistingCall(params.organizationId, params.externalId, params.dialerCallId);
  if (existing) return { call: existing, isDuplicate: true };

  const { agentId, agentName } = await resolveAgent(params.organizationId, params);

  let customerId: string | null = null;
  if (params.customerPhone) {
    const normalised = normalizePhone(params.customerPhone);
    if (normalised) {
      customerId = await upsertCustomer(params.organizationId, normalised, params.customerName ?? null, null);
    }
  }

  const callId = uuid();
  try {
    const rows = await query<Call>(
      `INSERT INTO calls (
         id, organization_id, uploaded_by, file_name, file_key,
         mime_type, agent_id, agent_name, customer_phone, customer_id,
         call_date, status, external_id, ingestion_source, encrypted_at_rest,
         dialer_connection_id, direction, recording_pointer, duration_seconds,
         dialer_call_id
       )
       VALUES ($1, $2, NULL, $3, NULL, NULL, $4, $5, $6, $7, $8,
               'captured', $9, 'dialer_webhook', false, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        callId,
        params.organizationId,
        `cloudtalk-${params.cloudtalkCallId ?? params.externalId}`,
        agentId,
        agentName,
        params.customerPhone ?? null,
        customerId,
        params.callDate ?? null,
        params.externalId,
        params.dialerConnectionId ?? null,
        params.direction ?? null,
        params.recordingPointer ?? null,
        params.durationSeconds ?? null,
        params.dialerCallId ?? null,
      ]
    );
    return { call: rows[0]!, isDuplicate: false };
  } catch (err) {
    // Same TOCTOU race as ingestCall: two concurrent webhook deliveries both
    // pass the SELECT above before either INSERTs. Return the row the other won.
    if ((err as { code?: string }).code === '23505') {
      const raced = await findExistingCall(params.organizationId, params.externalId, params.dialerCallId);
      if (raced) return { call: raced, isDuplicate: true };
    }
    throw err;
  }
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
    // Meeting/video containers. Named here so an SFTP drop of Teams recordings
    // is recognised as video and routed through audio extraction rather than
    // being handed to Deepgram as an opaque blob (see services/media.ts).
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'avi':
      return 'video/x-msvideo';
    default:
      return 'application/octet-stream';
  }
}

// Read a fetch Response body, aborting once it exceeds maxBytes. A
// Content-Length check alone isn't enough — it can be absent or lie; this
// enforces the cap against the actual bytes received.
async function readWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
  // Reported in MB derived from the cap actually applied — a video container is
  // allowed a larger one than a plain audio file (see fetchRemoteAudio).
  const limitMb = Math.round(maxBytes / 1024 / 1024);
  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > maxBytes) {
    throw new AppError(400, `Remote file exceeds the ${limitMb}MB limit`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new AppError(400, `Remote file exceeds the ${limitMb}MB limit`);
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
      throw new AppError(400, `Remote file exceeds the ${limitMb}MB limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a caller-supplied recording URL (API ingest, bulk-import, CloudTalk
 * recording_url, a Teams/Zoom download link) safely: HTTPS + public-address only
 * (see url-safety.ts), no redirect-following (an attacker-controlled 3xx could
 * otherwise point at an internal address after the check already passed), and a
 * hard size cap enforced against the actual stream, not just a trusted
 * Content-Length.
 *
 * A video container is reduced to audio before it is returned, so every caller
 * gets audio regardless of what the URL served.
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

  const pathParts = url.pathname.split('/');
  const lastPart = pathParts[pathParts.length - 1] || 'call.mp3';
  let fileName = lastPart.includes('.') ? lastPart : `${lastPart}.mp3`;
  let mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || inferMimeType(fileName);

  // Pick the size cap before reading a byte: a meeting recording is legitimately
  // several times the size of a call recording, and the audio we keep from it is
  // well inside the audio cap. Judged on the declared type and the URL's
  // extension — all we know at this point.
  const looksLikeVideo = isVideoMedia(mimeType, fileName);
  const buffer = await readWithLimit(
    res,
    looksLikeVideo ? MAX_VIDEO_FILE_SIZE_BYTES : MAX_FILE_SIZE_BYTES
  );

  // Some sources (e.g. CloudTalk's recording endpoint, whose URL ends '.json')
  // stream media as a generic binary type. Sniff the real format from the magic
  // bytes so storage + transcription get a correct type/extension rather than
  // 'binary/octet-stream' + a '.json' name.
  if (/octet-stream|binary/i.test(mimeType)) {
    const sig = buffer.subarray(0, 4).toString('hex').toLowerCase();
    // ISO base-media (MP4/MOV/M4A) puts 'ftyp' at offset 4 and its brand at 8.
    // The brand is the only thing that separates an audio-only .m4a from a video
    // .mp4 here, and getting it wrong either re-encodes audio needlessly or
    // hands Deepgram a video file.
    const isoBox = buffer.subarray(4, 8).toString('latin1');
    const isoBrand = buffer.subarray(8, 12).toString('latin1');
    const base = fileName.replace(/\.[^.]*$/, '');
    if (sig.startsWith('52494646')) {
      mimeType = 'audio/wav'; // RIFF….WAVE
      fileName = `${base}.wav`;
    } else if (sig.startsWith('494433') || sig.startsWith('fffb') || sig.startsWith('fff3') || sig.startsWith('fff2')) {
      mimeType = 'audio/mpeg'; // ID3 / MPEG frame sync
      fileName = `${base}.mp3`;
    } else if (sig.startsWith('1a45dfa3')) {
      mimeType = 'video/x-matroska'; // EBML — Matroska / WebM
      fileName = `${base}.mkv`;
    } else if (isoBox === 'ftyp') {
      if (isoBrand.startsWith('M4A')) {
        mimeType = 'audio/mp4';
        fileName = `${base}.m4a`;
      } else {
        mimeType = isoBrand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
        fileName = `${base}${isoBrand === 'qt  ' ? '.mov' : '.mp4'}`;
      }
    }
  }

  // Strip the video track if this turned out to be a container. Idempotent for
  // audio, so the sniffing above and this call can't fight each other.
  return prepareMediaForIngest({ buffer, fileName, mimeType });
}
