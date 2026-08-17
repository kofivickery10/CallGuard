/**
 * Enrich CallGuard's own `prospects` table from the FCA Financial Services
 * Register public API — given a firm name or FRN, look up its regulatory
 * status, permissions and registered (company) address and upsert that onto
 * the matching row, without touching anything a human typed in.
 *
 * DATA PROTECTION (see migrations/102_prospects.sql — read that file's
 * comments before touching this script, they are binding, not decoration):
 *   - `prospects` is FIRM-LEVEL DATA ONLY. `type=firm` Register searches also
 *     return sole traders trading under their own name (e.g. "Anna Woodvine"),
 *     which the Register still labels business type "Firm". Storing a named
 *     individual there would put personal data in a table that has no
 *     documented UK GDPR legitimate-interests assessment for holding it. This
 *     script therefore runs every resolved name through a company-vs-individual
 *     heuristic (isLikelyCompanyName, below) and refuses to write anything
 *     that fails it — it is reported instead, under "SKIPPED — looks like a
 *     named individual (not written; needs an LIA)". The heuristic is
 *     necessarily imperfect (see its own comment); it is deliberately biased
 *     toward skipping, since a false skip costs a manual look and a false
 *     store is a data-protection incident.
 *   - `ctps_screened_at` is NEVER set by this script, under any circumstance.
 *     Migration 102 is explicit that it must only ever be set by a deliberate
 *     manual action recording that a CTPS screen actually happened — this
 *     script has no such action to record, so it never appears in any INSERT
 *     or UPDATE below.
 *   - Human-entered columns (`status`, `note`, `fit_score`,
 *     `last_contacted_at`, `ctps_screened_at`) are never touched on update —
 *     only the Register-derived columns (`firm_name`, `frn`, `fca_status`,
 *     `permissions`, `website`, `main_phone`, `registered_address`) plus
 *     `updated_at` are refreshed. `source` is set to 'directory' on rows this
 *     script creates and is left alone on rows it updates.
 *
 * This connects to whatever DATABASE_URL points at, which is usually
 * production, and writes real rows there. Nothing is written until --yes is
 * passed; without it (or with --dry-run, which always forces preview even
 * alongside --yes), it only prints what it would do.
 *
 * Rate limit: the FCA Register API allows 50 requests / 10 seconds, and each
 * firm can cost up to 4 requests (Search, Firm, Permissions, Address). This
 * script throttles to a comfortably lower ceiling (see RATE_LIMIT_MAX below)
 * rather than trying to ride the exact limit.
 *
 * Usage:
 *   # Preview only (no writes) — a CSV of names/FRNs, or positional args:
 *   npx tsx src/scripts/enrich-prospects-fca.ts --file prospects.csv
 *   npx tsx src/scripts/enrich-prospects-fca.ts "Clever Financial Solutions" 122702
 *
 *   # For real:
 *   npx tsx src/scripts/enrich-prospects-fca.ts --file prospects.csv --yes
 *
 * The CSV tolerates a header row and either a single column of names/FRNs, or
 * a `name,frn` shape (with or without a header naming those columns).
 *
 * --discover mode BUILDS a prospect list from Register search terms, rather
 * than enriching one you already have:
 *   npx tsx src/scripts/enrich-prospects-fca.ts --discover "mortgage" "protection" --limit 100
 *   npx tsx src/scripts/enrich-prospects-fca.ts --discover --terms-file terms.txt --yes
 *
 * PAGINATION (confirmed against the live Register — see fcaGet/searchFirmPage):
 * a Search response's `ResultInfo` carries `total_count` (the true match
 * count) and `per_page` (always "20" — not overridable; `&page=N` is
 * silently ignored). More results ARE reachable via `&pgnp=N`, which
 * `ResultInfo.Next` — present on every page but the last — already encodes.
 * So 20 is a page size, not a hard cap. The real constraint is query
 * breadth, not depth: a single very common word (e.g. "mortgage",
 * "insurance", "advice", "financial") reliably fails outright — either an
 * HTTP 500 Apex governor-limit error ("Too many query rows: 50001") or an
 * HTTP 200 body `{Status:"413", Message:"Error: Request Entity Too Large"}`
 * — even on page 1, before any pagination happens. Two-word phrases (e.g.
 * "mortgage advice", "equity release", "life insurance") reliably work and
 * still return hundreds of matches. --discover treats a failed search as a
 * per-term failure to report and move past, never a reason to abort the run.
 *
 * --discover's filtering (dead/introducer status exclusion, named-individual
 * skip, FRN dedupe, --limit truncation, unrecognised-status collection) is
 * pure logic — see the "--discover pure logic" section below — exercised
 * directly by enrich-prospects-fca.test.ts without hitting the live API.
 *
 * Requires FCA_API_EMAIL and FCA_API_KEY in the environment (see
 * .env.example) — deliberately NOT read via src/config.ts, so the ordinary
 * API server and worker processes never carry this credential.
 */

import fs from 'fs';
import path from 'path';
import { pool, query, queryOne } from '../db/client.js';
import { config } from '../config.js';

// ── FCA Register client ─────────────────────────────────────────────────

const FCA_BASE = 'https://register.fca.org.uk/services/V0.1';

// The Register allows 50 requests / 10s. We stay comfortably under that
// rather than trying to ride the exact ceiling — a burst near 50 that lands
// badly against the Register's own clock would still get us rate-limited.
const RATE_LIMIT_MAX = 35;
const RATE_LIMIT_WINDOW_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simple sliding-window limiter: blocks callers once RATE_LIMIT_MAX requests
 * have gone out in the trailing RATE_LIMIT_WINDOW_MS, until the oldest of
 * them ages out of the window. */
class RateLimiter {
  private timestamps: number[] = [];
  async wait(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (this.timestamps.length >= RATE_LIMIT_MAX) {
      const oldest = this.timestamps[0]!;
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 50;
      await sleep(Math.max(waitMs, 50));
      return this.wait();
    }
    this.timestamps.push(Date.now());
  }
}

export interface FcaSearchResultItem {
  'Reference Number': string;
  Name: string;
  Status: string;
  'Type of business or Individual': string;
  URL: string | null;
}

