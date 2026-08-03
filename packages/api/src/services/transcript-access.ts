import { queryOne } from '../db/client.js';

// ============================================================
// Who may read a transcript that holds health data in the clear.
//
// Action 11 of the Data Forms DPIA: the controller restricted unredacted
// transcripts to the `admin` role. This is the enforcement point, and it is a
// precondition of permitting any redaction category for a firm — the assessment
// states the restriction as fact, so it has to be true.
//
// TWO PROPERTIES THAT MATTER
//
// It is conditional on the tenant. A firm with no permitted categories has
// source-redacted transcripts containing typed placeholders and nothing more, so
// gating them would remove access to something that was never sensitive. Nothing
// changes for those firms.
//
// It withholds rather than re-redacts. Suppressing health in a transcript that
// already contains it would mean detecting health content in free text with our
// own patterns, and any term those patterns missed would render to a viewer as
// ordinary conversation inside a view that looked redacted. Withholding is
// legible; a partial redaction that presents as complete is not.
// ============================================================

/**
 * Roles permitted to read an unredacted transcript.
 *
 * `admin` is the controller's decision. `superadmin` is CallGuard platform staff,
 * who are the processor and are covered by the processing agreement rather than
 * by the controller's internal role policy — and who need it to support the
 * feature at all.
 */
const TRANSCRIPT_READER_ROLES: ReadonlySet<string> = new Set(['admin', 'superadmin']);

export function roleMayReadUnredacted(role: string | null | undefined): boolean {
  return !!role && TRANSCRIPT_READER_ROLES.has(role);
}

/**
 * Does this organisation keep any redaction category in the clear?
 *
 * Reads the same column resolveRedactCategories consumes, so "the transcript may
 * contain health" and "we asked the provider not to redact health" cannot
 * disagree. Note it treats ANY permitted category as sensitive, not just health:
 * an unredacted name or address is still personal data a viewer should not get
 * merely because it is not Article 9.
 */
export async function organisationKeepsUnredacted(organizationId: string): Promise<boolean> {
  const row = await queryOne<{ categories: string[] | null }>(
    'SELECT pii_unredacted_categories AS categories FROM organizations WHERE id = $1',
    [organizationId]
  );
  return (row?.categories?.length ?? 0) > 0;
}

export interface TranscriptAccess {
  /** May this user be sent transcript content for this organisation? */
  readable: boolean;
  /**
   * True when content was withheld that this user would otherwise have seen.
   * Distinct from `!readable`: it lets the UI say "restricted" rather than
   * "no transcript", which are very different things to a supervisor.
   */
  restricted: boolean;
}

/**
 * Resolve transcript access for one request.
 *
 * Fails closed on a missing role: an unknown role is not an admin.
 */
export async function resolveTranscriptAccess(
  organizationId: string,
  role: string | null | undefined
): Promise<TranscriptAccess> {
  if (roleMayReadUnredacted(role)) return { readable: true, restricted: false };
  const sensitive = await organisationKeepsUnredacted(organizationId);
  return { readable: !sensitive, restricted: sensitive };
}

/** Fields that carry transcript content and must travel together. */
const TRANSCRIPT_FIELDS = ['transcript_text', 'transcript_raw'] as const;

/**
 * Remove transcript content from a row on its way out.
 *
 * Both fields, always. transcript_raw holds every word with its timings, so
 * dropping only the readable transcript would leave the same words in the JSON
 * beside it — the same mistake the bank-detail redaction had to avoid.
 *
 * Returns a copy; the caller's row is untouched.
 */
export function withheldTranscript<T extends Record<string, unknown>>(
  row: T,
  access: TranscriptAccess
): T & { transcript_restricted?: boolean } {
  if (access.readable) return row;
  const out: Record<string, unknown> = { ...row };
  let had = false;
  for (const field of TRANSCRIPT_FIELDS) {
    if (out[field] != null) had = true;
    out[field] = null;
  }
  // Only claim a restriction where there was something to restrict, so a call
  // that simply has not been transcribed yet does not read as withheld.
  if (had && access.restricted) out.transcript_restricted = true;
  return out as T & { transcript_restricted?: boolean };
}
