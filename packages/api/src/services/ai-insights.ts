import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import type { InsightRecommendation, InsightDigest } from '@callguard/shared';

interface InsightsMetrics {
  period_days: number;
  total_calls: number;
  scored_calls: number;
  avg_score_current: number | null;
  avg_score_prior: number | null;
  pass_rate_current: number | null;
  pass_rate_prior: number | null;
  top_breaches: Array<{ label: string; count: number }>;
  adviser_risk: { high_risk: number; elevated: number; monitor: number; low_risk: number; compliant: number };
  corrections_count: number;
  exemplars_count: number;
}

async function gatherMetrics(organizationId: string, periodDays: number): Promise<InsightsMetrics> {
  // Current-period + prior-period score + pass rate
  const [currentScores, priorScores] = await Promise.all([
    queryOne<{ avg_score: string | null; pass_count: string; total: string }>(
      `SELECT AVG(cs.overall_score)::text as avg_score,
              COUNT(*) FILTER (WHERE cs.pass = true)::text as pass_count,
              COUNT(*)::text as total
         FROM call_scores cs
         JOIN calls c ON c.id = cs.call_id
        WHERE c.organization_id = $1
          AND c.created_at >= now() - ($2 || ' days')::interval`,
      [organizationId, periodDays]
    ),
    queryOne<{ avg_score: string | null; pass_count: string; total: string }>(
      `SELECT AVG(cs.overall_score)::text as avg_score,
              COUNT(*) FILTER (WHERE cs.pass = true)::text as pass_count,
              COUNT(*)::text as total
         FROM call_scores cs
         JOIN calls c ON c.id = cs.call_id
        WHERE c.organization_id = $1
          AND c.created_at >= now() - ($2 || ' days')::interval
          AND c.created_at < now() - ($3 || ' days')::interval`,
      [organizationId, periodDays * 2, periodDays]
    ),
  ]);

  const totalCallsRow = await queryOne<{ total: string; scored: string }>(
    `SELECT COUNT(*)::text as total,
            COUNT(*) FILTER (WHERE status = 'scored')::text as scored
       FROM calls
      WHERE organization_id = $1
        AND created_at >= now() - ($2 || ' days')::interval`,
    [organizationId, periodDays]
  );

  const topBreaches = await query<{ label: string; count: string }>(
    `SELECT si.label, COUNT(*)::text as count
       FROM breaches b
       JOIN scorecard_items si ON si.id = b.scorecard_item_id
      WHERE b.organization_id = $1
        AND b.detected_at >= now() - ($2 || ' days')::interval
      GROUP BY si.id, si.label
      ORDER BY COUNT(*) DESC
      LIMIT 5`,
    [organizationId, periodDays]
  );

  // Adviser risk distribution
  const advisers = await query<{ critical: string; high: string; medium: string }>(
    `SELECT
       COUNT(b.id) FILTER (WHERE b.severity = 'critical')::text as critical,
       COUNT(b.id) FILTER (WHERE b.severity = 'high')::text as high,
       COUNT(b.id) FILTER (WHERE b.severity = 'medium')::text as medium
     FROM users u
     LEFT JOIN calls c ON c.agent_id = u.id
       AND c.created_at >= now() - ($2 || ' days')::interval
     LEFT JOIN breaches b ON b.call_id = c.id
       AND b.detected_at >= now() - ($2 || ' days')::interval
     WHERE u.organization_id = $1 AND u.role = 'member'
     GROUP BY u.id`,
    [organizationId, periodDays]
  );

  const risk = { high_risk: 0, elevated: 0, monitor: 0, low_risk: 0, compliant: 0 };
  for (const a of advisers) {
    const c = parseInt(a.critical) || 0;
    const h = parseInt(a.high) || 0;
    const m = parseInt(a.medium) || 0;
    const sum = c + h + m;
    if (sum === 0) risk.compliant++;
    else if (c >= 2 || h >= 4) risk.high_risk++;
    else if (c >= 1 || h >= 2) risk.elevated++;
    else if (h >= 1 || m >= 2) risk.monitor++;
    else risk.low_risk++;
  }

  const corrections = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM score_corrections
      WHERE organization_id = $1
        AND created_at >= now() - ($2 || ' days')::interval`,
    [organizationId, periodDays]
  );

  const exemplars = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM calls
      WHERE organization_id = $1 AND is_exemplar = true`,
    [organizationId]
  );

  const currentTotal = parseInt(currentScores?.total || '0');
  const priorTotal = parseInt(priorScores?.total || '0');

  return {
    period_days: periodDays,
    total_calls: parseInt(totalCallsRow?.total || '0'),
    scored_calls: parseInt(totalCallsRow?.scored || '0'),
    avg_score_current: currentScores?.avg_score ? parseFloat(currentScores.avg_score) : null,
    avg_score_prior: priorScores?.avg_score ? parseFloat(priorScores.avg_score) : null,
    pass_rate_current: currentTotal > 0 ? (parseInt(currentScores?.pass_count || '0') / currentTotal) * 100 : null,
    pass_rate_prior: priorTotal > 0 ? (parseInt(priorScores?.pass_count || '0') / priorTotal) * 100 : null,
    top_breaches: topBreaches.map((b) => ({ label: b.label, count: parseInt(b.count) })),
    adviser_risk: risk,
    corrections_count: parseInt(corrections?.count || '0'),
    exemplars_count: parseInt(exemplars?.count || '0'),
  };
}

