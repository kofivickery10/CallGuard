import type { ItemResult } from './scorecard.js';
import type { BreachSeverity } from './breaches.js';
import type { FeedbackStatus, JourneyStatus } from './journey.js';

export type CallStatus =
  // Metadata-only capture for tenants set to fetch recordings on sale
  // (organizations.fetch_recordings_on_sale, migration 119): the CloudTalk
  // webhook has recorded the call's metadata but no audio has been fetched or
  // transcribed yet — that happens later, when a sale for the customer arrives
  // (see services/journey.ts). Has no file_key/transcript until then.
  | 'captured'
  | 'uploaded'
  | 'transcribing'
  | 'transcribed'
  | 'scoring'
  | 'scored'
  | 'skipped'
  | 'failed';

export interface Call {
  id: string;
  organization_id: string;
  uploaded_by: string | null;
  file_name: string;
  // null for 'captured' calls — audio isn't fetched until a sale trigger
  // hydrates them (see services/journey.ts / jobs/processors/hydrate-call.ts).
  file_key: string | null;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  mime_type: string | null;
  status: CallStatus;
  error_message: string | null;
  transcript_text: string | null;
  /**
   * True when transcript_text was withheld rather than being absent: the tenant
   * keeps a redaction category in the clear and this user is not an administrator
   * (DPIA action 11, services/transcript-access.ts). Distinguishes "not permitted"
   * from "not transcribed", which the UI must not conflate.
   */
  transcript_restricted?: boolean;
  agent_id: string | null;
  agent_name: string | null;
  // The customers row this call is matched to, by phone. customer_name is
  // joined in by GET /api/calls/:id only.
  customer_id: string | null;
  customer_name?: string | null;
  customer_phone: string | null;
  call_date: string | null;
  tags: string[];
  external_id: string | null;
  ingestion_source: 'upload' | 'api' | 'sftp' | 'live_stream' | 'dialer_webhook';
  scorecard_id: string | null;
  dialer_connection_id: string | null;
  journey_id: string | null;
  is_exemplar: boolean;
  exemplar_reason: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallScore {
  id: string;
  call_id: string;
  scorecard_id: string;
  scorecard_version: number;
  overall_score: number | null;
  pass: boolean | null;
  scored_at: string | null;
  model_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  prior_coaching_count: number;
  created_at: string;
}

export interface CallItemScore {
  id: string;
  call_score_id: string;
  scorecard_item_id: string;
  // null for na / manual_review checkpoints — they are never AI-scored.
  score: number | null;
  normalized_score: number | null;
  confidence: number | null;
  evidence: string | null;
  reasoning: string | null;
  result: ItemResult;
  source_timestamp: number | null;
  created_at: string;
}

export interface CallWithScores extends Call {
  scores?: (CallScore & {
    item_scores?: CallItemScore[];
  })[];
}

// The checkpoints of a scored sale whose evidence came from THIS call — the
// per-call view's stand-in for call_item_scores when the call was never
// scored on its own (per-call scoring doesn't run for journey calls; see
// jobs/processors/score-journey). `weight` isn't returned: `severity` is
// already the value the sale was judged by (deriveSeverity falls back to it
// when the scorecard sets no explicit one), so shipping the raw weight too
// would let the UI recompute a severity that could disagree with the one the
// sale actually used.
export interface CallJourneyItem {
  id: string;
  scorecard_item_id: string;
  result: ItemResult;
  normalized_score: number | null;
  evidence: string | null;
  reasoning: string | null;
  label: string;
  section: string | null;
  severity: BreachSeverity;
}

// One of a sale's other calls, as summarised on a call's own detail view —
// enough to link to it and show what it contributed, without repeating the
// whole journeys.ts `calls` shape a call page has no use for.
export interface CallJourneySibling {
  id: string;
  // This call's position among the sale's transcribed calls (see call_number
  // on CallJourneyContext) — null when the sibling itself has no transcript.
  call_number: number | null;
  has_transcript: boolean;
  duration_seconds: number | null;
  // How many journey_item_scores name this call as their evidence source.
  item_count: number;
}

// The sale summary attached to GET /calls/:id when the call belongs to a
// scored journey (per-call scoring doesn't run for journey calls: the score
// lives on the journey, not the call — see jobs/processors/score-journey).
// Lets the call view link to and surface its sale without a second request.
export interface CallJourneyContext {
  id: string;
  status: JourneyStatus;
  branch: string | null;
  overall_score: number | null;
  pass: boolean | null;
  this_call_items: CallJourneyItem[];
  // Resolved the same way the sale detail endpoint resolves whose sale this
  // is: the linked customer's name.
  client_name: string | null;
  // This call's position among the sale's calls, counting only calls with a
  // transcript and in the order the sale page numbers them ("Call 1", "Call
  // 2", ...) — null when this call itself has no transcript, so it was never
  // one of the calls the scorer numbered.
  call_number: number | null;
  call_total: number;
  siblings: CallJourneySibling[];
  feedback_status: FeedbackStatus;
  feedback_sent_at: string | null;
  feedback_confirmed_at: string | null;
}

// One transcript line's position in the recording, for the call detail page's
// running clock down the transcript.
export interface CallTranscriptLinePosition {
  index: number;
  start_seconds: number | null;
}

// Where one checkpoint's evidence quote sits in this call: the transcript
// line it was matched to and the second of audio that line starts at.
// Deliberately carries no transcript text (see GET /calls/:id/positions) —
// only enough to point a reader at a line and a moment in the recording.
export interface CallItemPosition {
  item_score_id: string;
  kind: 'journey' | 'call';
  matched: boolean;
  line_index: number | null;
  timestamp_seconds: number | null;
}

export interface CallPositionsResponse {
  lines: CallTranscriptLinePosition[];
  items: CallItemPosition[];
}

// GET /api/calls — the sale a list row's call belongs to, for a firm whose
// scoring_scope defers per-call scoring to the sale (scoresCallsIndividually
// false). Deliberately thinner than CallJourneyContext: a list row has no use
// for the sale's checkpoints or siblings, only enough to link to it and show
// what it contributed.
export interface CallListSaleSummary {
  id: string;
  status: JourneyStatus;
  overall_score: number | null;
  pass: boolean | null;
  // This call's position among the sale's transcribed calls, and how many
  // there are — the same numbering rule as CallJourneyContext.call_number
  // (null when this call itself has no transcript).
  call_number: number | null;
  call_total: number;
  // journey_item_scores whose evidence came from THIS call, not the sale as a
  // whole.
  failed_here: number;
  waiting_here: number;
}

// GET /api/calls — a list row's own latest score, for a firm that scores
// every call on its own (scoresCallsIndividually true). null until the call
// is scored.
export interface CallListScoreSummary {
  overall_score: number | null;
  pass: boolean | null;
  failed: number;
  waiting: number;
}

// One row of GET /api/calls. Carries only what the list shows — see
// CALL_LIST_COLUMNS in routes/calls.ts for what it deliberately excludes (no
// transcript, no storage pointer).
export interface CallListRow {
  id: string;
  file_name: string;
  status: CallStatus;
  duration_seconds: number | null;
  called_at: string;
  direction: string | null;
  adviser_id: string | null;
  adviser_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  // Set (possibly to null) for a 'sales' mode org, and always null otherwise.
  sale: CallListSaleSummary | null;
  // Set (possibly to null) for a 'calls' mode org, and always null otherwise.
  score: CallListScoreSummary | null;
}

export interface CallListResponse {
  data: CallListRow[];
  total: number;
  page: number;
  limit: number;
  // Which of the two scoring shapes this org's calls carry — decided by
  // scoresCallsIndividually (services/tenant-settings.ts), never by Zoho.
  mode: 'sales' | 'calls';
  // One entry per tab available in this mode — under score_only, that is
  // 'failed_checks' and 'passed' excluded, since their counts would reveal
  // the verdict the feature hides. Each count is under every other active
  // filter (q/adviser/from/to) but not the tab itself, the same recipe as the
  // sales list's per-status counts.
  counts: Record<string, number>;
}

// GET /api/calls/advisers — the org's users who are the agent on at least one
// call, for the calls list's adviser filter. Thinner than AgentSummary (no
// role/status): a supervisor or viewer may use it, and /agents itself is
// admin-only.
export interface CallAdviserOption {
  id: string;
  name: string;
}
