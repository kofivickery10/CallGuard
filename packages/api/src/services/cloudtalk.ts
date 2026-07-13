import { decryptDialerSecret, type DialerConnectionRow } from './tenant-settings.js';

// ============================================================
// CloudTalk REST API client. Used by the ingest-call job (recording pull when
// the webhook payload doesn't carry a usable URL) and by journey assembly
// (call history by phone, spec §9.2). HTTP Basic auth from the tenant's
// dialer_connections row — see migration 039.
// ============================================================

export function cloudTalkBasicAuthHeader(conn: DialerConnectionRow): Record<string, string> | null {
  if (!conn.api_key_id_encrypted || !conn.api_secret_encrypted) return null;
  const keyId = decryptDialerSecret(conn.api_key_id_encrypted);
  const secret = decryptDialerSecret(conn.api_secret_encrypted);
  const token = Buffer.from(`${keyId}:${secret}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

interface CloudTalkRecordingResponse {
  data?: { call?: { vcc_recording_url?: string } };
  vcc_recording_url?: string;
}

/**
 * GET /calls/recording/{callId}.json — pull the recording URL for a call
 * that didn't arrive with a usable one in the webhook payload. Requires the
 * connection's API credentials; returns null if not configured or not found.
 */
export async function fetchRecordingUrlByCallId(
  conn: DialerConnectionRow,
  callId: string
): Promise<string | null> {
  const headers = cloudTalkBasicAuthHeader(conn);
  if (!headers) return null;

  const res = await fetch(`${conn.api_base_url}/calls/recording/${encodeURIComponent(callId)}.json`, {
    headers,
  });
  if (!res.ok) {
    console.warn(`[CloudTalk] recording fetch for call ${callId} returned ${res.status}`);
    return null;
  }
  const body = (await res.json().catch(() => null)) as CloudTalkRecordingResponse | null;
  return body?.data?.call?.vcc_recording_url ?? body?.vcc_recording_url ?? null;
}

interface CloudTalkHistoryEntry {
  id?: number | string;
  uuid?: string;
  started_at?: string;
}
interface CloudTalkIndexResponse {
  data?: { items?: Array<{ Cdr?: CloudTalkHistoryEntry }> };
  responseData?: { data?: Array<{ Cdr?: CloudTalkHistoryEntry }> };
}

/**
 * GET /calls/index.json filtered by phone — a customer's recent calls at
 * CloudTalk, for the multi-call journey window (spec §9.2). Best-effort
 * completeness check: CallGuard's own `calls` table (grouped by
 * customer_id) remains the source of truth for what actually gets scored,
 * since a call only has a transcript once CallGuard has ingested it. This
 * lets journey assembly log a mismatch (CloudTalk shows N calls, M
 * ingested) rather than silently scoring on whatever happened to arrive.
 */
export async function fetchCallHistoryByPhone(
  conn: DialerConnectionRow,
  phone: string,
  windowDays: number
): Promise<CloudTalkHistoryEntry[]> {
  const headers = cloudTalkBasicAuthHeader(conn);
  if (!headers) return [];

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    'filter[keyword]': phone,
    'filter[date_from]': since,
  });

  const res = await fetch(`${conn.api_base_url}/calls/index.json?${params.toString()}`, { headers });
  if (!res.ok) {
    console.warn(`[CloudTalk] history fetch for ${phone} returned ${res.status}`);
    return [];
  }
  const body = (await res.json().catch(() => null)) as CloudTalkIndexResponse | null;
  const items = body?.data?.items ?? body?.responseData?.data ?? [];
  return items.map((i) => i.Cdr).filter((c): c is CloudTalkHistoryEntry => !!c);
}
