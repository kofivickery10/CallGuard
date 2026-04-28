import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

// Summary stats (role-scoped)
dashboardRouter.get('/summary', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const agentId = req.query.agent_id as string | undefined;

    let callWhere = 'WHERE c.organization_id = $1';
    const params: unknown[] = [orgId];

    // Members see only their own stats
    if (req.user!.role === 'member') {
      params.push(req.user!.userId);
      callWhere += ` AND c.agent_id = $${params.length}`;
    } else if (agentId) {
      params.push(agentId);
      callWhere += ` AND c.agent_id = $${params.length}`;
    }

    const stats = await queryOne<{
      total_calls: string;
      scored_calls: string;
    }>(
      `SELECT
        COUNT(*) as total_calls,
        COUNT(*) FILTER (WHERE c.status = 'scored') as scored_calls
       FROM calls c ${callWhere}`,
      params
    );

    const scoreStats = await queryOne<{
      avg_score: string | null;
      pass_count: string;
      total_scored: string;
    }>(
      `SELECT
        AVG(cs.overall_score) as avg_score,
        COUNT(*) FILTER (WHERE cs.pass = true) as pass_count,
        COUNT(*) as total_scored
       FROM call_scores cs
       JOIN calls c ON c.id = cs.call_id
       ${callWhere}`,
      params
    );

    const totalScored = parseInt(scoreStats?.total_scored || '0');

    res.json({
      total_calls: parseInt(stats?.total_calls || '0'),
      scored_calls: parseInt(stats?.scored_calls || '0'),
      average_score: scoreStats?.avg_score ? parseFloat(scoreStats.avg_score) : null,
      pass_rate: totalScored > 0
        ? (parseInt(scoreStats?.pass_count || '0') / totalScored) * 100
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// Recent scored calls (role-scoped)
dashboardRouter.get('/recent', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const agentId = req.query.agent_id as string | undefined;

    let callWhere = 'WHERE c.organization_id = $1';
    const params: unknown[] = [req.user!.organizationId];

    if (req.user!.role === 'member') {
      params.push(req.user!.userId);
      callWhere += ` AND c.agent_id = $${params.length}`;
    } else if (agentId) {
      params.push(agentId);
      callWhere += ` AND c.agent_id = $${params.length}`;
    }

    const calls = await query(
      `SELECT c.*, cs.overall_score, cs.pass, u.name as resolved_agent_name
       FROM calls c
       LEFT JOIN call_scores cs ON cs.call_id = c.id
       LEFT JOIN users u ON u.id = c.agent_id
       ${callWhere}
       ORDER BY c.created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    res.json({ data: calls });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Trend endpoints (admin only)
// ============================================================

function buildTrendWhere(orgId: string, agentId?: string): { where: string; params: unknown[] } {
  const params: unknown[] = [orgId];
  let where = 'c.organization_id = $1';
  if (agentId) {
    params.push(agentId);
    where += ` AND c.agent_id = $${params.length}`;
  }
  return { where, params };
}

// Calls per day for last N days - fills gaps with zeros
dashboardRouter.get('/trends/calls-per-day', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days as string) || 30, 180);
    const agentId = req.query.agent_id as string | undefined;
    const { where, params } = buildTrendWhere(req.user!.organizationId, agentId);

    const rows = await query<{ date: string; total: string; scored: string }>(
      `SELECT
         to_char(date_trunc('day', c.created_at), 'YYYY-MM-DD') as date,
         COUNT(*)::text as total,
         COUNT(*) FILTER (WHERE c.status = 'scored')::text as scored
       FROM calls c
       WHERE ${where} AND c.created_at >= now() - ($${params.length + 1} || ' days')::interval
       GROUP BY 1
       ORDER BY 1`,
      [...params, days]
    );

    // Fill gaps so the chart x-axis is continuous
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const filled: { date: string; total: number; scored: number }[] = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const row = byDate.get(key);
      filled.push({
        date: key,
        total: row ? parseInt(row.total) : 0,
        scored: row ? parseInt(row.scored) : 0,
      });
    }
    res.json({ data: filled });
  } catch (err) {
    next(err);
  }
});

// Avg score + pass rate per week for last N weeks
dashboardRouter.get('/trends/scores-over-time', requireAdmin, async (req, res, next) => {
  try {
    const weeks = Math.min(parseInt(req.query.weeks as string) || 12, 52);
    const agentId = req.query.agent_id as string | undefined;
    const { where, params } = buildTrendWhere(req.user!.organizationId, agentId);

    const rows = await query<{
      week_start: string;
      call_count: string;
      avg_score: string | null;
      pass_rate: string | null;
    }>(
      `SELECT
         to_char(date_trunc('week', c.created_at), 'YYYY-MM-DD') as week_start,
         COUNT(*)::text as call_count,
         AVG(cs.overall_score)::text as avg_score,
         CASE WHEN COUNT(*) > 0 THEN
           (COUNT(*) FILTER (WHERE cs.pass = true)::numeric / COUNT(*) * 100)::text
         ELSE NULL END as pass_rate
       FROM calls c
       JOIN call_scores cs ON cs.call_id = c.id
       WHERE ${where} AND c.created_at >= now() - ($${params.length + 1} || ' weeks')::interval
       GROUP BY 1
       ORDER BY 1`,
      [...params, weeks]
    );

    res.json({
      data: rows.map((r) => ({
        week_start: r.week_start,
        call_count: parseInt(r.call_count),
        avg_score: r.avg_score ? parseFloat(r.avg_score) : null,
        pass_rate: r.pass_rate ? parseFloat(r.pass_rate) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Per-scorecard breakdown with flags and critical counts
dashboardRouter.get('/trends/by-scorecard', requireAdmin, async (req, res, next) => {
  try {
    const agentId = req.query.agent_id as string | undefined;
    const params: unknown[] = [req.user!.organizationId];
    let agentFilter = '';
    if (agentId) {
      params.push(agentId);
      agentFilter = ` AND c.agent_id = $${params.length}`;
    }

    const rows = await query<{
      id: string;
      name: string;
      call_count: string;
      avg_score: string | null;
      flags_per_call: string | null;
      critical_count: string;
    }>(
      `SELECT
         sc.id,
         sc.name,
         COUNT(DISTINCT c.id)::text as call_count,
         AVG(cs.overall_score)::text as avg_score,
         CASE WHEN COUNT(DISTINCT c.id) > 0 THEN
           (COUNT(b.id)::numeric / COUNT(DISTINCT c.id))::text
         ELSE NULL END as flags_per_call,
         COUNT(b.id) FILTER (WHERE b.severity = 'critical')::text as critical_count
       FROM scorecards sc
       LEFT JOIN call_scores cs ON cs.scorecard_id = sc.id
       LEFT JOIN calls c ON c.id = cs.call_id ${agentFilter}
       LEFT JOIN breaches b ON b.call_id = c.id AND b.scorecard_item_id IN (
         SELECT id FROM scorecard_items WHERE scorecard_id = sc.id
       )
       WHERE sc.organization_id = $1
       GROUP BY sc.id, sc.name
       HAVING COUNT(DISTINCT c.id) > 0
       ORDER BY COUNT(DISTINCT c.id) DESC`,
      params
    );

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        call_count: parseInt(r.call_count),
        avg_score: r.avg_score ? parseFloat(r.avg_score) : null,
        flags_per_call: r.flags_per_call ? parseFloat(r.flags_per_call) : null,
        critical_count: parseInt(r.critical_count) || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Breach severity trend (weekly stacked counts)
dashboardRouter.get('/trends/breach-severity', requireAdmin, async (req, res, next) => {
  try {
    const weeks = Math.min(parseInt(req.query.weeks as string) || 12, 52);
    const agentId = req.query.agent_id as string | undefined;
    const params: unknown[] = [req.user!.organizationId];
    let agentFilter = '';
    if (agentId) {
      params.push(agentId);
      agentFilter = ` AND c.agent_id = $${params.length}`;
    }

    const rows = await query<{
      week_start: string;
      critical: string;
      high: string;
      medium: string;
      low: string;
    }>(
      `SELECT
         to_char(date_trunc('week', b.detected_at), 'YYYY-MM-DD') as week_start,
         COUNT(*) FILTER (WHERE b.severity = 'critical')::text as critical,
         COUNT(*) FILTER (WHERE b.severity = 'high')::text as high,
         COUNT(*) FILTER (WHERE b.severity = 'medium')::text as medium,
         COUNT(*) FILTER (WHERE b.severity = 'low')::text as low
       FROM breaches b
       JOIN calls c ON c.id = b.call_id
       WHERE b.organization_id = $1
         AND b.detected_at >= now() - ($${params.length + 1} || ' weeks')::interval
         ${agentFilter}
       GROUP BY 1
       ORDER BY 1`,
      [...params, weeks]
    );

    res.json({
      data: rows.map((r) => ({
        week_start: r.week_start,
        critical: parseInt(r.critical),
        high: parseInt(r.high),
        medium: parseInt(r.medium),
        low: parseInt(r.low),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Adviser risk profile (admin only)
dashboardRouter.get('/adviser-risk', requireAdmin, async (req, res, next) => {
  try {
    const rawDays = parseInt(req.query.days as string);
    const daysParam = Number.isFinite(rawDays) ? rawDays : 30;
    const orgId = req.user!.organizationId;

    // Use a very large window for "all time"
    const days = daysParam <= 0 ? 36500 : Math.min(daysParam, 36500);

    const rows = await query<{
      agent_id: string;
      agent_name: string;
      email: string;
      critical: string;
      high: string;
      medium: string;
      low: string;
      total_calls: string;
      scored_calls: string;
      top_breach_label: string | null;
    }>(
      `WITH bc AS (
         SELECT
           u.id as agent_id,
           u.name as agent_name,
           u.email,
           COUNT(b.id) FILTER (WHERE b.severity = 'critical')::text as critical,
           COUNT(b.id) FILTER (WHERE b.severity = 'high')::text as high,
           COUNT(b.id) FILTER (WHERE b.severity = 'medium')::text as medium,
           COUNT(b.id) FILTER (WHERE b.severity = 'low')::text as low,
           COUNT(DISTINCT c.id)::text as total_calls,
           COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'scored')::text as scored_calls
         FROM users u
         LEFT JOIN calls c ON c.agent_id = u.id
           AND c.created_at >= now() - ($2 || ' days')::interval
         LEFT JOIN breaches b ON b.call_id = c.id
           AND b.detected_at >= now() - ($2 || ' days')::interval
         WHERE u.organization_id = $1 AND u.role = 'member'
         GROUP BY u.id
       ),
       agent_breach_counts AS (
         SELECT c.agent_id, si.label, COUNT(*) as n
         FROM breaches b
         JOIN calls c ON c.id = b.call_id
         JOIN scorecard_items si ON si.id = b.scorecard_item_id
         WHERE c.organization_id = $1
           AND c.agent_id IS NOT NULL
           AND b.detected_at >= now() - ($2 || ' days')::interval
           AND b.severity IN ('critical','high','medium')
         GROUP BY c.agent_id, si.label
       ),
       top_breaches AS (
         SELECT DISTINCT ON (agent_id) agent_id, label as top_breach_label
         FROM agent_breach_counts
         ORDER BY agent_id, n DESC
       )
       SELECT
         bc.*,
         tb.top_breach_label
       FROM bc
       LEFT JOIN top_breaches tb ON tb.agent_id = bc.agent_id
       ORDER BY
         (bc.critical::int * 10 + bc.high::int * 3 + bc.medium::int) DESC,
         bc.agent_name`,
      [orgId, days]
    );

    const data = rows.map((r) => {
      const critical = parseInt(r.critical);
      const high = parseInt(r.high);
      const medium = parseInt(r.medium);
      const low = parseInt(r.low);
      const risk_level = classifyRisk(critical, high, medium, low);
      const recommended_action = recommendAction(risk_level, r.top_breach_label);
      return {
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        email: r.email,
        critical,
        high,
        medium,
        low,
        total_calls: parseInt(r.total_calls),
        scored_calls: parseInt(r.scored_calls),
        top_breach_label: r.top_breach_label,
        risk_level,
        recommended_action,
      };
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

function classifyRisk(critical: number, high: number, medium: number, low: number): 'high_risk' | 'elevated' | 'monitor' | 'low_risk' | 'compliant' {
  if (critical + high + medium + low === 0) return 'compliant';
  if (critical >= 2 || high >= 4) return 'high_risk';
  if (critical >= 1 || high >= 2) return 'elevated';
  if (high >= 1 || medium >= 2) return 'monitor';
  return 'low_risk';
}

function recommendAction(
  risk: 'high_risk' | 'elevated' | 'monitor' | 'low_risk' | 'compliant',
  topBreachLabel: string | null
): string {
  switch (risk) {
    case 'high_risk':
      return 'Immediate supervision & file review';
    case 'elevated':
      return topBreachLabel ? `Coaching: ${topBreachLabel}` : 'Coaching session required';
    case 'monitor':
      return topBreachLabel ? `Refresher: ${topBreachLabel}` : 'Monitor closely';
    case 'low_risk':
      return 'Routine monitoring';
    case 'compliant':
      return 'No action required';
  }
}

// Agent leaderboard (admin only)
dashboardRouter.get('/agent-leaderboard', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const agents = await query(
      `SELECT
        u.id, u.name, u.email,
        COUNT(c.id) as total_calls,
        COUNT(c.id) FILTER (WHERE c.status = 'scored') as scored_calls,
        AVG(cs.overall_score) as average_score,
        CASE
          WHEN COUNT(cs.id) > 0
          THEN (COUNT(cs.id) FILTER (WHERE cs.pass = true)::numeric / COUNT(cs.id) * 100)
          ELSE NULL
        END as pass_rate
       FROM users u
       LEFT JOIN calls c ON c.agent_id = u.id
       LEFT JOIN call_scores cs ON cs.call_id = c.id
       WHERE u.organization_id = $1 AND u.role = 'member'
       GROUP BY u.id
       ORDER BY AVG(cs.overall_score) DESC NULLS LAST`,
      [req.user!.organizationId]
    );

    res.json({
      data: agents.map((a: Record<string, unknown>) => ({
        ...a,
        total_calls: parseInt(a.total_calls as string) || 0,
        scored_calls: parseInt(a.scored_calls as string) || 0,
        average_score: a.average_score ? parseFloat(a.average_score as string) : null,
        pass_rate: a.pass_rate ? parseFloat(a.pass_rate as string) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});
