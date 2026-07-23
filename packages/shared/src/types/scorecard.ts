export type ScoreType = 'binary' | 'scale_1_5' | 'scale_1_10';
export type ScorecardItemType = 'ai' | 'manual';
export type ItemResult = 'pass' | 'fail' | 'na' | 'manual_review';
export type ScorecardScoringMode = 'per_call' | 'journey';

// Branch condition on a scorecard item — which branch(es) it applies to.
// Absent/null on the item = applies to every branch.
export interface AppliesWhen {
  branch: string | string[];
}

// How a scorecard's branches are detected on a call/journey transcript.
export interface BranchConfig {
  branches: string[];
  detect: 'keyword';
  // Per non-default branch, keyword/phrase triggers checked against the
  // transcript. The first branch with a match wins; no match = the first
  // entry in `branches` (the implicit default).
  keywords?: Record<string, string[]>;
}

export interface ScorecardItem {
  id: string;
  scorecard_id: string;
  label: string;
  description: string | null;
  score_type: ScoreType;
  weight: number;
  sort_order: number;
  created_at: string;
  severity?: 'critical' | 'high' | 'medium' | 'low' | null;
  // Set when an edit removed this item from the scorecard after it had
  // already been scored against — retired from future scoring runs but kept
  // for historical call_item_scores/breaches, which reference it and cannot
  // cascade-delete.
  archived_at?: string | null;
  // Grouping label for the dashboard/coaching view (e.g. "Identity & fact
  // find", "Suitability", "Consent & disclosure").
  section?: string | null;
  // 'manual' items are never sent to Claude — they always resolve to
  // manual_review and are excluded from the AI-scored denominator.
  item_type: ScorecardItemType;
  applies_when?: AppliesWhen | null;
  // Explicit expectation text fed to the model, distinct from the free-text
  // `description` rubric.
  expectation?: string | null;
  // Presence-and-meaning check instruction for regulatory statements.
  ai_check?: string | null;
  // Requires an explicit customer affirmative — the scorer may not infer
  // consent from context, and low-confidence speaker attribution on the
  // evidence utterance routes the item to manual_review instead of a score.
  consent_gate: boolean;
  // Product ids this item is required for. Null/empty = applies to every
  // product (the default). When populated, the item is only scored on a sale
  // whose products intersect this set; otherwise it resolves to 'na' and is
  // excluded from the weighted denominator — same gate as `applies_when` on
  // the branch axis. See services/checkpoint-classification.ts.
  applies_to_products?: string[] | null;
}

export interface Scorecard {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  branch_config: BranchConfig | null;
  scoring_mode: ScorecardScoringMode;
  items?: ScorecardItem[];
}

export interface ScorecardItemInput {
  id?: string;
  label: string;
  description?: string;
  score_type: ScoreType;
  weight: number;
  sort_order: number;
  severity?: 'critical' | 'high' | 'medium' | 'low' | null;
  section?: string | null;
  item_type?: ScorecardItemType;
  applies_when?: AppliesWhen | null;
  expectation?: string | null;
  ai_check?: string | null;
  consent_gate?: boolean;
  applies_to_products?: string[] | null;
}

export interface CreateScorecardInput {
  name: string;
  description?: string;
  branch_config?: BranchConfig | null;
  scoring_mode?: ScorecardScoringMode;
  items: ScorecardItemInput[];
}

export interface UpdateScorecardInput {
  name?: string;
  description?: string;
  is_active?: boolean;
  branch_config?: BranchConfig | null;
  scoring_mode?: ScorecardScoringMode;
  items?: ScorecardItemInput[];
}
