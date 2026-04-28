import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { generateInsights } from '../services/ai-insights.js';
import { hasFeature, type Plan, type InsightDigest } from '@callguard/shared';

export const insightsRouter = Router();
insightsRouter.use(authenticate);
insightsRouter.use(requireAdmin);

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

insightsRouter.post('/generate', async (req, res, next) => {
  try {
    await requirePlan(req.user!.organizationId);
    const days = Math.min(Math.max(parseInt(req.body?.days) || 7, 1), 90);
    const digest = await generateInsights(req.user!.organizationId, days, req.user!.userId);
    res.status(201).json(digest);
  } catch (err) {
    next(err);
  }
});
