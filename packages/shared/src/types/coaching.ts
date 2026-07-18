export type Plan = 'core' | 'professional' | 'enterprise';

export const PLANS: Plan[] = ['core', 'professional', 'enterprise'];

export const PLAN_LABELS: Record<Plan, string> = {
  core: 'Core',
  professional: 'Professional',
  enterprise: 'Enterprise',
};

export const PLAN_DESCRIPTIONS: Record<Plan, string> = {
  core: 'Everything you need for AI compliance QA',
  professional: 'Adds real-time call monitoring and live coaching',
  enterprise: 'Adds dedicated support and white-label branding',
};

export interface CallCoaching {
  summary: string;
  strengths: string[];
  improvements: string[];
  next_actions: string[];
}

export type ScoringScope = 'sales_only' | 'over_threshold' | 'everything';
export type TranscriptionMode = 'mono_diarize' | 'stereo_multichannel';
export type DeepgramRegion = 'eu' | 'us';
// Mono recordings have no channel to pin, so the agent is identified by
// who speaks first — true for inbound calls (agent greets), backwards for
// outbound calls (the customer answers "Hello?" before the agent speaks).
export type MonoFirstSpeaker = 'agent' | 'customer';

export interface OrganizationInfo {
  id: string;
  name: string;
  plan: Plan;
  // Free-text industry / advice domain (e.g. "FCA-regulated protection insurance
  // advice"). Frames the AI scoring prompt. null = generic sales/service framing.
  industry?: string | null;
  // Stereo channel the adviser is recorded on: 0 = left, 1 = right, null = auto-detect.
  adviser_channel?: number | null;
  // Opt-in (default false) to let CallGuard use anonymised, customer-derived
  // data to improve the Services, per DPA §4.2.
  data_improvement_opt_in?: boolean;
  data_improvement_opt_in_at?: string | null;
  // Per-tenant scoring/ingestion policy — see services/tenant-settings.ts,
  // which layers these onto the shared/constants.ts defaults.
  scoring_scope?: ScoringScope;
  min_scoreable_seconds?: number;
  min_scoreable_words?: number;
  pass_threshold?: number;
  retention_days?: number;
  transcription_mode?: TranscriptionMode;
  mono_first_speaker?: MonoFirstSpeaker;
  deepgram_region?: DeepgramRegion;
  deepgram_mip_opt_out?: boolean;
  status?: 'active' | 'suspended' | 'cancelled';
  cancelled_at?: string | null;
}

export type FeatureFlag =
  | 'coaching'
  | 'ai_learning'
  | 'insights'
  | 'customer_journey'
  | 'live_streaming'
  | 'live_coaching'
  | 'dedicated_support'
  | 'white_label';

export const FEATURES: Record<FeatureFlag, Plan[]> = {
  // Available on all tiers
  coaching:          ['core', 'professional', 'enterprise'],
  ai_learning:       ['core', 'professional', 'enterprise'],
  insights:          ['core', 'professional', 'enterprise'],
  customer_journey:  ['core', 'professional', 'enterprise'],
  // Professional+
  live_streaming:    ['professional', 'enterprise'],
  live_coaching:     ['professional', 'enterprise'],
  // Enterprise only
  dedicated_support: ['enterprise'],
  white_label:       ['enterprise'],
};

export function hasFeature(
  plan: Plan | null | undefined,
  feature: FeatureFlag,
  // Per-tenant overrides set by a superadmin: true grants, false denies,
  // absent falls back to the plan tier.
  overrides?: Record<string, boolean> | null
): boolean {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, feature)) {
    return overrides[feature] === true;
  }
  if (!plan) return false;
  return FEATURES[feature].includes(plan);
}

const PLAN_RANK: Record<Plan, number> = { core: 0, professional: 1, enterprise: 2 };

export function planRank(plan: Plan): number {
  return PLAN_RANK[plan] ?? 0;
}

// Returns the higher of the two plans — used when a user has a per-user tier
// override that bumps them above the base org plan.
export function effectivePlan(orgPlan: Plan, override: Plan | null | undefined): Plan {
  if (!override) return orgPlan;
  return planRank(override) > planRank(orgPlan) ? override : orgPlan;
}
