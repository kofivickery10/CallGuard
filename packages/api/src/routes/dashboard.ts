import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

// ============================================================
// Journey-aware stat rules (used across every endpoint below).
// Under the sales_only capture model, scores live on journeys (multi-call
// sales), NOT call_scores — journey calls rest at 'transcribed' and never get
// a call_scores row. Any stat computed from call_scores/status='scored' alone
// reads zero/null for such tenants. So:
//  - a "scored unit" = the latest score per call PLUS each scored journey;
//  - a journey's score is attributed to its wrap-up (closing) agent — the
//    same attribution the Zoho QA owner uses;
//  - a journey breach is attributed to the agent on its evidenced source call
//    (journey_item_scores.source_call_id), falling back to the breach's call;
//  - a call counts as "scored" if per-call scored OR part of a scored journey.
// ============================================================

// EXISTS clause: journey j's wrap-up agent matches the given param index.
function journeyWrapUpAgentClause(paramIdx: number): string {
  return `EXISTS (
    SELECT 1 FROM journey_calls jc JOIN calls wc ON wc.id = jc.call_id
    WHERE jc.journey_id = j.id AND jc.role = 'wrap_up' AND wc.agent_id = $${paramIdx}
  )`;
}

const CALL_IS_SCORED = `(c.status = 'scored'
  OR EXISTS (SELECT 1 FROM journeys j2 WHERE j2.id = c.journey_id AND j2.status = 'scored'))`;

