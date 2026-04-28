export type RiskLevel =
  | 'high_risk'
  | 'elevated'
  | 'monitor'
  | 'low_risk'
  | 'compliant';

export const RISK_LEVELS: RiskLevel[] = [
  'high_risk',
  'elevated',
  'monitor',
  'low_risk',
  'compliant',
];

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  high_risk: 'High Risk',
  elevated: 'Elevated',
  monitor: 'Monitor',
  low_risk: 'Low Risk',
  compliant: 'Compliant',
};

export interface AdviserRisk {
  agent_id: string;
  agent_name: string;
  email: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  total_calls: number;
  scored_calls: number;
  top_breach_label: string | null;
  risk_level: RiskLevel;
  recommended_action: string;
}
