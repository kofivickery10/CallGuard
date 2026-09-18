import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { getScoringSettings, orgHasFeature, scoresCallsIndividually } from '../services/tenant-settings.js';
import { FEEDBACK_STATUS_SQL } from '../db/feedback-status.js';
import { SALE_DATE_SQL } from './journeys.js';
import type {
  DashboardRecentResponse,
  RecentCallRow,
  RecentSaleRow,
} from '@callguard/shared';

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
// Exported so other org-wide reports (e.g. routes/board-pack.ts) attribute a
// journey to an adviser exactly this way, rather than re-deriving it.
export function journeyWrapUpAgentClause(paramIdx: number): string {
  return `EXISTS (
    SELECT 1 FROM journey_calls jc JOIN calls wc ON wc.id = jc.call_id
    WHERE jc.journey_id = j.id AND jc.role = 'wrap_up' AND wc.agent_id = $${paramIdx}
  )`;
}

// Exported for the same reason as journeyWrapUpAgentClause above — a "scored
// unit" must mean one thing everywhere it's counted.
export const CALL_IS_SCORED = `(c.status = 'scored'
  OR EXISTS (SELECT 1 FROM journeys j2 WHERE j2.id = c.journey_id AND j2.status = 'scored'))`;

/**
 * Every scored unit of one organisation, with the scorecard it was scored
 * against: the LATEST score per call (a rescore replaces its call's earlier
 * score rather than adding a second unit) plus each scored journey.
 *
 * The body of a CTE — callers wrap it (`WITH units AS (...)`) and aggregate.
 * Exported for the same reason as CALL_IS_SCORED: the Scorecards list counts
 * the same units the dashboard does, and "scoring 107 sales" has to mean on one
 * screen what it means on the other.
 *
 * `callFilter` / `journeyFilter` are extra predicates appended to each half
 * (e.g. an agent filter); `c` is the call alias and `j` the journey alias.
 */
export function scoredUnitsByScorecard(
  orgParamIdx: number,
  opts: { callFilter?: string; journeyFilter?: string } = {}
): string {
  return `SELECT latest.scorecard_id, latest.overall_score AS score, latest.pass
     FROM (
       SELECT DISTINCT ON (cs.call_id) cs.scorecard_id, cs.overall_score, cs.pass
       FROM call_scores cs
       JOIN calls c ON c.id = cs.call_id
       WHERE c.organization_id = $${orgParamIdx}${opts.callFilter ?? ''}
       ORDER BY cs.call_id, cs.scored_at DESC
     ) latest
     UNION ALL
     SELECT j.scorecard_id, j.overall_score, j.pass
     FROM journeys j
     WHERE j.organization_id = $${orgParamIdx} AND j.status = 'scored'${opts.journeyFilter ?? ''}`;
}

