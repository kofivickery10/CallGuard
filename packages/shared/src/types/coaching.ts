export type Plan = 'starter' | 'growth' | 'pro';

export const PLANS: Plan[] = ['starter', 'growth', 'pro'];

export const PLAN_LABELS: Record<Plan, string> = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
};

export const PLAN_DESCRIPTIONS: Record<Plan, string> = {
  starter: 'Scoring & breach register',
  growth: 'Scoring, coaching, integrations',
  pro: 'Everything + webhooks & dedicated support',
};

export interface CallCoaching {
  summary: string;
  strengths: string[];
  improvements: string[];
  next_actions: string[];
}

export interface OrganizationInfo {
  id: string;
  name: string;
  plan: Plan;
  // Stereo channel the adviser is recorded on: 0 = left, 1 = right, null = auto-detect.
  adviser_channel?: number | null;
  // Opt-in (default false) to let CallGuard use anonymised, customer-derived
  // data to improve the Services, per DPA §4.2.
  data_improvement_opt_in?: boolean;
  data_improvement_opt_in_at?: string | null;
}

export type FeatureFlag = 'coaching' | 'ai_learning' | 'insights';

export const FEATURES: Record<FeatureFlag, Plan[]> = {
  coaching: ['growth', 'pro'],
  ai_learning: ['growth', 'pro'],
  insights: ['pro'],
};

export function hasFeature(plan: Plan, feature: FeatureFlag): boolean {
  return FEATURES[feature].includes(plan);
}
