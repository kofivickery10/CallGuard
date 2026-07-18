import { query } from '../db/client.js';
import { config } from '../config.js';
import { alertsQueue } from '../jobs/queue.js';
import type { AlertSeverity, NotificationType } from '@callguard/shared';

// The generic notification spine. Any part of the app can raise a directed
// system notification through notify(): it writes an in-app row per recipient
// (surfaced by the notification bell) and, when email is requested and
// configured, enqueues an email on the alerts queue. This is deliberately
// separate from the alert-rule delivery path (jobs/processors/alert-deliver.ts,
// which is tied to alert_rules and alert_deliveries) — system events aren't
// rules and shouldn't need one authored to reach the right person.

export interface NotifyRecipient {
  userId: string;
  email: string | null;
}

export interface NotifyInput {
  organizationId: string;
  type: NotificationType;
  severity: AlertSeverity;
  title: string;
  body: string;
  recipients: NotifyRecipient[];
  // App-relative deep link the notification opens (e.g. '/breaches').
  actionUrl?: string | null;
  callId?: string | null;
  breachId?: string | null;
  // Event-specific dedupe key (the recipient's user id is appended
  // automatically). While a matching notification is unread, repeats are
  // swallowed. Omit to always create a new notification.
  dedupeKey?: string | null;
  // Also email recipients who have an address (skipped when Resend isn't
  // configured, so dev environments don't accumulate un-sendable jobs).
  email?: boolean;
}

// Resolve every org user in the given roles to a recipient.
export async function recipientsByRole(
  organizationId: string,
  roles: string[]
): Promise<NotifyRecipient[]> {
  if (roles.length === 0) return [];
  const rows = await query<{ id: string; email: string | null }>(
    `SELECT id, email FROM users
      WHERE organization_id = $1 AND role = ANY($2::text[])`,
    [organizationId, roles]
  );
  return rows.map((r) => ({ userId: r.id, email: r.email }));
}

export async function recipientById(userId: string): Promise<NotifyRecipient | null> {
  const rows = await query<{ id: string; email: string | null }>(
    `SELECT id, email FROM users WHERE id = $1`,
    [userId]
  );
  const r = rows[0];
  return r ? { userId: r.id, email: r.email } : null;
}

export async function getUserName(userId: string): Promise<string | null> {
  const rows = await query<{ name: string | null }>(
    `SELECT name FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0]?.name ?? null;
}

// Write an in-app notification per recipient and optionally enqueue an email.
// Never throws into the caller — a failed notification must not fail the action
// that triggered it, so per-recipient errors are logged and swallowed.
export async function notify(input: NotifyInput): Promise<void> {
  const {
    organizationId,
    type,
    severity,
    title,
    body,
    recipients,
    actionUrl = null,
    callId = null,
    breachId = null,
    dedupeKey = null,
    email = false,
  } = input;

  const emailEnabled = email && Boolean(config.resend.apiKey);
  const seen = new Set<string>();

  for (const r of recipients) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);

    // Per-recipient key so the partial unique index (user_id, dedupe_key)
    // dedupes one recipient without blocking another.
    const perUserKey = dedupeKey ? `${dedupeKey}:${r.userId}` : null;

    try {
      await query(
        `INSERT INTO notifications
           (organization_id, user_id, type, title, body, severity, call_id, breach_id, action_url, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, dedupe_key) WHERE read_at IS NULL AND dedupe_key IS NOT NULL
         DO NOTHING`,
        [organizationId, r.userId, type, title, body, severity, callId, breachId, actionUrl, perUserKey]
      );
    } catch (err) {
      console.error(`[notify] in-app write failed for user ${r.userId}:`, (err as Error).message);
    }

    if (emailEnabled && r.email) {
      try {
        await alertsQueue.add('notify-email', { to: r.email, title, body, severity, actionUrl });
      } catch (err) {
        console.error(`[notify] email enqueue failed for user ${r.userId}:`, (err as Error).message);
      }
    }
  }
}