function buildInsightsPrompt(orgName: string, metrics: InsightsMetrics): string {
  const scoreTrend = metrics.avg_score_current != null && metrics.avg_score_prior != null
    ? `${(metrics.avg_score_current - metrics.avg_score_prior).toFixed(1)}pts`
    : 'n/a';

  const passTrend = metrics.pass_rate_current != null && metrics.pass_rate_prior != null
    ? `${(metrics.pass_rate_current - metrics.pass_rate_prior).toFixed(1)}pts`
    : 'n/a';

  return `You are an AI compliance chief-of-staff for ${orgName}. You are producing a strategic insights brief for the compliance team based on the last ${metrics.period_days} days of data.

## This Period's Metrics (last ${metrics.period_days} days)

- Total calls: ${metrics.total_calls} (${metrics.scored_calls} scored)
- Avg score: ${metrics.avg_score_current?.toFixed(1) ?? 'n/a'}% (trend: ${scoreTrend} vs prior period)
- Pass rate: ${metrics.pass_rate_current?.toFixed(1) ?? 'n/a'}% (trend: ${passTrend} vs prior period)
- Top 5 breach types:
${metrics.top_breaches.length === 0 ? '  (none)' : metrics.top_breaches.map((b, i) => `  ${i + 1}. ${b.label} - ${b.count} occurrences`).join('\n')}
- Adviser risk distribution: ${metrics.adviser_risk.high_risk} high risk, ${metrics.adviser_risk.elevated} elevated, ${metrics.adviser_risk.monitor} monitor, ${metrics.adviser_risk.low_risk} low risk, ${metrics.adviser_risk.compliant} compliant
- AI learning: ${metrics.corrections_count} compliance corrections made this period; ${metrics.exemplars_count} firm exemplars on file

## Your task

Produce a concise strategic brief that a compliance director would actually want to read. Focus on:
1. What changed this period (improved/worsened) and the likely cause
2. The one or two patterns that deserve attention
3. 2-4 specific, actionable recommendations with priority

Do NOT write platitudes ("keep monitoring", "stay vigilant"). Every recommendation must be something a human will actually do this week.

Output via the tool. The summary should be 2-3 short paragraphs. Recommendations should be concrete and named (e.g. "Coach Marcus Webb on capacity-for-loss this week - he has 3 critical fails on this item alone").`;
}

export async function generateInsights(
  organizationId: string,
  periodDays: number,
  generatedBy: string
): Promise<InsightDigest> {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set - required for AI Insights');
  }

  const org = await queryOne<{ name: string }>(
    'SELECT name FROM organizations WHERE id = $1',
    [organizationId]
  );
  if (!org) throw new Error('Organisation not found');

  const metrics = await gatherMetrics(organizationId, periodDays);

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = 'claude-sonnet-4-20250514';

  const response = await client.messages.create({
    model,
    max_tokens: 3072,
    messages: [
      {
        role: 'user',
        content: buildInsightsPrompt(org.name, metrics),
      },
    ],
    tools: [
      {
        name: 'submit_insights',
        description: 'Submit the strategic compliance insights brief',
        input_schema: {
          type: 'object' as const,
          properties: {
            summary: {
              type: 'string',
              description: '2-3 short paragraphs summarising trends and patterns',
            },
            recommendations: {
              type: 'array',
              minItems: 2,
              maxItems: 5,
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  detail: { type: 'string' },
                  priority: {
                    type: 'string',
                    enum: ['critical', 'high', 'medium', 'info'],
                  },
                },
                required: ['title', 'detail', 'priority'],
              },
            },
          },
          required: ['summary', 'recommendations'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_insights' },
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return insights');
  }

  const aiOutput = toolUse.input as {
    summary: string;
    recommendations: InsightRecommendation[];
  };

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const rows = await query<InsightDigest>(
    `INSERT INTO insight_digests
       (organization_id, period_start, period_end, summary, recommendations, metrics, generated_by, model_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      organizationId,
      periodStart,
      periodEnd,
      aiOutput.summary,
      JSON.stringify(aiOutput.recommendations),
      JSON.stringify(metrics),
      generatedBy,
      model,
    ]
  );

  return rows[0]!;
}
