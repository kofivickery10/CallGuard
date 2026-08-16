import type { BreachSeverity, BreachStatus, BreachEvidenceCaveat } from './breaches.js';
import type { ItemResult } from './scorecard.js';
import type { JourneyCallRole, JourneyStatus } from './journey.js';
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
  // Plain-language limits of what this pack can and cannot say, read
  // alongside the figures above rather than as small print.
  limitations: string[];
  generated_at: string;
}
