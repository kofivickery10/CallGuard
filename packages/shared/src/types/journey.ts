import type { ItemResult, BranchSource } from './scorecard.js';
import type { CallStatus } from './call.js';
import type { CallCoaching } from './coaching.js';
import type { ProductSource, JourneyProduct } from './product.js';

// 'skipped' — the CRM stage marks this as a sale that did not complete (an NTU
// state), so it is deliberately not scored. Distinct from 'failed', which means
// scoring was attempted and broke.
export type JourneyStatus = 'pending' | 'scoring' | 'scored' | 'failed' | 'skipped';
export type JourneyTriggerSource = 'zoho_sale' | 'manual' | 'fallback';
export type JourneyCallRole = 'wrap_up' | 'context';

export interface Journey {
  id: string;
  organization_id: string;
  customer_id: string;
  scorecard_id: string;
  scorecard_version: number;
  window_start: string | null;
  window_end: string | null;
  trigger_source: JourneyTriggerSource;
  status: JourneyStatus;
  branch: string | null;
  // How `branch` was decided: 'crm' (the sale's CRM policy stage), 'keyword'
  // (a phrase matched in the transcript) or 'default' (nothing matched, the
  // first branch was assumed). Null for journeys scored before migration 071.
  // A 'default' branch is a guess that silently decides which checkpoints
  // apply, so the UI must present it as unconfirmed rather than as fact.
  branch_source: BranchSource | null;
  // The raw CRM stage value the branch was derived from, for audit.
  crm_stage: string | null;
  overall_score: number | null;
  pass: boolean | null;
  model_id: string | null;
  // Journey-level coaching brief (whole-sale strengths / improvements / next
  // actions). Null until scored, or if coaching is disabled for the plan.
  coaching: CallCoaching | null;
  // How this journey's product set was resolved. Null until resolution runs
  // (or for orgs not using product-aware scoring).
  product_source: ProductSource | null;
  error_message: string | null;
  scored_at: string | null;
  // Firm exemplar: an admin marked this whole sale as "what good looks like".
  // Fed into the scoring prompt via getLearningContext (requires ai_learning).
  is_exemplar: boolean;
  exemplar_reason: string | null;
  // Partial-journey coverage (docs/partial-journey-detection.md, Phase 1):
  // whether this journey's captured calls read as the complete sale.
  // 'partial' = the model judged the evidence starts mid-conversation (an
  // earlier call was likely never captured); 'unknown' = the model judged it
  // complete but structural signals disagree, logged for tuning; 'complete'
  // = model and structure agree. NULL = never assessed — a journey scored
  // before this feature shipped, or an assessment that failed on its run.
  // Phase 1 only: populated on every new scoring run, but nothing downstream
  // reacts to it yet (no breach caveat, no UI, no aggregate exclusion).
  coverage: JourneyCoverage | null;
  // Sale stages (e.g. "intro", "fact_find", "regulatory_disclosures") the
  // model judged missing. Empty unless coverage = 'partial'.
  coverage_missing_stages: string[];
  // The model's stated evidence for its coverage judgement.
  coverage_rationale: string | null;
  created_at: string;
  updated_at: string;
}

export type JourneyCoverage = 'complete' | 'partial' | 'unknown';

export interface JourneyCall {
  journey_id: string;
  call_id: string;
  role: JourneyCallRole;
}

export interface JourneyItemScore {
  id: string;
  journey_id: string;
  scorecard_item_id: string;
  result: ItemResult;
  score: number | null;
  normalized_score: number | null;
  confidence: number | null;
  evidence: string | null;
  reasoning: string | null;
  source_call_id: string | null;
  source_timestamp: number | null;
  created_at: string;
}

/**
 * One completed scoring run for a sale (migration 074). Append-only: the
 * journey row holds the current score, this is the history behind it.
 *
 * Exists because LLM scoring is not reproducible and cannot be made so — Sonnet
 * 5 rejects `temperature` outright, and temperature 0 never guaranteed identical
 * output on models that accept it. Since the number can legitimately move, what
 * a regulated firm needs is not a frozen score but a complete record of every
 * score the system produced, and who caused each one.
 *
 * The item counts matter as much as the score: they distinguish "the model
 * changed its mind about the same checkpoints" from "a different set of
 * checkpoints applied", which the percentage alone cannot.
 */
