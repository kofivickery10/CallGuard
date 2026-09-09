export interface ScoreCorrection {
  id: string;
  organization_id: string;
  call_id: string;
  call_item_score_id: string;
  scorecard_item_id: string;
  corrected_by: string;
  original_score: number;
  corrected_score: number;
  original_pass: boolean | null;
  corrected_pass: boolean;
  reason: string | null;
  transcript_excerpt: string | null;
  created_at: string;
}

export interface CorrectItemScoreInput {
  corrected_pass: boolean;
  reason?: string;
}

export type InsightPriority = 'critical' | 'high' | 'medium' | 'info';

export interface InsightRecommendation {
  title: string;
  detail: string;
  priority: InsightPriority;
  cta?: {
    label: string;
    href: string;
  };
}

export interface InsightDigest {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  summary: string;
  recommendations: InsightRecommendation[];
  metrics: Record<string, unknown>;
  generated_by: string | null;
  model_id: string | null;
  created_at: string;
}

// ── The override register (CG-7) ──────────────────────────────────────────────

// Which way a person moved the AI's verdict.
//
// 'ai_undecided' is deliberately its own case, not a kind of override: the AI
// declined to decide (original_pass NULL, migration 077) and a human ruled.
// Counting that as the model being overturned would inflate the override rate
// with exactly the cases where it behaved correctly.
export type OverrideDirection =
  | 'ai_too_harsh'
  | 'ai_too_lenient'
  | 'ai_undecided'
  | 'unchanged';

export interface OverrideRegisterEntry {
  id: string;
  created_at: string;
  item_label: string;
  item_section: string | null;
  scorecard_item_id: string;
  user_id: string;
  // Null when the reviewer's user row has since been deleted. The entry stays
  // in the register regardless — an override whose author has left the firm
  // still happened.
  user_name: string | null;
  original_pass: boolean | null;
  corrected_pass: boolean | null;
  direction: OverrideDirection;
  // Optional at the point of override, which is the weak link in the audit
  // chain: an override with no stated basis is the one that cannot be defended
  // later. The register makes those findable rather than hiding them.
  reason: string | null;
  // Exactly one is set — per-call overrides (068) or sale-side ones (077).
  call_id: string | null;
  journey_id: string | null;
  // The client or customer the record concerns, for a reader scanning the
  // register. Null where neither the sale nor the call resolves one.
  subject_name: string | null;
}

export interface OverrideRegisterSummary {
  total: number;
  ai_too_harsh: number;
  ai_too_lenient: number;
  ai_undecided: number;
  // Overrides recorded with no reason. Surfaced as a headline because it is the
  // number that decides whether "every override is logged" is a defensible
  // claim or just a true one.
  missing_reason: number;
  reviewers: number;
}
