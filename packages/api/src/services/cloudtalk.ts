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

// Parsed from a CloudTalk /calls/index.json item (Cdr + Agent + Contact),
// carrying everything the backfill needs to record the call accurately.
export interface CloudTalkHistoryEntry {
  id: string;
  startedAt: string | null;
  externalNumber: string | null; // the customer's number (Cdr.public_external)
  direction: 'inbound' | 'outbound' | null;
  durationSeconds: number | null;
  agentEmail: string | null;
  agentName: string | null;
  agentExternalId: string | null;
  contactName: string | null;
}

interface CloudTalkRawCdr {
  id?: number | string;
  billsec?: number | string;
  talking_time?: number | string;
  type?: string;
  public_external?: string;
  started_at?: string;
}
interface CloudTalkRawAgent {
  id?: number | string;
  email?: string;
  fullname?: string;
}
interface CloudTalkRawContact {
  name?: string;
}
interface CloudTalkRawItem {
  Cdr?: CloudTalkRawCdr;
  Agent?: CloudTalkRawAgent;
  Contact?: CloudTalkRawContact;
}
interface CloudTalkIndexResponse {
  data?: { items?: CloudTalkRawItem[] };
  responseData?: { data?: CloudTalkRawItem[] };
}

function toSeconds(v: number | string | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// UK-tolerant national-significant-number reduction for comparing numbers that
// may arrive as +44…, 0…, or bare. Strips non-digits, then a leading 44 or 0,
// so "+447742556539", "07742556539" and "447742556539" all compare equal.
export function natSig(raw: string | null | undefined): string {
  if (!raw) return '';
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('44')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return d;
}

function parseCdrItem(item: CloudTalkRawItem): CloudTalkHistoryEntry | null {
  const cdr = item.Cdr;
  if (!cdr?.id) return null;
  const type = (cdr.type ?? '').toLowerCase();
  return {
    id: String(cdr.id),
    startedAt: cdr.started_at ?? null,
    externalNumber: cdr.public_external ?? null,
    direction: type.startsWith('in') ? 'inbound' : type.startsWith('out') ? 'outbound' : null,
    durationSeconds: toSeconds(cdr.billsec) ?? toSeconds(cdr.talking_time),
    agentEmail: item.Agent?.email ?? null,
    agentName: item.Agent?.fullname ?? null,
    agentExternalId: item.Agent?.id != null ? String(item.Agent.id) : null,
    contactName: item.Contact?.name ?? null,
  };
}

/**
 * Fetch every call in the date window by paginating /calls/index.json.
 *
 * CloudTalk's server-side filters (filter[keyword], filter[public_external],
 * filter[contact_id]) are NOT honoured on this account's API — they return an
 * unfiltered page regardless — so there is no way to ask for one number's
 * calls. Instead we page through the whole window (calls come newest-first) and
 * let the caller index/match client-side on public_external. Heavy but correct;
 * intended for the one-off backfill, not per-request use.
 *
 * Stops at the first page older than the window, a short (final) page, or
 * maxPages as a safety cap.
 */
export async function fetchCallsInWindow(
  conn: DialerConnectionRow,
  windowDays: number,
  maxPages = 200
): Promise<CloudTalkHistoryEntry[]> {
  const headers = cloudTalkBasicAuthHeader(conn);
  if (!headers) return [];

  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const sinceStr = new Date(sinceMs).toISOString().slice(0, 10);
  const limit = 1000;
  const out: CloudTalkHistoryEntry[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      'filter[date_from]': sinceStr,
      limit: String(limit),
      page: String(page),
    });
    const res = await fetch(`${conn.api_base_url}/calls/index.json?${params.toString()}`, { headers });
    if (!res.ok) {
      console.warn(`[CloudTalk] calls page ${page} returned ${res.status} — stopping`);
      break;
    }
    const body = (await res.json().catch(() => null)) as CloudTalkIndexResponse | null;
    const items = body?.data?.items ?? body?.responseData?.data ?? [];
    if (items.length === 0) break;

    let sawOlderThanWindow = false;
    for (const item of items) {
      const e = parseCdrItem(item);
      if (!e) continue;
      if (e.startedAt && new Date(e.startedAt).getTime() < sinceMs) {
        sawOlderThanWindow = true;
        continue;
      }
      out.push(e);
    }
    if (process.env.CLOUDTALK_DEBUG) {
      console.log(`[CloudTalk DEBUG] page ${page}: ${items.length} items, ${out.length} kept in window`);
    }
    if (items.length < limit || sawOlderThanWindow) break; // last page or walked past the window
  }
  return out;
}

/**
 * A single customer's calls in the window — pages the whole window and filters
 * client-side on public_external. Convenience wrapper over fetchCallsInWindow
 * for single-phone use; the backfill script pages once and indexes many phones.
 */
export async function fetchCallHistoryByPhone(
  conn: DialerConnectionRow,
  phone: string,
  windowDays: number
): Promise<CloudTalkHistoryEntry[]> {
  const target = natSig(phone);
  const all = await fetchCallsInWindow(conn, windowDays);
  return all.filter((e) => natSig(e.externalNumber) === target);
}
