import type { ItemResult, BranchSource } from './scorecard.js';
import type { CallStatus } from './call.js';
import type { CallCoaching } from './coaching.js';
import type { ProductSource, JourneyProduct } from './product.js';

// 'skipped' — the CRM stage marks this as a sale that did not complete (an NTU
// state), so it is deliberately not scored. Distinct from 'failed', which means
// scoring was attempted and broke.
export type JourneyStatus = 'pending' | 'scoring' | 'scored' | 'failed' | 'skipped';
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
  // How `branch` was decided: 'crm' (the sale's CRM policy stage), 'keyword'
  // (a phrase matched in the transcript) or 'default' (nothing matched, the
  // first branch was assumed). Null for journeys scored before migration 071.
  // A 'default' branch is a guess that silently decides which checkpoints
  // apply, so the UI must present it as unconfirmed rather than as fact.
  branch_source: BranchSource | null;
  // The raw CRM stage value the branch was derived from, for audit.
  crm_stage: string | null;
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
  // Firm exemplar: an admin marked this whole sale as "what good looks like".
  // Fed into the scoring prompt via getLearningContext (requires ai_learning).
  is_exemplar: boolean;
  exemplar_reason: string | null;
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
  // The calls that composed this sale, oldest first. call_date is already
  // coalesced to the call's created_at server-side, so it is never null here;
  // overall_score/pass are null for calls that were only scored as part of the
  // sale (journey mode) rather than individually.
  calls: Array<{
    id: string;
    role: JourneyCallRole;
    call_date: string;
    agent_name: string | null;
    direction: 'inbound' | 'outbound' | null;
    duration_seconds: number | null;
    status: CallStatus;
    overall_score: number | null;
    pass: boolean | null;
    // Set when automated checks found the Agent/Customer labels contradicted by
    // the conversation's content (services/speaker-integrity.ts). Any checkpoint
    // that turns on who said something is unsafe on such a call, so the UI warns
    // rather than presenting the result as settled.
    speaker_integrity_flag: string | null;
  }>;
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
