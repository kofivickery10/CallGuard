export type ScoreType = 'binary' | 'scale_1_5' | 'scale_1_10';
export type ScorecardItemType = 'ai' | 'manual';
export type ItemResult = 'pass' | 'fail' | 'na' | 'manual_review';
export type ScorecardScoringMode = 'per_call' | 'journey';

// The FCA Consumer Duty's four outcomes. Vulnerability is deliberately NOT a
// member of this type — it is a cross-cutting consideration that runs through
// all four outcomes, not a fifth outcome, so it is modelled separately as
// ScorecardItem.vulnerability_related. Collapsing the two into one enum would
// misrepresent the regulation.
export type ConsumerDutyOutcome =
  | 'products_and_services'
  | 'price_and_value'
  | 'consumer_understanding'
  | 'consumer_support';

// Branch condition on a scorecard item — which branch(es) it applies to.
// Absent/null on the item = applies to every branch.
export interface AppliesWhen {
  branch: string | string[];
}

// How a scorecard's branches are detected on a call/journey transcript.
export interface BranchConfig {
  branches: string[];
  // 'keyword' = transcript phrase matching only. 'crm_field' = prefer the
  // sale's CRM stage (see `crm_values`), falling back to keywords when the
  // stage is missing or unmapped. Both keep `branches[0]` as the last resort.
  detect: 'keyword' | 'crm_field';
  // Per non-default branch, keyword/phrase triggers checked against the
  // transcript. The first branch with a match wins; no match = the first
  // entry in `branches` (the implicit default).
  //
  // Keyword matching is a weak signal — an adviser who says "we'll leave it
  // to the underwriters now" rather than the literal configured phrase is
  // silently scored under the default branch, which mutes the branch's real
  // checkpoints and scores the other branch's against a sale they don't apply
  // to. Prefer `crm_values` wherever the CRM carries a stage.
  keywords?: Record<string, string[]>;
  // Per branch, the CRM stage values that map to it (case-insensitive, exact
  // after trimming). Read off the sale's policy records — for Zoho that is the
  // `policy_stage_field` on the policies related list. Authoritative when it
  // resolves: the CRM is the system of record for whether a policy went on
  // risk, and the transcript only ever paraphrases it.
  crm_values?: Record<string, string[]>;
  // CRM stage values that mean "this sale did not complete — do not score it".
  // Matched exactly, like crm_values, and checked BEFORE branch resolution.
  //
  // For a protection firm these are the NTU ("not taken up") states: the
  // customer walked away, so there is no sale to hold against the adviser and
  // scoring one would put breaches on the register for business that never
  // existed. A sale at one of these stages is skipped at assembly — no audio is
  // fetched, nothing is transcribed, nothing is pushed to the CRM.
  no_score_crm_values?: string[];
}

// How a journey's branch was determined, for auditability. A 'default' branch
// is a guess — no CRM stage and no keyword matched — and must be surfaced as
// such rather than presented as fact, since it silently decides which
// checkpoints apply (see resolveBranchWithSource).
export type BranchSource = 'crm' | 'keyword' | 'default';

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
  // Which Consumer Duty outcome this checkpoint evidences. Null = unmapped —
  // the honest default for every scorecard until a person tags it; never
  // silently bucketed into an outcome it was not assigned.
  consumer_duty_outcome?: ConsumerDutyOutcome | null;
  // Whether this checkpoint is about identifying or adapting to customer
  // vulnerability. Orthogonal to consumer_duty_outcome — vulnerability is a
  // cross-cutting consideration, not a fifth outcome.
  vulnerability_related?: boolean;
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
  consumer_duty_outcome?: ConsumerDutyOutcome | null;
  vulnerability_related?: boolean;
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
