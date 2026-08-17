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

type FcaResult<T> = { ok: true; data: T } | { ok: false; message: string };

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
  let body: { Status?: string; Message?: string; Data?: T } | null = null;
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
  // is treated as a failed lookup, per the brief.
  if (!res.ok || !message || !/^ok\b/i.test(message)) {
    return { ok: false, message: message || `HTTP ${res.status}` };
  }
  return { ok: true, data: body!.Data as T };
}

async function searchFirm(
  rl: RateLimiter,
  headers: Record<string, string>,
  name: string
): Promise<FcaResult<FcaSearchResultItem[]>> {
  return fcaGet(rl, headers, `/Search?q=${encodeURIComponent(name)}&type=firm`);
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

  const { file, yes, dryRun, positional } = parseArgs(process.argv.slice(2));
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
