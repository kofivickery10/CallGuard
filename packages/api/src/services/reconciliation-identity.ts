// Does the application and the call describe the same person?
//
// WHY THIS IS A SEPARATE CHECK
//
// Every other question on an application is compared on the assumption that the
// document and the recording belong to the same customer. Name and date of birth
// are the two that can DISPROVE that assumption, and when they do, no other
// answer on the run means anything.
//
// A real case: a protection sale where the Zoho record, and the application
// attached to it, belonged to one member of a household, while the only call
// CallGuard held on that mobile was another member of the same household. The
// run compared one person's submitted answers against the other person's speech
// and produced six findings against the adviser — five of them "you never asked
// this" — with the disproof sitting two rows above them, filed as
// 'undetermined'. Journey matching is by normalised phone number, and a shared
// mobile is ordinary in this market, so this recurs; what we can do is make it
// loud instead of silent.
//
// WHY THE BAR IS DELIBERATELY HIGH
//
// Aborting a run is destructive: it withholds every real finding on the sale.
// So this fires only on POSITIVE contradiction, never on absence, and only when
// the gap is too wide to be anything but a different person.
//
//   - Absence never fires. A date of birth the call never mentions, or that
//     redaction removed, tells us nothing.
//   - Ambiguous day/month order never fires. The application writes 20/05/1995
//     and the call is read back as 05/20/1995; those are the same date, and
//     treating them as a contradiction would abort most runs in the tenant.
//     Every reading of each side is generated, and a contradiction requires the
//     two sets of readings to be disjoint.
//   - A near miss never fires. 09/04/1997 against 19/04/1997 is a plausible
//     mishearing of "ninth" for "nineteenth"; 20/04/1968 against 20/04/1969 is
//     a plausible typo in one system or the other. Both are real discrepancies
//     worth reporting, and neither is evidence of a different human being. They
//     stay ordinary 'mismatch' findings on their own item.
//
// WHY NAME IS NOT A TRIGGER
//
// Names are redacted out of transcripts by design, so the call side is usually a
// placeholder and occasionally a name belonging to whoever else was mentioned in
// the conversation. That is too weak to abort on. A contradicting name is
// carried into the message as corroboration when the date of birth has already
// decided it, and never fires on its own.

// The general date parser lives with the comparison logic; this specialised
// check uses it rather than owning a second copy.
import { dateCandidates } from './reconciliation.js';

/** How far apart two dates of birth must be before they cannot be one person. */
//
// Eighteen months. Above it, no mishearing or transposition explains the gap —
// the household case measured ten and a half years. Below it sit the two shapes
// that are discrepancies rather than different people: a wrong day within the
// same month, and a year out by one with the day and month intact.
export const IDENTITY_DOB_TOLERANCE_DAYS = 550;

const DAY_MS = 24 * 60 * 60 * 1000;

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'rev', 'sir', 'lady']);

export type IdentityRole = 'name' | 'dob';

/**
 * Which identity field, if any, a question is asking for.
 *
 * Matched on the whole normalised question rather than a substring, because
 * "Account holder's name" and "Name of the medical condition or illness" both
 * contain "name" and neither identifies the customer.
 */
export function identityRoleOf(question: string): IdentityRole | null {
  const q = question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q === 'name' || q === 'full name' || q === 'customer name' || q === 'client name') {
    return 'name';
  }
  if (
    q === 'dob' ||
    q === 'date of birth' ||
    q === 'your date of birth' ||
    q === 'what is your date of birth'
  ) {
    return 'dob';
  }
  return null;
}

/**
 * The customer's forename, or null when the text carries none we can trust.
 *
 * Redaction placeholders are not names — `[NAME_GIVEN_1]` is the absence of one,
 * and treating it as a value would compare a tag against a real forename.
 */
export function forenameOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const stripped = text.replace(/\[[A-Z_]+\d*\]/g, ' ');
  const tokens = stripped
    .toLowerCase()
    .replace(/[^a-z' -]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter((t) => t.length > 1 && !TITLES.has(t));
  return tokens[0] ?? null;
}

/** Two forenames that cannot be the same person. "Rob" and "Robert" can. */
export function forenamesContradict(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return false;
  return !a.startsWith(b) && !b.startsWith(a);
}

export interface IdentityCheckInput {
  role: IdentityRole;
  question: string;
  applicationAnswer: string | null;
  callAnswer: string | null;
}

export interface IdentityVerdict {
  /** True only when the run must not be scored at all. */
  aborts: boolean;
  /** Reader-facing explanation, for the run's error_message. */
  message: string | null;
  /** Set when a date of birth decided it, for the log. */
  dobGapDays: number | null;
}

/**
 * Read the identity fields on a run and decide whether it may proceed.
 *
 * Only a date of birth can abort. A contradicting name is reported alongside it
 * when present, and is never the trigger — see the header.
 */
export function checkIdentity(inputs: IdentityCheckInput[]): IdentityVerdict {
  const clean = (v: string | null): string | null =>
    v && v.trim() !== '' ? v.trim() : null;

  let gap: number | null = null;
  for (const input of inputs.filter((i) => i.role === 'dob')) {
    const app = dateCandidates(clean(input.applicationAnswer));
    const call = dateCandidates(clean(input.callAnswer));
    // Absence proves nothing, and neither does an unparseable value.
    if (app.length === 0 || call.length === 0) continue;
    if (app.some((a) => call.includes(a))) continue;
    // Disjoint. The nearest pair of readings is the most generous reading of
    // the discrepancy, so it is the one the tolerance is applied to.
    let nearest = Infinity;
    for (const a of app) {
      for (const c of call) nearest = Math.min(nearest, Math.abs(a - c) / DAY_MS);
    }
    if (nearest > IDENTITY_DOB_TOLERANCE_DAYS && nearest > (gap ?? 0)) gap = nearest;
  }

  if (gap === null) return { aborts: false, message: null, dobGapDays: null };

  const nameContradicts = inputs
    .filter((i) => i.role === 'name')
    .some((i) =>
      forenamesContradict(
        forenameOf(clean(i.applicationAnswer)),
        forenameOf(clean(i.callAnswer))
      )
    );

  const years = (gap / 365.25).toFixed(1);
  return {
    aborts: true,
    dobGapDays: Math.round(gap),
    message:
      `The date of birth on the application and the one given on the call are ${years} years apart` +
      (nameContradicts ? ', and the first names do not match either' : '') +
      '. The application and the recording appear to be about different people, ' +
      'so nothing on this sale has been compared. Check that the right call is ' +
      'attached to this sale before anything is judged from it.',
  };
}