export interface JourneyScoreRun {
  id: string;
  // 1 for the original scoring, incrementing per re-score.
  run_number: number;
  overall_score: number | null;
  pass: boolean | null;
  branch: string | null;
  branch_source: BranchSource | null;
  model_id: string | null;
  items_passed: number | null;
  items_failed: number | null;
  items_na: number | null;
  items_manual_review: number | null;
  calls_scored: number | null;
  // 'initial' — first scoring off the sale trigger. 'rescore' — a human pressed
  // the button. 'bulk' — an operational re-score script.
  trigger_source: 'initial' | 'rescore' | 'bulk';
  // Null for automatic runs, and for a user since deleted.
  triggered_by_name: string | null;
  created_at: string;
}

export interface JourneyWithDetail extends Journey {
  customer_name: string | null;
  customer_phone: string | null;
  // Scoring history, newest first. Always at least one entry for a scored sale.
  score_runs: JourneyScoreRun[];
  // The products this sale covered (empty for orgs not using product scoping).
  products: JourneyProduct[];
  // The calls that composed this sale, oldest first. call_date is already
  // coalesced to the call's created_at server-side, so it is never null here;
  // overall_score/pass are null for calls that were only scored as part of the
  // sale (journey mode) rather than individually.
  calls: Array<{
    id: string;
    role: JourneyCallRole;
    call_date: string;
    agent_name: string | null;
    direction: 'inbound' | 'outbound' | null;
    duration_seconds: number | null;
    status: CallStatus;
    overall_score: number | null;
    pass: boolean | null;
    // Set when automated checks found the Agent/Customer labels contradicted by
    // the conversation's content (services/speaker-integrity.ts). Any checkpoint
    // that turns on who said something is unsafe on such a call, so the UI warns
    // rather than presenting the result as settled.
    speaker_integrity_flag: string | null;
  }>;
  item_scores: Array<
    JourneyItemScore & {
      label: string;
      section: string | null;
      severity: 'critical' | 'high' | 'medium' | 'low' | null;
      // Product ids this checkpoint is scoped to — lets the UI explain an 'na'
      // result as "not required for this sale's products".
      applies_to_products: string[] | null;
    }
  >;
}

// A row in the journeys list view (spec §9) — the journey plus the customer it
// belongs to and how many calls composed it.
export interface JourneyListItem extends Journey {
  customer_name: string | null;
  customer_phone: string | null;
  call_count: number;
  scorecard_name: string | null;
  // The sale's closing adviser — the same attribution used by breaches, the
  // review queue, adviser scores and the Zoho QA write-back, so a sale reads
  // consistently wherever it appears. Null when no call carries an agent.
  agent_name: string | null;
  // Distinct advisers across the sale's calls. More than one is common enough
  // (roughly a quarter of sales) that showing only the closer would misstate
  // who handled the business, so the UI flags it rather than hiding it.
  agent_count: number;
  // When the sale actually happened: the date of its last call, falling back to
  // when the journey was assembled for one with no calls.
  //
  // Distinct from scored_at, which a re-score rewrites, and from created_at,
  // which a backfill stamps with the day it ran. This is the one that stays put,
  // so it is what the list sorts and filters on.
  sale_date: string | null;
  // How many times this sale has been scored. Above 1, the score on screen
  // replaced an earlier one — which matters when the earlier one was already
  // fed back to an adviser.
  score_runs: number;
  // Where this sale sits in the acknowledgement loop (CG-11).
  feedback_status: FeedbackStatus;
  // When the feedback that decides the status above was sent. Null on a sale
  // never fed back. On 'awaiting' this is what the waiting time is measured
  // from; on 'acknowledged' it is the most recent round.
  feedback_sent_at: string | null;
  // When the adviser confirmed. Null unless the sale has been acknowledged —
  // which now includes 'awaiting_remediation', where the acknowledgement
  // happened and the work behind it did not.
  feedback_confirmed_at: string | null;
  // Findings on this sale where the firm asked for something and the adviser
  // has not said what they did (CG-27). 0 on every sale that was never fed
  // back, and on every tenant that has never written guidance.
  open_remediations: number;
  // Whole days since the oldest of those was acknowledged. Null when there are
  // none. Not derived from feedback_confirmed_at above: a checkpoint asked
  // about in July and dropped from August's re-scored round is still open from
  // July, while the row's own confirmed_at says August.
  oldest_remediation_days: number | null;
}

