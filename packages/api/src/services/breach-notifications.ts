import { query } from '../db/client.js';
import type { AlertSeverity } from '@callguard/shared';
import { notify, recipientById, recipientsByRole, getUserName, type NotifyRecipient } from './notify.js';

// Breach-specific wrappers over the generic notify() spine. Called (fire-and-
// forget) from the breach routes when a supervisor assigns or escalates a
// breach — the workflow that, until now, wrote an audit row and told nobody.

interface BreachContext {
  id: string;
  severity: string; // breach scale: critical | high | medium | low
  breach_type: string | null; // scorecard item label
  call_id: string | null;
  source_name: string | null; // call file name, or a journey fallback
  agent_name: string | null;
}

async function loadBreachContext(breachId: string): Promise<BreachContext | null> {
  const rows = await query<BreachContext>(
    `SELECT b.id, b.severity, b.call_id,
            si.label AS breach_type,
            COALESCE(c.file_name, 'Journey review') AS source_name,
            c.agent_name
       FROM breaches b
       JOIN scorecard_items si ON si.id = b.scorecard_item_id
       LEFT JOIN calls c ON c.id = b.call_id
      WHERE b.id = $1`,
    [breachId]
  );
  return rows[0] ?? null;
}

// Map the breach severity scale onto the notification scale (info/warning/critical).
function notifSeverity(breachSeverity: string, escalated: boolean): AlertSeverity {
  const high = breachSeverity === 'critical' || breachSeverity === 'high';
  if (escalated) return high ? 'critical' : 'warning';
  return high ? 'warning' : 'info';
}

export async function notifyBreachAssigned(
  breachId: string,
  assigneeUserId: string,
  actorUserId: string,
  organizationId: string
): Promise<void> {
  try {
    const [ctx, assignee, actorName] = await Promise.all([
      loadBreachContext(breachId),
      recipientById(assigneeUserId),
      getUserName(actorUserId),
    ]);
    if (!ctx || !assignee) return;

    const label = ctx.breach_type ?? 'Compliance breach';
    const by = actorName ? ` by ${actorName}` : '';
    const agent = ctx.agent_name ? ` (agent: ${ctx.agent_name})` : '';

    await notify({
      organizationId,
      type: 'breach.assigned',
      severity: notifSeverity(ctx.severity, false),
      title: `Breach assigned to you: ${label}`,
      body: `You've been assigned a ${ctx.severity} breach "${label}" on ${ctx.source_name}${agent}${by}.`,
      recipients: [assignee],
      actionUrl: '/breaches',
      callId: ctx.call_id,
      breachId: ctx.id,
      dedupeKey: `breach.assigned:${ctx.id}`,
      email: true,
    });
  } catch (err) {
    console.error(`[breach-notifications] assigned notify failed for ${breachId}:`, (err as Error).message);
  }
}

export async function notifyBreachEscalated(
  breachId: string,
  actorUserId: string,
  organizationId: string,
  assignedTo: string | null
): Promise<void> {
  try {
    const [ctx, actorName, managers] = await Promise.all([
      loadBreachContext(breachId),
      getUserName(actorUserId),
      recipientsByRole(organizationId, ['admin', 'supervisor']),
    ]);
    if (!ctx) return;

    const recipients: NotifyRecipient[] = [...managers];
    if (assignedTo) {
      const assignee = await recipientById(assignedTo);
      if (assignee) recipients.push(assignee);
    }
    // Don't notify whoever did the escalating.
    const targets = recipients.filter((r) => r.userId !== actorUserId);
    if (targets.length === 0) return;

    const label = ctx.breach_type ?? 'Compliance breach';
    const lead = actorName ? `${actorName} escalated` : 'Escalated';
    const agent = ctx.agent_name ? ` (agent: ${ctx.agent_name})` : '';

    await notify({
      organizationId,
      type: 'breach.escalated',
      severity: notifSeverity(ctx.severity, true),
      title: `Breach escalated: ${label}`,
      body: `${lead} a ${ctx.severity} breach "${label}" on ${ctx.source_name}${agent}.`,
      recipients: targets,
      actionUrl: '/breaches',
      callId: ctx.call_id,
      breachId: ctx.id,
      dedupeKey: `breach.escalated:${ctx.id}`,
      email: true,
    });
  } catch (err) {
    console.error(`[breach-notifications] escalated notify failed for ${breachId}:`, (err as Error).message);
  }
}
