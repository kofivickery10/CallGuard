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
 *   - Human/harvest-entered columns (`status`, `note`, `fit_score`,
 *     `last_contacted_at`, `ctps_screened_at`, `general_email`,
 *     `general_email_source_url`, `opted_out_at`) are never touched on
 *     update — only the Register-derived columns (`firm_name`, `frn`,
 *     `fca_status`, `permissions`, `website`, `main_phone`,
 *     `registered_address`, `companies_house_number`, `authorised_since`)
 *     plus `updated_at` are refreshed. `source` is set to 'directory' on
 *     rows this script creates and is left alone on rows it updates.
 *     `former_ar`/`ar_ceased_on` are a partial exception: they refresh only
 *     when this run finds positive transition evidence (see
 *     TransitionEvidence) — with none found, they carry the existing row's
 *     values through unchanged rather than being reset, since a false
 *     former_ar is worse than a missed one (see the "AR -> directly-
 *     authorised transition detection" section below). `fit_score` is never
 *     set by this script even for a confirmed transition — that stays a
 *     human judgement, not a generated number. `general_email`/
 *     `general_email_source_url` are written only by `--harvest-emails` (see
 *     that section below), and `opted_out_at` is never written by this
 *     script at all — it is a PECR opt-out, and once set it must survive
 *     every future enrichment refresh or harvest re-run permanently, the
 *     same non-negotiable guarantee `ctps_screened_at` gets above.
 *   - This script never writes a firm that is one of CallGuard's own
 *     existing tenants (`organizations`) as a prospect — see the
 *     "Existing-client guard" section below (findMatchingExistingClient). A
 *     match is reported under "[skip-existing-client]"/"SKIPPED — matches an
 *     existing CallGuard tenant" instead of being written. --include-clients
 *     disables this (off by default) for the rare case someone genuinely
 *     wants tenants included.
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
 * --transitions-only (--discover flag) additionally filters what gets
 * written down to firms that are `Authorised` AND either a confirmed former
 * Appointed Representative or authorised within the last N months (default
 * 24, override with --authorised-within-months N) — see the "AR ->
 * directly-authorised transition detection" section below for why that
 * combination is the signal worth surfacing. It also suppresses the per-firm
 * "[not-transition]" line for everything it excludes by default (a broad run
 * can otherwise print hundreds of routine exclusions to convey a handful of
 * results) — pass --verbose to restore them; the excluded count is always in
 * the summary either way.
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
 * --sweep mode is --discover's recurring sibling — see docs/prospect-sweep.md
 * and migration 104_fca_register_observations.sql for the full design:
 *   npx tsx src/scripts/enrich-prospects-fca.ts --sweep "mortgage and protection" --yes
 *   npx tsx src/scripts/enrich-prospects-fca.ts --sweep --terms-file terms.txt --limit 50 --yes
 * Every search result is recorded to fca_register_observations, including
 * ones excluded from `prospects` entirely — that's what lets a later run
 * detect a status CHANGE rather than only ever seeing the current snapshot.
 * Only a firm that's new to that table, or whose stored status disagrees
 * with what this run found, is worth the enrichment cost; an unchanged firm
 * just gets its last_seen_at bumped. Ends with a digest ordered by what
 * needs action: confirmed AR -> Authorised transitions, new firms grouped by
 * target_tier (migration 105_prospect_tier.sql), then firms that have left
 * the market — see the "--sweep pure logic" section below for the mechanics.
 *
 * Requires FCA_API_EMAIL and FCA_API_KEY in the environment (see
 * .env.example) — deliberately NOT read via src/config.ts, so the ordinary
 * API server and worker processes never carry this credential.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import type { IncomingHttpHeaders } from 'http';
import type { LookupFunction } from 'net';
import { pool, query, queryOne } from '../db/client.js';
import { config } from '../config.js';
import { assertSafeRemoteUrl } from '../services/url-safety.js';

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
  // "dd/mm/yyyy" (e.g. "18/12/2025") when the current Status took effect —
  // see parseFcaDate below for why this must never be parsed with `new
  // Date(str)`.
  'Status Effective Date'?: string;
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

// ── Outreach: role-based email only (migration 106) ─────────────────────
//
// `general_email` may only ever hold a role-based inbox (info@, sales@,
// etc.), never a named individual's address — the same firm-level-only rule
// as `main_phone` being a switchboard number, and for the same two reasons:
// there is no legitimate-interests assessment on file for holding a named
// contact, and under PECR a sole trader or partnership is an INDIVIDUAL
// subscriber, not a corporate one, so a personal address needs a different
// (and here, unavailable) lawful basis to email at all. Migration 106's
// CHECK constraint enforces this in the schema, but this function exists so
// every write path — this script's own --harvest-emails (below), and any
// future one — rejects a bad address in code, before ever reaching the
// database, rather than leaning on the CHECK to catch a mistake after the
// fact. Keep this allowlist and the migration's CHECK regex in sync:
// extending one without the other lets code and schema quietly disagree
// about what's allowed.
const ROLE_BASED_EMAIL_LOCAL_PARTS = [
  'info', 'enquiries', 'enquiry', 'hello', 'contact', 'admin', 'office',
  'mail', 'team', 'support', 'sales', 'reception',
];

// Unlike migration 106's CHECK (which only needs to guard the local part —
// Postgres has no interest in the domain shape), this also requires a
// plausible domain (something, a dot, a letters-only TLD) so a malformed
// string that happens to start "info@" — "info@", "info@nowhere",
// "info@@x.com" — is rejected here in code rather than only failing later at
// the database. `name.trim()` tolerates copy-pasted whitespace from a
// scraped page; the match itself is case-insensitive since email local
// parts conventionally are.
const ROLE_BASED_EMAIL_RE = new RegExp(
  `^(${ROLE_BASED_EMAIL_LOCAL_PARTS.join('|')})@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.[a-z]{2,}$`,
  'i'
);

export function isRoleBasedEmail(email: string): boolean {
  return ROLE_BASED_EMAIL_RE.test(email.trim());
}

// ── --harvest-emails: pure extraction (Phase 4) ──────────────────────────
//
// The one part of --harvest-emails that is unit tested — see
// enrich-prospects-fca.test.ts's HTML fixtures — kept deliberately free of
// any network code so it never needs a live HTTP call to exercise.

/** Most generic first — "prefer info@ over sales@", per the brief — using
 * migration 106's own allowlist order as the tie-break when a page offers
 * more than one qualifying address. Anything not on the allowlist can't
 * reach this (isRoleBasedEmail has already excluded it), so indexOf's -1
 * case never actually happens in practice; it's handled anyway so this
 * degrades to "sorts last" instead of throwing if that ever changes. */
const EMAIL_GENERICITY_ORDER = [
  'info', 'enquiries', 'enquiry', 'hello', 'contact', 'reception',
  'office', 'admin', 'mail', 'team', 'support', 'sales',
];

function emailGenericityRank(email: string): number {
  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  const idx = EMAIL_GENERICITY_ORDER.indexOf(localPart);
  return idx === -1 ? EMAIL_GENERICITY_ORDER.length : idx;
}

// Deliberately permissive at the extraction stage — this only has to find
// candidate strings that LOOK like an email address; isRoleBasedEmail (the
// same function migration 106's CHECK constraint mirrors) is what actually
// decides what's safe to keep. A mailto: link is the stronger signal (a
// human deliberately marked it as the contact address), but plain text in
// the page body is worth catching too — many contact pages just print the
// address rather than linking it.
const MAILTO_RE = /mailto:([^"'?\s>]+)/gi;
const PLAIN_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Finds every candidate address on a page (mailto: links and plain text),
 * keeps only the ones isRoleBasedEmail accepts, and returns the most
 * generic surviving one — or null if the page has no role-based address at
 * all. This is the ONLY place a personal address is discarded rather than
 * stored: even a page whose one and only address is a named individual's
 * (e.g. "Contact Jane Smith: jane.smith@firm.co.uk") returns null here,
 * never that address — matching the brief's "never store a name-shaped
 * address, even if it is the only one on the page" exactly. */
export function extractRoleBasedEmail(html: string): string | null {
  const candidates = new Set<string>();

  let m: RegExpExecArray | null;
  MAILTO_RE.lastIndex = 0;
  while ((m = MAILTO_RE.exec(html))) {
    candidates.add(m[1]!.trim().toLowerCase());
  }
  PLAIN_EMAIL_RE.lastIndex = 0;
  while ((m = PLAIN_EMAIL_RE.exec(html))) {
    candidates.add(m[0]!.trim().toLowerCase());
  }

  const roleBased = [...candidates].filter((c) => isRoleBasedEmail(c));
  if (roleBased.length === 0) return null;
  return [...roleBased].sort((a, b) => emailGenericityRank(a) - emailGenericityRank(b) || a.localeCompare(b))[0]!;
}

/** Turns whatever CallGuard has on file for a prospect's `website` (often
 * scheme-less, e.g. the Register Address endpoint's raw "Website Address"
 * value — see EnrichedFirm.website — or a bare domain typed in by hand) into
 * a single https:// origin to try fetching, stripping any path/query/hash
 * the stored value happened to include (--harvest-emails builds its own
 * candidate paths against this origin — see HARVEST_PATHS). https is
 * enforced unconditionally, matching assertSafeRemoteUrl's own restriction
 * (see url-safety.ts) — an http-only site simply can't be harvested; that is
 * a missed firm, not a reason to weaken the SSRF check. Returns null for
 * anything that doesn't parse as a URL at all once a scheme is assumed. */
export function normalizeWebsiteToHttpsOrigin(website: string): string | null {
  const trimmed = website.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed.replace(/^http:\/\//i, 'https://') : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' || !url.hostname) return null;
    return `https://${url.host}`;
  } catch {
    return null;
  }
}

// ── --harvest-emails: refuse an address that is not plausibly the firm's own ──
//
// The Register's `website` field is frequently the AR's PRINCIPAL's site,
// not its own — an Appointed Representative trades under its principal's
// infrastructure, and that shows up here as the principal's own domain
// sitting in the AR's website column. The real case that caught this:
// "Lighthouse Advisory Services Limited" (an AR under Quilter) has `website`
// = "www.quilter.com", so --harvest-emails dutifully fetched Quilter's own
// contact page and found "support@quilterinvest.com" — Quilter's investor
// support desk, not a real contact for the AR at all. Storing that would be
// worse than useless: with roughly 80% of this list being ARs, the same
// principal's domain recurs across dozens of unrelated prospects, and
// emailing one large network repeatedly about compliance software — once
// per AR under it — is a reputational own goal aimed at exactly the kind of
// firm CallGuard would eventually want as a channel partner, not a lead.
//
// Two independent checks, both run before ANY write; either one failing is
// enough to refuse the address. Same bias as everywhere else in this
// script: a false rejection costs a manual look, a false store sends mail
// to the wrong company (see isLikelyCompanyName's own comment for the same
// reasoning applied to a different mistake).

// Almost every firm in this list contains one or more of these words, so
// they carry no identifying signal for the name-plausibility check below —
// left in, they'd make nearly any domain look like a match. The brief's own
// list (mortgage, mortgages, protection, financial, services, ltd, limited,
// group, advice), plus 'and' — a real gap the brief's list didn't cover:
// three real firms in this exact dataset ("Carnegie Mortgage AND Protection
// Ltd", "Eaton Mortgages AND Protection Ltd", "Spectrum Mortgages AND
// Protection Ltd") would otherwise keep the bare conjunction "and" as a
// "distinctive" token, and "and" is a three-letter substring of enough real
// domains (brand, sandford, andrews...) to manufacture a false plausible
// match — exactly the failure mode this whole check exists to prevent.
// Extending this list further is a deliberate decision, not something to
// grow casually.
const GENERIC_FIRM_NAME_WORDS = new Set([
  'mortgage', 'mortgages', 'protection', 'financial', 'services', 'ltd', 'limited', 'group', 'advice', 'and',
]);

/** The distinctive tokens left in a firm name once its generic/corporate
 * words are stripped (see GENERIC_FIRM_NAME_WORDS). A firm name built
 * ENTIRELY from generic words (e.g. "Mortgages Ltd") deliberately produces
 * no tokens at all, not a false one — isPlausibleFirmDomain then has
 * nothing to match against and correctly refuses, rather than matching
 * everything. */
export function extractDistinctiveNameTokens(firmName: string): string[] {
  return firmName
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !GENERIC_FIRM_NAME_WORDS.has(w));
}

/** The domain's own distinguishing label — "hcbmortgages" out of
 * "hcbmortgages.co.uk", "quilterinvest" out of "quilterinvest.com" — the
 * part of the domain most likely to encode which company registered it. */
export function domainLabel(domain: string): string {
  return domain.toLowerCase().split('.')[0] ?? '';
}

/** Whether a harvested email's domain plausibly belongs to `firmName` at
 * all: does the domain's own label share at least one distinctive token
 * with the firm name once corporate/generic words are stripped from the
 * name (see extractDistinctiveNameTokens)? "HCB Mortgages Ltd" -> token
 * "hcb" -> "hcbmortgages.co.uk" contains it: plausible. "Antcliff Mortgages
 * & Protection Ltd" -> token "antcliff" -> "quilterinvest.com" does not
 * contain it: not plausible — the real case that prompted this check.
 * Tokens shorter than 3 characters are never accepted as a match on their
 * own (below the point where a shared substring means anything — two
 * unrelated names can trivially share "co" or "ltd" remnants). */
export function isPlausibleFirmDomain(firmName: string, domain: string): boolean {
  const tokens = extractDistinctiveNameTokens(firmName);
  const label = domainLabel(domain);
  if (tokens.length === 0 || !label) return false;
  return tokens.some((t) => t.length >= 3 && label.includes(t));
}

/** The domain half of a harvested email address, lower-cased — the key used
 * by wouldBeSharedDomain, below. */
export function emailDomain(email: string): string {
  return email.toLowerCase().split('@')[1] ?? '';
}

/** Whether storing `domain` against a new prospect would make it the SECOND
 * prospect using that domain — the shared-domain signal that this is a
 * principal's (or website builder's) domain, not one firm's own. Same-domain
 * firms are vanishingly rare otherwise: two genuinely independent FCA firms
 * do not normally share a website.
 *
 * `domainCounts` is seeded from every general_email already on file (see
 * runHarvestEmails) and updated as this run stores its own addresses, so a
 * domain first seen earlier in the SAME run is caught just as reliably as
 * one already sitting in the database — the Quilter domain does not need to
 * have been stored on a PREVIOUS run for the second AR under it, in the
 * same run, to be refused. */
export function wouldBeSharedDomain(domain: string, domainCounts: ReadonlyMap<string, number>): boolean {
  return (domainCounts.get(domain) ?? 0) > 0;
}

// The Register's "Status Effective Date" is "dd/mm/yyyy" (e.g. "18/12/2025"
// for 18 December 2025) — NOT ISO 8601 and NOT US "mm/dd/yyyy". Feeding that
// straight into `new Date(str)` is wrong on both counts: JS parses an
// unrecognised slash-format as locale-dependent (commonly mm/dd/yyyy, so
// "18/12/2025" — day 18 has no US month — becomes Invalid Date; a value like
// "03/04/2025" would silently become 4 March instead of 3 April). This parser
// only ever accepts the Register's actual dd/mm/yyyy shape and validates it
// really is a calendar date (so "31/04/2025", which has no 31 April, is
// rejected rather than silently rolling over into May), returning NULL — not
// throwing, not Invalid Date — for anything malformed, empty, or absent, so
// a bad value degrades to "we don't know" rather than a bogus stored date.
const FCA_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export function parseFcaDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = FCA_DATE_RE.exec(value.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Catches calendar-invalid combinations (31 April, 29 Feb in a non-leap
  // year, etc.) that the range checks above don't: Date.UTC normalises an
  // out-of-range day into the following month rather than rejecting it, so
  // rolling the parts back out and comparing is what actually detects it.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Formats a Register "Status Effective Date" for print, choosing the right
 * verb for what that date actually means. For an Appointed Representative,
 * Status Effective Date is when the firm BECAME an AR — not when it (or
 * anyone) was authorised; the firm may never have held its own
 * authorisation at all. Labelling that "authorised" is simply wrong and
 * could mislead outreach copy built off this script's output, so this only
 * ever says "authorised <date>" for a status that isn't an Appointed
 * Representative, and "AR since <date>" for one that is. Returns null when
 * there is no date to print (parseFcaDate already turns anything malformed
 * or absent into null before it reaches here). */
export function formatStatusEffectiveDateLabel(
  status: string | null | undefined,
  effectiveDate: string | null
): string | null {
  if (!effectiveDate) return null;
  const isAppointedRepresentative = (status ?? '').toLowerCase().trim() === 'appointed representative';
  return isAppointedRepresentative ? `AR since ${effectiveDate}` : `authorised ${effectiveDate}`;
}

// ── AR -> directly-authorised transition detection ──────────────────────
//
// Trust Point, CallGuard's existing client, is the pattern this exists to
// find. On the live Register it shows up as two FRN records sharing one
// Companies House number: FRN 1021037 was an Appointed Representative,
// status now "No longer registered as an Appointed Representative" (eff.
// 29/11/2024); FRN 1044052 is the same firm, now "Authorised" (eff.
// 18/12/2025). The firm went from AR to directly authorised. That moment is
// commercially decisive: as an AR, the principal firm supplies the
// compliance scaffolding — file checks, call monitoring, QA — for free. On
// authorisation the firm inherits all of that overnight with no compliance
// function of its own. "Recently authorised, formerly an AR" is the signal
// that a firm has just become worth selling this product to.
//
// former_ar is set ONLY on a Companies House number match between the two
// FRN records (see isPersistableTransitionMatch) — a name-only match is
// reported to the console as unconfirmed but never persisted. This costs
// almost nothing: CH numbers are reliably present on recently-lapsed AR
// records (Trust Point's, and M6 Mortgage Advice's, both are) and it's
// exactly the recent cohort worth targeting — older lapses, where CH numbers
// are often blank, aren't a lead worth chasing anyway. A firm authorised
// within the recency window still qualifies for --transitions-only on that
// basis alone, with no former-AR claim attached, when no CH match is found.

// Firm names vary in punctuation, case and legal suffix between the
// AR-era and authorised-era Register records for the same company (and
// sometimes even between Search and Firm responses for one FRN) — this
// strips that noise so two spellings of the same firm compare equal.
// stripPostcodeSuffix has already removed the "(Postcode: ...)" suffix by
// the time any name reaches this function.
const NAME_SUFFIX_NOISE = /\b(limited|ltd|llp|plc|group|holdings|company|co)\b/g;

export function normalizeFirmName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(NAME_SUFFIX_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A lapsed Register record worth keeping as transition evidence — captured
// while the discovery loop is otherwise discarding it as a dead/excluded
// status (see isDeadStatus). Only ever built from Search results already
// fetched for the current --discover run; never a separate lookup.
export interface LapsedArCandidate {
  frn: string;
  name: string;
  status: string;
}

// A narrower check than isDeadStatus: specifically "this FRN used to be an
// Appointed Representative and no longer is" (e.g. "No longer registered as
// an Appointed Representative"), as opposed to any other kind of lapse (e.g.
// "No longer authorised", which is a firm that used to be directly
// authorised — not an AR transition candidate at all). Only statuses this
// matches are worth indexing as transition evidence.
export function isLapsedArStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const lower = status.toLowerCase();
  return lower.includes('no longer') && lower.includes('appointed representative');
}

/** Statuses this is willing to treat as "confirmed Authorised" for
 * transition-detection purposes — deliberately the exact Register value
 * only, not isKnownGoodStatus's broader "any authorised variant" (e.g. "EEA
 * Authorised"), since the transition signal specifically means "directly
 * authorised in its own right", not some other authorised-adjacent status. */
export function isConfirmedAuthorisedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return status.toLowerCase().trim() === 'authorised';
}

/** Narrows the full set of this run's lapsed-AR sightings down to the ones
 * whose normalised name matches the given (already-authorised) firm's name —
 * "plausible" matches worth spending the one extra Firm-record lookup on to
 * compare Companies House numbers. Never called against every dead row, only
 * this filtered, usually-empty-or-single-entry subset. */
export function findPlausibleLapsedArMatches(
  firmName: string,
  lapsedCandidates: LapsedArCandidate[]
): LapsedArCandidate[] {
  const target = normalizeFirmName(firmName);
  if (!target) return [];
  return lapsedCandidates.filter((c) => normalizeFirmName(c.name) === target);
}

export type TransitionMatchKind = 'ch_number' | 'name' | 'none';

/** Classifies an already name-matched lapsed AR record against the current
 * firm's Companies House number. Companies House number is authoritative
 * both ways when both sides have one on file: matching numbers confirm the
 * match ('ch_number'), and known-but-different numbers veto it even though
 * the names matched ('none'). When the CH number genuinely can't be compared
 * (either side unknown) this reports 'name' — a name-only match, which
 * isPersistableTransitionMatch (below) then refuses to persist. */
export function decideTransitionMatch(
  currentChNumber: string | null,
  lapsedChNumber: string | null
): TransitionMatchKind {
  if (currentChNumber && lapsedChNumber) {
    return currentChNumber === lapsedChNumber ? 'ch_number' : 'none';
  }
  return 'name';
}

/** The only match kind safe to write as former_ar = true. A name-only match
 * is deliberately NOT enough on its own, even though decideTransitionMatch
 * reports it as a "match": real Register data shows Companies House Number
 * is reliably populated on recently-lapsed AR records but frequently blank
 * on older ones, and a generic or franchise-style name (e.g. "Mortgage
 * Advice Bureau") can normalise identically across many unrelated historic
 * branch records — a real example caught live during testing, where a
 * name-only accept picked an arbitrary 1986 branch lapse as "evidence" about
 * a firm trading today. former_ar drives outreach messaging ("you inherited
 * your network's compliance function"), so a false positive is worse than a
 * missed one; a name-only match is reported to the console as unconfirmed
 * (see findTransitionEvidence) but never reaches the database. */
export function isPersistableTransitionMatch(matchKind: TransitionMatchKind): boolean {
  return matchKind === 'ch_number';
}

/** Positive, CH-number-confirmed transition evidence only — there is no
 * "confirmed not a former AR" state, just "no confirmed evidence found
 * (yet)", so this is either the evidence or null, never a `formerAr: false`
 * shape. That asymmetry is deliberate: it lets the upsert path (see
 * processEnriched) treat "no evidence this run" as "leave whatever's already
 * on the row alone" rather than clobbering a previously-confirmed transition
 * back to false just because this particular search term's results didn't
 * happen to include the lapsed record again. */
export interface TransitionEvidence {
  formerAr: true;
  arCeasedOn: string | null;
}

const DEFAULT_AUTHORISED_WITHIN_MONTHS = 24;

/** Whether `authorisedSince` falls within the last `months` months of `now`.
 * Missing/malformed dates (already NULL by the time they reach here, per
 * parseFcaDate) never count as "recent" — there is nothing to be recent
 * about. */
export function isAuthorisedWithinMonths(authorisedSince: string | null, months: number, now: Date): boolean {
  if (!authorisedSince) return false;
  const since = new Date(`${authorisedSince}T00:00:00Z`);
  if (Number.isNaN(since.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return since.getTime() >= cutoff.getTime();
}

/** --transitions-only's write filter: Authorised AND (a confirmed former AR
 * OR authorised within the window). Facts only — this never touches
 * fit_score, which stays a human judgement (see processEnriched). */
export function qualifiesForTransitionsOnly(
  fcaStatus: string | null,
  formerAr: boolean,
  authorisedSince: string | null,
  months: number,
  now: Date
): boolean {
  if (!isConfirmedAuthorisedStatus(fcaStatus)) return false;
  return formerAr || isAuthorisedWithinMonths(authorisedSince, months, now);
}

export interface TransitionRankable {
  formerAr: boolean;
  authorisedSince: string | null;
  firmName: string;
}

/** Most-promising-first ordering for --transitions-only's printed report:
 * confirmed former ARs before merely-recent authorisations, then most
 * recently authorised first, then name. authorisedSince is already an ISO
 * "yyyy-mm-dd" string (see parseFcaDate) so plain string comparison sorts it
 * correctly; a missing date sorts as the empty string, which is always
 * "less than" a real date, so undated rows fall to the back rather than
 * jumping the queue. */
export function compareTransitionRank(a: TransitionRankable, b: TransitionRankable): number {
  if (a.formerAr !== b.formerAr) return a.formerAr ? -1 : 1;
  const aDate = a.authorisedSince ?? '';
  const bDate = b.authorisedSince ?? '';
  if (aDate !== bDate) return aDate > bDate ? -1 : 1;
  return a.firmName.localeCompare(b.firmName);
}

// ── Existing-client guard ────────────────────────────────────────────────
//
// A production run once wrote CallGuard's own paying client ("TRUST POINT
// MORTGAGE & PROTECTION SERVICES LIMITED", FRN 1044052) into `prospects` as
// a fresh lead — a client sitting in the sales pipeline is how somebody cold
// -pitches an account CallGuard already has. Tenants live in
// `organizations`, which has no FRN (see its schema — just id/name/
// created_at/updated_at), so the only thing to match on is name, and the
// tenant's `organizations.name` is typically much shorter than the Register's
// registered name (e.g. "Trust Point" vs "TRUST POINT MORTGAGE & PROTECTION
// SERVICES LIMITED"). An exact normalised comparison alone would therefore
// miss it; findMatchingExistingClient also accepts a normalised PREFIX match,
// guarded by isEligibleForPrefixMatch so a short/generic tenant name can't
// prefix-match half the register.
//
// This is deliberately biased toward over-matching, the opposite bias from
// isLikelyCompanyName above: a false skip here costs one manual re-add and is
// visible in the printed [skip-existing-client] line; a false WRITE puts an
// existing paying client back into the sales pipeline as a fresh lead, which
// is the incident this guard exists to prevent. --include-clients is the
// deliberate escape hatch for the rare case someone genuinely wants
// tenants included; it defaults to off.

/** Guards findMatchingExistingClient's prefix rule. Only a normalised
 * organisation name of at least 2 tokens AND at least 8 characters is
 * eligible to match as a prefix of a longer FCA-registered name — a
 * one-word or very short tenant name (e.g. "Acme") must never prefix-match
 * half the register. An exact normalised match (checked separately, in
 * findMatchingExistingClient) is never subject to this guard. */
export function isEligibleForPrefixMatch(orgNormalized: string): boolean {
  if (orgNormalized.length < 8) return false;
  return orgNormalized.split(' ').filter(Boolean).length >= 2;
}

/** Whether `candidateName` (a name resolved off the FCA Register) is one of
 * CallGuard's own existing tenants, checked by name only against every
 * `organizations.name` loaded once at startup (see loadExistingClientNames)
 * — never a per-candidate query. A match is either the two normalised names
 * being equal, or the candidate's normalised name starting with the
 * organisation's normalised name (guarded by isEligibleForPrefixMatch).
 * Returns the matched `organizations.name` (for the printed message) or
 * null. */
export function findMatchingExistingClient(candidateName: string, orgNames: string[]): string | null {
  const candidateNormalized = normalizeFirmName(candidateName);
  if (!candidateNormalized) return null;
  for (const orgName of orgNames) {
    const orgNormalized = normalizeFirmName(orgName);
    if (!orgNormalized) continue;
    if (candidateNormalized === orgNormalized) return orgName;
    // Prefix match must land on a word boundary. A bare startsWith() would also
    // match an unrelated firm whose name merely begins with the same letters --
    // a tenant "Trust Point" would skip "Trust Pointer Financial Services". That
    // is only a false skip, so it fails safe, but it is avoidable: require the
    // next character to be a space, so "trust point mortgage ..." matches and
    // "trust pointer ..." does not.
    if (
      isEligibleForPrefixMatch(orgNormalized) &&
      candidateNormalized.startsWith(`${orgNormalized} `)
    ) {
      return orgName;
    }
  }
  return null;
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
//
// "run-off" was added the same way, catching both "Contractual run-off" and
// "Supervised run-off" (and any other variant of the same family) seen live:
// a firm in run-off has stopped writing new business and is only running
// its existing book to expiry, so there is no new advice being given and no
// advice call for CallGuard to score — again excluded because the product
// cannot serve them, not on any guess about appetite.
const DEAD_STATUS_KEYWORDS = [
  'no longer',
  'deregistered',
  'cancelled',
  'expired',
  'dissolved',
  'revoked',
  'lapsed',
  'applied to cancel',
  'run-off',
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

// ── --sweep pure logic (observation diffing, transition/departure
// classification, target tiering, digest grouping) ─────────────────────────
//
// --sweep is what turns a one-off list-builder into a recurring monitor —
// see migration 104_fca_register_observations.sql for the full "why". The
// short version: --discover (above) only ever decides "is this firm worth a
// prospect row", using whatever the Register says RIGHT NOW. --sweep adds a
// second axis — "did this firm's status change since the last time we
// looked" — by recording every search result (not just the ones worth
// targeting) to fca_register_observations, and diffing against what was
// already stored there.

export type ObservationEvent = 'new' | 'unchanged' | 'status-changed';

/** The result of comparing what fca_register_observations already held for
 * one FRN (`existingStatus`, null when this is the very first sighting)
 * against what this sweep's search result reports (`newStatus`). This is
 * the entire "detect a change" mechanism — deliberately just a string
 * comparison, no dates or heuristics, because the Register's own status
 * text is the ground truth being tracked. */
export interface ObservationDiff {
  event: ObservationEvent;
  // Only set when event is 'status-changed' — what fca_status held
  // immediately before this sighting, about to be moved sideways into
  // previous_status.
  previousStatus: string | null;
}

export function diffObservation(existingStatus: string | null, newStatus: string): ObservationDiff {
  if (existingStatus === null) return { event: 'new', previousStatus: null };
  if (existingStatus === newStatus) return { event: 'unchanged', previousStatus: null };
  return { event: 'status-changed', previousStatus: existingStatus };
}

/** Exact match only, same reasoning as isConfirmedAuthorisedStatus: this
 * needs the Register's literal live-AR status, not an introducer or lapsed
 * variant of it (isExcludedStatus already routes those away well before a
 * status pair reaches classifyObservationChange, below). */
export function isAppointedRepresentativeStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return status.toLowerCase().trim() === 'appointed representative';
}

export type ObservationDigestCategory = 'new' | 'unchanged' | 'transition' | 'departure' | 'other-status-change';

/** What a status change actually MEANS, for the end-of-sweep digest (see
 * runSweep). 'new' and 'unchanged' pass straight through — there's nothing
 * to classify about them. For 'status-changed':
 *   - previously the Register's exact "Appointed representative", now
 *     confirmed "Authorised" — the money case this feature exists to catch.
 *     NOTE, and this matters: in real Register data this same-FRN path is
 *     rare. The FCA typically issues a brand NEW FRN when a firm goes
 *     directly authorised (see migration 103's own Trust Point/M6 examples —
 *     the AR-era and Authorised-era records are two entirely different
 *     FRNs). That real-world case shows up here as a brand-new FRN (event
 *     'new') carrying target_tier 'transition' via the existing
 *     Companies-House matching (findTransitionEvidence), grouped under "new
 *     firms by tier" in the digest — not this same-FRN path. This function
 *     still needs to exist and be correct, because it's the mechanism that
 *     WOULD catch a same-FRN transition if the Register ever behaves that
 *     way for a given firm, but it should not be relied on as the primary
 *     way a real transition gets caught.
 *   - was not already a dead/excluded status and now is one (isDeadStatus)
 *     — the firm has left the market: run-off, revoked, cancelled, etc.
 *   - anything else that changed (e.g. Authorised -> Appointed
 *     representative) is neither of the above — still worth enriching, just
 *     not one of the two headline digest sections.
 */
export function classifyObservationChange(
  diff: ObservationDiff,
  newStatus: string
): ObservationDigestCategory {
  if (diff.event !== 'status-changed') return diff.event;
  if (isAppointedRepresentativeStatus(diff.previousStatus) && isConfirmedAuthorisedStatus(newStatus)) {
    return 'transition';
  }
  if (!isDeadStatus(diff.previousStatus) && isDeadStatus(newStatus)) {
    return 'departure';
  }
  return 'other-status-change';
}

export type SweepEnrichDecision = 'enrich' | 'skip-unchanged' | 'skip-limit';

/** Whether a sweep-observed firm is worth spending the enrichment cost on
 * (Firm/Permissions/Address — up to 3 more requests per firm). An
 * 'unchanged' observation never is — that saving is the entire point of
 * recording observations at all (see migration 104's header comment). A new
 * or changed firm is enriched up to --limit of them per run; beyond that
 * it's counted (never silently dropped) and left for a future run. */
export function decideSweepEnrichAction(
  event: ObservationEvent,
  enrichedCountSoFar: number,
  limit: number
): SweepEnrichDecision {
  if (event === 'unchanged') return 'skip-unchanged';
  if (enrichedCountSoFar >= limit) return 'skip-limit';
  return 'enrich';
}

export type ObservationCommitReason = 'excluded-by-rule' | 'enrichment-attempted' | 'skip-limit';

/** Whether a firm's fca_register_observations row should actually advance to
 * this run's fca_status (and stamp previous_status/status_changed_at), or be
 * left exactly as it already was so the SAME change is detected and retried
 * on a future run — see runSweep's --limit handling and migration 104's
 * header comment.
 *
 * This exists because of a real bug: recording the observation and deciding
 * whether to enrich used to happen as one step, so a firm whose status had
 * genuinely changed but which was skipped purely because --limit was reached
 * still had its new status written down. The next run then compared the
 * (already-updated) stored status against the Register's still-current
 * status, saw no difference, and silently never enriched it — the change
 * was lost for good, with nothing in the output saying so.
 *
 * The fix: only a genuine decision about this firm THIS run — enrichment was
 * actually attempted (regardless of whether it succeeded), or it was
 * deliberately excluded by a targeting rule (dead/introducer status, or
 * post-enrichment individual/existing-client) — earns the advance. Being
 * skipped merely because the enrichment budget ran out does not; last_seen_at
 * and firm_name still get bumped either way (see runSweep), but fca_status/
 * previous_status/status_changed_at are left stale on purpose. */
export function shouldAdvanceObservation(reason: ObservationCommitReason): boolean {
  return reason !== 'skip-limit';
}

// ── Target tiering (migration 105_prospect_tier.sql) ────────────────────

export type TargetTier = 'transition' | 'established_da' | 'appointed_rep' | 'startup' | 'unknown';

const ALL_TARGET_TIERS: TargetTier[] = ['transition', 'established_da', 'appointed_rep', 'startup', 'unknown'];

/** Ranks a prospect by buying intent, computed entirely from data an
 * enrichment run already fetched — no new API calls. Ranking order, most
 * promising first: transition > established_da > appointed_rep > startup;
 * unknown isn't ranked, it just means this run's data couldn't place the
 * firm in any of the other four (see migration 105 for the full reasoning
 * behind each tier, including why 'startup' and 'unknown' are deliberately
 * distinct rather than collapsed). This is a snapshot recomputed on every
 * enrichment refresh, not a live derivation — it can go stale between runs
 * exactly like every other Register-derived column on `prospects`. */
export function assignTargetTier(
  fcaStatus: string | null,
  formerAr: boolean,
  authorisedSince: string | null,
  months: number,
  now: Date
): TargetTier {
  if (isConfirmedAuthorisedStatus(fcaStatus)) {
    if (formerAr) return 'transition';
    if (isAuthorisedWithinMonths(authorisedSince, months, now)) return 'startup';
    if (authorisedSince) return 'established_da';
    return 'unknown';
  }
  if (isAppointedRepresentativeStatus(fcaStatus)) return 'appointed_rep';
  return 'unknown';
}

// ── Digest grouping (Phase 4) ────────────────────────────────────────────

export interface SweepDigestFirm {
  frn: string;
  firmName: string;
  category: ObservationDigestCategory;
  previousStatus: string | null;
  newStatus: string;
  // null for a firm that never reached enrichment this run (e.g. excluded
  // as dead/introducer before ever being enriched, or a departure — which
  // is detected from the observation alone and is never enriched at all).
  tier: TargetTier | null;
  // When this run observed the change, so the digest says WHEN a firm moved and
  // not merely that it did. Triaging a weekly digest needs that: the window in
  // which a newly independent firm is actually in the market is short, so a
  // change seen this week reads very differently from one seen months ago.
  observedOn: string;
}

export interface SweepDigest {
  transitions: SweepDigestFirm[];
  departures: SweepDigestFirm[];
  newByTier: Record<TargetTier, SweepDigestFirm[]>;
}

/** Pure grouping for the end-of-sweep digest — ordered, in runSweep's actual
 * print order, by what needs action first: confirmed transitions, then new
 * firms grouped by tier, then departures. Kept as a standalone pure function
 * (rather than inline in runSweep) purely so this grouping logic is
 * unit-testable without a database or a live Register call. */
export function buildSweepDigest(firms: SweepDigestFirm[]): SweepDigest {
  const transitions = firms.filter((f) => f.category === 'transition');
  const departures = firms.filter((f) => f.category === 'departure');
  const newByTier = ALL_TARGET_TIERS.reduce((acc, tier) => {
    acc[tier] = [];
    return acc;
  }, {} as Record<TargetTier, SweepDigestFirm[]>);
  for (const f of firms) {
    if (f.category === 'new' && f.tier) newByTier[f.tier].push(f);
  }
  return { transitions, departures, newByTier };
}

// ── --export-outreach (Phase 3) ─────────────────────────────────────────
//
// Builds the B2B email outreach list: firms with a role-based inbox on file,
// no PECR opt-out, and not out of the market. See migration
// 106_prospect_outreach.sql for why email (not phone) is the first-contact
// channel, and the CallGuard-standard reasoning (repeated for every column
// on this table) for why general_email can only ever be a role inbox.

export interface OutreachCandidate {
  firmName: string;
  frn: string | null;
  generalEmail: string;
  website: string | null;
  fcaStatus: string | null;
  targetTier: TargetTier | null;
  formerAr: boolean;
  // ISO "yyyy-mm-dd", same shape as everywhere else this column is handled
  // (see EnrichedFirm.authorisedSince).
  authorisedSince: string | null;
  registeredAddress: string | null;
  // null means never opted out. Anything else (a Date or an ISO string —
  // node-postgres hands back a Date for a TIMESTAMPTZ column, a test fixture
  // may just use a string) means opted out — the exact value never matters
  // to this filter, only whether a PECR opt-out was ever recorded at all.
  optedOutAt: string | Date | null;
}

// Ranking order, most-promising-first, matching migration 105's own tier
// ordering (see assignTargetTier/ALL_TARGET_TIERS above): transition >
// established_da > appointed_rep > startup. A firm with no tier at all
// (target_tier IS NULL — never enriched since migration 105 shipped) is
// grouped with 'unknown' at the back: both mean "this run's data can't rank
// this firm", so there is no reason to sort one ahead of the other.
const OUTREACH_TIER_RANK: Partial<Record<TargetTier, number>> = {
  transition: 0,
  established_da: 1,
  appointed_rep: 2,
  startup: 3,
};
const UNTIERED_OUTREACH_RANK = 4;

function outreachTierRank(tier: TargetTier | null): number {
  if (tier && tier in OUTREACH_TIER_RANK) return OUTREACH_TIER_RANK[tier]!;
  return UNTIERED_OUTREACH_RANK;
}

/** most-promising-first ordering for the outreach export: tier rank first
 * (see outreachTierRank), then most recently authorised first within a tier,
 * then firm name — same shape as compareTransitionRank above, and for the
 * same reason (authorisedSince is already an ISO "yyyy-mm-dd" string, so
 * plain string comparison sorts it correctly; a missing date sorts as the
 * empty string, always "less than" a real one, so undated rows fall to the
 * back of their tier rather than jumping the queue). */
export function compareOutreachRank(a: OutreachCandidate, b: OutreachCandidate): number {
  const rankDiff = outreachTierRank(a.targetTier) - outreachTierRank(b.targetTier);
  if (rankDiff !== 0) return rankDiff;
  const aDate = a.authorisedSince ?? '';
  const bDate = b.authorisedSince ?? '';
  if (aDate !== bDate) return aDate > bDate ? -1 : 1;
  return a.firmName.localeCompare(b.firmName);
}

/** The entire filter+order pipeline for the outreach export, kept pure and
 * exported so it's unit-testable without a database (see
 * enrich-prospects-fca.test.ts). Takes every prospect that already has a
 * `general_email` on file (that much is left to the SQL WHERE clause — see
 * runExportOutreach) and narrows it down to the ones actually safe to email:
 *   - never a firm with a PECR opt-out on record. This is deliberately
 *     checked here, in code, rather than trusted to the caller's SQL alone
 *     — the brief is explicit that this is the one filter that must never
 *     be forgotten, so it is enforced at both the query and this pure
 *     function, not either alone.
 *   - never a firm whose `fca_status` shows it has left the market —
 *     reuses isDeadStatus (the same predicate --discover/--sweep already
 *     use to decide a firm isn't a prospect at all) rather than
 *     re-implementing "has this firm left the market" a second way.
 */
export function selectOutreachCandidates(candidates: OutreachCandidate[]): OutreachCandidate[] {
  return candidates
    .filter((c) => c.optedOutAt === null)
    .filter((c) => !isDeadStatus(c.fcaStatus))
    .sort(compareOutreachRank);
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

/** Mirrors csvEscapeProspect in routes/superadmin.ts (RFC4180 quoting: only
 * quote a field that needs it, double up embedded quotes) — used by
 * --export-outreach's CSV writer, below. */
function csvEscapeField(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
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

export interface EnrichedFirm {
  frn: string;
  firmName: string;
  fcaStatus: string | null;
  permissions: string[];
  website: string | null;
  mainPhone: string | null;
  registeredAddress: string | null;
  companiesHouseNumber: string | null;
  // ISO "yyyy-mm-dd", parsed from the Firm record's "Status Effective Date"
  // via parseFcaDate — null if absent or malformed.
  authorisedSince: string | null;
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
      companiesHouseNumber: firmData['Companies House Number']?.trim() || null,
      authorisedSince: parseFcaDate(firmData['Status Effective Date']),
    },
  };
}

/** The result of looking for transition evidence: `evidence` is the only
 * part that ever reaches the database (via processEnriched), and only ever
 * populated by a Companies House number match (see
 * isPersistableTransitionMatch). `unconfirmedFrn` is a name-only match that
 * could not be confirmed that way — surfaced in the console report so a
 * human can look at it, but never written to former_ar/ar_ceased_on. */
interface TransitionLookup {
  evidence: TransitionEvidence | null;
  unconfirmedFrn: string | null;
}

// Only spent on a "plausible" name match (see findPlausibleLapsedArMatches)
// — one extra Firm-record lookup per plausible match, never per dead row —
// to fetch the lapsed FRN's own Companies House number and the date its AR
// status ended, then apply decideTransitionMatch's classification. Keeps
// checking every plausible match even after finding a name-only one, in
// case a later candidate is the one with the confirming CH number; a
// CH-number match (via isPersistableTransitionMatch) returns immediately, a
// CH-number mismatch ('none') vetoes that candidate outright, and a
// name-only match is remembered (the first one seen) only for console
// visibility.
async function findTransitionEvidence(
  firmName: string,
  currentChNumber: string | null,
  lapsedCandidates: LapsedArCandidate[],
  rl: RateLimiter,
  headers: Record<string, string>
): Promise<TransitionLookup> {
  const plausible = findPlausibleLapsedArMatches(firmName, lapsedCandidates);
  let unconfirmedFrn: string | null = null;
  for (const candidate of plausible) {
    const lapsedFirmRes = await getFirm(rl, headers, candidate.frn);
    const lapsedFirmData = lapsedFirmRes.ok ? (lapsedFirmRes.data ?? [])[0] ?? null : null;
    const lapsedChNumber = lapsedFirmData?.['Companies House Number']?.trim() || null;
    const matchKind = decideTransitionMatch(currentChNumber, lapsedChNumber);
    if (isPersistableTransitionMatch(matchKind)) {
      return {
        evidence: { formerAr: true, arCeasedOn: parseFcaDate(lapsedFirmData?.['Status Effective Date']) },
        unconfirmedFrn: null,
      };
    }
    if (matchKind === 'name' && !unconfirmedFrn) unconfirmedFrn = candidate.frn;
  }
  return { evidence: null, unconfirmedFrn };
}

// ── Upsert ───────────────────────────────────────────────────────────────

export interface ExistingProspectRow {
  id: string;
  firm_name: string;
  frn: string | null;
  fca_status: string | null;
  permissions: string[];
  website: string | null;
  main_phone: string | null;
  registered_address: string | null;
  companies_house_number: string | null;
  authorised_since: string | null;
  former_ar: boolean;
  ar_ceased_on: string | null;
  target_tier: TargetTier | null;
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

// node-postgres returns a DATE column (authorised_since, ar_ceased_on) as a
// JS Date object, not the "yyyy-mm-dd" string this script writes and
// compares against — left as-is, that mismatch would report a spurious
// "change" on every single re-run even when the stored date is identical.
// Normalise both sides to the same "yyyy-mm-dd" shape before comparing.
function normalizeDiffValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

export function diffFields(existing: ExistingProspectRow, next: Record<string, unknown>): string[] {
  const diffs: string[] = [];
  for (const [k, v] of Object.entries(next)) {
    const oldVal = normalizeDiffValue((existing as unknown as Record<string, unknown>)[k]);
    const newVal = normalizeDiffValue(v);
    const same = Array.isArray(newVal)
      ? JSON.stringify([...newVal].sort()) === JSON.stringify([...(Array.isArray(oldVal) ? oldVal : [])].sort())
      : (newVal ?? null) === (oldVal ?? null);
    if (!same) diffs.push(`${k}: ${JSON.stringify(oldVal ?? null)} -> ${JSON.stringify(newVal ?? null)}`);
  }
  return diffs;
}

// Exported (rather than kept file-private, like every other DB-touching
// function here) purely so enrich-prospects-fca.test.ts can prove — against
// a mocked db client, per the repo's existing pattern for DB-bound logic
// (see services/journey.test.ts) — that a re-run never clobbers
// opted_out_at/general_email/general_email_source_url. Nothing else outside
// this file should call it directly; main()/runDiscover()/runSweep() remain
// the only real callers.
export async function processEnriched(
  firm: EnrichedFirm,
  write: boolean,
  transition: TransitionEvidence | null
): Promise<{ action: 'create' | 'update'; diffs: string[]; tier: TargetTier }> {
  const existing = await findExisting(firm.frn, firm.firmName);
  if (existing === 'ambiguous') {
    throw new Error(`multiple existing prospects named "${firm.firmName}" with no FRN to disambiguate — resolve manually`);
  }

  // former_ar/ar_ceased_on are never clobbered back to "no evidence": with
  // no transition found this run (either because this call site never
  // attempts detection — the single-firm enrich path below always passes
  // null — or --discover ran the check and genuinely found nothing this
  // time), the existing row's values are carried through unchanged rather
  // than reset to false/null. Only positive evidence ever overwrites them.
  // See TransitionEvidence's own comment for why that asymmetry is
  // deliberate.
  const formerAr = transition ? true : existing ? existing.former_ar : false;
  const arCeasedOn = transition ? transition.arCeasedOn : existing ? existing.ar_ceased_on : null;
  // target_tier is recomputed on every enrichment refresh (migration 105's
  // own comment) — a snapshot, not a live derivation — from data this
  // function already has in hand: the freshly-resolved fcaStatus/
  // authorisedSince plus formerAr, which is itself either fresh transition
  // evidence or the row's own carried-through value (see assignTargetTier).
  const tier = assignTargetTier(firm.fcaStatus, formerAr, firm.authorisedSince, DEFAULT_AUTHORISED_WITHIN_MONTHS, new Date());

  const nextValues = {
    firm_name: firm.firmName,
    frn: firm.frn,
    fca_status: firm.fcaStatus,
    permissions: firm.permissions,
    website: firm.website,
    main_phone: firm.mainPhone,
    registered_address: firm.registeredAddress,
    companies_house_number: firm.companiesHouseNumber,
    authorised_since: firm.authorisedSince,
    former_ar: formerAr,
    ar_ceased_on: arCeasedOn,
    target_tier: tier,
  };

  if (existing) {
    const diffs = diffFields(existing, nextValues);
    if (write) {
      // Only Register-derived columns + updated_at. status, note, fit_score,
      // last_contacted_at, ctps_screened_at, general_email,
      // general_email_source_url and opted_out_at are deliberately absent
      // from this SET clause — never written by this script, so an
      // enrichment refresh can never wipe a harvested email or, critically,
      // a PECR opt-out (see the file header comment and migration 106).
      await query(
        `UPDATE prospects SET
           firm_name               = $2,
           frn                     = COALESCE($3, frn),
           fca_status              = $4,
           permissions             = $5,
           website                 = $6,
           main_phone              = $7,
           registered_address      = $8,
           companies_house_number  = $9,
           authorised_since        = $10,
           former_ar               = $11,
           ar_ceased_on            = $12,
           target_tier             = $13,
           updated_at              = now()
         WHERE id = $1`,
        [
          existing.id, nextValues.firm_name, nextValues.frn, nextValues.fca_status,
          nextValues.permissions, nextValues.website, nextValues.main_phone, nextValues.registered_address,
          nextValues.companies_house_number, nextValues.authorised_since, nextValues.former_ar, nextValues.ar_ceased_on,
          nextValues.target_tier,
        ]
      );
    }
    return { action: 'update', diffs, tier };
  }

  if (write) {
    await query(
      `INSERT INTO prospects (
         firm_name, frn, fca_status, permissions, website, main_phone, registered_address,
         companies_house_number, authorised_since, former_ar, ar_ceased_on, target_tier, source
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'directory')`,
      [
        nextValues.firm_name, nextValues.frn, nextValues.fca_status,
        nextValues.permissions, nextValues.website, nextValues.main_phone, nextValues.registered_address,
        nextValues.companies_house_number, nextValues.authorised_since, nextValues.former_ar, nextValues.ar_ceased_on,
        nextValues.target_tier,
      ]
    );
  }
  return { action: 'create', diffs: [], tier };
}

// ── CLI plumbing ─────────────────────────────────────────────────────────

export interface ParsedArgs {
  file: string | null;
  yes: boolean;
  dryRun: boolean;
  // --include-clients: the rare escape hatch to disable the existing-client
  // guard (see findMatchingExistingClient) and write a match like any other
  // firm. Defaults to off — the guard is conservative by design.
  includeClients: boolean;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  let file: string | null = null;
  let yes = false;
  let dryRun = false;
  let includeClients = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--file') { file = argv[++i] ?? null; continue; }
    if (a === '--yes') { yes = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--include-clients') { includeClients = true; continue; }
    if (a.startsWith('--')) { continue; }
    positional.push(a);
  }
  return { file, yes, dryRun, includeClients, positional };
}

const DEFAULT_DISCOVER_LIMIT = 250;

export interface DiscoverArgs {
  terms: string[];
  termsFile: string | null;
  limit: number;
  yes: boolean;
  dryRun: boolean;
  // --transitions-only: write only firms that are Authorised AND (a
  // confirmed former AR OR authorised within authorisedWithinMonths). See
  // qualifiesForTransitionsOnly.
  transitionsOnly: boolean;
  authorisedWithinMonths: number;
  // --include-clients: see ParsedArgs's field of the same name — the
  // discover path has its own copy since DiscoverArgs is a distinct shape.
  includeClients: boolean;
  // --verbose: restores the per-firm [not-transition] line that
  // --transitions-only otherwise suppresses (see runDiscover) — off by
  // default so a broad discovery run doesn't print hundreds of routine
  // exclusion lines to convey a handful of results.
  verbose: boolean;
}

// Separate from parseArgs (rather than extending it) so the existing
// ParsedArgs shape — and the tests asserting its exact fields — are
// untouched; --discover is a distinct mode with its own flags (--terms-file,
// --limit, --transitions-only, --authorised-within-months, --include-clients,
// --verbose) that don't apply to the single-firm enrich path.
export function parseDiscoverArgs(argv: string[]): DiscoverArgs {
  let termsFile: string | null = null;
  let limit = DEFAULT_DISCOVER_LIMIT;
  let yes = false;
  let dryRun = false;
  let transitionsOnly = false;
  let authorisedWithinMonths = DEFAULT_AUTHORISED_WITHIN_MONTHS;
  let includeClients = false;
  let verbose = false;
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
    if (a === '--transitions-only') { transitionsOnly = true; continue; }
    if (a === '--authorised-within-months') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) authorisedWithinMonths = Math.floor(n);
      continue;
    }
    if (a === '--include-clients') { includeClients = true; continue; }
    if (a === '--verbose') { verbose = true; continue; }
    if (a.startsWith('--')) continue;
    terms.push(a);
  }
  return { terms, termsFile, limit, yes, dryRun, transitionsOnly, authorisedWithinMonths, includeClients, verbose };
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

/** Loads every tenant name once at startup — a single query, never one per
 * candidate — for the existing-client guard (see findMatchingExistingClient).
 * Called unconditionally by main() even when --include-clients is set, since
 * the query itself is cheap and the flag only decides whether the result is
 * actually applied. */
async function loadExistingClientNames(): Promise<string[]> {
  const rows = await query<{ name: string }>(`SELECT name FROM organizations`);
  return rows.map((r) => r.name);
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

// Shared by --discover and --sweep (both DiscoverArgs and SweepArgs carry
// `terms`/`termsFile`) — kept as one function rather than duplicated per the
// brief's "do not duplicate" instruction.
function loadDiscoverTerms(args: { terms: string[]; termsFile: string | null }): string[] {
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

async function runDiscover(
  argv: string[],
  headers: Record<string, string>,
  existingClientNames: string[]
): Promise<void> {
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
      'Usage: enrich-prospects-fca.ts --discover <term> [<term> ...] [--terms-file <path>] [--limit N] ' +
        '[--transitions-only] [--authorised-within-months N] [--include-clients] [--verbose] [--yes] [--dry-run]'
    );
    process.exitCode = 1;
    return;
  }

  printDbBanner();
  console.log(`\nDiscover mode: ${terms.length} search term(s), --limit ${args.limit} new firm(s).`);
  console.log(write ? 'Mode: LIVE — writes will be made.' : 'Mode: PREVIEW (dry run) — nothing will be written.');
  if (args.transitionsOnly) {
    console.log(
      `--transitions-only: writing only Authorised firms that are a confirmed former AR, or authorised within the last ${args.authorisedWithinMonths} month(s).`
    );
  }
  if (args.includeClients) {
    console.log('--include-clients: the existing-client guard is DISABLED — a matching tenant will be written like any other firm.');
  }

  const rl = new RateLimiter();

  const seenFrns = new Set<string>();
  const unrecognisedStatuses = new Set<string>();
  // Lapsed Appointed Representative sightings from this run's search
  // results — the other half of the AR -> directly-authorised transition
  // evidence (see isLapsedArStatus). Persists across every term/page, same
  // as seenFrns, since the lapsed record and the live authorised one can
  // easily surface under different search terms.
  const lapsedArIndex: LapsedArCandidate[] = [];
  let rawResultsCount = 0;
  let excludedDeadCount = 0;
  let excludedIntroducerCount = 0;
  let skippedIndividualCount = 0;
  let blankFrnCount = 0;
  let duplicateCount = 0;
  let alreadyKnownCount = 0;
  let newCount = 0;
  let limitSkippedCount = 0;
  let excludedNotTransitionCount = 0;
  let skippedExistingClientCount = 0;
  let termsSearched = 0;
  let limitReached = false;
  const termFailures: string[] = [];
  const failed: string[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const skippedExistingClient: string[] = [];
  const transitionRows: { firmName: string; frn: string; formerAr: boolean; authorisedSince: string | null }[] = [];

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
          if (isLapsedArStatus(c.status)) {
            lapsedArIndex.push({ frn: c.frn, name: c.name, status: c.status });
          }
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

        if (!isLikelyCompanyName(firm.firmName)) {
          skippedIndividualCount++;
          console.log(`  [skip-individual] "${firm.firmName}" (FRN ${firm.frn})`);
          continue;
        }

        if (!args.includeClients) {
          const matchedOrg = findMatchingExistingClient(firm.firmName, existingClientNames);
          if (matchedOrg) {
            skippedExistingClientCount++;
            const line = `  [skip-existing-client] "${firm.firmName}" (FRN ${firm.frn}) — matches existing tenant "${matchedOrg}"`;
            skippedExistingClient.push(line);
            console.log(line);
            continue;
          }
        }

        // Only worth checking once the firm is confirmed Authorised — an AR
        // (or anything else) can't be the destination end of an AR ->
        // directly-authorised transition. See findTransitionEvidence.
        // `evidence` is the only part ever persisted; a name-only match
        // that couldn't be confirmed by Companies House number surfaces
        // below as an "unconfirmed" note, never as former_ar.
        const transitionLookup = isConfirmedAuthorisedStatus(firm.fcaStatus)
          ? await findTransitionEvidence(firm.firmName, firm.companiesHouseNumber, lapsedArIndex, rl, headers)
          : { evidence: null, unconfirmedFrn: null };
        const transition = transitionLookup.evidence;
        const unconfirmedNote = transitionLookup.unconfirmedFrn
          ? `possible former AR (FRN ${transitionLookup.unconfirmedFrn}) — name match only, not confirmed by Companies House number, NOT recorded`
          : null;
        const allNotes = [...enrichOutcome.notes, ...(unconfirmedNote ? [unconfirmedNote] : [])];
        const noteSuffix = allNotes.length > 0 ? ` [note: ${allNotes.join('; ')}]` : '';

        if (args.transitionsOnly) {
          const qualifies = qualifiesForTransitionsOnly(
            firm.fcaStatus,
            !!transition,
            firm.authorisedSince,
            args.authorisedWithinMonths,
            new Date()
          );
          if (!qualifies) {
            excludedNotTransitionCount++;
            // Suppressed by default — a broad discovery run can hit
            // hundreds of routine exclusions to convey a handful of real
            // results (see excludedNotTransitionCount in the summary
            // below). --verbose restores the per-firm line.
            if (args.verbose) {
              const dateLabel = formatStatusEffectiveDateLabel(firm.fcaStatus, firm.authorisedSince);
              console.log(
                `  [not-transition] "${firm.firmName}" (FRN ${firm.frn}) — status "${firm.fcaStatus ?? 'unknown'}"` +
                  `${dateLabel ? `, ${dateLabel}` : ''} — excluded by --transitions-only${noteSuffix}`
              );
            }
            continue;
          }
        }

        try {
          const plan = await processEnriched(firm, write, transition);
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
          if (args.transitionsOnly) {
            transitionRows.push({
              firmName: firm.firmName,
              frn: firm.frn,
              formerAr: !!transition,
              authorisedSince: firm.authorisedSince,
            });
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
  console.log(`Skipped — existing client:         ${skippedExistingClientCount} (not written; matches a CallGuard tenant)`);
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
  if (args.transitionsOnly) {
    console.log(`Excluded — not a transitions-only match: ${excludedNotTransitionCount}`);
  }

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

  if (args.transitionsOnly) {
    // Ranked, most-promising-first — readable straight off this run, no SQL
    // query needed (see compareTransitionRank). fit_score is deliberately
    // never set for this — this is a print-time ranking only.
    console.log(`\n=== Transitions-only ranked list (${transitionRows.length}) — most promising first ===`);
    [...transitionRows]
      .sort((a, b) => compareTransitionRank(a, b))
      .forEach((r) => {
        const marker = r.formerAr ? ' [former AR]' : '';
        console.log(`  ${r.authorisedSince ?? '(authorised date unknown)'}  ${r.firmName} (FRN ${r.frn})${marker}`);
      });
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

// ── --sweep ──────────────────────────────────────────────────────────────
//
// Turns this script from a one-off list-builder into a recurring monitor —
// see migration 104_fca_register_observations.sql and docs/prospect-sweep.md
// for the full design. Reuses everything --discover already has: the FCA
// client, RateLimiter, exclusion predicates (isDeadStatus/isIntroducerStatus/
// isLikelyCompanyName), findMatchingExistingClient, enrichFirm,
// findTransitionEvidence and processEnriched. The only genuinely new thing
// --sweep does is decide, per firm, whether any of that is worth doing at
// all this run — see diffObservation/decideSweepEnrichAction above.

export interface SweepArgs {
  terms: string[];
  termsFile: string | null;
  // Bounds how many new-or-changed firms get enriched (Firm/Permissions/
  // Address — the expensive calls) this run — see decideSweepEnrichAction.
  // Unlike --discover's --limit, this never stops a term's paging early:
  // every search result is still observed (see runSweep) regardless of
  // whether it happens to fall past this limit, since recording the
  // observation costs nothing extra. Defaults to unlimited — a real
  // scheduled sweep is meant to enrich every change it finds; --limit exists
  // mainly so a manual/test run can bound how many expensive calls it makes.
  limit: number;
  yes: boolean;
  dryRun: boolean;
  includeClients: boolean;
  verbose: boolean;
}

export function parseSweepArgs(argv: string[]): SweepArgs {
  let termsFile: string | null = null;
  let limit = Infinity;
  let yes = false;
  let dryRun = false;
  let includeClients = false;
  let verbose = false;
  const terms: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--sweep') continue;
    if (a === '--terms-file') { termsFile = argv[++i] ?? null; continue; }
    if (a === '--limit') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
      continue;
    }
    if (a === '--yes') { yes = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--include-clients') { includeClients = true; continue; }
    if (a === '--verbose') { verbose = true; continue; }
    if (a.startsWith('--')) continue;
    terms.push(a);
  }
  return { terms, termsFile, limit, yes, dryRun, includeClients, verbose };
}

/** Reads the stored status for one FRN from fca_register_observations, or
 * null if it's never been seen. Read unconditionally, even in preview mode —
 * the diff it produces (see diffObservation) is what the rest of the sweep
 * uses to decide whether to bother enriching this firm at all; only the
 * actual write is gated behind `write`, same convention as every other DB
 * touch in this script. */
async function readObservationStatus(frn: string): Promise<string | null> {
  const row = await queryOne<{ fca_status: string }>(
    `SELECT fca_status FROM fca_register_observations WHERE frn = $1`,
    [frn]
  );
  return row?.fca_status ?? null;
}

/** Bumps last_seen_at (and refreshes firm_name) on an EXISTING observation
 * row WITHOUT touching fca_status/previous_status/status_changed_at — used
 * both for a genuinely unchanged sighting and for a changed one that is
 * being deliberately deferred (see shouldAdvanceObservation and runSweep's
 * --limit handling). Only ever called on a row diffObservation has already
 * confirmed exists — a 'new' event has no row yet to touch (see runSweep:
 * a brand-new FRN deferred for budget reasons gets no row written at all
 * this run, so the next run still sees it as 'new'). */
async function touchObservationSeen(frn: string, firmName: string): Promise<void> {
  await query(
    `UPDATE fca_register_observations SET firm_name = $2, last_seen_at = now() WHERE frn = $1`,
    [frn, firmName]
  );
}

/** Commits this run's observed status as the firm's new stored truth — only
 * ever called once runSweep has actually decided this firm's fate this run
 * (enrichment attempted, or excluded by a deliberate targeting rule), never
 * when it was merely skipped for budget reasons (see shouldAdvanceObservation
 * and the ObservationCommitReason it takes). Handles both a first sighting
 * (INSERT) and a genuine status change (UPDATE, moving the old value into
 * previous_status) — 'unchanged' never reaches this function; see
 * touchObservationSeen for that case. */
async function advanceObservation(frn: string, firmName: string, status: string, diff: ObservationDiff): Promise<void> {
  if (diff.event === 'new') {
    await query(
      `INSERT INTO fca_register_observations (frn, firm_name, fca_status)
       VALUES ($1, $2, $3)
       ON CONFLICT (frn) DO NOTHING`,
      [frn, firmName, status]
    );
    return;
  }
  await query(
    `UPDATE fca_register_observations
       SET firm_name = $2, previous_status = fca_status, fca_status = $3,
           status_changed_at = now(), last_seen_at = now()
     WHERE frn = $1`,
    [frn, firmName, status]
  );
}

async function runSweep(
  argv: string[],
  headers: Record<string, string>,
  existingClientNames: string[]
): Promise<void> {
  const args = parseSweepArgs(argv);
  const write = args.yes && !args.dryRun;
  // Stamped once so every firm in one sweep reports the same observation date,
  // rather than drifting across a run that can take a long while at 50 requests
  // per 10 seconds.
  const sweepStartedOn = new Date().toISOString().slice(0, 10);

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
      'Usage: enrich-prospects-fca.ts --sweep <term> [<term> ...] [--terms-file <path>] [--limit N] ' +
        '[--include-clients] [--verbose] [--yes] [--dry-run]'
    );
    process.exitCode = 1;
    return;
  }

  printDbBanner();
  console.log(
    `\nSweep mode: ${terms.length} search term(s)` +
      (Number.isFinite(args.limit) ? `, --limit ${args.limit} enrichment(s)` : ', no --limit (enriches every change found)') +
      '.'
  );
  console.log(write ? 'Mode: LIVE — writes will be made.' : 'Mode: PREVIEW (dry run) — nothing will be written.');
  if (args.includeClients) {
    console.log('--include-clients: the existing-client guard is DISABLED — a matching tenant will be written like any other firm.');
  }

  const rl = new RateLimiter();
  const seenFrns = new Set<string>();
  // Same purpose as --discover's lapsedArIndex — lapsed-AR sightings from
  // this run's own search results, spent on the one extra Firm lookup a
  // plausible name match costs (see findTransitionEvidence). Built from
  // every non-individual candidate seen this run, regardless of whether its
  // own observation turned out to be new/unchanged/changed.
  const lapsedArIndex: LapsedArCandidate[] = [];

  let termsSearched = 0;
  let rawResultsCount = 0;
  let blankFrnCount = 0;
  let duplicateCount = 0;
  let skippedIndividualCount = 0;
  let observedCount = 0;
  let unchangedSkippedCount = 0;
  let otherStatusChangedCount = 0;
  let excludedDeadCount = 0;
  let excludedIntroducerCount = 0;
  let skippedExistingClientCount = 0;
  let enrichedCount = 0;
  // Changed (or brand-new) firms this run detected but did NOT enrich purely
  // because --limit was reached — self-healing (see shouldAdvanceObservation
  // and the [skip-limit] branch below): each of these will be detected again
  // and retried on the next run, never silently dropped.
  let enrichBudgetDeferredCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  const failed: string[] = [];
  const digestFirms: SweepDigestFirm[] = [];

  for (const term of terms) {
    termsSearched++;
    let page = 1;
    for (;;) {
      const pageResult = await searchFirmPage(rl, headers, term, page);
      if (!pageResult.ok) {
        console.log(`  [search-failed] "${term}" page ${page} — ${pageResult.message}`);
        break;
      }
      const items = pageResult.data ?? [];
      if (items.length === 0) break;
      rawResultsCount += items.length;

      const candidates = toDiscoveryCandidates(items);
      blankFrnCount += items.length - candidates.length;
      const fresh = dedupeByFrn(candidates, seenFrns);
      duplicateCount += candidates.length - fresh.length;

      for (const c of fresh) {
        // Step 1 (see migration 104's header comment): a named individual is
        // never recorded here at all — no observation, no prospect. This is
        // checked BEFORE the observation read/diff, which is why it happens
        // earlier in this loop than --discover's equivalent check.
        if (!isLikelyCompanyName(c.name)) {
          skippedIndividualCount++;
          if (args.verbose) console.log(`  [skip-individual] "${c.name}" (FRN ${c.frn}) — not observed, needs an LIA`);
          continue;
        }

        // Step 2: diff against what was already stored — read-only. Nothing
        // is written yet: whether (and how) this run actually commits that
        // to fca_register_observations depends on what happens to this firm
        // below (see shouldAdvanceObservation's own comment for why).
        const existingStatus = await readObservationStatus(c.frn);
        const diff = diffObservation(existingStatus, c.status);
        observedCount++;

        if (isDeadStatus(c.status) && isLapsedArStatus(c.status)) {
          lapsedArIndex.push({ frn: c.frn, name: c.name, status: c.status });
        }

        // Step 3: classify what the diff means. This is pure comparison
        // logic against the Register's own reported status, so it's valid
        // (and worth reporting) regardless of what this run ends up
        // committing to the database below.
        const category = classifyObservationChange(diff, c.status);

        if (diff.event === 'unchanged') {
          // The whole saving a repeat sweep exists to realise: bump
          // last_seen_at/firm_name only, nothing else to do.
          if (write) await touchObservationSeen(c.frn, c.name);
          unchangedSkippedCount++;
          continue;
        }

        if (category === 'transition' || category === 'departure') {
          digestFirms.push({
            frn: c.frn,
            firmName: c.name,
            category,
            previousStatus: diff.previousStatus,
            newStatus: c.status,
            tier: null,
            observedOn: sweepStartedOn,
          });
          console.log(
            `  [${category}] "${c.name}" (FRN ${c.frn}) — ${diff.previousStatus ?? '(unknown)'} -> ${c.status}`
          );
        } else if (category === 'other-status-change') {
          otherStatusChangedCount++;
        }

        // Apply --discover's existing exclusions to the PROSPECT write only.
        // A dead/introducer status is a deliberate targeting-rule decision —
        // this firm's fate this run is settled regardless of the enrichment
        // budget, so its observation is fully advanced now (see
        // shouldAdvanceObservation).
        if (isIntroducerStatus(c.status)) {
          excludedIntroducerCount++;
          if (write) await advanceObservation(c.frn, c.name, c.status, diff);
          continue;
        }
        if (isDeadStatus(c.status)) {
          excludedDeadCount++;
          if (write) await advanceObservation(c.frn, c.name, c.status, diff);
          continue;
        }

        const decision = decideSweepEnrichAction(diff.event, enrichedCount, args.limit);
        if (decision === 'skip-limit') {
          enrichBudgetDeferredCount++;
          // THE FIX: a firm skipped purely because the enrichment budget ran
          // out must NOT have its observation advanced — doing so is exactly
          // the bug that let a real status change be silently lost forever,
          // because the next run would then compare the (already-updated)
          // stored status against the Register's still-current one, see no
          // difference, and never enrich it. Leaving fca_status untouched
          // means the next run's diff sees the SAME change again and retries
          // it — see shouldAdvanceObservation's own comment for the full
          // story, and the "re-detected on the following run" tests in
          // enrich-prospects-fca.test.ts.
          //
          // A brand-new FRN (diff.event === 'new') gets no row at all this
          // run: fca_status is NOT NULL, so there is no "stale but valid"
          // value such a row could hold, and touchObservationSeen only ever
          // updates a row that already exists. The next run sees it as 'new'
          // again and gets another chance, subject to the same limit.
          if (write && diff.event === 'status-changed') {
            await touchObservationSeen(c.frn, c.name);
          }
          continue;
        }

        // The enrichment budget is spent on this firm now, regardless of
        // whether the lookup below actually succeeds — see
        // shouldAdvanceObservation('enrichment-attempted').
        if (write) await advanceObservation(c.frn, c.name, c.status, diff);

        const enrichOutcome = await enrichFirm(c.frn, c.status, rl, headers);
        enrichedCount++;
        if (!enrichOutcome.ok) {
          failed.push(`  "${c.name}" (FRN ${c.frn}) — ${enrichOutcome.reason}`);
          console.log(`  [FAILED]    "${c.name}" (FRN ${c.frn}) — ${enrichOutcome.reason}`);
          continue;
        }
        const firm = enrichOutcome.firm;

        if (!isLikelyCompanyName(firm.firmName)) {
          skippedIndividualCount++;
          console.log(`  [skip-individual] "${firm.firmName}" (FRN ${firm.frn})`);
          continue;
        }

        if (!args.includeClients) {
          const matchedOrg = findMatchingExistingClient(firm.firmName, existingClientNames);
          if (matchedOrg) {
            skippedExistingClientCount++;
            console.log(`  [skip-existing-client] "${firm.firmName}" (FRN ${firm.frn}) — matches existing tenant "${matchedOrg}"`);
            continue;
          }
        }

        const transitionLookup = isConfirmedAuthorisedStatus(firm.fcaStatus)
          ? await findTransitionEvidence(firm.firmName, firm.companiesHouseNumber, lapsedArIndex, rl, headers)
          : { evidence: null, unconfirmedFrn: null };
        const transition = transitionLookup.evidence;

        try {
          const plan = await processEnriched(firm, write, transition);
          // Unlike --discover, this per-firm line is --verbose-only: a real
          // first sweep can enrich hundreds of genuinely new firms in one
          // run (see docs/prospect-sweep.md), and a previous run's per-firm
          // exclusion logging already once produced a 50,000+ character
          // report from routine volume like this — every firm here is still
          // counted (createdCount/updatedCount) and named individually in
          // the "New firms, grouped by tier" digest below regardless.
          if (plan.action === 'create') {
            createdCount++;
            if (args.verbose) {
              console.log(`  [${write ? 'created' : 'would create'}] ${firm.firmName} (FRN ${firm.frn}) — tier: ${plan.tier}`);
            }
          } else {
            updatedCount++;
            if (args.verbose) {
              const changeNote = plan.diffs.length > 0 ? plan.diffs.join('; ') : 'no changes';
              console.log(`  [${write ? 'updated' : 'would update'}] ${firm.firmName} (FRN ${firm.frn}) — ${changeNote} — tier: ${plan.tier}`);
            }
          }
          if (category === 'new') {
            digestFirms.push({
              frn: firm.frn,
              firmName: firm.firmName,
              category: 'new',
              previousStatus: null,
              newStatus: firm.fcaStatus ?? c.status,
              tier: plan.tier,
              observedOn: sweepStartedOn,
            });
          }
        } catch (err) {
          failed.push(`  "${firm.firmName}" (FRN ${firm.frn}) — ${(err as Error).message}`);
          console.log(`  [FAILED]    ${firm.firmName} (FRN ${firm.frn}) — ${(err as Error).message}`);
        }
      }

      if (!pageResult.resultInfo?.Next) break;
      page++;
    }
  }

  const digest = buildSweepDigest(digestFirms);

  console.log(`\n=== Transitions detected (${digest.transitions.length}) — the money list ===`);
  digest.transitions.forEach((f) =>
    console.log(
      `  ${f.firmName} (FRN ${f.frn}) — ${f.previousStatus ?? '(unknown)'} -> ${f.newStatus}` +
        ` (observed ${f.observedOn})`
    )
  );

  // Counts only by default — a broad first sweep can turn up hundreds of
  // genuinely new firms in one run (see docs/prospect-sweep.md), and naming
  // every one of them is exactly the kind of routine volume that once made
  // a report exceed 50,000 characters. --verbose restores the full,
  // per-firm name list within each tier.
  console.log('\n=== New firms, grouped by tier ===');
  for (const tier of ALL_TARGET_TIERS) {
    const firms = digest.newByTier[tier];
    console.log(`  ${tier} (${firms.length})${args.verbose ? ':' : ''}`);
    if (args.verbose) firms.forEach((f) => console.log(`    "${f.firmName}" (FRN ${f.frn})`));
  }

  console.log(`\n=== Firms that left the market (${digest.departures.length}) ===`);
  digest.departures.forEach((f) =>
    console.log(
      `  ${f.firmName} (FRN ${f.frn}) — ${f.previousStatus ?? '(unknown)'} -> ${f.newStatus}` +
        ` (observed ${f.observedOn})`
    )
  );

  console.log('\n=== Sweep Summary ===');
  console.log(`Terms searched:                    ${termsSearched} / ${terms.length}`);
  console.log(`Raw search results seen:           ${rawResultsCount}`);
  console.log(`Skipped — named individual:        ${skippedIndividualCount} (not observed; needs an LIA)`);
  console.log(`Dropped — blank-FRN scam clone:    ${blankFrnCount}`);
  console.log(`Duplicate FRN (seen earlier term):  ${duplicateCount}`);
  console.log(`Observed:                           ${observedCount}`);
  console.log(`Unchanged — skipped (no enrichment): ${unchangedSkippedCount}`);
  console.log(`Status changed — other:            ${otherStatusChangedCount}`);
  console.log(`Excluded — dead firm (not enriched): ${excludedDeadCount}`);
  console.log(`Excluded — introducer AR (not enriched): ${excludedIntroducerCount}`);
  console.log(`Skipped — existing client:         ${skippedExistingClientCount} (not written; matches a CallGuard tenant)`);
  console.log(`Enriched:                           ${enrichedCount}`);
  // Distinct from every other count above: this is the one that would have
  // been silent before the --limit fix — each of these is a real, detected
  // change that this run chose not to act on purely for budget reasons, and
  // will be reported again and retried on the next run (see
  // shouldAdvanceObservation).
  console.log(
    `Changed/new but NOT enriched — budget reached, will retry next run: ${enrichBudgetDeferredCount}` +
      (enrichBudgetDeferredCount > 0 ? ` (--limit ${args.limit})` : '')
  );
  console.log(`${write ? 'Created' : 'Would create'}:                       ${createdCount}`);
  console.log(`${write ? 'Updated' : 'Would update'}:                       ${updatedCount}`);
  console.log(`Failed:                             ${failed.length}`);
  failed.forEach((l) => console.log(l));

  if (!write) {
    console.log('\nPREVIEW ONLY — nothing has been written. Re-run with --sweep ... --yes to write the changes above.');
  }
}

// ── --export-outreach (Phase 3, DB-touching runner) ─────────────────────

export interface ExportOutreachArgs {
  outputPath: string | null;
}

export function parseExportOutreachArgs(argv: string[]): ExportOutreachArgs {
  let outputPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--export-outreach') { outputPath = argv[++i] ?? null; continue; }
  }
  return { outputPath };
}

interface OutreachDbRow {
  firm_name: string;
  frn: string | null;
  general_email: string;
  website: string | null;
  fca_status: string | null;
  target_tier: TargetTier | null;
  former_ar: boolean;
  authorised_since: string | Date | null;
  registered_address: string | null;
  opted_out_at: string | Date | null;
}

const OUTREACH_CSV_HEADER = [
  'firm_name', 'frn', 'general_email', 'website', 'fca_status', 'target_tier',
  'former_ar', 'authorised_since', 'registered_address',
];

/** No phone column, deliberately: this is the email list. A firm's
 * main_phone has never been CTPS-screened (see migration 102), so including
 * a number here would invite exactly the mistake this whole outreach
 * design exists to prevent — cold-calling before that screen has happened. */
async function runExportOutreach(argv: string[]): Promise<void> {
  const { outputPath } = parseExportOutreachArgs(argv);
  if (!outputPath) {
    console.error('Usage: enrich-prospects-fca.ts --export-outreach <path>');
    process.exitCode = 1;
    return;
  }

  // The email-presence filter is left to the WHERE clause here — there's no
  // outreach candidate at all without one, so there's nothing for the pure
  // selectOutreachCandidates pipeline to filter. Everything else that
  // decides whether a firm with an email is actually safe to mail (opt-out,
  // dead status) happens in that pure function instead, so it's covered by
  // a database-free unit test.
  const rows = await query<OutreachDbRow>(
    `SELECT firm_name, frn, general_email, website, fca_status, target_tier, former_ar,
            authorised_since, registered_address, opted_out_at
     FROM prospects
     WHERE general_email IS NOT NULL`
  );
  const noEmailRow = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM prospects WHERE general_email IS NULL`
  );
  const noEmailCount = Number(noEmailRow?.count ?? '0');

  const candidates: OutreachCandidate[] = rows.map((r) => ({
    firmName: r.firm_name,
    frn: r.frn,
    generalEmail: r.general_email,
    website: r.website,
    fcaStatus: r.fca_status,
    targetTier: r.target_tier,
    formerAr: r.former_ar,
    authorisedSince: normalizeDiffValue(r.authorised_since) as string | null,
    registeredAddress: r.registered_address,
    optedOutAt: r.opted_out_at,
  }));

  const selected = selectOutreachCandidates(candidates);
  const excludedOptedOutCount = candidates.filter((c) => c.optedOutAt !== null).length;
  const excludedDeadCount = candidates.filter((c) => c.optedOutAt === null && isDeadStatus(c.fcaStatus)).length;

  const lines = [OUTREACH_CSV_HEADER.join(',')];
  for (const c of selected) {
    lines.push(
      [
        c.firmName, c.frn, c.generalEmail, c.website, c.fcaStatus, c.targetTier,
        c.formerAr, c.authorisedSince, c.registeredAddress,
      ]
        .map(csvEscapeField)
        .join(',')
    );
  }

  const resolved = path.resolve(process.cwd(), outputPath);
  fs.writeFileSync(resolved, lines.join('\n') + '\n');

  console.log(`Outreach export: ${selected.length} emailable firm(s) written to ${resolved}`);
  console.log(`Excluded — opted out:                ${excludedOptedOutCount}`);
  console.log(`Excluded — left the market:           ${excludedDeadCount}`);
  console.log(`Excluded — no email on file:          ${noEmailCount}`);
}

// ── --harvest-emails (Phase 4, network-touching runner) ──────────────────
//
// Finds a role-based inbox on a prospect's OWN website, since the FCA
// Register publishes no email address at all. Every fetch goes through
// assertSafeRemoteUrl (services/url-safety.ts) — the same SSRF guard that
// already protects every other caller-supplied URL this codebase fetches
// (API ingest audio_url, bulk-import rows, CloudTalk recording_url) — so a
// prospect's `website` column can never be used to make this server request
// an internal address. See that file's own comments for the DNS-rebinding
// hazard its pinned `lookup` closes; the same requirement applies here:
// every request (including the one-hop redirect this allows, below) must
// connect using the `lookup` assertSafeRemoteUrl just returned, never a
// fresh resolution of the hostname.

// A small, fixed set of paths most business sites use for a contact/about
// page — never any URL supplied by a prospect record itself beyond the
// origin. Tried in this order; --harvest-emails stops at the first one that
// yields a role-based address.
const HARVEST_PATHS = ['/', '/contact', '/contact-us', '/about'];

const HARVEST_TIMEOUT_MS = 10_000;

// Enough for any real contact/about page (the largest ordinary marketing
// page is a small fraction of this); not remotely enough for anyone to use
// this as a way to make CallGuard download something large from a
// prospect's site.
const MAX_HARVEST_HTML_BYTES = 2 * 1024 * 1024;

// "Roughly one request per second" per the brief — these are other
// people's servers, not the FCA Register's rate-limited API. A single
// shared timestamp is enough (--harvest-emails processes one firm, one path
// at a time; there is no concurrency to coordinate).
const HARVEST_MIN_INTERVAL_MS = 1_000;
let lastHarvestRequestAt = 0;
async function throttleHarvestRequest(): Promise<void> {
  const wait = lastHarvestRequestAt + HARVEST_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHarvestRequestAt = Date.now();
}

interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

// GET a single DNS-pinned URL, same shape and same reasoning as
// services/ingestion.ts's requestPinned/fetchRemoteAudio: `https.request`
// rather than the global `fetch`, because `fetch` has no supported way to
// take a pre-resolved address short of a custom undici dispatcher, and
// re-resolving the hostname here would reopen the DNS-rebinding hole
// assertSafeRemoteUrl's pinned `lookup` exists to close. Reads the body
// itself (rather than handing back the stream) so the size cap below is
// enforced against bytes actually received, not a trusted Content-Length.
function fetchPinnedOnce(url: URL, lookup: LookupFunction): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        servername: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'User-Agent': 'CallGuardOutreachHarvester/1.0 (prospect research; see docs/prospect-sweep.md)',
          Accept: 'text/html',
        },
        lookup,
        timeout: HARVEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_HARVEST_HTML_BYTES) {
            res.destroy();
            reject(new Error(`response exceeded the ${MAX_HARVEST_HTML_BYTES} byte cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

type HarvestFetchOutcome = { ok: true; html: string } | { ok: false; reason: string };

/** Fetches one candidate URL, safely: SSRF-checked (and re-checked on the
 * redirect target — see below), at most one redirect and only when it stays
 * on the SAME host, a hard timeout, a hard size cap, and a content-type
 * check that skips anything that isn't HTML (a PDF brochure or a JSON API
 * response is never worth running the email regexes over). */
async function fetchHtmlSameHost(rawUrl: string): Promise<HarvestFetchOutcome> {
  let pinned;
  try {
    pinned = await assertSafeRemoteUrl(rawUrl);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  let { url, lookup } = pinned;
  let redirected = false;

  for (;;) {
    await throttleHarvestRequest();
    let res: PinnedResponse;
    try {
      res = await fetchPinnedOnce(url, lookup);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }

    if (res.status >= 300 && res.status < 400) {
      if (redirected) return { ok: false, reason: 'more than one redirect — not followed' };
      const location = res.headers.location;
      if (!location) return { ok: false, reason: `redirect (${res.status}) with no Location header` };
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, url);
      } catch {
        return { ok: false, reason: `redirect to an unparseable URL: ${location}` };
      }
      if (redirectUrl.hostname !== url.hostname) {
        return { ok: false, reason: `redirect left ${url.hostname} for ${redirectUrl.hostname} — not followed (same-host only)` };
      }
      // Re-validate the redirect target from scratch — a fresh
      // assertSafeRemoteUrl call, and the fresh `lookup` it returns, exactly
      // as that function's own comment requires for any caller that follows
      // a redirect at all.
      try {
        pinned = await assertSafeRemoteUrl(redirectUrl.toString());
      } catch (err) {
        return { ok: false, reason: `redirect target failed the SSRF check: ${(err as Error).message}` };
      }
      url = pinned.url;
      lookup = pinned.lookup;
      redirected = true;
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }

    const contentTypeHeader = res.headers['content-type'];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
    if (contentType && !/text\/html/i.test(contentType)) {
      return { ok: false, reason: `non-HTML content-type (${contentType})` };
    }

    return { ok: true, html: res.body.toString('utf8') };
  }
}

export interface HarvestEmailsArgs {
  yes: boolean;
  dryRun: boolean;
}

export function parseHarvestEmailsArgs(argv: string[]): HarvestEmailsArgs {
  let yes = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--harvest-emails') continue;
    if (a === '--yes') { yes = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
  }
  return { yes, dryRun };
}

interface HarvestCandidateRow {
  id: string;
  firm_name: string;
  website: string;
}

async function runHarvestEmails(argv: string[]): Promise<void> {
  const { yes, dryRun } = parseHarvestEmailsArgs(argv);
  const write = yes && !dryRun;

  const rows = await query<HarvestCandidateRow>(
    `SELECT id, firm_name, website FROM prospects WHERE website IS NOT NULL AND general_email IS NULL ORDER BY firm_name`
  );

  // Seeded from every general_email already on file, then updated as this
  // run stores its own — see wouldBeSharedDomain's own comment for why a
  // domain first seen earlier in THIS run must be caught too, not just one
  // already in the database.
  const existingEmailRows = await query<{ general_email: string }>(
    `SELECT general_email FROM prospects WHERE general_email IS NOT NULL`
  );
  const domainCounts = new Map<string, number>();
  for (const r of existingEmailRows) {
    const d = emailDomain(r.general_email);
    domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
  }

  printDbBanner();
  console.log(`\n--harvest-emails: ${rows.length} prospect(s) with a website and no email on file yet.`);
  console.log(write ? 'Mode: LIVE — writes will be made.' : 'Mode: PREVIEW (dry run) — nothing will be written.');

  let foundCount = 0;
  let noneFoundCount = 0;
  let fetchFailedCount = 0;
  let rejectedNotOwnCount = 0;
  const found: string[] = [];
  const noneFound: string[] = [];
  const fetchFailed: string[] = [];
  const rejectedNotOwn: string[] = [];

  for (const row of rows) {
    const origin = normalizeWebsiteToHttpsOrigin(row.website);
    if (!origin) {
      fetchFailedCount++;
      const line = `  [fetch-failed] "${row.firm_name}" — "${row.website}" is not a usable https URL`;
      fetchFailed.push(line);
      console.log(line);
      continue;
    }

    let anyFetchSucceeded = false;
    let match: { email: string; sourceUrl: string } | null = null;
    const pathFailures: string[] = [];

    for (const p of HARVEST_PATHS) {
      const candidateUrl = `${origin}${p}`;
      const outcome = await fetchHtmlSameHost(candidateUrl);
      if (!outcome.ok) {
        pathFailures.push(`${p} (${outcome.reason})`);
        continue;
      }
      anyFetchSucceeded = true;
      const email = extractRoleBasedEmail(outcome.html);
      if (email) {
        match = { email, sourceUrl: candidateUrl };
        break;
      }
    }

    if (match) {
      // Two independent checks — either failing refuses the address
      // outright, before any write. Neither is about whether the address is
      // role-based (extractRoleBasedEmail already guaranteed that); both are
      // about whether it is plausibly THIS firm's own, not its principal's
      // or a website builder's — see the section comment above
      // isPlausibleFirmDomain for the real Quilter case that prompted this.
      const domain = emailDomain(match.email);
      const ownershipFailures: string[] = [];
      if (wouldBeSharedDomain(domain, domainCounts)) {
        ownershipFailures.push('shared domain — already used by another prospect, likely a principal\'s or platform\'s domain');
      }
      if (!isPlausibleFirmDomain(row.firm_name, domain)) {
        ownershipFailures.push('domain does not plausibly match the firm name');
      }

      if (ownershipFailures.length > 0) {
        rejectedNotOwnCount++;
        const line = `  [needs-review] "${row.firm_name}" — ${match.email} (domain: ${domain}) — ${ownershipFailures.join('; ')} — NOT stored`;
        rejectedNotOwn.push(line);
        console.log(line);
        continue;
      }

      foundCount++;
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      const line = `  [${write ? 'found' : 'would set'}] "${row.firm_name}" — ${match.email} (${match.sourceUrl})`;
      found.push(line);
      console.log(line);
      if (write) {
        await query(
          `UPDATE prospects SET general_email = $2, general_email_source_url = $3, updated_at = now() WHERE id = $1`,
          [row.id, match.email, match.sourceUrl]
        );
      }
      continue;
    }

    if (anyFetchSucceeded) {
      noneFoundCount++;
      const line = `  [none-found] "${row.firm_name}" — ${origin} — no role-based address found on ${HARVEST_PATHS.join(', ')}`;
      noneFound.push(line);
      console.log(line);
    } else {
      fetchFailedCount++;
      const line = `  [fetch-failed] "${row.firm_name}" — ${origin} — ${pathFailures.join('; ')}`;
      fetchFailed.push(line);
      console.log(line);
    }
  }

  console.log('\n=== Harvest Summary ===');
  console.log(`Found:                    ${foundCount}`);
  console.log(`None found:               ${noneFoundCount}`);
  console.log(`Fetch failed:             ${fetchFailedCount}`);
  console.log(`Rejected — not the firm's own (needs a human look): ${rejectedNotOwnCount}`);

  if (!write) {
    console.log('\nPREVIEW ONLY — nothing has been written. Re-run with --harvest-emails --yes to write the addresses above.');
  }
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  // --export-outreach and --harvest-emails never call the FCA Register, so
  // neither needs FCA_API_EMAIL/FCA_API_KEY — dispatched before
  // checkFcaCredentials below so an operator running only one of these
  // doesn't need Register credentials configured at all.
  if (rawArgv.includes('--export-outreach')) {
    await runExportOutreach(rawArgv);
    return;
  }
  if (rawArgv.includes('--harvest-emails')) {
    await runHarvestEmails(rawArgv);
    return;
  }

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

  // Loaded once, up front, for the existing-client guard (see
  // findMatchingExistingClient) — never queried per candidate.
  const existingClientNames = await loadExistingClientNames();

  if (rawArgv.includes('--discover')) {
    await runDiscover(rawArgv, headers, existingClientNames);
    return;
  }
  if (rawArgv.includes('--sweep')) {
    await runSweep(rawArgv, headers, existingClientNames);
    return;
  }

  const { file, yes, dryRun, includeClients, positional } = parseArgs(rawArgv);
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
      'Usage: enrich-prospects-fca.ts (--file <path-to-csv> | <name-or-frn> [<name-or-frn> ...]) [--include-clients] [--yes] [--dry-run]'
    );
    process.exitCode = 1;
    return;
  }

  printDbBanner();
  console.log(`\n${entries.length} input row(s) to process.`);
  console.log(write ? 'Mode: LIVE — writes will be made.' : 'Mode: PREVIEW (dry run) — nothing will be written.');
  if (includeClients) {
    console.log('--include-clients: the existing-client guard is DISABLED — a matching tenant will be written like any other firm.');
  }

  const rl = new RateLimiter();

  const created: string[] = [];
  const updated: string[] = [];
  const skippedIndividual: string[] = [];
  const skippedExistingClient: string[] = [];
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

    if (!includeClients) {
      const matchedOrg = findMatchingExistingClient(firm.firmName, existingClientNames);
      if (matchedOrg) {
        const line = `  [skip-existing-client] "${firm.firmName}" (FRN ${firm.frn}) — matches existing tenant "${matchedOrg}"`;
        skippedExistingClient.push(line);
        console.log(line);
        continue;
      }
    }

    try {
      // No lapsed-AR index to check here — that only exists within a single
      // --discover run's search results (see runDiscover) — so this path
      // never has fresh transition evidence to offer; processEnriched
      // carries any existing former_ar/ar_ceased_on through unchanged.
      const plan = await processEnriched(firm, write, null);
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
  console.log(`SKIPPED — matches an existing CallGuard tenant (not written): ${skippedExistingClient.length}`);
  skippedExistingClient.forEach((l) => console.log(l));
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
