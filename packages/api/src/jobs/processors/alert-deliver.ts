import { Job } from 'bullmq';
import { query } from '../../db/client.js';
import { sendEmail } from '../../services/email.js';
import { sendSlackWebhook } from '../../services/slack.js';
import { config } from '../../config.js';
import type { AlertChannel } from '@callguard/shared';
import type { AlertPayload } from '../../services/alert-evaluator.js';

interface DeliverJobData {
  ruleId: string;
  callId: string | null;
  channel: AlertChannel;
  target: string;
  payload: AlertPayload;
  organizationId?: string;  // for in-app notifications
}

export async function processAlertDelivery(job: Job<DeliverJobData>) {
  const { ruleId, callId, channel, target, payload } = job.data;

  // Create delivery record
  const deliveryRows = await query<{ id: string }>(
    `INSERT INTO alert_deliveries (rule_id, call_id, channel, target)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [ruleId, callId, channel, target]
  );
  const deliveryId = deliveryRows[0]!.id;

  let result: { ok: boolean; error?: string };

  try {
    if (channel === 'email') {
      result = await deliverEmail(target, payload);
    } else if (channel === 'slack') {
      result = await deliverSlack(target, payload);
    } else if (channel === 'in_app') {
      result = await deliverInApp(target, payload, ruleId, callId);
    } else {
      result = { ok: false, error: `Unknown channel: ${channel}` };
    }
  } catch (err) {
    result = { ok: false, error: (err as Error).message };
  }

  await query(
    `UPDATE alert_deliveries
        SET status = $1, error_message = $2, sent_at = CASE WHEN $1 = 'sent' THEN now() ELSE null END
      WHERE id = $3`,
    [result.ok ? 'sent' : 'failed', result.error || null, deliveryId]
  );

  if (!result.ok) {
    throw new Error(result.error || 'Alert delivery failed');
  }
}

async function deliverEmail(recipient: string, payload: AlertPayload) {
  const callLink = payload.call_id
    ? `${config.appUrl}/calls/${payload.call_id}`
    : config.appUrl;

  const severityColor = {
    info: '#2d5a9e',
    warning: '#b8860b',
    critical: '#c0392b',
  }[payload.severity];

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${severityColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0; font-size: 18px;">${escapeHtml(payload.title)}</h2>
      </div>
      <div style="background: #ffffff; border: 1px solid #e2e8e2; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
        <p style="color: #3a4e3a; font-size: 14px; line-height: 1.6;">${escapeHtml(payload.body)}</p>
        ${payload.overall_score != null ? `<p style="color: #6a7e6a; font-size: 13px;"><strong>Overall score:</strong> ${Math.round(payload.overall_score)}%</p>` : ''}
        ${payload.agent_name ? `<p style="color: #6a7e6a; font-size: 13px;"><strong>Agent:</strong> ${escapeHtml(payload.agent_name)}</p>` : ''}
        <p style="color: #6a7e6a; font-size: 13px;"><strong>Reason:</strong> ${escapeHtml(payload.matched_reason)}</p>
        <div style="margin-top: 24px;">
          <a href="${callLink}" style="background: #4a9e6e; color: white; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; display: inline-block;">View Call</a>
        </div>
        <p style="color: #8a9e8a; font-size: 12px; margin-top: 24px;">Sent by CallGuard — <a href="${config.appUrl}/alerts" style="color: #4a9e6e;">manage alert rules</a></p>
      </div>
    </div>
  `;

  const text = [
    payload.title,
    '',
    payload.body,
    payload.overall_score != null ? `Overall score: ${Math.round(payload.overall_score)}%` : '',
    payload.agent_name ? `Agent: ${payload.agent_name}` : '',
    `Reason: ${payload.matched_reason}`,
    '',
    `View: ${callLink}`,
  ].filter(Boolean).join('\n');

  return sendEmail({
    to: recipient,
    subject: `[CallGuard] ${payload.title}`,
    html,
    text,
  });
}

async function deliverSlack(webhookUrl: string, payload: AlertPayload) {
  const callLink = payload.call_id
    ? `${config.appUrl}/calls/${payload.call_id}`
    : config.appUrl;

  const emoji = {
    info: ':information_source:',
    warning: ':warning:',
    critical: ':rotating_light:',
  }[payload.severity];

  const fields: { type: string; text: string }[] = [];
  if (payload.overall_score != null) {
    fields.push({ type: 'mrkdwn', text: `*Score:*\n${Math.round(payload.overall_score)}%` });
  }
  if (payload.agent_name) {
    fields.push({ type: 'mrkdwn', text: `*Agent:*\n${payload.agent_name}` });
  }
  fields.push({ type: 'mrkdwn', text: `*Reason:*\n${payload.matched_reason}` });

  return sendSlackWebhook(webhookUrl, {
    text: `${emoji} ${payload.title}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} ${payload.title}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: payload.body },
      },
      {
        type: 'section',
        fields,
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Call' },
            url: callLink,
          },
        ],
      },
    ],
  });
}

async function deliverInApp(
  userId: string,
  payload: AlertPayload,
  ruleId: string,
  callId: string | null
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Look up user's org to populate notification row
    const user = await query<{ organization_id: string }>(
      `SELECT organization_id FROM users WHERE id = $1`,
      [userId]
    );
    if (user.length === 0) {
      return { ok: false, error: `User ${userId} not found` };
    }

    await query(
      `INSERT INTO notifications (organization_id, user_id, title, body, severity, call_id, rule_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user[0]!.organization_id, userId, payload.title, payload.body, payload.severity, callId, ruleId]
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
