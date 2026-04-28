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
  call_id: string;
  call_item_score_id: string;
  scorecard_item_id: string;
  severity: BreachSeverity;
  status: BreachStatus;
  assigned_to: string | null;
  notes: string | null;
  detected_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BreachWithDetail extends Breach {
  call_file_name: string;
  agent_name: string | null;
  agent_id: string | null;
  assigned_to_name: string | null;
  breach_type: string;
  scorecard_name: string | null;
  evidence: string | null;
  reasoning: string | null;
  normalized_score: number;
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