export interface FcaFirmData {
  FRN: string;
  'Organisation Name': string;
  Status: string;
  'Business Type'?: string;
  'Companies House Number'?: string;
  [key: string]: unknown;
}

export interface FcaAddressData {
  'Website Address'?: string;
  'Phone Number'?: string;
  'Address Line 1'?: string;
  'Address Line 2'?: string;
  // The FCA Register's own typo — capital I in "LIne" — is the field it
  // actually returns today. We accept the correctly-spelled key too, in case
  // they ever fix it, so this script doesn't silently start dropping the
  // line if they do.
  'Address LIne 3'?: string;
  'Address Line 3'?: string;
  'Address Line 4'?: string;
  Town?: string;
  County?: string;
  Postcode?: string;
  Country?: string;
  [key: string]: unknown;
}

// The Search endpoint's ResultInfo — present only on a Search response (Firm/
// Permissions/Address never carry it). Confirmed live: `total_count` is the
// true match count across all pages, `per_page` is always "20", and `Next`
// is the follow-on URL (carrying `&pgnp=N+1`) present on every page except
// the last — its absence is the pagination end signal. See the --discover
// pagination investigation notes in this file's header comment.
interface FcaResultInfo {
  Next?: string;
  Previous?: string;
  page?: string;
  per_page?: string;
  total_count?: string;
}

type FcaResult<T> =
  | { ok: true; data: T; resultInfo: FcaResultInfo | null }
  | { ok: false; message: string };

async function fcaGet<T>(
  rateLimiter: RateLimiter,
  headers: Record<string, string>,
  pathAndQuery: string
): Promise<FcaResult<T>> {
  await rateLimiter.wait();
  let res: Response;
  try {
    res = await fetch(`${FCA_BASE}${pathAndQuery}`, { headers });
  } catch (err) {
    return { ok: false, message: `network error: ${(err as Error).message}` };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return { ok: false, message: `could not read response body: ${(err as Error).message}` };
  }
  let body: { Status?: string; Message?: string; Data?: T; ResultInfo?: FcaResultInfo } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: `HTTP ${res.status}: non-JSON response — check FCA_API_EMAIL/FCA_API_KEY are correct`,
    };
  }
  const message = body?.Message;
  // Every successful Register response we've seen starts its Message with
  // "Ok." (e.g. "Ok. Search successful", "Ok. Firm Found"). Anything else —
  // "Firm not found", "No search result found", a missing field entirely —
  // is treated as a failed lookup, per the brief. This also covers two real
  // failure modes hit while investigating --discover pagination: an overly
  // broad single-word search term (e.g. "mortgage", "insurance") comes back
  // as either an HTTP 500 Apex governor-limit error or an HTTP 200 body
  // `{Status:"413", Message:"Error: Request Entity Too Large"}` — neither has
  // an "Ok."-prefixed Message, so both land here as an ordinary failure a
  // caller can log and move past, without needing special-case handling.
  if (!res.ok || !message || !/^ok\b/i.test(message)) {
    return { ok: false, message: message || `HTTP ${res.status}` };
  }
  return { ok: true, data: body!.Data as T, resultInfo: body!.ResultInfo ?? null };
}

async function searchFirm(
  rl: RateLimiter,
  headers: Record<string, string>,
  name: string
): Promise<FcaResult<FcaSearchResultItem[]>> {
  return fcaGet(rl, headers, `/Search?q=${encodeURIComponent(name)}&type=firm`);
}

// Same Search endpoint as searchFirm, but requesting a specific page via
// `pgnp` — the paging parameter the Register's own `ResultInfo.Next` URL
// uses (confirmed live; `&page=N` is silently ignored). Used only by
// --discover, which needs every match for a broad term, not just the first
// 20 (`per_page` is fixed and not overridable).
async function searchFirmPage(
  rl: RateLimiter,
  headers: Record<string, string>,
  term: string,
  page: number
): Promise<FcaResult<FcaSearchResultItem[]>> {
  return fcaGet(rl, headers, `/Search?q=${encodeURIComponent(term)}&type=firm&pgnp=${page}`);
}

async function getFirm(
  rl: RateLimiter,
  headers: Record<string, string>,
  frn: string
): Promise<FcaResult<FcaFirmData[]>> {
  return fcaGet(rl, headers, `/Firm/${encodeURIComponent(frn)}`);
}

async function getPermissions(
  rl: RateLimiter,
  headers: Record<string, string>,
  frn: string
): Promise<FcaResult<Record<string, unknown>>> {
  return fcaGet(rl, headers, `/Firm/${encodeURIComponent(frn)}/Permissions`);
}

async function getAddress(
  rl: RateLimiter,
  headers: Record<string, string>,
  frn: string
): Promise<FcaResult<FcaAddressData[]>> {
  return fcaGet(rl, headers, `/Firm/${encodeURIComponent(frn)}/Address?Type=PPOB`);
}

// ── Pure parsing helpers (unit tested — see enrich-prospects-fca.test.ts) ──

/**
 * The Register appends the postcode to the `Name` field in Search results,
 * e.g. "Clever Financial Solutions Limited (Postcode: SG14 1AJ)" or
 * "... (Postcode: N/A)". Strip that suffix before storing — it's not part of
 * the firm's actual name.
 */
export function stripPostcodeSuffix(name: string): string {
  return name.replace(/\s*\(Postcode:[^)]*\)\s*$/i, '').trim();
}

// The Register's `type=firm` search also returns sole traders trading under
// their own personal name (real examples: "Anna Woodvine", "Craig Taylor"),
// and still labels their "Type of business or Individual" as "Firm" — so
// that field can't be used to tell company from person. Instead we look for
// a corporate marker word in the name itself. This is a heuristic, not a
// lookup against Companies House: it will falsely treat a genuine company
// with no marker word in its trading name (e.g. "The Mortgage Guild") as an
// individual and skip it, and it will treat a sole trader operating under a
// name that happens to include one of these words (e.g. "J Smith Financial
// Services") as a company. Both directions are real failure modes. We accept
// the false-skip direction deliberately — per the brief, a false skip costs
// a manual review, a false store of a named individual is a data-protection
// problem — and a human reviewing the "SKIPPED" list can always add a
// company by hand.
const CORPORATE_MARKERS = [
  'ltd', 'limited', 'llp', 'plc', 'group', 'financial', 'services', 'mortgage', 'mortgages',
  'associates', 'partners', 'partnership', 'advisers', 'advisors', 'advice', 'solutions',
  'consultancy', 'consulting', 'wealth', 'capital', 'insurance', 'brokers', 'broking',
  'holdings', 'company',
];

