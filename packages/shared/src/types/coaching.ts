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
