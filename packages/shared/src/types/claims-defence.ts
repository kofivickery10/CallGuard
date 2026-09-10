import type { BreachSeverity, BreachStatus, BreachEvidenceCaveat } from './breaches.js';
import type { ItemResult } from './scorecard.js';
import type { JourneyCallRole, JourneyStatus, RemediationOutcome } from './journey.js';
import type { ReconciliationOutcome, AmendmentType, AnswerRevision } from './reconciliation.js';

// A per-sale evidence pack for a claim declinature or a complaint: what was
// actually said on the call, set against what was submitted to the insurer,
// with the AI's checkpoint verdicts and every human ruling on top of them. See
// GET /api/journeys/:id/claims-defence.
//
// Built to leave the building — an insurer or the Financial Ombudsman may read
// this — so every field on it has been checked against the underlying table
// for personal data before being added. In particular, reconciliation's
// `call_answer` is safe to export: it is extracted from the call's own stored
// transcript, which already had personal data (PII/PCI/PHI) redacted at
// source by Deepgram before it was ever written to storage (see
// services/transcription.ts and jobs/processors/reconcile.ts's
// comparePair — a value that IS a redaction placeholder is forced to
// null and `call_answer_redacted` is set true instead). There is no separate
// "raw" call answer field anywhere in the schema to accidentally export.

export interface ClaimsDefenceHeader {
  journey_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  // The sale's own date (SALE_DATE_SQL) — the date of its last call, not when
  // it was assembled, scored, or re-scored.
  sale_date: string;
  // The closing adviser, resolved the same way as everywhere else in the app
  // (earliest call flagged wrap_up, else the latest call in the set).
  adviser_name: string | null;
  scorecard_name: string | null;
  // The scorecard version in force when this sale was scored — not
  // necessarily the version the scorecard is on today.
  scorecard_version: number;
  status: JourneyStatus;
  overall_score: number | null;
  pass: boolean | null;
}

export interface ClaimsDefenceCall {
  id: string;
  role: JourneyCallRole;
  call_date: string;
  duration_seconds: number | null;
  agent_name: string | null;
}

export interface ClaimsDefenceCheckpoint {
  id: string;
  label: string;
  section: string | null;
  result: ItemResult;
  evidence: string | null;
  reasoning: string | null;
  confidence: number | null;
  // Where in the recording, so a reader can find the moment for themselves.
  source_call_id: string | null;
  source_timestamp: number | null;
}

// What was asked of the adviser about one finding, and what they said they did
// about it (CG-26). The sixth step of the evidence chain: reviewed → evidenced →
// verified → communicated → acknowledged → remediated.
//
// Every field here is either the firm's own text, the adviser's own words about
// their own conduct, or a timestamp. The adviser's note is free text and is
// exported for the same reason case notes are (see ClaimsDefenceNote): it is
// written by a person at the firm to explain the record to whoever reads it
// next, and a pack that showed the instruction but not the answer would omit
// the half the reader came for. It is disclosed as unverified in the pack's
// limitations, never presented as something CallGuard checked.
export interface ClaimsDefenceRemediation {
  // The firm's instruction as it was sent to the adviser, snapshotted at send
  // time — not the wording the scorecard carries today. Null where the
  // checkpoint had no guidance and the adviser was simply told what was found.
  guidance: string | null;
  // Who was told, as recorded on the feedback itself. Durable and never null:
  // most advisers have no user row to resolve a name from later, and some have
  // no login at all.
  adviser_name: string;
  told_at: string;
  // When the adviser acknowledged the feedback. Null cannot occur alongside a
  // recorded outcome — an outcome cannot be written before acknowledgement —
  // but can where they were told and have said nothing since.
  acknowledged_at: string | null;
  // Null means no answer has been given. It never means "no action was needed":
  // that is `not_needed`, and the difference is the whole point of the field.
  outcome: RemediationOutcome | null;
  // The adviser's own account. Carries the substance for
  // 'customer_unreachable', where the attempts and their dates are the evidence.
  note: string | null;
  // When the answer was RECORDED, not when the work was done. An adviser may be
  // describing a call they made the previous week; the note is where a date for
  // the work itself can be stated.
  recorded_at: string | null;
  // Answers this adviser gave before the current one, oldest first. An adviser
  // who says "couldn't reach them" and later says "put right" has told the
  // reader something a single value cannot, so the earlier answers are shown
  // rather than overwritten. Empty on the ordinary case of one answer.
  //
  // The note that accompanied an earlier answer is not recoverable — only the
  // answer itself and when it was given — and nor is any answer given against a
  // finding that a later re-score replaced. Both are disclosed in limitations.
  earlier_answers: Array<{ outcome: RemediationOutcome; recorded_at: string }>;
}

