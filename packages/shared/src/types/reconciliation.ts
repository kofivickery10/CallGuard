// Data Forms reconciliation (Part B): comparing the application submitted to the
// insurer against what the customer actually said on the call.
//
// Distinct from Data Capture (Part A), which asks whether the adviser covered the
// tenant's OWN question set. Reconciliation takes its questions from the
// insurer's document, so the two can disagree and neither depends on the other.

export type ReconciliationRunStatus =
  | 'pending'
  | 'running'
  // Nothing to compare against yet. The pack is attached to the CRM record by
  // hand after the call, so this is a waiting state, re-checked on a decaying
  // cadence until the document arrives.
  | 'needs_document'
  // A human must confirm how to parse the document before any answer is judged
  // against it: either the insurer changed their question set (the run carries a
  // profile_id) or the format has never been seen before (it does not).
  | 'needs_profile'
  // Parsed fine, but the document carries no question set (a unit-based
  // product's summary of key facts). Reported explicitly so a clean result is
  // never mistaken for "the health answers matched" when there were none.
  | 'summary_only'
  | 'completed'
  | 'failed'
  // We stopped waiting: no application document was ever attached within the
  // window, or the sale has no CRM record for one to appear on. Distinct from
  // 'needs_document', which invites the reader to keep waiting.
  | 'abandoned';

export type ReconciliationOutcome =
  | 'match'
  | 'mismatch'
  | 'not_asked'
  | 'asked_no_answer'
  | 'no_application_answer'
  // The two outcomes of a 'presence' question — one checked for completion on
  // the document rather than against the call, because its value could never be
  // verified from a recording. See QuestionCheckMode.
  //
  // Filled in. NOT 'match': nothing was compared, and counting it as one would
  // inflate the match rate with fields nobody checked.
  | 'recorded'
  // Left blank where it had to be filled in. A finding — and the opposite of
  // 'no_application_answer', which is the same empty value on a question where
  // blank is legitimate.
  | 'missing_from_application'
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
  /** How many times the run has been processed. Drives the retry cadence. */
  attempts: number;
  last_attempt_at: string | null;
  /**
   * How the items were produced, and therefore what they are worth as evidence.
   * A 'profile' run is a deterministic parse with a stored document profile:
   * re-run it and the same items come back, which is what lets a flag stand. A
   * 'model' run is a direct model reading, the fallback for a format no profile
   * fits yet — a best effort that cannot be re-derived, and one that is replaced
   * automatically when a profile for the format goes live. See migration 093.
   */
  extraction_method: 'profile' | 'model';
  /** Consecutive processing failures. Drives the give-up threshold. */
  failure_streak: number;
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
  // A required field left blank on the submitted application. Unlike the other
  // three this is not a claim about how the adviser conducted the call — it is
  // visible in the document alone — but it is still something someone must fix.
  'missing_from_application',
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

/**
 * What kind of check one field on an application can bear.
 *
 * Reconciliation assumes a submitted answer can be checked against what the
 * customer said. That is true of a health disclosure, an occupation, a premium
 * or a term. It is not true of a bank account number, whose stored value the
 * insurer masks and which a customer reads back in fragments — so the honest
 * check on that field is not "does it match the call" but "was it filled in".
 *
 * Defaulted by heuristic (defaultCheckMode) and overridable per question when a
 * format is confirmed, because whether a field is spoken aloud is a fact about
 * the insurer's form rather than something to infer per sale.
 */
export type QuestionCheckMode =
  /** Compare against the call. The default, and what every question was before. */
  | 'reconcile'
  /** Never compared. Populated -> 'recorded'; blank -> 'missing_from_application'. */
  | 'presence'
  /** On the record, never compared, never a finding — e.g. a policy number the insurer issues on submission. */
  | 'none';