// Summary stats (role-scoped)
dashboardRouter.get('/summary', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const agentId = req.query.agent_id as string | undefined;
    // Members see only their own stats; admins may filter by agent.
    const agentScope = req.user!.role === 'adviser' ? req.user!.userId : agentId || null;

    let callWhere = 'WHERE c.organization_id = $1';
    let journeyWhere = `WHERE j.organization_id = $1 AND j.status = 'scored'`;
    const params: unknown[] = [orgId];
    if (agentScope) {
      params.push(agentScope);
      callWhere += ` AND c.agent_id = $${params.length}`;
      journeyWhere += ` AND ${journeyWrapUpAgentClause(params.length)}`;
    }

    const stats = await queryOne<{
      total_calls: string;
      scored_calls: string;
    }>(
      `SELECT
        COUNT(*) as total_calls,
        COUNT(*) FILTER (WHERE ${CALL_IS_SCORED}) as scored_calls
       FROM calls c ${callWhere}`,
      params
    );

    // Scored units: latest call_scores row per call (DISTINCT ON — a plain
    // join counted every rescore) UNION each scored journey.
    const scoreStats = await queryOne<{
      avg_score: string | null;
      pass_count: string;
      total_scored: string;
    }>(
      `SELECT
        AVG(u.score) as avg_score,
        COUNT(*) FILTER (WHERE u.pass = true) as pass_count,
        COUNT(*) as total_scored
       FROM (
         SELECT latest.overall_score AS score, latest.pass
         FROM (
           SELECT DISTINCT ON (cs.call_id) cs.overall_score, cs.pass
           FROM call_scores cs
           JOIN calls c ON c.id = cs.call_id
           ${callWhere}
           ORDER BY cs.call_id, cs.scored_at DESC
         ) latest
         UNION ALL
         SELECT j.overall_score, j.pass FROM journeys j ${journeyWhere}
       ) u`,
      params
    );

    const salesRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) as n FROM journeys j ${journeyWhere}`,
      params
    );

    const totalScored = parseInt(scoreStats?.total_scored || '0');

    res.json({
      total_calls: parseInt(stats?.total_calls || '0'),
      scored_calls: parseInt(stats?.scored_calls || '0'),
      scored_sales: parseInt(salesRow?.n || '0'),
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

    if (req.user!.role === 'adviser') {
      params.push(req.user!.userId);
      callWhere += ` AND c.agent_id = $${params.length}`;
    } else if (agentId) {
      params.push(agentId);
      callWhere += ` AND c.agent_id = $${params.length}`;
    }

    // See routes/calls.ts for why this is a LATERAL join on the latest score
    // rather than a plain join on call_id (fan-out duplicates the call).
    const calls = await query(
      `SELECT c.*, cs.overall_score, cs.pass, u.name as resolved_agent_name
       FROM calls c
       LEFT JOIN LATERAL (
         SELECT overall_score, pass FROM call_scores
         WHERE call_id = c.id
         ORDER BY scored_at DESC
         LIMIT 1
       ) cs ON true
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
dashboardRouter.get('/trends/calls-per-day', requireOrgView, async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days as string) || 30, 180);
    const agentId = req.query.agent_id as string | undefined;
    const { where, params } = buildTrendWhere(req.user!.organizationId, agentId);

    // Truncate in Europe/London, not the DB session's UTC — otherwise a call
    // logged between 00:00-01:00 local time (BST) lands on the previous day.
    const rows = await query<{ date: string; total: string; scored: string }>(
      `SELECT
         to_char(date_trunc('day', c.created_at AT TIME ZONE 'Europe/London'), 'YYYY-MM-DD') as date,
         COUNT(*)::text as total,
         COUNT(*) FILTER (WHERE ${CALL_IS_SCORED})::text as scored
       FROM calls c
       WHERE ${where} AND c.created_at >= now() - ($${params.length + 1} || ' days')::interval
       GROUP BY 1
       ORDER BY 1`,
      [...params, days]
    );

    // Fill gaps so the chart x-axis is continuous. Keys must be London
    // calendar dates to match the query above — building them from the
    // server process's local Date methods then formatting with
    // toISOString() (always UTC) silently drifts a day out of step with the
    // query during BST.
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const filled: { date: string; total: number; scored: number }[] = [];
    const todayLondon = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    const anchor = new Date(`${todayLondon}T00:00:00Z`);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(anchor);
      d.setUTCDate(d.getUTCDate() - i);
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
dashboardRouter.get('/trends/scores-over-time', requireOrgView, async (req, res, next) => {
  try {
    const weeks = Math.min(parseInt(req.query.weeks as string) || 12, 52);
    const agentId = req.query.agent_id as string | undefined;
    const { where, params } = buildTrendWhere(req.user!.organizationId, agentId);

    // Scored units per week: per-call scores (by call date) + scored journeys
    // (by scored_at, attributed to the wrap-up agent for the agent filter).
    const journeyAgent = agentId ? ` AND ${journeyWrapUpAgentClause(2)}` : '';
    const rows = await query<{
      week_start: string;
      call_count: string;
      avg_score: string | null;
      pass_rate: string | null;
    }>(
      `SELECT
         to_char(u.wk, 'YYYY-MM-DD') as week_start,
         COUNT(*)::text as call_count,
         AVG(u.score)::text as avg_score,
         CASE WHEN COUNT(*) > 0 THEN
           (COUNT(*) FILTER (WHERE u.pass = true)::numeric / COUNT(*) * 100)::text
         ELSE NULL END as pass_rate
       FROM (
         SELECT date_trunc('week', c.created_at AT TIME ZONE 'Europe/London') as wk,
                cs.overall_score as score, cs.pass
         FROM calls c
         JOIN call_scores cs ON cs.call_id = c.id
         WHERE ${where} AND c.created_at >= now() - ($${params.length + 1} || ' weeks')::interval
         UNION ALL
         SELECT date_trunc('week', j.scored_at AT TIME ZONE 'Europe/London'),
                j.overall_score, j.pass
         FROM journeys j
         WHERE j.organization_id = $1 AND j.status = 'scored'
           AND j.scored_at >= now() - ($${params.length + 1} || ' weeks')::interval
           ${journeyAgent}
       ) u
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
dashboardRouter.get('/trends/by-scorecard', requireOrgView, async (req, res, next) => {
  try {
    const agentId = req.query.agent_id as string | undefined;
    const params: unknown[] = [req.user!.organizationId];
    let agentFilter = '';
    if (agentId) {
      params.push(agentId);
      agentFilter = ` AND c.agent_id = $${params.length}`;
    }

    // Scored units per scorecard (per-call scores + scored journeys), with
    // breaches counted whether they hang off a call or a journey. Journey
    // breaches attribute to the evidenced source call's agent for the filter.
    const journeyAgent = agentId ? ` AND ${journeyWrapUpAgentClause(2)}` : '';
    const breachAgent = agentId
      ? ` AND COALESCE(bcall.agent_id, srccall.agent_id) = $2`
      : '';
    const rows = await query<{
      id: string;
      name: string;
      call_count: string;
      avg_score: string | null;
      flags_per_call: string | null;
      critical_count: string;
    }>(
      `WITH units AS (
         SELECT cs.scorecard_id, cs.overall_score AS score
         FROM call_scores cs
         JOIN calls c ON c.id = cs.call_id
         WHERE c.organization_id = $1${agentFilter}
         UNION ALL
         SELECT j.scorecard_id, j.overall_score
         FROM journeys j
         WHERE j.organization_id = $1 AND j.status = 'scored'${journeyAgent}
       ),
       breach_counts AS (
         SELECT si.scorecard_id,
                COUNT(*)::numeric AS n,
                COUNT(*) FILTER (WHERE b.severity = 'critical') AS crit
         FROM breaches b
         JOIN scorecard_items si ON si.id = b.scorecard_item_id
         LEFT JOIN calls bcall ON bcall.id = b.call_id
         LEFT JOIN journey_item_scores jis ON jis.id = b.journey_item_score_id
         LEFT JOIN calls srccall ON srccall.id = jis.source_call_id
         WHERE b.organization_id = $1${breachAgent}
         GROUP BY si.scorecard_id
       )
       SELECT
         sc.id,
         sc.name,
         COUNT(u.score)::text as call_count,
         AVG(u.score)::text as avg_score,
         CASE WHEN COUNT(u.score) > 0 THEN
           (COALESCE(MAX(bc.n), 0) / COUNT(u.score))::text
         ELSE NULL END as flags_per_call,
         COALESCE(MAX(bc.crit), 0)::text as critical_count
       FROM scorecards sc
       JOIN units u ON u.scorecard_id = sc.id
       LEFT JOIN breach_counts bc ON bc.scorecard_id = sc.id
       WHERE sc.organization_id = $1
       GROUP BY sc.id, sc.name
       HAVING COUNT(u.score) > 0
       ORDER BY COUNT(u.score) DESC`,
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
dashboardRouter.get('/trends/breach-severity', requireOrgView, async (req, res, next) => {
  try {
    const weeks = Math.min(parseInt(req.query.weeks as string) || 12, 52);
    const agentId = req.query.agent_id as string | undefined;
    const params: unknown[] = [req.user!.organizationId];
    if (agentId) params.push(agentId);

    // LEFT JOINs: journey breaches have journey_id set and call_id NULL — an
    // inner join on calls silently dropped every one of them. Agent filter
    // attributes a journey breach to its evidenced source call's agent.
    const rows = await query<{
      week_start: string;
      critical: string;
      high: string;
      medium: string;
      low: string;
    }>(
      `SELECT
         to_char(date_trunc('week', b.detected_at AT TIME ZONE 'Europe/London'), 'YYYY-MM-DD') as week_start,
         COUNT(*) FILTER (WHERE b.severity = 'critical')::text as critical,
         COUNT(*) FILTER (WHERE b.severity = 'high')::text as high,
         COUNT(*) FILTER (WHERE b.severity = 'medium')::text as medium,
         COUNT(*) FILTER (WHERE b.severity = 'low')::text as low
       FROM breaches b
       LEFT JOIN calls c ON c.id = b.call_id
       LEFT JOIN journey_item_scores jis ON jis.id = b.journey_item_score_id
       LEFT JOIN calls srccall ON srccall.id = jis.source_call_id
       WHERE b.organization_id = $1
         AND b.detected_at >= now() - ($${params.length + 1} || ' weeks')::interval
         ${agentId ? ` AND COALESCE(c.agent_id, srccall.agent_id) = $2` : ''}
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
dashboardRouter.get('/adviser-risk', requireOrgView, async (req, res, next) => {
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
      `WITH breach_agents AS (
         -- Breach → agent attribution, covering both shapes: call breaches via
         -- the call's agent, journey breaches via the evidenced source call's
         -- agent (journey_item_scores.source_call_id). A journey breach with
         -- no source call has no agent and is excluded here, matching the
         -- previous per-call behaviour of not guessing attribution.
         SELECT b.id, b.severity, b.scorecard_item_id,
                COALESCE(c.agent_id, srccall.agent_id) as agent_id
         FROM breaches b
         LEFT JOIN calls c ON c.id = b.call_id
         LEFT JOIN journey_item_scores jis ON jis.id = b.journey_item_score_id
         LEFT JOIN calls srccall ON srccall.id = jis.source_call_id
         WHERE b.organization_id = $1
           AND b.detected_at >= now() - ($2 || ' days')::interval
       ),
       bc AS (
         SELECT
           u.id as agent_id,
           u.name as agent_name,
           u.email,
           (SELECT COUNT(*) FROM breach_agents ba WHERE ba.agent_id = u.id AND ba.severity = 'critical')::text as critical,
           (SELECT COUNT(*) FROM breach_agents ba WHERE ba.agent_id = u.id AND ba.severity = 'high')::text as high,
           (SELECT COUNT(*) FROM breach_agents ba WHERE ba.agent_id = u.id AND ba.severity = 'medium')::text as medium,
           (SELECT COUNT(*) FROM breach_agents ba WHERE ba.agent_id = u.id AND ba.severity = 'low')::text as low,
           COUNT(DISTINCT c.id)::text as total_calls,
           COUNT(DISTINCT c.id) FILTER (WHERE ${CALL_IS_SCORED})::text as scored_calls
         FROM users u
         LEFT JOIN calls c ON c.agent_id = u.id
           AND c.created_at >= now() - ($2 || ' days')::interval
         WHERE u.organization_id = $1 AND u.role = 'adviser'
         GROUP BY u.id
       ),
       agent_breach_counts AS (
         SELECT ba.agent_id, si.label, COUNT(*) as n
         FROM breach_agents ba
         JOIN scorecard_items si ON si.id = ba.scorecard_item_id
         WHERE ba.agent_id IS NOT NULL
           AND ba.severity IN ('critical','high','medium')
         GROUP BY ba.agent_id, si.label
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
dashboardRouter.get('/agent-leaderboard', authenticate, requireOrgView, async (req, res, next) => {
  try {
    // Scored units per adviser: latest per-call scores for their calls
    // (LATERAL — a plain join fans out rescored calls) UNION scored journeys
    // where they are the wrap-up (closing) agent.
    const agents = await query(
      `WITH units AS (
         SELECT c.agent_id, cs.overall_score, cs.pass
         FROM calls c
         JOIN LATERAL (
           SELECT overall_score, pass FROM call_scores
           WHERE call_id = c.id
           ORDER BY scored_at DESC
           LIMIT 1
         ) cs ON true
         WHERE c.organization_id = $1 AND c.agent_id IS NOT NULL
         UNION ALL
         SELECT wc.agent_id, j.overall_score, j.pass
         FROM journeys j
         JOIN journey_calls jc ON jc.journey_id = j.id AND jc.role = 'wrap_up'
         JOIN calls wc ON wc.id = jc.call_id
         WHERE j.organization_id = $1 AND j.status = 'scored' AND wc.agent_id IS NOT NULL
       )
       SELECT
        u.id, u.name, u.email,
        (SELECT COUNT(*) FROM calls c WHERE c.agent_id = u.id) as total_calls,
        (SELECT COUNT(*) FROM calls c WHERE c.agent_id = u.id AND ${CALL_IS_SCORED}) as scored_calls,
        AVG(un.overall_score) as average_score,
        CASE
          WHEN COUNT(un.overall_score) > 0
          THEN (COUNT(*) FILTER (WHERE un.pass = true)::numeric / COUNT(un.overall_score) * 100)
          ELSE NULL
        END as pass_rate
       FROM users u
       LEFT JOIN units un ON un.agent_id = u.id
       WHERE u.organization_id = $1 AND u.role = 'adviser'
       GROUP BY u.id
       ORDER BY AVG(un.overall_score) DESC NULLS LAST`,
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
