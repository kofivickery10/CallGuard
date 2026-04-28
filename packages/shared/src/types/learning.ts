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
