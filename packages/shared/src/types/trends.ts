export interface CallsPerDayPoint {
  date: string;
  total: number;
  scored: number;
}

export interface ScoreTrendPoint {
  week_start: string;
  // Scored units in the week — the latest score per call plus each scored sale,
  // both dated by WHEN THE CONVERSATION HAPPENED. The series used to bucket
  // calls by their own date and sales by when they were scored, so the same
  // conversation landed in a different week depending on the firm's scoring
  // mode, and a re-score moved it.
  unit_count: number;
  avg_score: number | null;
  // Null under score_only, and null in a week with no unit carrying a verdict.
  pass_rate: number | null;
}

export interface ScorecardBreakdownRow {
  id: string;
  name: string;
  // Scored units against this scorecard — sales at a firm that scores sales,
  // calls at one that scores calls. Counts the unit, not its score: a sale
  // scored but left without an overall score (every checkpoint held or n/a)
  // used to vanish from this table entirely.
  unit_count: number;
  avg_score: number | null;
  flags_per_unit: number | null;
  // Critical breaches still open — the same definition as the KPI tile
  // (anything not resolved or noted), so one screen no longer shows two
  // different numbers both labelled "Critical".
  critical_open: number;
  // Critical breaches ever raised against this scorecard, open or closed. The
  // figure this column used to show, now saying what it is.
  critical_total: number;
}

export interface BreachSeverityPoint {
  week_start: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}