// A checkpoint awaiting human review (item_type='manual' or a consent gate
// routed to manual_review on low speaker-attribution confidence). Spans both
// per-call and journey scoring — `kind` says which.
export interface ManualReviewItem {
  kind: 'call' | 'journey';
  item_score_id: string;
  scorecard_item_id: string;
  label: string;
  section: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | null;
  // The call or journey this checkpoint belongs to.
  parent_id: string;
  customer_name: string | null;
  agent_name: string | null;
  detected_at: string;
  // What the AI had to say about this checkpoint, so the reviewer decides on the
  // evidence rather than on the label alone. All null for an item_type='manual'
  // checkpoint, which is never sent to the scorer at all.
  evidence: string | null;
  reasoning: string | null;
  confidence: number | null;
  // The AI's provisional verdict, present only for a consent gate routed to
  // manual review on low speaker-attribution confidence (the human confirms it
  // rather than scoring from scratch).
  normalized_score: number | null;
  // The call whose transcript and recording carry the evidence: the call itself
  // for a per-call checkpoint, the scorer's cited source call for a journey one.
  // Null when a journey checkpoint cited no particular call.
  source_call_id: string | null;
  source_call_name: string | null;
  // Whether that call still has audio stored (retention purges it before the
  // score), so the UI offers playback only when there is something to play.
  has_audio: boolean;
}

// Where a checkpoint's evidence quote sits in the call — recovered from the
// transcript on demand (services/evidence-locator.ts), not stored.
export interface EvidenceLocation {
  call_id: string;
  call_file_name: string | null;
  call_date: string | null;
  has_audio: boolean;
  duration_seconds: number | null;
  // Set when automated checks found this transcript's Agent/Customer labels
  // contradicted by the conversation's content. Any judgement that turns on WHO
  // said something is unsafe here, so the reviewer must be warned rather than
  // shown the labels as fact.
  speaker_integrity_flag: string | null;
  // Second of the recording the quote starts at. Null when it couldn't be
  // pinned to an utterance — playback then starts at the beginning.
  timestamp_seconds: number | null;
  // False when the quote couldn't be found in the transcript (or there is no
  // quote): the excerpt is empty and the reviewer gets the full transcript.
  matched: boolean;
  excerpt: Array<{
    index: number;
    speaker: 'Agent' | 'Customer' | null;
    text: string;
    is_match: boolean;
  }>;
}

// ── Case-level notes (CG-9) ───────────────────────────────────────────────────

// A superseded version of a note: what it said before one particular edit.
// Returned oldest-first, so a note's history reads chronologically and ends at
// the note's current body.
export interface JourneyNoteRevision {
  id: string;
  body: string;
  // Who wrote THIS version, and when — not who wrote the note originally. An
  // edit by a second person must not re-attribute the earlier text to them.
  author_name: string;
  written_at: string;
  superseded_at: string;
  superseded_by_name: string;
}

export interface JourneyNote {
  id: string;
  // The note as it currently stands. Earlier text is in `revisions`.
  body: string;
  author_name: string;
  created_at: string;
  // Null on a note that has never been edited — which is how a reader tells
  // untouched original text from the current version of something amended.
  edited_by_name: string | null;
  edited_at: string | null;
  // Empty on an unedited note. Never trimmed: notes are not deletable and
  // their history is not prunable, both by design (migration 112).
  revisions: JourneyNoteRevision[];
}

// ── Feedback status on a sale (CG-11) ─────────────────────────────────────────

