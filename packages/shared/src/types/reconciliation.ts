// Data Forms reconciliation (Part B): comparing the application submitted to the
// insurer against what the customer actually said on the call.
//
// Distinct from Data Capture (Part A), which asks whether the adviser covered the
// tenant's OWN question set. Reconciliation takes its questions from the
// insurer's document, so the two can disagree and neither depends on the other.

export type ReconciliationRunStatus =
  | 'pending'
  | 'running'
  // No attachment on the record matched a known document profile. Usually just
  // means the pack has not been uploaded yet, so it is a waiting state.
  | 'needs_document'
  // A document was found but its question set no longer matches the stored
  // profile — the insurer changed something and a human must confirm before any
  // answer is judged against it.
  | 'needs_profile'
  // Parsed fine, but the document carries no question set (a unit-based
  // product's summary of key facts). Reported explicitly so a clean result is
  // never mistaken for "the health answers matched" when there were none.
  | 'summary_only'
  | 'completed'
  | 'failed';

export type ReconciliationOutcome =
  | 'match'
  | 'mismatch'
  | 'not_asked'
  | 'asked_no_answer'
  | 'no_application_answer'
  // Could not be established — most often because health redaction removed the
  // very words that identify the question. Never presented as a pass or a miss.
  | 'undetermined';

export type AmendmentType =
  // Something was disclosed and then taken back. The only type worth surfacing
  // on its own.
  | 'disclosure_withdrawn'
  | 'disclosure_added'
  | 'value_changed';

/** One superseded answer from the insurer's own audit trail. */
export interface AnswerRevision {
  value: string;
  timestamp: string | null;
  recordedBy: string | null;
}

export interface ReconciliationRun {
  id: string;
  organization_id: string;
  journey_id: string;
  status: ReconciliationRunStatus;
  profile_id: string | null;
  attachment_id: string | null;
  attachment_name: string | null;
  document_fingerprint: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ReconciliationItem {
  id: string;
  run_id: string;
  sort_order: number;
  question: string;
  guidance: string | null;
  application_answer: string | null;
  call_answer: string | null;
  call_answer_redacted: boolean;
  outcome: ReconciliationOutcome;
  evidence: string | null;
  reasoning: string | null;
  confidence: number | null;
  source_call_id: string | null;
  source_timestamp: number | null;
  application_answered_at: string | null;
  application_recorded_by: string | null;
  answer_amended: boolean;
  amendment_type: AmendmentType | null;
  revisions: AnswerRevision[];
}

/** Outcomes that warrant a supervisor's attention. */
export const ACTIONABLE_RECONCILIATION_OUTCOMES: ReconciliationOutcome[] = [
  'mismatch',
  'not_asked',
  'asked_no_answer',
];

// ------------------------------------------------------------
// Document profiles: how one insurer's application is read, learned once and
// reused until the insurer changes it.
// ------------------------------------------------------------

export type DocumentProfileStrategy = 'question_answer' | 'label_value' | 'question_marker';

export type DocumentProfileStatus =
  // Proposed, never yet used to judge anything. Waiting on a human.
  | 'needs_confirmation'
  | 'active'
  | 'superseded';

export interface DocumentProfileQuestion {
  order: number;
  question: string;
  guidance: string | null;
  choices: string[];
  /**
   * Whether "none of this question's terms appear in the call" may be reported
   * as "the adviser did not ask it". False where redaction removes the very
   * words that would identify the question, so its absence proves nothing.
   */
  absence_meaningful: boolean;
}

export interface DocumentProfile {
  id: string;
  organization_id: string;
  insurer: string;
  product: string | null;
  strategy: DocumentProfileStrategy;
  detect_patterns: string[];
  question_fingerprint: string;
  questions: DocumentProfileQuestion[];
  version: number;
  status: DocumentProfileStatus;
  learned_from_journey_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}

/** What changed between the incumbent question set and a proposed one. */
export interface QuestionSetDrift {
  changed: boolean;
  added: string[];
  removed: string[];
  reordered: boolean;
}
