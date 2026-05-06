import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';

export const auditRouter = Router();
auditRouter.use(authenticate);
auditRouter.use(requireAdmin);

interface AuditRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  summary: string | null;
  metadata: unknown;
  ip_address: string | null;
  created_at: string;
}

auditRouter.get('/', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const actionType = req.query.action_type as string | undefined;
    const userId = req.query.user_id as string | undefined;
    const since = req.query.since as string | undefined;

    const params: unknown[] = [orgId];
    let where = 'a.organization_id = $1';

    if (actionType) {
      params.push(actionType);
      where += ` AND a.action_type = $${params.length}`;
    }
    if (userId) {
      params.push(userId);
      where += ` AND a.user_id = $${params.length}`;
    }
    if (since) {
      params.push(since);
      where += ` AND a.created_at >= $${params.length}`;
    }

    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log a WHERE ${where}`,
      params
    );
    const total = parseInt(countRow?.count || '0', 10);

    const rows = await query<AuditRow>(
      `SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email,
              a.action_type, a.entity_type, a.entity_id, a.summary,
              a.metadata, a.ip_address, a.created_at
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

auditRouter.get('/export.csv', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const since = req.query.since as string | undefined;

    const params: unknown[] = [orgId];
    let where = 'a.organization_id = $1';
    if (since) {
      params.push(since);
      where += ` AND a.created_at >= $${params.length}`;
    }

    const rows = await query<AuditRow>(
      `SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email,
              a.action_type, a.entity_type, a.entity_id, a.summary,
              a.metadata, a.ip_address, a.created_at
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT 10000`,
      params
    );

    const csvEscape = (v: unknown) => {
      if (v == null) return '';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const header = ['timestamp', 'user_email', 'action', 'entity_type', 'entity_id', 'summary', 'ip', 'metadata'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.created_at,
        r.user_email || '',
        r.action_type,
        r.entity_type,
        r.entity_id || '',
        r.summary || '',
        r.ip_address || '',
        r.metadata,
      ].map(csvEscape).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});
