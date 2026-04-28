import { Router, Request } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import {
  BREACH_SEVERITIES,
  BREACH_STATUSES,
  BREACH_SEVERITY_LABELS,
  BREACH_STATUS_LABELS,
  type BreachSeverity,
  type BreachStatus,
  type BreachWithDetail,
  type BreachEvent,
  type BreachSummary,
} from '@callguard/shared';

export const breachesRouter = Router();
breachesRouter.use(authenticate);
breachesRouter.use(requireAdmin);

interface BreachFilters {
  severity?: BreachSeverity;
  status?: BreachStatus;
  agent_id?: string;
  scorecard_id?: string;
  from?: string;
  to?: string;
  search?: string;
}

function parseFilters(req: Request): BreachFilters {
  const f: BreachFilters = {};
  const q = req.query;
  if (q.severity && BREACH_SEVERITIES.includes(q.severity as BreachSeverity))
    f.severity = q.severity as BreachSeverity;
  if (q.status && BREACH_STATUSES.includes(q.status as BreachStatus))
    f.status = q.status as BreachStatus;
  if (typeof q.agent_id === 'string') f.agent_id = q.agent_id;
  if (typeof q.scorecard_id === 'string') f.scorecard_id = q.scorecard_id;
  if (typeof q.from === 'string') f.from = q.from;
  if (typeof q.to === 'string') f.to = q.to;
  if (typeof q.search === 'string') f.search = q.search;
  return f;
}

function buildWhere(orgId: string, f: BreachFilters): { sql: string; params: unknown[] } {
  const parts = ['b.organization_id = $1'];
  const params: unknown[] = [orgId];

  if (f.severity) {
    params.push(f.severity);
    parts.push(`b.severity = $${params.length}`);
  }
  if (f.status) {
    params.push(f.status);
    parts.push(`b.status = $${params.length}`);
  }
  if (f.agent_id) {
    params.push(f.agent_id);
    parts.push(`c.agent_id = $${params.length}`);
  }
  if (f.scorecard_id) {
    params.push(f.scorecard_id);
    parts.push(`si.scorecard_id = $${params.length}`);
  }
  if (f.from) {
    params.push(f.from);
    parts.push(`b.detected_at >= $${params.length}`);
  }
  if (f.to) {
    params.push(f.to);
    parts.push(`b.detected_at <= $${params.length}`);
  }
  if (f.search) {
    params.push(`%${f.search}%`);
    parts.push(`(si.label ILIKE $${params.length} OR c.file_name ILIKE $${params.length})`);
  }

  return { sql: parts.join(' AND '), params };
}

// ============================================================
// GET /api/breaches/summary
// ============================================================

breachesRouter.get('/summary', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    const bySeverity = await query<{ severity: BreachSeverity; count: string }>(
      `SELECT severity, COUNT(*)::text as count
         FROM breaches
        WHERE organization_id = $1 AND status NOT IN ('resolved','noted')
        GROUP BY severity`,
      [orgId]
    );

    const byStatus = await query<{ status: BreachStatus; count: string }>(
      `SELECT status, COUNT(*)::text as count
         FROM breaches
        WHERE organization_id = $1
        GROUP BY status`,
      [orgId]
    );

    const resolvedRecent = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM breaches
        WHERE organization_id = $1 AND status = 'resolved'
          AND resolved_at >= now() - interval '30 days'`,
      [orgId]
    );

    const totalOpenRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM breaches
        WHERE organization_id = $1 AND status NOT IN ('resolved','noted')`,
      [orgId]
    );

    const summary: BreachSummary = {
      total_open: parseInt(totalOpenRow?.count || '0'),
      by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
      by_status: { new: 0, acknowledged: 0, coached: 0, escalated: 0, resolved: 0, noted: 0 },
      resolved_last_30_days: parseInt(resolvedRecent?.count || '0'),
    };

    for (const row of bySeverity) summary.by_severity[row.severity] = parseInt(row.count);
    for (const row of byStatus) summary.by_status[row.status] = parseInt(row.count);

    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/breaches (paginated list)
// ============================================================

