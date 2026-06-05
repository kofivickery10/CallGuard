import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { PLANS, type Plan, type OrganizationInfo } from '@callguard/shared';

export const organizationRouter = Router();
organizationRouter.use(authenticate);

// Any authenticated user in the org can see the org info + plan
organizationRouter.get('/', async (req, res, next) => {
  try {
    const org = await queryOne<OrganizationInfo>(
      'SELECT id, name, plan, adviser_channel FROM organizations WHERE id = $1',
      [req.user!.organizationId]
    );
    if (!org) throw new AppError(404, 'Organisation not found');
    res.json(org);
  } catch (err) {
    next(err);
  }
});

// Admins can change the plan (no billing integration - demo/self-service for now)
organizationRouter.put('/plan', requireAdmin, async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (!PLANS.includes(plan)) {
      throw new AppError(400, `Invalid plan. Must be one of: ${PLANS.join(', ')}`);
    }
    const rows = await query<OrganizationInfo>(
      `UPDATE organizations SET plan = $1, updated_at = now()
        WHERE id = $2 RETURNING id, name, plan`,
      [plan as Plan, req.user!.organizationId]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Admins set which stereo channel the adviser is recorded on (split-stereo calls).
// 0 = left, 1 = right, null = auto-detect (first speaker).
organizationRouter.put('/adviser-channel', requireAdmin, async (req, res, next) => {
  try {
    const { adviser_channel } = req.body as { adviser_channel: unknown };
    if (adviser_channel !== null && adviser_channel !== 0 && adviser_channel !== 1) {
      throw new AppError(400, 'adviser_channel must be 0 (left), 1 (right), or null (auto)');
    }
    const rows = await query<OrganizationInfo>(
      `UPDATE organizations SET adviser_channel = $1, updated_at = now()
        WHERE id = $2 RETURNING id, name, plan, adviser_channel`,
      [adviser_channel, req.user!.organizationId]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