export function isLikelyCompanyName(name: string): boolean {
  if (/&/.test(name)) return true;
  const lower = name.toLowerCase();
  return CORPORATE_MARKERS.some((marker) => new RegExp(`\\b${marker}\\b`, 'i').test(lower));
}

// ── --discover pure logic (status filtering, dedupe, --limit) ──────────────
//
// --discover has to decide, from a Search result's `Status` string alone,
// whether a firm is worth enriching at all, before it ever spends the ~3
// extra requests enrichment costs. Three buckets:
//   - excluded: a dead firm or an introducer-only AR (see isDeadStatus /
//     isIntroducerStatus below) — never written.
//   - known-good: an active status we recognise — enriched normally.
//   - unrecognised: neither of the above — still enriched (a false exclusion
//     is worse than a false inclusion here, symmetric with the
//     isLikelyCompanyName bias the other way), but surfaced separately so a
//     human can confirm the Register isn't using some other live status this
//     script doesn't know about.

// Firm/AR registration that has lapsed, been cancelled, or otherwise ended —
// there is no ongoing business to sell to. Real Register values seen live
// include "No longer registered as an Appointed Representative", "No longer
// authorised" and "No Longer Registered as a PSD Agent".
//
// "revoked", "lapsed" and "applied to cancel" were added after being caught
// live by the unrecognised-statuses safety net and ruled on by a human (not
// guessed at here): a firm whose FCA permission has been revoked, whose
// authorisation has lapsed, or which has applied to cancel its permissions
// (i.e. is winding down) cannot lawfully give regulated advice — so there is
// no advice call for CallGuard to score. That's the same non-prospect
// category as an introducer AR: excluded because the product cannot serve
// them, not on any guess about their commercial appetite. "applied to
// cancel" is listed as its own keyword, distinct from "cancelled" above,
// since "Applied to Cancel" does not contain the substring "cancelled".
const DEAD_STATUS_KEYWORDS = [
  'no longer',
  'deregistered',
  'cancelled',
  'expired',
  'dissolved',
  'revoked',
  'lapsed',
  'applied to cancel',
];

// Statuses excluded on an EXACT match (after trimming/lowercasing) rather
// than a substring test, because a substring rule here would either be
// wrong or only work by luck:
//   - "Registered": investigated live (FRN 1049760, "Your Mortgage Advice
//     Limited") — its Firm record carries `Business Type: CBTL` (Consumer
//     Buy-to-Let) with no Permissions on file. CBTL is a *registration*
//     regime under the Mortgage Credit Directive Order, not an FSMA
//     authorisation — CBTL business isn't a regulated activity, so MCOB
//     doesn't apply to it and there's no regulated advice call for
//     CallGuard to score. A genuine mortgage/protection adviser always
//     shows as "Authorised" or "Appointed representative", never
//     "Registered", so excluding this status can't cost a real prospect. A
//     plain substring rule would be the wrong tool here too: "No longer
//     registered as an Appointed Representative" contains "registered" and
//     is already excluded by the "no longer" keyword above, so a substring
//     match would happen to work rather than being the actual reason.
//   - "Unauthorised": a firm not authorised cannot lawfully carry on
//     regulated activity — some appear on the Register precisely because
//     the FCA is warning about them. This one is an EXACT match rather than
//     a keyword deliberately, because "Unauthorised" contains the substring
//     "authorised" — see isKnownGoodStatus below, which is the function
//     that substring check would otherwise corrupt.
const EXACT_DEAD_STATUSES = ['registered', 'unauthorised'];

export function isDeadStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const lower = status.toLowerCase().trim();
  if (EXACT_DEAD_STATUSES.includes(lower)) return true;
  return DEAD_STATUS_KEYWORDS.some((kw) => lower.includes(kw));
}

// "Appointed representative - introducer" is a live, in-good-standing AR —
// but an introducer-only AR passes leads to its principal and never itself
// gives regulated advice or runs the sales call CallGuard scores. It can
// never buy this product, regardless of how "active" its Register status
// looks, so it's excluded alongside genuinely dead firms rather than merely
// deprioritised.
export function isIntroducerStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return status.toLowerCase().includes('introducer');
}

export function isExcludedStatus(status: string | null | undefined): boolean {
  return isDeadStatus(status) || isIntroducerStatus(status);
}

/** Statuses this script explicitly recognises as "still an active firm
 * worth enriching", beyond the two exact Register values in the brief
 * ("Authorised", "Appointed representative"). Anything else that is a
 * whole-word match for "authorised" after the dead/introducer exclusions
 * above have already run is presumed to be a live variant we haven't
 * catalogued by name (e.g. "EEA Authorised", seen live on the Register)
 * rather than something genuinely unknown — "No longer authorised" never
 * reaches this function, since isDeadStatus already caught it.
 *
 * MATCHING HAZARD, handled deliberately: "Unauthorised" contains the
 * substring "authorised", so a plain `.includes('authorised')` test would
 * misclassify an unauthorised firm — the opposite of an active one — as
 * known-good. `\bauthorised\b` is a whole-word match instead: there's a
 * word boundary before "Authorised" in "EEA Authorised" (space, then
 * letters) so that still matches, but there's no boundary between "un" and
 * "authorised" in "Unauthorised" (both are letters, same word), so it
 * doesn't. isDeadStatus's exact "unauthorised" check (above) is what
 * actually excludes it before this function is ever reached in the real
 * pipeline, but this function is also exported and tested standalone, so it
 * needs to be correct on its own rather than merely lucky about call order. */
export function isKnownGoodStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const lower = status.toLowerCase().trim();
  if (lower === 'authorised' || lower === 'appointed representative') return true;
  return /\bauthorised\b/.test(lower);
}

export interface DiscoveryCandidate {
  frn: string;
  name: string;
  status: string;
}