breachesRouter.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    const filters = parseFilters(req);
    const { sql: whereSQL, params } = buildWhere(req.user!.organizationId, filters);

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count
         FROM breaches b
         JOIN calls c ON c.id = b.call_id
         JOIN scorecard_items si ON si.id = b.scorecard_item_id
        WHERE ${whereSQL}`,
      params
    );

    const rows = await query<BreachWithDetail>(
      `SELECT
          b.*,
          c.file_name as call_file_name,
          c.agent_name,
          c.agent_id,
          u.name as assigned_to_name,
          si.label as breach_type,
          sc.name as scorecard_name,
          cis.evidence,
          cis.reasoning,
          cis.normalized_score
        FROM breaches b
        JOIN calls c ON c.id = b.call_id
        JOIN call_item_scores cis ON cis.id = b.call_item_score_id
        JOIN scorecard_items si ON si.id = b.scorecard_item_id
        LEFT JOIN scorecards sc ON sc.id = si.scorecard_id
        LEFT JOIN users u ON u.id = b.assigned_to
        WHERE ${whereSQL}
        ORDER BY b.detected_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      data: rows,
      total: parseInt(countResult?.count || '0'),
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/breaches/export.csv
// ============================================================

breachesRouter.get('/export.csv', async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const { sql: whereSQL, params } = buildWhere(req.user!.organizationId, filters);

    const rows = await query<BreachWithDetail>(
      `SELECT
          b.*,
          c.file_name as call_file_name,
          c.agent_name,
          u.name as assigned_to_name,
          si.label as breach_type,
          sc.name as scorecard_name,
          cis.evidence,
          cis.reasoning,
          cis.normalized_score
        FROM breaches b
        JOIN calls c ON c.id = b.call_id
        JOIN call_item_scores cis ON cis.id = b.call_item_score_id
        JOIN scorecard_items si ON si.id = b.scorecard_item_id
        LEFT JOIN scorecards sc ON sc.id = si.scorecard_id
        LEFT JOIN users u ON u.id = b.assigned_to
        WHERE ${whereSQL}
        ORDER BY b.detected_at DESC
        LIMIT 10000`,
      params
    );

    const header = [
      'Detected',
      'Call ID',
      'File',
      'Agent',
      'Breach Type',
      'Scorecard',
      'Severity',
      'Status',
      'Normalized Score',
      'Assigned To',
      'Evidence',
      'Reasoning',
      'Notes',
      'Resolved At',
    ];
    const lines = [header.map(csvEscape).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.detected_at,
          r.call_id,
          r.call_file_name,
          r.agent_name || '',
          r.breach_type,
          r.scorecard_name || '',
          r.severity,
          r.status,
          String(r.normalized_score),
          r.assigned_to_name || '',
          r.evidence || '',
          r.reasoning || '',
          r.notes || '',
          r.resolved_at || '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }

    const csv = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="callguard-breaches-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/breaches/report (HTML print-ready)
// ============================================================

breachesRouter.get('/report', async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const { sql: whereSQL, params } = buildWhere(req.user!.organizationId, filters);

    const org = await queryOne<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [req.user!.organizationId]
    );

    const rows = await query<BreachWithDetail>(
      `SELECT
          b.*,
          c.file_name as call_file_name,
          c.agent_name,
          u.name as assigned_to_name,
          si.label as breach_type,
          sc.name as scorecard_name,
          cis.normalized_score
        FROM breaches b
        JOIN calls c ON c.id = b.call_id
        JOIN call_item_scores cis ON cis.id = b.call_item_score_id
        JOIN scorecard_items si ON si.id = b.scorecard_item_id
        LEFT JOIN scorecards sc ON sc.id = si.scorecard_id
        LEFT JOIN users u ON u.id = b.assigned_to
        WHERE ${whereSQL}
        ORDER BY b.severity, b.detected_at DESC
        LIMIT 5000`,
      params
    );

    // Counts for summary
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of rows) counts[r.severity] = (counts[r.severity] || 0) + 1;

    const dateRange = filters.from && filters.to
      ? `${new Date(filters.from).toLocaleDateString('en-GB')} - ${new Date(filters.to).toLocaleDateString('en-GB')}`
      : 'All time';

    const html = renderReportHtml({
      orgName: org?.name || 'Organization',
      dateRange,
      filters,
      rows,
      counts,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/breaches/:id (detail with events)
// ============================================================

breachesRouter.get('/:id', async (req, res, next) => {
  try {
    const breach = await queryOne<BreachWithDetail>(
      `SELECT
          b.*,
          c.file_name as call_file_name,
          c.agent_name,
          c.agent_id,
          u.name as assigned_to_name,
          si.label as breach_type,
          sc.name as scorecard_name,
          cis.evidence,
          cis.reasoning,
          cis.normalized_score
        FROM breaches b
        JOIN calls c ON c.id = b.call_id
        JOIN call_item_scores cis ON cis.id = b.call_item_score_id
        JOIN scorecard_items si ON si.id = b.scorecard_item_id
        LEFT JOIN scorecards sc ON sc.id = si.scorecard_id
        LEFT JOIN users u ON u.id = b.assigned_to
        WHERE b.id = $1 AND b.organization_id = $2`,
      [req.params.id, req.user!.organizationId]
    );
    if (!breach) throw new AppError(404, 'Breach not found');

    const events = await query<BreachEvent>(
      `SELECT be.*, u.name as user_name
         FROM breach_events be
         LEFT JOIN users u ON u.id = be.user_id
        WHERE be.breach_id = $1
        ORDER BY be.created_at DESC`,
      [breach.id]
    );

    res.json({ ...breach, events });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PATCH /api/breaches/:id/status
// ============================================================

breachesRouter.post('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!BREACH_STATUSES.includes(status)) {
      throw new AppError(400, `Invalid status: ${status}`);
    }

    const existing = await queryOne<{ id: string; status: BreachStatus }>(
      'SELECT id, status FROM breaches WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!existing) throw new AppError(404, 'Breach not found');
    if (existing.status === status) {
      res.json({ message: 'No change' });
      return;
    }

    const resolvedAt = status === 'resolved' ? 'now()' : status === existing.status ? 'resolved_at' : existing.status === 'resolved' ? 'NULL' : 'resolved_at';

    await query(
      `UPDATE breaches SET status = $1, resolved_at = ${resolvedAt}, updated_at = now() WHERE id = $2`,
      [status, existing.id]
    );

    await query(
      `INSERT INTO breach_events (breach_id, user_id, event_type, from_value, to_value)
       VALUES ($1, $2, 'status_changed', $3, $4)`,
      [existing.id, req.user!.userId, existing.status, status]
    );

    res.json({ message: 'Status updated' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PATCH /api/breaches/:id/assign
// ============================================================

breachesRouter.post('/:id/assign', async (req, res, next) => {
  try {
    const { assigned_to } = req.body;

    const existing = await queryOne<{ id: string; assigned_to: string | null }>(
      'SELECT id, assigned_to FROM breaches WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!existing) throw new AppError(404, 'Breach not found');

    if (assigned_to) {
      const user = await queryOne(
        'SELECT id FROM users WHERE id = $1 AND organization_id = $2',
        [assigned_to, req.user!.organizationId]
      );
      if (!user) throw new AppError(404, 'User not found in your organization');
    }

    await query(
      `UPDATE breaches SET assigned_to = $1, updated_at = now() WHERE id = $2`,
      [assigned_to || null, existing.id]
    );

    await query(
      `INSERT INTO breach_events (breach_id, user_id, event_type, from_value, to_value)
       VALUES ($1, $2, 'assigned', $3, $4)`,
      [existing.id, req.user!.userId, existing.assigned_to || null, assigned_to || null]
    );

    res.json({ message: 'Assignment updated' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /api/breaches/:id/notes
// ============================================================

breachesRouter.post('/:id/notes', async (req, res, next) => {
  try {
    const { note } = req.body;
    if (!note || typeof note !== 'string' || !note.trim()) {
      throw new AppError(400, 'note is required');
    }

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM breaches WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!existing) throw new AppError(404, 'Breach not found');

    await query(
      `INSERT INTO breach_events (breach_id, user_id, event_type, note)
       VALUES ($1, $2, 'note_added', $3)`,
      [existing.id, req.user!.userId, note.trim()]
    );

    res.json({ message: 'Note added' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Helpers
// ============================================================

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function renderReportHtml(data: {
  orgName: string;
  dateRange: string;
  filters: BreachFilters;
  rows: BreachWithDetail[];
  counts: Record<string, number>;
}): string {
  const escape = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

  const severityColor = (s: string) => ({
    critical: '#c0392b',
    high: '#c0392b',
    medium: '#b8860b',
    low: '#6a7e6a',
  }[s] || '#6a7e6a');

  const rowsHtml = data.rows
    .map(
      (r) => `
      <tr>
        <td>${new Date(r.detected_at).toLocaleDateString('en-GB')}</td>
        <td>${escape(r.call_file_name)}</td>
        <td>${escape(r.agent_name || '--')}</td>
        <td>${escape(r.breach_type)}</td>
        <td style="color:${severityColor(r.severity)};font-weight:600;text-transform:uppercase">${r.severity}</td>
        <td>${BREACH_STATUS_LABELS[r.status]}</td>
        <td>${Math.round(Number(r.normalized_score))}%</td>
        <td>${escape(r.assigned_to_name || '--')}</td>
      </tr>
    `
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CallGuard Compliance Report - ${escape(data.orgName)}</title>
<style>
  @page { size: A4; margin: 15mm 12mm; }
  body { font-family: -apple-system, 'Inter', sans-serif; color: #1a2e1a; font-size: 11px; line-height: 1.5; }
  .cover { text-align: center; padding: 40px 0; border-bottom: 3px solid #4a9e6e; margin-bottom: 30px; }
  .cover h1 { font-size: 24px; margin: 0 0 8px; color: #1a2e1a; }
  .cover .sub { font-size: 14px; color: #6a7e6a; }
  .cover .confidential { margin-top: 16px; padding: 6px 14px; background: #fef3e0; color: #b8860b; display: inline-block; border-radius: 4px; font-weight: 600; font-size: 11px; letter-spacing: 0.5px; text-transform: uppercase; }
  h2 { font-size: 16px; margin-top: 30px; margin-bottom: 12px; color: #1a2e1a; border-bottom: 1px solid #e2e8e2; padding-bottom: 6px; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { padding: 12px; background: #f8faf8; border: 1px solid #e2e8e2; border-radius: 6px; }
  .card .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #8a9e8a; }
  .card .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .card .value.critical, .card .value.high { color: #c0392b; }
  .card .value.medium { color: #b8860b; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { text-align: left; padding: 8px; background: #f8faf8; border-bottom: 1px solid #e2e8e2; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #6a7e6a; }
  td { padding: 8px; border-bottom: 1px solid #f0f5f0; }
  tr:nth-child(even) td { background: #fafcfa; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e2e8e2; font-size: 10px; color: #8a9e8a; text-align: center; }
  @media print {
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="cover">
    <h1>${escape(data.orgName)}</h1>
    <div class="sub">CallGuard Compliance Report</div>
    <div class="sub">${escape(data.dateRange)}</div>
    <div class="confidential">Confidential - FCA Supervisory Use</div>
  </div>

  <h2>Summary</h2>
  <div class="summary">
    <div class="card"><div class="label">Total Breaches</div><div class="value">${data.rows.length}</div></div>
    <div class="card"><div class="label">Critical</div><div class="value critical">${data.counts.critical || 0}</div></div>
    <div class="card"><div class="label">High</div><div class="value high">${data.counts.high || 0}</div></div>
    <div class="card"><div class="label">Medium</div><div class="value medium">${data.counts.medium || 0}</div></div>
  </div>

  <h2>Breach Register</h2>
  ${data.rows.length === 0 ? '<p style="color:#6a7e6a">No breaches match the selected filters.</p>' : `
    <table>
      <thead>
        <tr>
          <th>Date</th><th>Call</th><th>Agent</th><th>Breach Type</th>
          <th>Severity</th><th>Status</th><th>Score</th><th>Assigned To</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `}

  <div class="footer">
    Generated by CallGuard on ${new Date().toLocaleString('en-GB')}<br/>
    This report is confidential and intended solely for authorized compliance use.
  </div>

  <script class="no-print">
    // Auto-trigger print dialog on load (user can cancel)
    window.addEventListener('load', () => setTimeout(() => window.print(), 500));
  </script>
</body>
</html>`;
}