// Where a sale sits in the acknowledgement loop.
//
// Derived, never stored: it is a reading of journey_feedback rows, so it cannot
// drift from them. `journey_feedback` carries a UNIQUE index on journey_id WHERE
// confirmed_at IS NULL (087), so a sale has at most one OPEN feedback but may
// have several confirmed ones from earlier rounds — which is why an open row
// wins over any history. A sale fed back, acknowledged, re-scored and fed back
// again is awaiting confirmation, not acknowledged.
export type FeedbackStatus =
  // No feedback has ever been sent for this sale.
  | 'not_fed_back'
  // Sent, and the adviser has not yet confirmed. This is the backlog.
  | 'awaiting'
  // Acknowledged, and the firm asked for something on at least one finding that
  // the adviser has not answered (CG-27). A subdivision of 'acknowledged', not a
  // state beside it: the adviser has confirmed, so nothing is outstanding in the
  // acknowledgement loop — what is outstanding is the work.
  //
  // Only counts checkpoints the firm wrote guidance for. A checkpoint with no
  // guidance has no remediation step at all (migration 115), so it cannot have
  // an outstanding one, and a firm that has never written any guidance never
  // sees this state.
  | 'awaiting_remediation'
  // Confirmed by the adviser, with nothing outstanding behind it.
  | 'acknowledged';

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  not_fed_back: 'Not fed back',
  awaiting: 'Awaiting confirmation',
  awaiting_remediation: 'Awaiting outcome',
  acknowledged: 'Acknowledged',
};

// ── What the adviser did about a finding (CG-25) ──────────────────────────────

// Recorded per finding by the adviser, on the tokenised page from their email.
//
// Absent (null on the row) means unanswered. It is NOT `not_needed`: "nobody has
// told us yet" and "we looked and no action was required" are different facts,
// and the whole value of this record to a claims file rests on not collapsing
// them.
export type RemediationOutcome =
  // Put right. What that meant in practice is in the note, if the adviser wrote
  // one — the outcome alone is an assertion, not evidence.
  | 'done'
  // Looked at, judged to need nothing. A deliberate answer, and the one that
  // stops an adviser recording `done` for something they correctly did nothing
  // about.
  | 'not_needed'
  // Tried and could not reach the customer. The case that would otherwise be
  // filed as one of the other two, or left blank forever — and the only one
  // where the note carries the substance rather than the colour.
  | 'customer_unreachable';

// Written in the second person because the only place they are shown is the
// adviser's own page, addressed to them.
export const REMEDIATION_OUTCOME_LABELS: Record<RemediationOutcome, string> = {
  done: 'Sorted',
  not_needed: 'Not needed',
  customer_unreachable: "Couldn't reach them",
};

// The same three answers written for someone who was not in the conversation
// (CG-26). The labels above are addressed to the adviser and read as a reply to
// a question they were just asked; in a claims-defence pack or a board pack the
// reader is an insurer, the Ombudsman or a board, and "Sorted" is neither their
// register nor a statement of who did what. These say what was asserted, in the
// third person, and they are the only labels those documents use.
export const REMEDIATION_OUTCOME_REPORT_LABELS: Record<RemediationOutcome, string> = {
  done: 'Put right',
  not_needed: 'No action needed',
  customer_unreachable: 'Customer could not be reached',
};

export const REMEDIATION_OUTCOMES: RemediationOutcome[] = [
  'done',
  'not_needed',
  'customer_unreachable',
];

/** Cap on the adviser's note. Generous for an account of three phone calls, and
 *  a bound on an unauthenticated write. Enforced server-side; the page counts
 *  down to it so the limit is never a surprise on submit. */
export const REMEDIATION_NOTE_MAX = 2000;

// How many sales sit in each state, plus the age of the oldest one still
// waiting. The counts describe the current filter set with the feedback filter
// itself removed, so each tab shows what clicking it would return.
export interface FeedbackStatusSummary {
  not_fed_back: number;
  awaiting: number;
  awaiting_remediation: number;
  acknowledged: number;
  // Whole days since the oldest still-unconfirmed feedback was sent. Null when
  // nothing is awaiting. "Fed back 9 days ago, still not confirmed" is the
  // number a supervisor is actually managing, and the one a principal asks for.
  oldest_awaiting_days: number | null;
  // The same number for the other backlog (CG-27): whole days since the oldest
  // unanswered ask was ACKNOWLEDGED, not since it was sent. The days before
  // acknowledgement are already counted by oldest_awaiting_days above, and an
  // outcome cannot be recorded before acknowledgement anyway (migration 116) —
  // so measuring from sent_at would bill the same delay to two backlogs and
  // overstate this one. Null when nothing is outstanding.
  oldest_remediation_days: number | null;
}
