import type { Request } from 'express';
import { query } from '../db/client.js';

export type AuditActionType =
  | 'auth.login'
  | 'auth.logout'
  | 'call.delete'
  | 'call.upload'
  | 'call.bulk_import'
  | 'call.rescore'
  | 'call.reviewed'
  | 'call.review_cleared'
  | 'score.correct'
  | 'exemplar.toggle'
  | 'breach.status_change'
  | 'breach.assign'
  | 'breach.note_add'
  | 'scorecard.create'
  | 'scorecard.update'
  | 'scorecard.delete'
  | 'kb.upload'
  | 'kb.delete'
  | 'api_key.create'
  | 'api_key.revoke'
  | 'sftp.create'
  | 'sftp.update'
  | 'sftp.delete'
  | 'user.invite'
  | 'user.role_change'
  | 'user.delete'
  | 'plan.change'
  | 'scorecard.deactivate'
  | 'org.data_improvement_optin'
  | 'org.industry.change'
  // Superadmin (cross-tenant) actions, logged against the target org.
  | 'tenant.create'
  | 'tenant.status_change'
  | 'tenant.seat_price'
  | 'tenant.feature_override'
  | 'tenant.impersonate';

export type AuditEntityType =
  | 'call'
  | 'breach'
  | 'score'
  | 'scorecard'
  | 'kb_file'
  | 'api_key'
  | 'sftp_source'
  | 'user'
  | 'session'
  | 'organization';

interface AuditEvent {
  organizationId: string;
  userId: string | null;
  actionType: AuditActionType;
  entityType: AuditEntityType;
  entityId?: string | string[] | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
  req?: Request;
}

const coerceEntityId = (v: AuditEvent['entityId']): string | null => {
  if (v == null) return null;
  return Array.isArray(v) ? v.join(',') : String(v);
};

/**
 * Records an audit event. Best-effort: failures are logged but never thrown,
 * so audit-log breakage cannot break a user-facing request.
 */
export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  try {
    // Use the trusted client IP: Cloudflare's CF-Connecting-IP when present
    // (set at the edge, not client-spoofable), else Express's req.ip (with
    // 'trust proxy' configured). Never the raw leftmost X-Forwarded-For, which
    // the caller can forge.
    const cfIp = event.req?.headers['cf-connecting-ip'];
    const ip = (Array.isArray(cfIp) ? cfIp[0] : cfIp) || event.req?.ip || null;
    const userAgent = event.req?.headers['user-agent']?.toString().slice(0, 500) || null;

    await query(
      `INSERT INTO audit_log
         (organization_id, user_id, action_type, entity_type, entity_id,
          summary, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.organizationId,
        event.userId,
        event.actionType,
        event.entityType,
        coerceEntityId(event.entityId),
        event.summary ?? null,
        JSON.stringify(event.metadata ?? {}),
        ip,
        userAgent,
      ]
    );
  } catch (err) {
    console.error('[Audit] Failed to record event:', err);
  }
}