/** Turns raw Search results into discovery candidates: strips the postcode
 * suffix from the name (see stripPostcodeSuffix) and drops the blank-FRN
 * "clone of FCA authorised firm" scam-warning entries the Register
 * sometimes returns — the same filter resolveFrn already applies for the
 * single-firm lookup path. */
export function toDiscoveryCandidates(items: FcaSearchResultItem[]): DiscoveryCandidate[] {
  return items
    .filter((i) => (i['Reference Number'] || '').trim() !== '')
    .map((i) => ({
      frn: i['Reference Number'],
      name: stripPostcodeSuffix(i.Name),
      status: i.Status,
    }));
}

/** Drops candidates whose FRN has already been seen this run (across every
 * search term), recording newly-seen FRNs into `seen` as a side effect so
 * the same FRN surfacing again under a later term is also caught. */
export function dedupeByFrn(candidates: DiscoveryCandidate[], seen: Set<string>): DiscoveryCandidate[] {
  const out: DiscoveryCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.frn)) continue;
    seen.add(c.frn);
    out.push(c);
  }
  return out;
}

export type LimitDecision = 'process-new' | 'process-existing' | 'skip-limit';

/** Decides what to do with one already-deduped, non-excluded, non-individual
 * discovery candidate, given whether its FRN is already in `prospects` and
 * how many genuinely NEW firms this run has queued for insert so far.
 * `--limit` only bounds new inserts (per the brief — "how many NEW firms get
 * written"), so a firm already on file is always processed (to refresh its
 * Register-derived fields) regardless of the running new-firm count; a
 * not-yet-known firm is processed only while under the limit, and skipped
 * (never silently dropped without being counted) once it's reached. Kept
 * pure/synchronous so this truncation behaviour is unit-testable without a
 * database. */
export function decideLimitAction(alreadyKnown: boolean, newCountSoFar: number, limit: number): LimitDecision {
  if (alreadyKnown) return 'process-existing';
  if (newCountSoFar >= limit) return 'skip-limit';
  return 'process-new';
}

/** The Permissions endpoint returns a dict keyed by permission name (values
 * are arrays of limitation objects we don't need) — the permission list IS
 * Object.keys(Data). */
export function permissionsDictToArray(data: Record<string, unknown> | null | undefined): string[] {
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data);
}

/** Joins the Address endpoint's line fields into one string, handling both
 * the Register's real "Address LIne 3" typo and the correctly-spelled key. */
