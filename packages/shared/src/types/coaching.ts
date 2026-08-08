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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

// The first syntactically balanced {...} starting at the first brace, ignoring
// braces inside strings. Recovers an object the model emitted with trailing
// junk after it (a stray closing brace is the observed case) instead of losing
// the whole brief to one bad character.
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Coerce whatever is sitting in a `coaching` column (or came back from the
 * model) into a coaching brief, or null if it cannot be trusted to be one.
 *
 * Needed because the coaching brief is free-form model output that nothing else
 * validates: the scoring tool schema declares it as an object, but a model can
 * and does answer with the object serialised as a *string* — sometimes with
 * stray characters after it. That reaches the database as a JSONB string
 * scalar, and a UI that assumes an object then dies on `coaching.strengths.map`
 * and takes the whole sale page with it.
 *
 * Coaching is advisory: an unreadable brief must degrade to "no brief", never
 * to a failed score or a page that will not load.
 */
export function parseCoaching(raw: unknown): CallCoaching | null {
  let value = raw;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const balanced = firstBalancedObject(text);
      if (!balanced) return null;
      try {
        parsed = JSON.parse(balanced);
      } catch {
        return null;
      }
    }
    // A doubly-encoded string is possible; one more pass, then give up.
    value = typeof parsed === 'string' ? parseCoaching(parsed) : parsed;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.summary !== 'string') return null;
  if (!isStringArray(c.strengths)) return null;
  if (!isStringArray(c.improvements)) return null;
  if (!isStringArray(c.next_actions)) return null;

  return {
    summary: c.summary,
    strengths: c.strengths,
    improvements: c.improvements,
    next_actions: c.next_actions,
  };
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
  // Per-tenant Deepgram keyterm boosting: the org's domain vocabulary
  // (products, sector jargon, provider names). Boosted ahead of the generic
  // core list at transcription time — see services/transcription.ts.
  keyterms?: string[];
  // Data Capture module switch (migration 059). Set by CallGuard staff, like
  // the other scoring-policy columns; gates capture jobs, routes and UI.
  capture_enabled?: boolean;
  // Application reconciliation module switch (migration 080). Independent of
  // capture_enabled: a tenant can run their own question set without ever
  // comparing it against an insurer's submitted application, and vice versa.
  reconciliation_enabled?: boolean;
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
  // Independent scoring passes to vote across (migration 076), and the
  // model-confidence floor below which a checkpoint is handed to a human
  // instead of being auto-scored (migration 082, 0 = off). Both trade AI
  // coverage for human review; both are staff-set, like the rest of this block.
  scoring_samples?: number;
  review_confidence_floor?: number;
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
  | 'white_label'
  // Display-only mode: show the numeric score alone and suppress the overall
  // Pass/Fail/Review verdict (and its red/green styling and pass-rate KPIs).
  // Per-checkpoint item results are unaffected, and the verdict is still
  // computed and stored server-side (alerts, Zoho write-back and reporting are
  // unchanged). Not tied to any plan tier — granted per tenant by a superadmin
  // via feature_overrides.
  | 'score_only';

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
  // No tier grants this by default — enabled per tenant via a superadmin override.
  score_only:        [],
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
