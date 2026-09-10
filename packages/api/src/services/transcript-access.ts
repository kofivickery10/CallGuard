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

/**
 * Does this organisation keep HEALTH (phi) in the clear?
 *
 * Narrower than organisationKeepsUnredacted, deliberately. That one gates a
 * transcript view inside the platform, where any permitted category is more than
 * the viewer should get. This gates what LEAVES the platform by email, where the
 * recipient is the adviser who was on the call and already heard it — so the risk
 * is the channel, not the audience.
 *
 * Drawn on the Article 9 line that migration 079 exists to draw. That migration
 * replaced a single exemption flag precisely because one flag "made the easier
 * half of the feature wait on the harder half's paperwork", and re-merging
 * identity into health here would undo it. It would also be incoherent: the
 * feedback email names the client in its body by design, so withholding the
 * model's sentence on the grounds it might contain a name protects nothing.
 *
 * DPIA R5 (docs/dpia-data-forms-reconciliation.md): "email is not an appropriate
 * channel for health data... payloads must carry the question, the fact of a
 * discrepancy, and a link back into CallGuard, never the answer content." Its
 * residual rating is conditional on that control being implemented AND covered
 * by test, so the caller has a test naming R5.
 */
export async function organisationKeepsHealthUnredacted(
  organizationId: string
): Promise<boolean> {
  const row = await queryOne<{ categories: string[] | null }>(
    'SELECT pii_unredacted_categories AS categories FROM organizations WHERE id = $1',
    [organizationId]
  );
  return (row?.categories ?? []).includes('phi');
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

// ── What leaves the platform in a scored payload (DPIA R5, action 8) ──────────
//
// `breaches[].evidence` is a VERBATIM TRANSCRIPT QUOTE — services/scoring.ts
// asks the model for "a direct quote from the transcript as evidence". On a
// tenant keeping health in the clear that quote is the customer's health
// disclosure, word for word, and it is strictly more exposing than the model's
// `reasoning`, which the feedback email already withholds from exactly these
// tenants (services/journey-feedback.ts).
//
// It was travelling to four kinds of destination that leave the controlled
// environment: the tenant's Zoho CRM (a breach Task's description and the QA
// record's notes field, services/zoho.ts), any tenant-configured webhook
// (services/webhook-delivery.ts), the two CSV downloads (routes/breaches.ts,
// routes/capture.ts), and the partner pull endpoint that is the webhook's
// documented companion (routes/ingestion.ts). None is assessed as a recipient
// of health data anywhere in the DPIA, whose sub-processor list names Deepgram
// and Anthropic — not a CRM, and not an endpoint we cannot see.
//
// R5: "exports and alert payloads must carry the question, the fact of a
// discrepancy, and a link back into CallGuard, never the answer content."
// The label is the question, the severity is the fact, the review link is
// already in the payloads that have one. The quote is the answer content.
//
// CUT AT THE EXIT, NOT AT THE BUILD. Six call sites build these payloads but
// far fewer deliver them, and every delivery function has an organizationId to
// hand. Applying it at the exit also means the copy persisted for retry
// (zoho_deliveries / webhook_deliveries carry the payload) is the withheld one,
// so a replay months later cannot re-send what this removed.
//
// TWO GATES, AND THE DIFFERENCE IS THE DESTINATION, NOT THE DATA.
//
//   Zoho     — `organisationKeepsHealthUnredacted`. The CRM already holds the
//              customer's name and address by definition; it IS the firm's
//              customer record. Withholding a quote there on the grounds it
//              might contain a name would protect nothing, so health is the
//              marginal disclosure. Same reasoning the feedback email uses.
//
//   Webhook, — `organisationKeepsUnredacted` (ANY permitted category). A
//   CSV,       webhook_url is whatever endpoint the tenant typed and a CSV is a
//   pull API   file that goes wherever files go; neither is a system we can say
//              anything about. The CRM argument does not survive the move to a
//              destination we cannot see, so an unredacted date of birth or
//              address in a quote is withheld there too.

/** Empty every `evidence`, top level and inside `breaches[]`. */
function stripEvidence<P extends object>(payload: P): P {
  const out = { ...payload } as Record<string, unknown>;
  if (typeof out.evidence === 'string') out.evidence = '';
  if (Array.isArray(out.breaches)) {
    out.breaches = (out.breaches as Array<Record<string, unknown>>).map((b) => ({
      ...b,
      evidence: '',
    }));
  }
  return out as P;
}

/** Does this payload actually carry a quote to withhold? */
function carriesEvidence(payload: Record<string, unknown>): boolean {
  if (typeof payload.evidence === 'string' && payload.evidence) return true;
  if (Array.isArray(payload.breaches)) {
    return (payload.breaches as Array<Record<string, unknown>>).some((b) => !!b.evidence);
  }
  return false;
}

/**
 * Strip verbatim transcript quotes from a payload on its way out.
 *
 * `withhold` is the caller's gate — see the two-gates note above; this function
 * deliberately does not choose it, because the right predicate depends on where
 * the payload is going and only the caller knows that.
 *
 * Returns the payload untouched when nothing is withheld, so a tenant whose
 * transcripts were redacted at source is unaffected and pays no allocation.
 *
 * Sets `evidence_withheld` rather than quietly shortening the list: a breach
 * list with no quotes reads as "the AI had nothing to quote", which is a
 * different and false statement.
 */
export function withheldBreachEvidence<
  P extends { evidence_withheld?: boolean } & (
    | { breaches: Array<{ evidence: string }> }
    | { evidence: string }
  ),
>(payload: P, withhold: boolean): P {
  if (!withhold) return payload;
  // Nothing to withhold, so do not claim a restriction — same rule as
  // withheldTranscript above.
  if (!carriesEvidence(payload as unknown as Record<string, unknown>)) return payload;
  return { ...stripEvidence(payload), evidence_withheld: true };
}
