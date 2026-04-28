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
      'SELECT id, name, plan FROM organizations WHERE id = $1',
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
