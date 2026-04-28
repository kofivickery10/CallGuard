export interface CallsPerDayPoint {
  date: string;
  total: number;
  scored: number;
}

export interface ScoreTrendPoint {
  week_start: string;
  call_count: number;
  avg_score: number | null;
  pass_rate: number | null;
}

export interface ScorecardBreakdownRow {
  id: string;
  name: string;
  call_count: number;
  avg_score: number | null;
  flags_per_call: number | null;
  critical_count: number;
}

export interface BreachSeverityPoint {
  week_start: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}