// Summary stats (role-scoped)
dashboardRouter.get('/summary', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const agentId = req.query.agent_id as string | undefined;
    // Members see only their own stats; admins may filter by agent. Only an
    // ADVISER is narrowed to themselves — which is exactly why the scope is
    // reported back below rather than re-derived in the client, where a
    // supervisor's org-wide figures were captioned "Your performance".
    const selfScoped = req.user!.role === 'adviser';
    const agentScope = selfScoped ? req.user!.userId : agentId || null;

    const settings = await getScoringSettings(orgId);
    const mode = scoresCallsIndividually(settings) ? 'calls' : 'sales';
    // score_only gates the VALUE, not just its display (services/
    // tenant-settings.ts), as the sale, call and review lists do: the verdict
    // must not ship in the payload to a tenant that is never shown one.
    const scoreOnly = await orgHasFeature(orgId, 'score_only');

    let callCond = 'c.organization_id = $1';
    let journeyCond = 'j.organization_id = $1';
    const params: unknown[] = [orgId];
    if (agentScope) {
      params.push(agentScope);
      callCond += ` AND c.agent_id = $${params.length}`;
      journeyCond += ` AND ${journeyWrapUpAgentClause(params.length)}`;
    }
    const callWhere = `WHERE ${callCond}`;
    const scoredJourneyWhere = `WHERE ${journeyCond} AND j.status = 'scored'`;

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
    //
    // The pass rate divides by the units that actually carry a verdict, not by
    // every scored unit. A unit whose checkpoints are still held for a person
    // has pass = NULL, and counting it in the denominator quietly reported the
    // firm as failing something it has not yet ruled on (176/235 where the
    // honest figure was 176/234).
    const scoreStats = await queryOne<{
      avg_score: string | null;
      pass_count: string;
      verdict_count: string;
      total_scored: string;
    }>(
      `SELECT
        AVG(u.score) as avg_score,
        COUNT(*) FILTER (WHERE u.pass = true) as pass_count,
        COUNT(*) FILTER (WHERE u.pass IS NOT NULL) as verdict_count,
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
         SELECT j.overall_score, j.pass FROM journeys j ${scoredJourneyWhere}
       ) u`,
      params
    );

    const salesRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) as n FROM journeys j ${scoredJourneyWhere}`,
      params
    );

    // Checkpoints the scorer would not rule on, waiting for a person. The same
    // set the review queue offers (routes/review.ts) — retired checkpoints
    // excluded — so a tile reading 130 cannot send a reviewer to a queue of 128.
    const heldRow = await queryOne<{ n: string; oldest_days: string | null }>(
      `SELECT COUNT(*) as n,
              MAX(FLOOR(EXTRACT(EPOCH FROM (now() - held.created_at)) / 86400))::text as oldest_days
         FROM (
           SELECT cis.created_at
             FROM call_item_scores cis
             JOIN call_scores cs ON cs.id = cis.call_score_id
             JOIN calls c ON c.id = cs.call_id
             JOIN scorecard_items si ON si.id = cis.scorecard_item_id
            WHERE ${callCond} AND cis.result = 'manual_review' AND si.archived_at IS NULL
           UNION ALL
           SELECT jis.created_at
             FROM journey_item_scores jis
             JOIN journeys j ON j.id = jis.journey_id
             JOIN scorecard_items si ON si.id = jis.scorecard_item_id
            WHERE ${journeyCond} AND jis.result = 'manual_review' AND si.archived_at IS NULL
         ) held`,
      params
    );

    const verdictCount = parseInt(scoreStats?.verdict_count || '0');

    res.json({
      total_calls: parseInt(stats?.total_calls || '0'),
      scored_calls: parseInt(stats?.scored_calls || '0'),
      scored_sales: parseInt(salesRow?.n || '0'),
      mode,
      scope: selfScoped ? 'own' : agentScope ? 'adviser' : 'organisation',
      scored_units: parseInt(scoreStats?.total_scored || '0'),
      units_with_verdict: scoreOnly ? null : verdictCount,
      average_score: scoreStats?.avg_score ? parseFloat(scoreStats.avg_score) : null,
      pass_rate:
        scoreOnly || verdictCount === 0
          ? null
          : (parseInt(scoreStats?.pass_count || '0') / verdictCount) * 100,
      items_to_review: parseInt(heldRow?.n || '0'),
      oldest_review_days: heldRow?.oldest_days != null ? parseInt(heldRow.oldest_days) : null,
    });
  } catch (err) {
    next(err);
  }
});

// The sale's closing adviser: earliest call flagged wrap_up, else the latest
// call in the set. The same attribution the review queue, the breach register
// and the Zoho QA write-back use, so a sale reads the same wherever it appears.
const WRAP_UP_AGENT_LATERAL = `LEFT JOIN LATERAL (
         SELECT jac.agent_name
           FROM journey_calls jajc
           JOIN calls jac ON jac.id = jajc.call_id
          WHERE jajc.journey_id = j.id
          ORDER BY (jajc.role = 'wrap_up') DESC,
                   CASE WHEN jajc.role = 'wrap_up'
                        THEN COALESCE(jac.call_date, jac.created_at) END ASC,
                   COALESCE(jac.call_date, jac.created_at) DESC
          LIMIT 1
       ) ja ON true`;

// The sale's own current checkpoints, counted live off journey_item_scores
// rather than read from the frozen score run — the sales register's rule
// (JourneyListItem.items_to_review), so the two screens agree. Retired
// checkpoints are excluded, as the review queue excludes them.
function journeyItemCountSql(result: 'manual_review' | 'fail', alias: string): string {
  return `(SELECT COUNT(*)::int
             FROM journey_item_scores ${alias}is
             JOIN scorecard_items ${alias}si ON ${alias}si.id = ${alias}is.scorecard_item_id
            WHERE ${alias}is.journey_id = j.id AND ${alias}is.result = '${result}'
              AND ${alias}si.archived_at IS NULL)`;
}

// Recent activity (role-scoped): the last few SALES at a firm that scores
// sales, the last few calls at one that scores calls.
//
// Every column is named. This used to be `SELECT c.*`, which shipped
// transcript_raw (2.7 MB on one measured call), transcript_text, the customer's
// phone number and the storage pointer to render six columns — the bug #226
// fixed for the calls list and never applied here.
dashboardRouter.get('/recent', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const agentId = req.query.agent_id as string | undefined;
    const orgId = req.user!.organizationId;
    const scoreOnly = await orgHasFeature(orgId, 'score_only');
    const settings = await getScoringSettings(orgId);
    const mode: DashboardRecentResponse['mode'] = scoresCallsIndividually(settings)
      ? 'calls'
      : 'sales';

    const params: unknown[] = [orgId];
    const scopeTo = req.user!.role === 'adviser' ? req.user!.userId : agentId || null;
    if (scopeTo) params.push(scopeTo);
    const agentParam = params.length;

    if (mode === 'sales') {
      const journeyWhere =
        `WHERE j.organization_id = $1` +
        (scopeTo ? ` AND ${journeyWrapUpAgentClause(agentParam)}` : '');

      const rows = await query<RecentSaleRow>(
        `SELECT j.id,
                cust.name as customer_name,
                ja.agent_name,
                ${SALE_DATE_SQL} as sale_date,
                j.status,
                j.overall_score::float as overall_score,
                j.pass,
                ${FEEDBACK_STATUS_SQL} as feedback_status,
                ${journeyItemCountSql('manual_review', 'r')} as items_to_review,
                ${journeyItemCountSql('fail', 'f')} as items_failed
           FROM journeys j
           LEFT JOIN customers cust ON cust.id = j.customer_id
           ${WRAP_UP_AGENT_LATERAL}
           ${journeyWhere}
          ORDER BY sale_date DESC NULLS LAST, j.id DESC
          LIMIT $${params.length + 1}`,
        [...params, limit]
      );

      const data = rows.map((r) => (scoreOnly ? { ...r, pass: null } : r));
      res.json({ mode, data } satisfies DashboardRecentResponse);
      return;
    }

    const callWhere =
      `WHERE c.organization_id = $1` + (scopeTo ? ` AND c.agent_id = $${agentParam}` : '');

    // See routes/calls.ts for why this is a LATERAL join on the latest score
    // rather than a plain join on call_id (fan-out duplicates the call).
    const rows = await query<RecentCallRow>(
      `SELECT c.id,
              c.file_name,
              cust.name as customer_name,
              COALESCE(u.name, c.agent_name) as agent_name,
              COALESCE(c.call_date, c.created_at) as called_at,
              c.duration_seconds::float as duration_seconds,
              c.status,
              cs.overall_score::float as overall_score,
              cs.pass
         FROM calls c
         LEFT JOIN LATERAL (
           SELECT overall_score, pass FROM call_scores
           WHERE call_id = c.id
           ORDER BY scored_at DESC
           LIMIT 1
         ) cs ON true
         LEFT JOIN users u ON u.id = c.agent_id
         LEFT JOIN customers cust ON cust.id = c.customer_id
         ${callWhere}
        ORDER BY called_at DESC, c.id DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    const data = rows.map((r) => (scoreOnly ? { ...r, pass: null } : r));
    res.json({ mode, data } satisfies DashboardRecentResponse);
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
    const anchor = new Date(`${todayInLondon()}T00:00:00Z`);
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

