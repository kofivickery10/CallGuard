import type { ItemResult } from './scorecard.js';
import type { CallCoaching } from './coaching.js';
import type { ProductSource, JourneyProduct } from './product.js';

export type JourneyStatus = 'pending' | 'scoring' | 'scored' | 'failed';
export type JourneyTriggerSource = 'zoho_sale' | 'manual' | 'fallback';
export type JourneyCallRole = 'wrap_up' | 'context';

export interface Journey {
  id: string;
  organization_id: string;
  customer_id: string;
  scorecard_id: string;
  scorecard_version: number;
  window_start: string | null;
  window_end: string | null;
  trigger_source: JourneyTriggerSource;
  status: JourneyStatus;
  branch: string | null;
  overall_score: number | null;
  pass: boolean | null;
  model_id: string | null;
  // Journey-level coaching brief (whole-sale strengths / improvements / next
  // actions). Null until scored, or if coaching is disabled for the plan.
  coaching: CallCoaching | null;
  // How this journey's product set was resolved. Null until resolution runs
  // (or for orgs not using product-aware scoring).
  product_source: ProductSource | null;
  error_message: string | null;
  scored_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JourneyCall {
  journey_id: string;
  call_id: string;
  role: JourneyCallRole;
}

export interface JourneyItemScore {
  id: string;
  journey_id: string;
  scorecard_item_id: string;
  result: ItemResult;
  score: number | null;
  normalized_score: number | null;
  confidence: number | null;
  evidence: string | null;
  reasoning: string | null;
  source_call_id: string | null;
  source_timestamp: number | null;
  created_at: string;
}

export interface JourneyWithDetail extends Journey {
  customer_name: string | null;
  customer_phone: string | null;
  // The products this sale covered (empty for orgs not using product scoping).
  products: JourneyProduct[];
  calls: Array<{ id: string; role: JourneyCallRole; call_date: string | null; agent_name: string | null }>;
  item_scores: Array<
    JourneyItemScore & {
      label: string;
      section: string | null;
      severity: 'critical' | 'high' | 'medium' | 'low' | null;
      // Product ids this checkpoint is scoped to — lets the UI explain an 'na'
      // result as "not required for this sale's products".
      applies_to_products: string[] | null;
    }
  >;
}

// A row in the journeys list view (spec §9) — the journey plus the customer it
// belongs to and how many calls composed it.
export interface JourneyListItem extends Journey {
  customer_name: string | null;
  customer_phone: string | null;
  call_count: number;
  scorecard_name: string | null;
}

// A checkpoint awaiting human review (item_type='manual' or a consent gate
// routed to manual_review on low speaker-attribution confidence). Spans both
// per-call and journey scoring — `kind` says which.
export interface ManualReviewItem {
  kind: 'call' | 'journey';
  item_score_id: string;
  scorecard_item_id: string;
  label: string;
  section: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | null;
  // The call or journey this checkpoint belongs to.
  parent_id: string;
  customer_name: string | null;
  agent_name: string | null;
  detected_at: string;
}
