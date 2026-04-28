import { query, queryOne } from '../db/client.js';
import { alertsQueue } from '../jobs/queue.js';
import type { AlertRule, AlertChannelsConfig, AlertSeverity } from '@callguard/shared';

interface CallRow {
  id: string;
  organization_id: string;
  file_name: string;
  status: string;
  agent_name: string | null;
  error_message: string | null;
}

interface CallScoreRow {
  id: string;
  overall_score: number | null;
  pass: boolean | null;
}

interface ItemScoreRow {
  scorecard_item_id: string;
  normalized_score: number;
  label: string;
}

export interface AlertPayload {
  title: string;
  body: string;
  severity: AlertSeverity;
  call_id: string;
  call_file_name: string;
  agent_name: string | null;
  overall_score: number | null;
  matched_reason: string;
}

/**
 * Evaluate all active alert rules for a call and queue delivery jobs for any
 * that match. Called after a call is scored or has failed.
 */
export async function evaluateAlertsForCall(
  callId: string,
  status: 'scored' | 'failed'
): Promise<void> {
  const call = await queryOne<CallRow>(
    `SELECT id, organization_id, file_name, status, agent_name, error_message
       FROM calls WHERE id = $1`,
    [callId]
  );
  if (!call) return;

  const rules = await query<AlertRule>(
    `SELECT * FROM alert_rules
       WHERE organization_id = $1 AND is_active = true`,
    [call.organization_id]
  );
  if (rules.length === 0) return;

  // Load latest score + item scores if the call was scored
  let callScore: CallScoreRow | null = null;
  let itemScores: ItemScoreRow[] = [];
  if (status === 'scored') {
    callScore = await queryOne<CallScoreRow>(
      `SELECT id, overall_score, pass FROM call_scores
        WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [callId]
    );
    if (callScore) {
      itemScores = await query<ItemScoreRow>(
        `SELECT cis.scorecard_item_id, cis.normalized_score, si.label
           FROM call_item_scores cis
           JOIN scorecard_items si ON si.id = cis.scorecard_item_id
          WHERE cis.call_score_id = $1`,
        [callScore.id]
      );
    }
  }

  for (const rule of rules) {
    const match = evaluateRule(rule, status, call, callScore, itemScores);
    if (!match) continue;

    await fanOutDeliveries(rule, call, match);
  }
}

function evaluateRule(
  rule: AlertRule,
  status: 'scored' | 'failed',
  call: CallRow,
  callScore: CallScoreRow | null,
  itemScores: ItemScoreRow[]
): AlertPayload | null {
  switch (rule.trigger_type) {
    case 'low_overall_score': {
      if (status !== 'scored' || !callScore || callScore.overall_score == null) return null;
      const threshold = Number(rule.trigger_config.threshold);
      if (Number.isNaN(threshold)) return null;
      if (Number(callScore.overall_score) >= threshold) return null;
      return {
        title: `Low score: ${call.file_name}`,
        body: `Call scored ${Math.round(Number(callScore.overall_score))}% (threshold ${threshold}%)${call.agent_name ? ` — agent: ${call.agent_name}` : ''}`,
        severity: 'critical',
        call_id: call.id,
        call_file_name: call.file_name,
        agent_name: call.agent_name,
        overall_score: Number(callScore.overall_score),
        matched_reason: `overall score ${Math.round(Number(callScore.overall_score))}% < ${threshold}%`,
      };
    }
    case 'item_below_threshold': {
      if (status !== 'scored') return null;
      const itemId = String(rule.trigger_config.scorecard_item_id);
      const threshold = Number(rule.trigger_config.threshold);
      const item = itemScores.find((s) => s.scorecard_item_id === itemId);
      if (!item) return null;
      if (Number(item.normalized_score) >= threshold) return null;
      return {
        title: `Item failed: ${item.label}`,
        body: `"${item.label}" scored ${Math.round(Number(item.normalized_score))}% on call ${call.file_name}`,
        severity: 'critical',
        call_id: call.id,
        call_file_name: call.file_name,
        agent_name: call.agent_name,
        overall_score: callScore?.overall_score != null ? Number(callScore.overall_score) : null,
        matched_reason: `${item.label} scored ${Math.round(Number(item.normalized_score))}% < ${threshold}%`,
      };
    }
    case 'processing_failed': {
      if (status !== 'failed') return null;
      return {
        title: `Processing failed: ${call.file_name}`,
        body: call.error_message || 'Call failed to process',
        severity: 'warning',
        call_id: call.id,
        call_file_name: call.file_name,
        agent_name: call.agent_name,
        overall_score: null,
        matched_reason: 'call processing failed',
      };
    }
    default:
      return null;
  }
}

async function fanOutDeliveries(
  rule: AlertRule,
  call: CallRow,
  payload: AlertPayload
): Promise<void> {
  const channels = rule.channels as AlertChannelsConfig;

  if (channels.email?.recipients?.length) {
    for (const recipient of channels.email.recipients) {
      await alertsQueue.add(
        'deliver',
        {
          ruleId: rule.id,
          callId: call.id,
          channel: 'email',
          target: recipient,
          payload,
        },
        { jobId: `alert-${rule.id}-${call.id}-email-${recipient}` }
      );
    }
  }

  if (channels.slack?.webhook_url) {
    await alertsQueue.add(
      'deliver',
      {
        ruleId: rule.id,
        callId: call.id,
        channel: 'slack',
        target: channels.slack.webhook_url,
        payload,
      },
      { jobId: `alert-${rule.id}-${call.id}-slack` }
    );
  }

  if (channels.in_app) {
    const userIds = await resolveInAppUserIds(call.organization_id, channels.in_app.user_ids);
    for (const userId of userIds) {
      await alertsQueue.add(
        'deliver',
        {
          ruleId: rule.id,
          callId: call.id,
          channel: 'in_app',
          target: userId,
          payload,
        },
        { jobId: `alert-${rule.id}-${call.id}-inapp-${userId}` }
      );
    }
  }
}

async function resolveInAppUserIds(
  organizationId: string,
  config: string[] | 'all_admins'
): Promise<string[]> {
  if (config === 'all_admins') {
    const admins = await query<{ id: string }>(
      `SELECT id FROM users WHERE organization_id = $1 AND role = 'admin'`,
      [organizationId]
    );
    return admins.map((a) => a.id);
  }
  return Array.isArray(config) ? config : [];
}