// The Monday (London) of the week a given London calendar date falls in, as
// 'YYYY-MM-DD'. Matches Postgres's date_trunc('week', …), which also starts on
// Monday, so the weeks built here line up with the weeks the query groups by.
function londonWeekStart(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  // getUTCDay: 0 = Sunday. Monday-based offset.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function todayInLondon(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

// Avg score + pass rate per week for last N weeks
dashboardRouter.get('/trends/scores-over-time', requireOrgView, async (req, res, next) => {
  try {
    const weeks = Math.min(parseInt(req.query.weeks as string) || 12, 52);
    const agentId = req.query.agent_id as string | undefined;
    const { where, params } = buildTrendWhere(req.user!.organizationId, agentId);
    const scoreOnly = await orgHasFeature(req.user!.organizationId, 'score_only');

    // Every week in the window, oldest first — computed here rather than taken
    // from what the query happened to return, so a chart captioned "last 12
    // weeks" is twelve weeks wide even when only seven of them hold a score.
    const weekStarts: string[] = [];
    const thisWeek = londonWeekStart(todayInLondon());
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(`${thisWeek}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - i * 7);
      weekStarts.push(d.toISOString().slice(0, 10));
    }
    const from = weekStarts[0];

    // Scored units per week, both halves dated by WHEN THE CONVERSATION
    // HAPPENED — a call by its own date, a sale by the date of its last call
    // (SALE_DATE_SQL). They used to be dated differently (call date vs
    // scored_at), so the same conversation landed in a different week depending
    // on the firm's scoring mode, and re-scoring a June sale moved it to the
    // week the re-score ran.
    //
    // DISTINCT ON keeps the LATEST score per call. A plain join counted a
    // re-scored call twice, once at each score it has ever had — /summary and
    // the leaderboard both guard against that and this series did not.
    const journeyAgent = agentId ? ` AND ${journeyWrapUpAgentClause(2)}` : '';
    const fromParam = params.length + 1;
    const rows = await query<{
      week_start: string;
      unit_count: string;
      avg_score: string | null;
      pass_count: string;
      verdict_count: string;
    }>(
      `SELECT
         to_char(u.wk, 'YYYY-MM-DD') as week_start,
         COUNT(*)::text as unit_count,
         AVG(u.score)::text as avg_score,
         COUNT(*) FILTER (WHERE u.pass = true)::text as pass_count,
         COUNT(*) FILTER (WHERE u.pass IS NOT NULL)::text as verdict_count
       FROM (
         SELECT date_trunc('week', COALESCE(c.call_date, c.created_at) AT TIME ZONE 'Europe/London') as wk,
                latest.overall_score as score, latest.pass
         FROM (
           SELECT DISTINCT ON (cs.call_id) cs.call_id, cs.overall_score, cs.pass
           FROM call_scores cs
           JOIN calls c ON c.id = cs.call_id
           WHERE ${where}
           ORDER BY cs.call_id, cs.scored_at DESC
         ) latest
         JOIN calls c ON c.id = latest.call_id
         WHERE COALESCE(c.call_date, c.created_at) >= ($${fromParam}::date AT TIME ZONE 'Europe/London')
         UNION ALL
         SELECT date_trunc('week', ${SALE_DATE_SQL} AT TIME ZONE 'Europe/London'),
                j.overall_score, j.pass
         FROM journeys j
         WHERE j.organization_id = $1 AND j.status = 'scored'
           AND ${SALE_DATE_SQL} >= ($${fromParam}::date AT TIME ZONE 'Europe/London')
           ${journeyAgent}
       ) u
       GROUP BY 1
       ORDER BY 1`,
      [...params, from]
    );

    const byWeek = new Map(rows.map((r) => [r.week_start, r]));
    res.json({
      data: weekStarts.map((week_start) => {
        const r = byWeek.get(week_start);
        const verdicts = r ? parseInt(r.verdict_count) : 0;
        return {
          week_start,
          unit_count: r ? parseInt(r.unit_count) : 0,
          avg_score: r?.avg_score ? parseFloat(r.avg_score) : null,
          pass_rate:
            scoreOnly || !r || verdicts === 0
              ? null
              : (parseInt(r.pass_count) / verdicts) * 100,
        };
      }),
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
    // COUNT(*), not COUNT(u.score): a unit is a scored sale or a scored call
    // whether or not it ended up with an overall score. Counting the score
    // dropped the one sale sitting at status='scored' with overall_score NULL —
    // it simply vanished from the table rather than being shown as scored with
    // no number.
    //
    // Critical breaches are counted twice, on purpose. 'critical_open' is the
    // KPI tile's definition (not resolved, not noted); 'critical_total' is
    // every one ever raised — the figure this column used to show unqualified,
    // beside a tile reading a different number under the same word.
    const rows = await query<{
      id: string;
      name: string;
      unit_count: string;
      avg_score: string | null;
      flags_per_unit: string | null;
      critical_open: string;
      critical_total: string;
    }>(
      `WITH units AS (
         ${scoredUnitsByScorecard(1, { callFilter: agentFilter, journeyFilter: journeyAgent })}
       ),
       breach_counts AS (
         SELECT si.scorecard_id,
                COUNT(*)::numeric AS n,
                COUNT(*) FILTER (WHERE b.severity = 'critical') AS crit_total,
                COUNT(*) FILTER (
                  WHERE b.severity = 'critical' AND b.status NOT IN ('resolved', 'noted')
                ) AS crit_open
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
         COUNT(*)::text as unit_count,
         AVG(u.score)::text as avg_score,
         CASE WHEN COUNT(*) > 0 THEN
           (COALESCE(MAX(bc.n), 0) / COUNT(*))::text
         ELSE NULL END as flags_per_unit,
         COALESCE(MAX(bc.crit_open), 0)::text as critical_open,
         COALESCE(MAX(bc.crit_total), 0)::text as critical_total
       FROM scorecards sc
       JOIN units u ON u.scorecard_id = sc.id
       LEFT JOIN breach_counts bc ON bc.scorecard_id = sc.id
       WHERE sc.organization_id = $1
       GROUP BY sc.id, sc.name
       ORDER BY COUNT(*) DESC`,
      params
    );

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        unit_count: parseInt(r.unit_count),
        avg_score: r.avg_score ? parseFloat(r.avg_score) : null,
        flags_per_unit: r.flags_per_unit ? parseFloat(r.flags_per_unit) : null,
        critical_open: parseInt(r.critical_open) || 0,
        critical_total: parseInt(r.critical_total) || 0,
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

// Exported so routes/board-pack.ts's "advisers needing attention" section
// reuses this exact classification rather than duplicating it.
export function classifyRisk(critical: number, high: number, medium: number, low: number): 'high_risk' | 'elevated' | 'monitor' | 'low_risk' | 'compliant' {
  if (critical + high + medium + low === 0) return 'compliant';
  if (critical >= 2 || high >= 4) return 'high_risk';
  if (critical >= 1 || high >= 2) return 'elevated';
  if (high >= 1 || medium >= 2) return 'monitor';
  return 'low_risk';
}

export function recommendAction(
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

// Scored units and who is credited with each: the latest per-call score for
// every call (LATERAL — a plain join fans out rescored calls) plus each scored
// sale, credited to its wrap-up (closing) agent.
//
// Units with NO adviser are kept rather than filtered out, so the table can say
// how many it is not showing. Ten of this tenant's scored sales close on a call
// carrying no adviser; dropping them made the leaderboard's rows sum to 593
// against a tile reading 629, with nothing on screen to explain the gap.
const LEADERBOARD_UNITS_SQL = `SELECT c.agent_id, cs.overall_score, cs.pass
         FROM calls c
         JOIN LATERAL (
           SELECT overall_score, pass FROM call_scores
           WHERE call_id = c.id
           ORDER BY scored_at DESC
           LIMIT 1
         ) cs ON true
         WHERE c.organization_id = $1
         UNION ALL
         SELECT wc.agent_id, j.overall_score, j.pass
         FROM journeys j
         JOIN journey_calls jc ON jc.journey_id = j.id AND jc.role = 'wrap_up'
         JOIN calls wc ON wc.id = jc.call_id
         WHERE j.organization_id = $1 AND j.status = 'scored'`;

// Adviser leaderboard (org-wide readers)
dashboardRouter.get('/agent-leaderboard', authenticate, requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const scoreOnly = await orgHasFeature(orgId, 'score_only');
    const settings = await getScoringSettings(orgId);
    const mode = scoresCallsIndividually(settings) ? 'calls' : 'sales';

    // scored_units counts the UNITS behind the average beside it, not the
    // adviser's calls. The two used to be different populations — a count of
    // calls in one column and an average over sales in the next.
    const agents = await query(
      `WITH units AS (
         ${LEADERBOARD_UNITS_SQL}
       )
       SELECT
        u.id, u.name,
        COUNT(un.agent_id)::text as scored_units,
        AVG(un.overall_score) as average_score,
        CASE
          WHEN COUNT(un.pass) > 0
          THEN (COUNT(un.agent_id) FILTER (WHERE un.pass = true)::numeric / COUNT(un.pass) * 100)
          ELSE NULL
        END as pass_rate
       FROM users u
       LEFT JOIN units un ON un.agent_id = u.id
       WHERE u.organization_id = $1
         AND (u.role = 'adviser' OR EXISTS (SELECT 1 FROM units x WHERE x.agent_id = u.id))
       GROUP BY u.id
       ORDER BY AVG(un.overall_score) DESC NULLS LAST, u.name`,
      [orgId]
    );

    const unattributed = await queryOne<{ n: string }>(
      `WITH units AS (
         ${LEADERBOARD_UNITS_SQL}
       )
       SELECT COUNT(*)::text as n FROM units WHERE agent_id IS NULL`,
      [orgId]
    );

    res.json({
      mode,
      unattributed_units: parseInt(unattributed?.n || '0'),
      data: agents.map((a: Record<string, unknown>) => ({
        id: a.id as string,
        name: a.name as string,
        scored_units: parseInt(a.scored_units as string) || 0,
        average_score: a.average_score ? parseFloat(a.average_score as string) : null,
        // score_only gates the VALUE: a per-adviser pass rate is a verdict, and
        // it used to ship in this payload to a tenant that is never shown one.
        pass_rate: scoreOnly || !a.pass_rate ? null : parseFloat(a.pass_rate as string),
      })),
    });
  } catch (err) {
    next(err);
  }
});