export function joinAddressLines(addr: FcaAddressData | null | undefined): string | null {
  if (!addr) return null;
  const line3 = addr['Address LIne 3'] ?? addr['Address Line 3'];
  const parts = [
    addr['Address Line 1'],
    addr['Address Line 2'],
    line3,
    addr['Address Line 4'],
    addr.Town,
    addr.County,
    addr.Postcode,
    addr.Country,
  ]
    .map((p) => (p ?? '').toString().trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

const STATUS_PLACEHOLDER = 'See full details';

/** The Firm endpoint's Status is sometimes just the placeholder "See full
 * details" (e.g. Barclays, FRN 122702). Prefer the Search result's Status
 * when we have one and the Firm endpoint gave us the placeholder; otherwise
 * store whatever we got — never store the placeholder if a better value is
 * available. */
export function pickFcaStatus(
  searchStatus: string | null | undefined,
  firmStatus: string | null | undefined
): string | null {
  if (firmStatus && firmStatus !== STATUS_PLACEHOLDER) return firmStatus;
  if (searchStatus) return searchStatus;
  return firmStatus ?? null;
}

/** Minimal RFC4180-ish CSV parser (quoted fields, "" escaping) — mirrors the
 * one already used by the prospects CSV import in routes/superadmin.ts. */
export function parseSimpleCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export interface InputEntry {
  name: string | null;
  frn: string | null;
}

/** Turns parsed CSV rows into name/frn entries. Tolerates:
 *   - a single column of names or FRNs, with or without a header
 *     ("name"/"firm_name"/"frn");
 *   - a `name,frn` shape, with or without that header.
 * A single-column value that's purely numeric is treated as an FRN (an FRN
 * doubling as a "name" would be indistinguishable from one otherwise). */
export function normalizeInputRows(rows: string[][]): InputEntry[] {
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];

  const firstRow = nonEmpty[0]!.map((c) => c.trim().toLowerCase());
  const knownHeaders = new Set(['name', 'firm_name', 'frn']);
  const looksLikeHeader =
    firstRow.length > 0 &&
    firstRow.every((h) => knownHeaders.has(h)) &&
    firstRow.some((h) => h === 'name' || h === 'firm_name');

  let start = 0;
  let nameCol = 0;
  let frnCol = -1;
  if (looksLikeHeader) {
    nameCol = firstRow.findIndex((h) => h === 'name' || h === 'firm_name');
    frnCol = firstRow.findIndex((h) => h === 'frn');
    start = 1;
  } else if (nonEmpty[0]!.length >= 2) {
    nameCol = 0;
    frnCol = 1;
  }

  const out: InputEntry[] = [];
  for (let i = start; i < nonEmpty.length; i++) {
    const row = nonEmpty[i]!;
    const nameRaw = (row[nameCol] ?? '').trim();
    const frnRaw = frnCol >= 0 ? (row[frnCol] ?? '').trim() : '';
    if (!nameRaw && !frnRaw) continue;
    if (frnCol === -1 && /^\d+$/.test(nameRaw)) {
      out.push({ name: null, frn: nameRaw });
    } else {
      out.push({ name: nameRaw || null, frn: frnRaw || null });
    }
  }
  return out;
}

/** Same numeric-vs-name distinction as normalizeInputRows, for a bare
 * positional CLI argument. */
export function classifyPositionalArg(raw: string): InputEntry {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? { name: null, frn: trimmed } : { name: trimmed, frn: null };
}

// ── Resolution + enrichment ─────────────────────────────────────────────

type ResolveOutcome =
  | { kind: 'resolved'; frn: string; searchStatus: string | null; query: string }
  | { kind: 'ambiguous'; query: string; candidates: { frn: string; name: string; status: string }[] }
  | { kind: 'failed'; query: string; reason: string };

async function resolveFrn(
  entry: InputEntry,
  rl: RateLimiter,
  headers: Record<string, string>
): Promise<ResolveOutcome> {
  if (entry.frn) {
    if (!/^\d+$/.test(entry.frn)) {
      return { kind: 'failed', query: `FRN ${entry.frn}`, reason: `"${entry.frn}" is not a numeric FRN` };
    }
    return { kind: 'resolved', frn: entry.frn, searchStatus: null, query: `FRN ${entry.frn}` };
  }
  const name = entry.name!;
  const result = await searchFirm(rl, headers, name);
  if (!result.ok) {
    return { kind: 'failed', query: name, reason: `search failed: ${result.message}` };
  }
  const rawCandidates = result.data ?? [];
  if (rawCandidates.length === 0) {
    return { kind: 'failed', query: name, reason: 'no results found on the Register' };
  }
  // Search sometimes returns "clone of FCA authorised firm" scam-warning
  // entries with a blank Reference Number and Status "Unauthorised" — those
  // are never a real firm to enrich, so they're filtered out before we
  // decide whether the match is single or ambiguous.
  const candidates = rawCandidates.filter((c) => (c['Reference Number'] || '').trim() !== '');
  if (candidates.length === 0) {
    return {
      kind: 'failed',
      query: name,
      reason: 'Register only returned unauthorised clone/warning entries (no genuine FRN)',
    };
  }
  if (candidates.length > 1) {
    return {
      kind: 'ambiguous',
      query: name,
      candidates: candidates.map((c) => ({
        frn: c['Reference Number'],
        name: stripPostcodeSuffix(c.Name),
        status: c.Status,
      })),
    };
  }
  const only = candidates[0]!;
  return { kind: 'resolved', frn: only['Reference Number'], searchStatus: only.Status, query: name };
}

interface EnrichedFirm {
  frn: string;
  firmName: string;
  fcaStatus: string | null;
  permissions: string[];
  website: string | null;
  mainPhone: string | null;
  registeredAddress: string | null;
}

type EnrichOutcome = { ok: true; firm: EnrichedFirm; notes: string[] } | { ok: false; reason: string };

// Only a failed Firm lookup aborts the whole entry — without it we have no
// confirmed name/status to store at all. Permissions and Address failures
// degrade gracefully instead of aborting: live testing against the real
// Register turned up "Firm permission not found" as the *normal* response
// for Appointed Representative firms (confirmed on genuine companies, e.g.
// FRN 798324 "HLSA Financial Services Ltd" — not just sole traders), because
// an AR operates under its principal's permissions rather than holding its
// own. Aborting the entire enrichment over that would silently drop a large
// share of CallGuard's actual target market (small AR intermediaries), which
// is a worse outcome than storing a firm with an empty permissions array and
// noting why. The same graceful handling applies to Address, in case a firm
// genuinely has no PPOB record on file.
async function enrichFirm(
  frn: string,
  searchStatus: string | null,
  rl: RateLimiter,
  headers: Record<string, string>
): Promise<EnrichOutcome> {
  const firmRes = await getFirm(rl, headers, frn);
  if (!firmRes.ok) return { ok: false, reason: `firm lookup failed: ${firmRes.message}` };
  const firmData = (firmRes.data ?? [])[0];
  if (!firmData) return { ok: false, reason: 'firm lookup returned no data' };
  const firmName = stripPostcodeSuffix(firmData['Organisation Name'] || '');
  if (!firmName) return { ok: false, reason: 'firm lookup returned no organisation name' };

  const notes: string[] = [];

  const permsRes = await getPermissions(rl, headers, frn);
  if (!permsRes.ok) notes.push(`permissions unavailable (${permsRes.message})`);

  const addrRes = await getAddress(rl, headers, frn);
  if (!addrRes.ok) notes.push(`address unavailable (${addrRes.message})`);
  const addr = addrRes.ok ? (addrRes.data ?? [])[0] ?? null : null;

  return {
    ok: true,
    notes,
    firm: {
      frn: firmData.FRN || frn,
      firmName,
      fcaStatus: pickFcaStatus(searchStatus, firmData.Status),
      permissions: permsRes.ok ? permissionsDictToArray(permsRes.data) : [],
      website: addr?.['Website Address']?.trim() || null,
      mainPhone: addr?.['Phone Number']?.trim() || null,
      registeredAddress: joinAddressLines(addr),
    },
  };
}

// ── Upsert ───────────────────────────────────────────────────────────────

interface ExistingProspectRow {
  id: string;
  firm_name: string;
  frn: string | null;
  fca_status: string | null;
  permissions: string[];
  website: string | null;
  main_phone: string | null;
  registered_address: string | null;
}

async function findExisting(frn: string, firmName: string): Promise<ExistingProspectRow | 'ambiguous' | null> {
  const byFrn = await queryOne<ExistingProspectRow>(`SELECT * FROM prospects WHERE frn = $1`, [frn]);
  if (byFrn) return byFrn;
  const byName = await query<ExistingProspectRow>(
    `SELECT * FROM prospects WHERE lower(firm_name) = lower($1)`,
    [firmName]
  );
  if (byName.length > 1) return 'ambiguous';
  return byName[0] ?? null;
}

function diffFields(existing: ExistingProspectRow, next: Record<string, unknown>): string[] {
  const diffs: string[] = [];
  for (const [k, v] of Object.entries(next)) {
    const oldVal = (existing as unknown as Record<string, unknown>)[k];
    const same = Array.isArray(v)
      ? JSON.stringify([...v].sort()) === JSON.stringify([...(Array.isArray(oldVal) ? oldVal : [])].sort())
      : (v ?? null) === (oldVal ?? null);
    if (!same) diffs.push(`${k}: ${JSON.stringify(oldVal ?? null)} -> ${JSON.stringify(v ?? null)}`);
  }
  return diffs;
}

async function processEnriched(
  firm: EnrichedFirm,
  write: boolean
): Promise<{ action: 'create' | 'update'; diffs: string[] }> {
  const existing = await findExisting(firm.frn, firm.firmName);
  if (existing === 'ambiguous') {
    throw new Error(`multiple existing prospects named "${firm.firmName}" with no FRN to disambiguate — resolve manually`);
  }

  const nextValues = {
    firm_name: firm.firmName,
    frn: firm.frn,
    fca_status: firm.fcaStatus,
    permissions: firm.permissions,
    website: firm.website,
    main_phone: firm.mainPhone,
    registered_address: firm.registeredAddress,
  };

  if (existing) {
    const diffs = diffFields(existing, nextValues);
    if (write) {
      // Only Register-derived columns + updated_at. status, note, fit_score,
      // last_contacted_at and ctps_screened_at are deliberately absent from
      // this SET clause — never written by this script.
      await query(
        `UPDATE prospects SET
           firm_name           = $2,
           frn                 = COALESCE($3, frn),
           fca_status          = $4,
           permissions         = $5,
           website             = $6,
           main_phone          = $7,
           registered_address  = $8,
           updated_at          = now()
         WHERE id = $1`,
        [
          existing.id, nextValues.firm_name, nextValues.frn, nextValues.fca_status,
          nextValues.permissions, nextValues.website, nextValues.main_phone, nextValues.registered_address,
        ]
      );
    }
    return { action: 'update', diffs };
  }

  if (write) {
    await query(
      `INSERT INTO prospects (firm_name, frn, fca_status, permissions, website, main_phone, registered_address, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'directory')`,
      [
        nextValues.firm_name, nextValues.frn, nextValues.fca_status,
        nextValues.permissions, nextValues.website, nextValues.main_phone, nextValues.registered_address,
      ]
    );
  }
  return { action: 'create', diffs: [] };
}

// ── CLI plumbing ─────────────────────────────────────────────────────────

export interface ParsedArgs {
  file: string | null;
  yes: boolean;
  dryRun: boolean;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  let file: string | null = null;
  let yes = false;
  let dryRun = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--file') { file = argv[++i] ?? null; continue; }
    if (a === '--yes') { yes = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a.startsWith('--')) { continue; }
    positional.push(a);
  }
  return { file, yes, dryRun, positional };
}

