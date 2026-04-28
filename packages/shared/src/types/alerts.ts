export const ALERT_TRIGGER_TYPES = [
  'low_overall_score',
  'item_below_threshold',
  'processing_failed',
] as const;

export type AlertTriggerType = (typeof ALERT_TRIGGER_TYPES)[number];

export const ALERT_TRIGGER_LABELS: Record<AlertTriggerType, string> = {
  low_overall_score: 'Low overall score',
  item_below_threshold: 'Scorecard item below threshold',
  processing_failed: 'Call processing failed',
};

export type AlertChannel = 'email' | 'slack' | 'in_app';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface LowOverallScoreConfig {
  threshold: number;
}
export interface ItemBelowThresholdConfig {
  scorecard_item_id: string;
  threshold: number;
}
export type ProcessingFailedConfig = Record<string, never>;

export type AlertInAppTarget = string[] | 'all_admins';

export interface AlertChannelsConfig {
  email?: { recipients: string[] };
  slack?: { webhook_url: string };
  in_app?: { user_ids: AlertInAppTarget };
}

export interface AlertRule {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  trigger_type: AlertTriggerType;
  trigger_config: Record<string, unknown>;
  channels: AlertChannelsConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpsertAlertRuleInput {
  name: string;
  description?: string;
  trigger_type: AlertTriggerType;
  trigger_config: Record<string, unknown>;
  channels: AlertChannelsConfig;
  is_active?: boolean;
}

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  severity: AlertSeverity;
  call_id: string | null;
  rule_id: string | null;
  read_at: string | null;
  created_at: string;
}
