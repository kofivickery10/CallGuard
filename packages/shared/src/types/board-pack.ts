import type { BreachSeverity } from './breaches.js';
import type { AdviserRisk } from './risk.js';

// A single evidence pack for a compliance committee / board sign-off over a
// period, optionally narrowed to one product. See GET /api/board-pack.
//
// Deliberately does not surface journeys.coverage anywhere (partial-journey
// detection is Phase 1 only — see packages/api/src/db/migrations/100_journey_coverage.sql
// and packages/api/src/routes/board-pack.ts).

export interface BoardPackPeriod {
  from: string;
  to: string;
}

export interface BoardPackCoverage {
  // Calls landed with CallGuard in the period (by ingestion date), and how
  // many of those have a verdict (per-call score OR are part of a scored
  // journey — the same "scored unit" rule used across the app).
  calls_ingested: number;
  calls_scored: number;
  // What's holding the rest up, so "everything is reviewed" can be checked
  // rather than taken on trust. Statuses with zero calls are omitted.
  calls_not_scored_by_status: { status: string; count: number }[];
  // Sales (journeys) dated to the sale itself (not when it was assembled or
  // scored — see SALE_DATE_SQL in routes/journeys.ts) that reached 'scored'
  // in this period, and the other outcomes for sales dated into the period.
  sales_scored: number;
  sales_not_scored_by_status: { status: string; count: number }[];
}

export interface BoardPackOutcomesWindow {
  period: BoardPackPeriod;
  total_scored: number;
  average_score: number | null;
  pass_rate: number | null;
}

export interface BoardPackScoreBand {
  // e.g. '90-100', '80-89', ..., '<60'
  band: string;
  count: number;
}

export interface BoardPackOutcomes {
  current: BoardPackOutcomesWindow;
  previous: BoardPackOutcomesWindow;
  distribution: BoardPackScoreBand[];
}

export interface BoardPackSeverityCount {
  severity: BreachSeverity;
  count: number;
}

export interface BoardPackThemeCount {
  // Null when a breach's checkpoint has no section set.
  section: string | null;
  count: number;
}

export interface BoardPackFindingsByTheme {
  // Explicit label, always shown with the figures: these are the firm's own
  // scorecard sections, not an FCA / Consumer Duty outcome taxonomy.
  note: string;
  sections: BoardPackThemeCount[];
}

export interface BoardPackJourneyOversight {
  total_resolved: number;
  // original_pass IS NULL in score_corrections — the AI had no confident
  // verdict and routed the checkpoint to a human.
  ai_declined: number;
  // original_pass IS NOT NULL — a human overturned a confident AI verdict.
  human_overturned: number;
}

export interface BoardPackCallOversight {
  // Manual-review checkpoints on calls resolved in the period
  // (audit_log action_type='review.resolve', metadata->>'kind'='call'). By
  // construction every one of these is the AI declining to decide — see the
  // note below for why calls can't be split the way sales can.
  ai_declined_resolved: number;
  // A human overturning an already-confident call verdict
  // (score_corrections.call_id IS NOT NULL). Recorded on a different path to
  // ai_declined_resolved above, so the two are not additive into one "total".
  human_overturned: number;
  note: string;
}

export interface BoardPackHumanOversight {
  journeys: BoardPackJourneyOversight;
  calls: BoardPackCallOversight;
  // Breaches a person looked at and agreed were real (confirmed_by/confirmed_at),
  // confirmed within the period — the strongest standing a finding can have.
  breaches_confirmed_by_human: number;
  asymmetry_note: string;
}

export interface BoardPackActionTaken {
  by_status: { status: string; count: number }[];
  resolution_time: {
    // Breaches resolved in the period, detected_at -> resolved_at.
    n: number;
    median_hours: number | null;
    mean_hours: number | null;
  };
}

export interface BoardPackResponse {
  organization_name: string;
  period: BoardPackPeriod;
  product: { id: string; name: string } | null;
  // Explains what the product filter does and does not narrow, when set.
  product_scope_note: string | null;
  generated_at: string;

  coverage: BoardPackCoverage;
  outcomes: BoardPackOutcomes;
  findings_by_severity: BoardPackSeverityCount[];
  findings_by_theme: BoardPackFindingsByTheme;
  human_oversight: BoardPackHumanOversight;
  advisers_needing_attention: AdviserRisk[];
  action_taken: BoardPackActionTaken;

  // Plain-language limits of what this pack can and cannot say. Required
  // reading alongside the figures, not small print.
  methodology: string[];
}