const DEFAULT_DISCOVER_LIMIT = 250;

export interface DiscoverArgs {
  terms: string[];
  termsFile: string | null;
  limit: number;
  yes: boolean;
  dryRun: boolean;
}

// Separate from parseArgs (rather than extending it) so the existing
// ParsedArgs shape — and the tests asserting its exact fields — are
// untouched; --discover is a distinct mode with its own flags (--terms-file,
// --limit) that don't apply to the single-firm enrich path.
export function parseDiscoverArgs(argv: string[]): DiscoverArgs {
  let termsFile: string | null = null;
  let limit = DEFAULT_DISCOVER_LIMIT;
  let yes = false;
  let dryRun = false;
  const terms: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--discover') continue;
    if (a === '--terms-file') { termsFile = argv[++i] ?? null; continue; }
    if (a === '--limit') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
      continue;
    }
    if (a === '--yes') { yes = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a.startsWith('--')) continue;
    terms.push(a);
  }
  return { terms, termsFile, limit, yes, dryRun };
}

// Host + database name only — never the credentials embedded in the URL.
function dbTargetLabel(): string {
  try {
    const u = new URL(config.database.url);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(DATABASE_URL could not be parsed)';
  }
}

function printDbBanner(): void {
  const line = '='.repeat(70);
  console.log(line);
  console.log(`  TARGET DATABASE: ${dbTargetLabel()}`);
  console.log('  (this is almost certainly production — see .env DATABASE_URL)');
  console.log(line);
}

type CredentialCheck = { ok: true; email: string; key: string } | { ok: false; message: string };

// Deliberately reads process.env directly rather than src/config.ts — the
// FCA credentials must never become something the ordinary API server or
// worker process depends on. Factored out as a pure function (env passed
// in) purely so the "both missing" message can be unit tested without
// needing to strip these vars out of the real .env, which this script must
// never touch.
export function checkFcaCredentials(env: NodeJS.ProcessEnv): CredentialCheck {
  const email = env.FCA_API_EMAIL;
  const key = env.FCA_API_KEY;
  if (!email || !key) {
    return {
      ok: false,
      message:
        'Missing FCA_API_EMAIL and/or FCA_API_KEY. Set both in .env (see .env.example) before running this script. ' +
        'They are deliberately not part of src/config.ts — the API server and worker never read them.',
    };
  }
  return { ok: true, email, key };
}

// ── --discover ───────────────────────────────────────────────────────────

/** Whether an FRN is already in `prospects`, purely to decide (via
 * decideLimitAction) whether this candidate is exempt from --limit. The
 * ground truth for create-vs-update is still processEnriched's own
 * findExisting call below — this is only ever used for the limit gate. */
