export interface CallShareLink {
  id: string;
  call_id: string;
  url: string;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
  feedback_count: number;
  avg_stars: number | null;
}

export interface CallShareLinkListItem extends Omit<CallShareLink, 'url'> {
  url: string | null; // url may be omitted on list (can't reconstruct from DB alone)
}

export interface PublicCallViewItem {
  label: string;
  normalized_score: number;
  passed: boolean;
}

export interface PublicCallView {
  file_name: string;
  organization_name: string;
  call_date: string | null;
  duration_seconds: number | null;
  overall_score: number | null;
  pass: boolean | null;
  items: PublicCallViewItem[];
  feedback_submitted: boolean;
  // When true, the sharing tenant runs in score-only mode: the public page
  // shows the score alone and suppresses the overall Pass/Needs-review verdict.
  // Per-item results still render.
  score_only: boolean;
}

export interface CallFeedbackInput {
  stars: number;
  comment?: string;
}