export interface ClaimsDefenceFinding {
  id: string;
  scorecard_item_label: string;
  severity: BreachSeverity;
  status: BreachStatus;
  // Why this finding may not be fully settled — carried through rather than
  // omitted, as the breaches report template does today. These are the most
  // defensibility-relevant fields on the row.
  evidence_caveats: BreachEvidenceCaveat[];
  confirmed_by_name: string | null;
  confirmed_at: string | null;
  detected_at: string;
  // Null where this finding was never fed back to the adviser — a normal case
  // (feedback is sent per sale, when a supervisor sends it), not a gap.
  remediation: ClaimsDefenceRemediation | null;
}

export interface ClaimsDefenceReconciliationItem {
  id: string;
  question: string;
  application_answer: string | null;
  // Extracted from the call's already-redacted transcript — see the header
  // comment on this file for why this is the safe field to export.
  call_answer: string | null;
  // True when the topic was covered on the call but the value itself was
  // redacted before it ever reached storage — explains a null call_answer
  // as "known covered, value withheld" rather than "not found".
  call_answer_redacted: boolean;
  outcome: ReconciliationOutcome;
  evidence: string | null;
  source_call_id: string | null;
  source_timestamp: number | null;
  // The insurer's own audit trail: an answer amended on their portal after the
  // call is a strong defence signal, because it comes from their document
  // rather than from this system's model.
  answer_amended: boolean;
  amendment_type: AmendmentType | null;
  revisions: AnswerRevision[];
}

export interface ClaimsDefenceReconciliation {
  status: string;
  // How the items were produced — 'profile' is a deterministic, re-derivable
  // parse; 'model' is a best-effort fallback, provisional until a stored
  // profile exists. Matters for how much weight the "said vs submitted"
  // section below can bear.
  extraction_method: 'profile' | 'model';
  completed_at: string | null;
  items: ClaimsDefenceReconciliationItem[];
}

export interface ClaimsDefenceCorrection {
  id: string;
  scorecard_item_label: string;
  corrected_by_name: string | null;
  created_at: string;
  // Null: the AI could not decide and a human ruled. Not null: a human
  // overturned a confident AI verdict. The two are not the same event.
  original_pass: boolean | null;
  corrected_pass: boolean;
  reason: string | null;
}

// A case-level note as it appears in the pack (CG-9).
//
// Carried here rather than left in the UI because the note's whole purpose is
// to explain the record to a later reader — most often why a score is what it
// is. A pack that showed the AI's verdicts and the human rulings on them, but
// not the human's account of the case, would omit the one part written for the
// person now reading it.
//
// Edits are disclosed rather than flattened. `edited_at` non-null tells the
// reader the text in front of them is not the text originally written, and
// `previous_versions` gives them what it said before, so nothing about the
// note's history has to be taken on trust.
export interface ClaimsDefenceNote {
  id: string;
  body: string;
  author_name: string;
  created_at: string;
  edited_by_name: string | null;
  edited_at: string | null;
  previous_versions: Array<{
    body: string;
    author_name: string;
    written_at: string;
    superseded_at: string;
    superseded_by_name: string;
  }>;
}

export interface ClaimsDefenceResponse {
  header: ClaimsDefenceHeader;
  evidence_basis: ClaimsDefenceCall[];
  checkpoints: ClaimsDefenceCheckpoint[];
  findings: ClaimsDefenceFinding[];
  // Null when this sale has no reconciliation run at all — a normal case (the
  // module may not be in use, or the application document has not arrived
  // yet), not an error.
  reconciliation: ClaimsDefenceReconciliation | null;
  human_review: ClaimsDefenceCorrection[];
  // Case-level notes, oldest first. Empty on most sales — a note is written
  // when someone has something to say about the case, which is the exception.
  notes: ClaimsDefenceNote[];
  // Plain-language limits of what this pack can and cannot say, read
  // alongside the figures above rather than as small print.
  limitations: string[];
  generated_at: string;
}