export interface DocumentProfileQuestion {
  order: number;
  question: string;
  guidance: string | null;
  choices: string[];
  /**
   * Whether "none of this question's terms appear in the call" may be reported
   * as "the adviser did not ask it". False where redaction removes the very
   * words that would identify the question, so its absence proves nothing.
   *
   * Only consulted when check_mode is 'reconcile' — the other modes never look
   * at the call, so absence of anything from it says nothing either way.
   */
  absence_meaningful: boolean;
  /**
   * How this field is checked. Optional on the wire: profiles stored before this
   * existed carry no value, and the reader falls back to defaultCheckMode rather
   * than forcing a backfill that would have to re-decide it from data it cannot
   * see.
   */
  check_mode?: QuestionCheckMode;
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
  /**
   * True when this form asks conditional follow-ups, so its question set
   * legitimately differs from sale to sale. Exact question-set drift detection
   * is replaced by a structural check that the document still parses — see
   * migration 090. Set by a human at confirmation, never inferred.
   */
  questions_vary: boolean;
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

// ------------------------------------------------------------
// Data Forms dashboard: the same reconciliation record read in aggregate.
//
// Every count below excludes 'undetermined' from findings, matching the rule
// applied everywhere else: it means we could not tell, usually because health
// redaction removed the words identifying the question. Counting it as a
// finding would bury real flags under noise of our own making. It is reported
// on its own instead, because a large undetermined share is a signal about the
// checking, not about the adviser.
// ------------------------------------------------------------

export interface ReconciliationDashboardSummary {
  /** Days the windowed figures cover. */
  days: number;
  /** Runs that finished a comparison in the window. */
  sales_checked: number;
  /** Items produced by those runs. */
  questions_compared: number;
  /**
   * Share of questions that matched, out of those we could reach a conclusion
   * on (match + mismatch + not_asked + asked_no_answer). Questions the
   * application left blank and undetermined ones are excluded from both sides —
   * neither is evidence either way. Null when nothing was conclusive.
   */
  match_rate: number | null;
  /** Items flagged: mismatch, not asked, asked but unanswered, or withdrawn. */
  findings: number;
  /** Checked sales carrying at least one finding. */
  sales_with_findings: number;
  /** Items we could not establish either way. */
  undetermined: number;
  /**
   * Presence-mode fields that were filled in. Never compared against the call
   * and deliberately outside the match rate — see migration 094.
   */
  recorded: number;
  /** Presence-mode fields left blank where they had to be filled in. A finding. */
  missing_from_application: number;
  /**
   * Completed runs read by a model rather than a stored profile. Provisional:
   * they are re-read deterministically once a profile for the format goes live.
   */
  model_read: number;
  /** Runs waiting on something — a document, a profile, or the queue. */
  parked: number;
  /** Runs that gave up or errored. */
  failed: number;
  /**
   * Question sets awaiting a person. Not windowed: an unconfirmed set parks
   * every sale on that format regardless of when it was proposed.
   */
  awaiting_confirmation: number;
}

/** One week of checking activity. */
export interface ReconciliationTrendPoint {
  week_start: string;
  /** Runs created that week that reached a completed comparison. */
  checked: number;
  /** Runs created that week still parked, abandoned, or failed. */
  unchecked: number;
  /** Match rate across that week's completed runs, on the summary's basis. */
  match_rate: number | null;
}

/** Findings rolled up to the insurer whose form was used. */
export interface ReconciliationInsurerRow {
  profile_id: string | null;
  insurer: string;
  product: string | null;
  sales: number;
  questions: number;
  match_rate: number | null;
  mismatches: number;
  not_asked: number;
  no_answer: number;
  /** Presence-mode fields left blank on the submitted application. */
  missing: number;
  withdrawn: number;
}

/**
 * A question flagged repeatedly across sales.
 *
 * Concentration is the point: one question flagged on most sales is more often
 * a parsing or search-window artefact than a whole team getting the same thing
 * wrong, so this table is as much a check on us as on the advisers.
 */
export interface ReconciliationFlaggedQuestion {
  question: string;
  insurer: string | null;
  /** Sales where this question produced a finding. */
  flagged: number;
  /** Sales where the question was compared at all. */
  compared: number;
  mismatches: number;
  not_asked: number;
  no_answer: number;
  /** Presence-mode fields left blank on the submitted application. */
  missing: number;
}
