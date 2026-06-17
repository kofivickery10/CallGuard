import { Router } from 'express';
import { authenticate, requireOrgView, requireActioner } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { generateInsights } from '../services/ai-insights.js';
import { hasFeature, type Plan, type InsightDigest } from '@callguard/shared';

export const insightsRouter = Router();
insightsRouter.use(authenticate);
insightsRouter.use(requireOrgView);

async function requirePlan(orgId: string): Promise<void> {
  const row = await queryOne<{ plan: Plan }>(
    'SELECT plan FROM organizations WHERE id = $1',
    [orgId]
  );
  if (!row || !hasFeature(row.plan, 'insights')) {
    throw new AppError(403, 'AI Insights requires the Pro plan');
  }
}

insightsRouter.get('/', async (req, res, next) => {
  try {
    await requirePlan(req.user!.organizationId);
    const digests = await query<InsightDigest>(
      `SELECT * FROM insight_digests WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user!.organizationId]
    );
    res.json({ data: digests });
  } catch (err) {
    next(err);
  }
});

insightsRouter.post('/generate', requireActioner, async (req, res, next) => {
  try {
    await requirePlan(req.user!.organizationId);
    const days = Math.min(Math.max(parseInt(req.body?.days) || 7, 1), 90);
    const digest = await generateInsights(req.user!.organizationId, days, req.user!.userId);
    res.status(201).json(digest);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/insights/calibration
// Calibration health: how often reviewers override the AI, the trend over time
// (lower = better aligned), and which scorecard items are least aligned + which
// way (AI too harsh vs too lenient). Computed from real human corrections.
// ============================================================
insightsRouter.get('/calibration', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    const correctionsByMonth = await query<{ month: string; corrections: string }>(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
              COUNT(*)::text AS corrections
         FROM score_corrections
        WHERE organization_id = $1 AND created_at >= date_trunc('month', now()) - interval '5 months'
        GROUP BY 1`,
      [orgId]
    );

    const scoredByMonth = await query<{ month: string; scored_calls: string }>(
      `SELECT to_char(date_trunc('month', cs.scored_at), 'YYYY-MM') AS month,
              COUNT(*)::text AS scored_calls
         FROM call_scores cs
         JOIN calls c ON c.id = cs.call_id
        WHERE c.organization_id = $1 AND cs.scored_at >= date_trunc('month', now()) - interval '5 months'
        GROUP BY 1`,
      [orgId]
    );

    // Build last 6 months oldest->newest
    const months: string[] = [];
    const base = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    // True agreement: over calls a reviewer marked reviewed, the item scores they
    // did NOT correct are agreements. agreement = (reviewed items - corrections) / reviewed items.
    const reviewedByMonth = await query<{ month: string; reviewed_items: string; disagreements: string }>(
      `SELECT to_char(date_trunc('month', c.reviewed_at), 'YYYY-MM') AS month,
              COUNT(cis.id)::text AS reviewed_items,
              COUNT(sc.id)::text  AS disagreements
         FROM calls c
         JOIN call_scores cscore ON cscore.call_id = c.id
         JOIN call_item_scores cis ON cis.call_score_id = cscore.id
         LEFT JOIN score_corrections sc ON sc.call_item_score_id = cis.id
        WHERE c.organization_id = $1
          AND c.reviewed_at IS NOT NULL
          AND c.reviewed_at >= date_trunc('month', now()) - interval '5 months'
        GROUP BY 1`,
      [orgId]
    );

    const corr = (m: string) => parseInt(correctionsByMonth.find((r) => r.month === m)?.corrections || '0', 10);
    const scored = (m: string) => parseInt(scoredByMonth.find((r) => r.month === m)?.scored_calls || '0', 10);
    const reviewedItems = (m: string) => parseInt(reviewedByMonth.find((r) => r.month === m)?.reviewed_items || '0', 10);
    const disagreements = (m: string) => parseInt(reviewedByMonth.find((r) => r.month === m)?.disagreements || '0', 10);
    const trend = months.map((m) => {
      const c = corr(m);
      const s = scored(m);
      const ri = reviewedItems(m);
      const dis = disagreements(m);
      return {
        month: m,
        scored_calls: s,
        corrections: c,
        overrides_per_100_calls: s > 0 ? Math.round((c / s) * 1000) / 10 : null,
        reviewed_items: ri,
        agreement_pct: ri > 0 ? Math.round(((ri - dis) / ri) * 1000) / 10 : null,
      };
    });

    const topItems = await query<{
      label: string; total: string; too_lenient: string; too_harsh: string;
    }>(
      `SELECT si.label,
              COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE sc.original_pass = true  AND sc.corrected_pass = false)::text AS too_lenient,
              COUNT(*) FILTER (WHERE sc.original_pass = false AND sc.corrected_pass = true )::text AS too_harsh
         FROM score_corrections sc
         JOIN scorecard_items si ON si.id = sc.scorecard_item_id
        WHERE sc.organization_id = $1
        GROUP BY si.label
        ORDER BY total DESC
        LIMIT 8`,
      [orgId]
    );

    const totalsRow = await queryOne<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM score_corrections WHERE organization_id = $1`,
      [orgId]
    );

    const current = trend[trend.length - 1];
    const previous = trend[trend.length - 2];

    // Headline agreement = most recent month that actually has reviewed calls.
    const withAgreement = [...trend].reverse().filter((t) => t.agreement_pct != null);
    const totalReviewedItems = trend.reduce((a, t) => a + t.reviewed_items, 0);

    res.json({
      total_corrections: parseInt(totalsRow?.total || '0', 10),
      total_reviewed_items: totalReviewedItems,
      current_agreement_pct: withAgreement[0]?.agreement_pct ?? null,
      previous_agreement_pct: withAgreement[1]?.agreement_pct ?? null,
      current_override_rate: current?.overrides_per_100_calls ?? null,
      previous_override_rate: previous?.overrides_per_100_calls ?? null,
      trend,
      top_items: topItems.map((t) => ({
        label: t.label,
        corrections: parseInt(t.total, 10),
        too_lenient: parseInt(t.too_lenient, 10),
        too_harsh: parseInt(t.too_harsh, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Must stay LAST: this catch-all param route would otherwise swallow static
// paths like /calibration and /generate, casting the literal segment to a uuid.
insightsRouter.get('/:id', async (req, res, next) => {
  try {
    await requirePlan(req.user!.organizationId);
    const digest = await queryOne<InsightDigest>(
      'SELECT * FROM insight_digests WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!digest) throw new AppError(404, 'Digest not found');
    res.json(digest);
  } catch (err) {
    next(err);
  }
});
