import { query, queryOne } from '../db/client.js';
import { alertsQueue } from '../jobs/queue.js';
import type { AlertRule, AlertChannelsConfig, AlertSeverity } from '@callguard/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Where "view" should land, as an app-relative path. Optional: absent means
  // the classic per-call link (/calls/:call_id). Journey-level alerts (data
  // capture) point at the sale instead.
  action_url?: string | null;
  action_label?: string;
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

/**
 * Evaluate capture_missed_required rules for a completed capture run. Fires
 * when the run left at least min_missed (default 1) required questions
 * unanswered — the "catch the gap before the application goes off" alert.
 * Called fire-and-forget from the capture processor; never throws into it.
 */
export async function evaluateCaptureRunAlerts(runId: string): Promise<void> {
  const run = await queryOne<{
    id: string;
    organization_id: string;
    journey_id: string | null;
    call_id: string | null;
    form_name: string;
  }>(
    `SELECT r.id, r.organization_id, r.journey_id, r.call_id, cf.name AS form_name
       FROM capture_runs r
       JOIN capture_forms cf ON cf.id = r.form_id
      WHERE r.id = $1 AND r.status = 'completed'`,
    [runId]
  );
  if (!run) return;

  const rules = await query<AlertRule>(
    `SELECT * FROM alert_rules
      WHERE organization_id = $1 AND is_active = true
        AND trigger_type = 'capture_missed_required'`,
    [run.organization_id]
  );
  if (rules.length === 0) return;

  const missed = await query<{ label: string }>(
    `SELECT f.label
       FROM capture_answers ca
       JOIN capture_form_fields f ON f.id = ca.field_id
      WHERE ca.run_id = $1 AND ca.result = 'missed' AND f.required
      ORDER BY f.sort_order`,
    [runId]
  );
  if (missed.length === 0) return;

  // Anchor the delivery on a real call: the run's own call, or the journey's
  // wrap-up call (fall back to any linked call). The user-facing link still
  // points at the sale via action_url.
  const anchor = await queryOne<CallRow>(
    run.call_id
      ? `SELECT id, organization_id, file_name, status, agent_name, error_message
           FROM calls WHERE id = $1`
      : `SELECT c.id, c.organization_id, c.file_name, c.status, c.agent_name, c.error_message
           FROM journey_calls jc
           JOIN calls c ON c.id = jc.call_id
          WHERE jc.journey_id = $1
          ORDER BY (jc.role = 'wrap_up') DESC, c.created_at DESC
          LIMIT 1`,
    [run.call_id ?? run.journey_id]
  );
  if (!anchor) return;

  const customer = run.journey_id
    ? await queryOne<{ name: string | null }>(
        `SELECT cust.name FROM journeys j
           JOIN customers cust ON cust.id = j.customer_id
          WHERE j.id = $1`,
        [run.journey_id]
      )
    : null;

  const subject = customer?.name ?? anchor.file_name;
  const listed = missed.slice(0, 5).map((m) => `"${m.label}"`).join('; ');
  const overflow = missed.length > 5 ? ` (+${missed.length - 5} more)` : '';

  for (const rule of rules) {
    const minMissed = Math.max(1, Number(rule.trigger_config.min_missed) || 1);
    if (missed.length < minMissed) continue;

    const payload: AlertPayload = {
      title: `Missed answers: ${subject}`,
      body: `${missed.length} required question${missed.length === 1 ? '' : 's'} went unanswered (${run.form_name}): ${listed}${overflow}`,
      severity: 'critical',
      call_id: anchor.id,
      call_file_name: anchor.file_name,
      agent_name: anchor.agent_name,
      overall_score: null,
      matched_reason: `${missed.length} required answer${missed.length === 1 ? '' : 's'} missed (threshold ${minMissed})`,
      action_url: run.journey_id ? `/journeys/${run.journey_id}` : `/calls/${anchor.id}`,
      action_label: run.journey_id ? 'View Sale' : 'View Call',
    };
    await fanOutDeliveries(rule, anchor, payload);
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
  if (!Array.isArray(config) || config.length === 0) return [];
  // Only deliver to users in the rule's own organisation. An explicit id list
  // is admin-supplied JSONB — without this filter, a rule configured with a
  // foreign user's UUID would push this org's call metadata into another
  // tenant's notifications (deliverInApp resolves the notification's org from
  // the TARGET user, not the rule). Non-UUID entries are dropped up front so
  // a malformed rule can't fail the cast and take down the whole fan-out.
  const candidates = config.filter((id) => typeof id === 'string' && UUID_RE.test(id));
  if (candidates.length === 0) return [];
  const users = await query<{ id: string }>(
    `SELECT id FROM users WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, candidates]
  );
  return users.map((u) => u.id);
}