async function isFrnKnown(frn: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM prospects WHERE frn = $1`, [frn]);
  return !!row;
}

function loadDiscoverTerms(args: DiscoverArgs): string[] {
  let terms = [...args.terms];
  if (args.termsFile) {
    const resolved = path.resolve(process.cwd(), args.termsFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`No such file: ${resolved}`);
    }
    const content = fs.readFileSync(resolved, 'utf8');
    const fileTerms = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    terms = terms.concat(fileTerms);
  }
  return terms.map((t) => t.trim()).filter((t) => t.length > 0);
}

async function runDiscover(argv: string[], headers: Record<string, string>): Promise<void> {
  const args = parseDiscoverArgs(argv);
  const write = args.yes && !args.dryRun;

  let terms: string[];
  try {
    terms = loadDiscoverTerms(args);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  if (terms.length === 0) {
    console.error(
      'Usage: enrich-prospects-fca.ts --discover <term> [<term> ...] [--terms-file <path>] [--limit N] [--yes] [--dry-run]'
    );
    process.exitCode = 1;
    return;
  }

  printDbBanner();
  console.log(`\nDiscover mode: ${terms.length} search term(s), --limit ${args.limit} new firm(s).`);
  console.log(write ? 'Mode: LIVE — writes will be made.' : 'Mode: PREVIEW (dry run) — nothing will be written.');

  const rl = new RateLimiter();

  const seenFrns = new Set<string>();
  const unrecognisedStatuses = new Set<string>();
  let rawResultsCount = 0;
  let excludedDeadCount = 0;
  let excludedIntroducerCount = 0;
  let skippedIndividualCount = 0;
  let blankFrnCount = 0;
  let duplicateCount = 0;
  let alreadyKnownCount = 0;
  let newCount = 0;
  let limitSkippedCount = 0;
  let termsSearched = 0;
  let limitReached = false;
  const termFailures: string[] = [];
  const failed: string[] = [];
  const created: string[] = [];
  const updated: string[] = [];

  for (const term of terms) {
    if (limitReached) break;
    termsSearched++;
    let page = 1;
    for (;;) {
      const pageResult = await searchFirmPage(rl, headers, term, page);
      if (!pageResult.ok) {
        termFailures.push(`  "${term}" (page ${page}) — ${pageResult.message}`);
        console.log(`  [search-failed] "${term}" page ${page} — ${pageResult.message}`);
        break;
      }
      const items = pageResult.data ?? [];
      if (items.length === 0) break;
      rawResultsCount += items.length;

      const candidates = toDiscoveryCandidates(items);
      // toDiscoveryCandidates drops the blank-FRN "clone of FCA authorised
      // firm" scam-warning entries the Register sometimes mixes into Search
      // results (see resolveFrn's identical filter) — counted separately so
      // every one of `rawResultsCount` is accounted for somewhere below.
      blankFrnCount += items.length - candidates.length;
      const fresh = dedupeByFrn(candidates, seenFrns);
      duplicateCount += candidates.length - fresh.length;

      for (const c of fresh) {
        if (isIntroducerStatus(c.status)) {
          excludedIntroducerCount++;
          continue;
        }
        if (isDeadStatus(c.status)) {
          excludedDeadCount++;
          continue;
        }
        if (!isKnownGoodStatus(c.status)) {
          unrecognisedStatuses.add(c.status);
        }
        if (!isLikelyCompanyName(c.name)) {
          skippedIndividualCount++;
          continue;
        }

        const alreadyKnown = await isFrnKnown(c.frn);
        const decision = decideLimitAction(alreadyKnown, newCount, args.limit);
        if (decision === 'skip-limit') {
          // Never silently drop the rest of an already-fetched page: keep
          // classifying (introducer/dead/individual above already ran; this
          // just stops enriching) every remaining candidate on this page so
          // each is still accounted for in the summary, rather than only the
          // one candidate that first tripped the limit. Once this page is
          // done, the page/term loops below stop fetching anything further.
          limitSkippedCount++;
          limitReached = true;
          continue;
        }

        const enrichOutcome = await enrichFirm(c.frn, c.status, rl, headers);
        if (!enrichOutcome.ok) {
          failed.push(`  "${c.name}" (FRN ${c.frn}) — ${enrichOutcome.reason}`);
          console.log(`  [FAILED]    "${c.name}" (FRN ${c.frn}) — ${enrichOutcome.reason}`);
          continue;
        }
        const firm = enrichOutcome.firm;
        const noteSuffix = enrichOutcome.notes.length > 0 ? ` [note: ${enrichOutcome.notes.join('; ')}]` : '';

        if (!isLikelyCompanyName(firm.firmName)) {
          skippedIndividualCount++;
          console.log(`  [skip-individual] "${firm.firmName}" (FRN ${firm.frn})`);
          continue;
        }

        try {
          const plan = await processEnriched(firm, write);
          if (plan.action === 'create') {
            newCount++;
            created.push(`  "${firm.firmName}" (FRN ${firm.frn})${write ? '' : ' — would be created'}${noteSuffix}`);
            console.log(`  [${write ? 'created' : 'would create'}] ${firm.firmName} (FRN ${firm.frn})${noteSuffix}`);
          } else {
            alreadyKnownCount++;
            const changeNote = plan.diffs.length > 0 ? plan.diffs.join('; ') : 'no changes';
            updated.push(`  "${firm.firmName}" (FRN ${firm.frn}) — ${changeNote}${noteSuffix}`);
            console.log(
              `  [${write ? 'updated' : 'would update'}] ${firm.firmName} (FRN ${firm.frn}) — ${changeNote}${noteSuffix}`
            );
          }
        } catch (err) {
          failed.push(`  "${firm.firmName}" (FRN ${firm.frn}) — ${(err as Error).message}`);
          console.log(`  [FAILED]    ${firm.firmName} (FRN ${firm.frn}) — ${(err as Error).message}`);
        }
      }

      if (limitReached || !pageResult.resultInfo?.Next) break;
      page++;
    }
  }

  console.log('\n=== Discovery Summary ===');
  console.log(
    `Terms searched:                    ${termsSearched} / ${terms.length}` +
      (limitReached && termsSearched < terms.length ? ' (stopped early — --limit reached)' : '')
  );
  console.log(`Raw search results seen:           ${rawResultsCount}`);
  console.log(`Excluded — dead firm:              ${excludedDeadCount}`);
  console.log(`Excluded — introducer AR:          ${excludedIntroducerCount}`);
  console.log(`Skipped — named individual:        ${skippedIndividualCount} (not written; needs an LIA)`);
  console.log(`Dropped — blank-FRN scam clone:    ${blankFrnCount}`);
  console.log(`Duplicate FRN (seen earlier term):  ${duplicateCount}`);
  console.log(`Already known (refreshed):         ${alreadyKnownCount}`);
  const newLabel = write ? 'Written (new)' : 'Would write (new)';
  console.log(
    `${newLabel}:${' '.repeat(Math.max(1, 36 - newLabel.length - 1))}${newCount}` +
      (limitSkippedCount > 0
        ? ` — --limit ${args.limit} reached, ${limitSkippedCount} further new candidate(s) NOT processed`
        : '')
  );
  console.log(`Failed:                             ${failed.length}`);
  failed.forEach((l) => console.log(l));

  if (termFailures.length > 0) {
    console.log(`\nSearch term failures (term skipped, e.g. an overly-broad single-word term):`);
    termFailures.forEach((l) => console.log(l));
  }

  console.log(`\n${write ? 'Created' : 'Would create'} (${created.length}):`);
  created.forEach((l) => console.log(l));

  console.log(`\n${write ? 'Refreshed' : 'Would refresh'} — already known (${updated.length}):`);
  updated.forEach((l) => console.log(l));

  if (unrecognisedStatuses.size > 0) {
    console.log('\n=== UNRECOGNISED STATUSES — included, please review ===');
    [...unrecognisedStatuses].sort().forEach((s) => console.log(`  "${s}"`));
  }

  if (limitReached) {
    console.log(
      `\n--limit ${args.limit} reached — run stopped early ` +
        `(${terms.length - termsSearched} term(s) not searched at all, plus any remaining pages of the term in progress). ` +
        'Increase --limit or run again with the remaining terms to continue.'
    );
  }

  if (!write) {
    console.log('\nPREVIEW ONLY — nothing has been written. Re-run with --discover ... --yes to write the changes above.');
  }
}

async function main(): Promise<void> {
  const cred = checkFcaCredentials(process.env);
  if (!cred.ok) {
    console.error(cred.message);
    process.exitCode = 1;
    return;
  }
  const headers: Record<string, string> = {
    'X-Auth-Email': cred.email,
    'X-Auth-Key': cred.key,
    Accept: 'application/json',
  };

  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes('--discover')) {
    await runDiscover(rawArgv, headers);
    return;
  }

  const { file, yes, dryRun, positional } = parseArgs(rawArgv);
  const write = yes && !dryRun;

  let entries: InputEntry[] = [];
  if (file) {
    const resolved = path.resolve(process.cwd(), file);
    if (!fs.existsSync(resolved)) {
      console.error(`No such file: ${resolved}`);
      process.exitCode = 1;
      return;
    }
    const content = fs.readFileSync(resolved, 'utf8');
    entries = entries.concat(normalizeInputRows(parseSimpleCsv(content)));
  }
  entries = entries.concat(positional.map(classifyPositionalArg));

  if (entries.length === 0) {
    console.error(
      'Usage: enrich-prospects-fca.ts (--file <path-to-csv> | <name-or-frn> [<name-or-frn> ...]) [--yes] [--dry-run]'
    );
    process.exitCode = 1;
    return;
  }

  printDbBanner();
  console.log(`\n${entries.length} input row(s) to process.`);
  console.log(write ? 'Mode: LIVE — writes will be made.' : 'Mode: PREVIEW (dry run) — nothing will be written.');

  const rl = new RateLimiter();

  const created: string[] = [];
  const updated: string[] = [];
  const skippedIndividual: string[] = [];
  const ambiguous: string[] = [];
  const failed: string[] = [];

  for (const entry of entries) {
    const label = entry.frn ? `FRN ${entry.frn}` : (entry.name ?? '(blank)');
    const resolveOutcome = await resolveFrn(entry, rl, headers);

    if (resolveOutcome.kind === 'ambiguous') {
      const candidateLines = resolveOutcome.candidates
        .map((c) => `      - "${c.name}" (FRN ${c.frn || 'none'}, status: ${c.status})`)
        .join('\n');
      ambiguous.push(`  "${resolveOutcome.query}" — ${resolveOutcome.candidates.length} matches, skipped:\n${candidateLines}`);
      console.log(`  [ambiguous] ${label} — ${resolveOutcome.candidates.length} possible matches, not written`);
      continue;
    }
    if (resolveOutcome.kind === 'failed') {
      failed.push(`  "${resolveOutcome.query}" — ${resolveOutcome.reason}`);
      console.log(`  [FAILED]    ${label} — ${resolveOutcome.reason}`);
      continue;
    }

    const enrichOutcome = await enrichFirm(resolveOutcome.frn, resolveOutcome.searchStatus, rl, headers);
    if (!enrichOutcome.ok) {
      failed.push(`  "${resolveOutcome.query}" (FRN ${resolveOutcome.frn}) — ${enrichOutcome.reason}`);
      console.log(`  [FAILED]    ${label} — ${enrichOutcome.reason}`);
      continue;
    }
    const firm = enrichOutcome.firm;
    const noteSuffix = enrichOutcome.notes.length > 0 ? ` [note: ${enrichOutcome.notes.join('; ')}]` : '';

    if (!isLikelyCompanyName(firm.firmName)) {
      skippedIndividual.push(`  "${firm.firmName}" (FRN ${firm.frn}) — matched query "${resolveOutcome.query}"`);
      console.log(`  [skip-individual] ${label} -> "${firm.firmName}" (FRN ${firm.frn})`);
      continue;
    }

    try {
      const plan = await processEnriched(firm, write);
      if (plan.action === 'create') {
        created.push(`  "${firm.firmName}" (FRN ${firm.frn})${write ? '' : ' — would be created'}${noteSuffix}`);
        console.log(`  [${write ? 'created' : 'would create'}] ${firm.firmName} (FRN ${firm.frn})${noteSuffix}`);
      } else {
        const changeNote = plan.diffs.length > 0 ? plan.diffs.join('; ') : 'no changes';
        updated.push(`  "${firm.firmName}" (FRN ${firm.frn}) — ${changeNote}${noteSuffix}`);
        console.log(`  [${write ? 'updated' : 'would update'}] ${firm.firmName} (FRN ${firm.frn}) — ${changeNote}${noteSuffix}`);
      }
    } catch (err) {
      failed.push(`  "${firm.firmName}" (FRN ${firm.frn}) — ${(err as Error).message}`);
      console.log(`  [FAILED]    ${firm.firmName} (FRN ${firm.frn}) — ${(err as Error).message}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Created:   ${created.length}`);
  created.forEach((l) => console.log(l));
  console.log(`Updated:   ${updated.length}`);
  updated.forEach((l) => console.log(l));
  console.log(`SKIPPED — looks like a named individual (not written; needs an LIA): ${skippedIndividual.length}`);
  skippedIndividual.forEach((l) => console.log(l));
  console.log(`Ambiguous (multiple Register matches, skipped): ${ambiguous.length}`);
  ambiguous.forEach((l) => console.log(l));
  console.log(`Failed:    ${failed.length}`);
  failed.forEach((l) => console.log(l));

  if (!write) {
    console.log('\nPREVIEW ONLY — nothing has been written. Re-run with --yes to write the changes above.');
  }
}

// Only run main() when this file is executed directly (`tsx
// enrich-prospects-fca.ts`), not when the test file imports its exported
// pure functions — otherwise the import alone would kick off a live run.
if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error('\nFailed:', err instanceof Error ? err.message : err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
