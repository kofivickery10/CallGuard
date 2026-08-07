export type BreachSeverity = 'critical' | 'high' | 'medium' | 'low';
export type BreachStatus =
  | 'new'
  | 'acknowledged'
  | 'coached'
  | 'escalated'
  | 'resolved'
  | 'noted';

export const BREACH_SEVERITIES: BreachSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
];

export const BREACH_STATUSES: BreachStatus[] = [
  'new',
  'acknowledged',
  'coached',
  'escalated',
  'resolved',
  'noted',
];

export const BREACH_SEVERITY_LABELS: Record<BreachSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const BREACH_STATUS_LABELS: Record<BreachStatus, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  coached: 'Coached',
  escalated: 'Escalated',
  resolved: 'Resolved',
  noted: 'Noted',
};

export interface Breach {
  id: string;
  organization_id: string;
  // Exactly one of call_id/journey_id is set — call-level breaches come from
  // per-call scoring, journey-level breaches from journey scoring (a
  // checkpoint that never passed anywhere across the customer's call set).
  call_id: string | null;
  call_item_score_id: string | null;
  journey_id: string | null;
  journey_item_score_id: string | null;
  scorecard_item_id: string;
  severity: BreachSeverity;
  status: BreachStatus;
  assigned_to: string | null;
  notes: string | null;
  detected_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  // Why this finding is not settled (migration 078). Empty = no known weakness.
  //
  // Separate axis from `status`: status is the workflow (new -> resolved), this
  // is how much weight the finding can bear. A compliance register must never
  // assert more than its evidence supports, and equally must not suppress an
  // uncertain finding — missing a genuine failure is worse than raising a shaky
  // one. So the breach stands and the caveats travel with it.
  evidence_caveats: BreachEvidenceCaveat[];
  // A person agreed this breach is real. Distinct from resolving it, which only
  // records that it was dealt with.
  confirmed_by: string | null;
  confirmed_at: string | null;
}

// Why a breach may not be safe to act on as-is. Each is derived from something
// the pipeline already knows at scoring time.
export type BreachEvidenceCaveat =
  // Independent scoring runs disagreed on this verdict (consensus scoring).
  | 'low_agreement'
  // The scorer reported low confidence. 0.7 is the boundary measured between
  // checkpoints that flipped between runs (mean 0.66) and ones that never did (0.72).
  | 'low_confidence'
  // Who said what could not be established on the call the evidence came from,
  // so any checkpoint turning on speaker identity is unsafe.
  | 'unreliable_speakers'
  // The scorer cited no particular call, and the sale has more than one it
  // could have meant, so which recording this rests on is unknown. Distinct
  // from unreliable_speakers: there the source call is known and its labels are
  // doubted; here the source call itself was never established.
  | 'unattributed_evidence'
  // The sale's branch was inferred rather than read from the CRM, so this
  // checkpoint may not have applied to the sale at all.
  | 'guessed_branch'
  // Scored by a model no longer in use, under the retired two-pass design.
  | 'retired_model';

// Reviewer-facing wording. Kept with the type so the API, the register and any
// export describe a caveat the same way.
export const BREACH_CAVEAT_LABELS: Record<BreachEvidenceCaveat, string> = {
  low_agreement: 'Scoring runs disagreed on this checkpoint',
  low_confidence: 'The scorer was unsure',
  unreliable_speakers: 'Who said what could not be established on this call',
  unattributed_evidence: 'The scorer did not say which call this came from',
  guessed_branch: 'The sale\'s branch was inferred, so this checkpoint may not apply',
  retired_model: 'Scored by a model no longer in use',
};

export interface BreachWithDetail extends Breach {
  // For a journey breach this is a synthesised "Journey — <customer>" label
  // (there is no single call file); call breaches carry the real file name.
  call_file_name: string;
  agent_name: string | null;
  agent_id: string | null;
  // Set for journey breaches so the UI can link to /journeys/:id and label the row.
  customer_name: string | null;
  assigned_to_name: string | null;
  breach_type: string;
  scorecard_name: string | null;
  evidence: string | null;
  reasoning: string | null;
  normalized_score: number | null;
}

export interface BreachEvent {
  id: string;
  breach_id: string;
  user_id: string | null;
  user_name: string | null;
  event_type: 'status_changed' | 'assigned' | 'note_added' | 'reopened';
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  created_at: string;
}

export interface BreachSummary {
  total_open: number;
  by_severity: Record<BreachSeverity, number>;
  by_status: Record<BreachStatus, number>;
  resolved_last_30_days: number;
}
