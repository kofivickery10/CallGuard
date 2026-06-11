import { Router } from 'express';
import { authenticate, requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { hasFeature, effectivePlan } from '@callguard/shared';
import type { Plan } from '@callguard/shared';

export const customersRouter = Router();

customersRouter.use(authenticate);

// Guard: verify the user's effective plan (org plan, bumped by any per-user
// override) has the customer_journey feature enabled.
customersRouter.use(async (req, _res, next) => {
  try {
    const row = await queryOne<{ org_plan: string; plan_override: string | null }>(
      `SELECT o.plan AS org_plan, u.plan_override
         FROM organizations o
         JOIN users u ON u.id = $2
        WHERE o.id = $1`,
      [req.user!.organizationId, req.user!.userId]
    );
    const plan = row ? effectivePlan(row.org_plan as Plan, row.plan_override as Plan | null) : null;
    if (!hasFeature(plan, 'customer_journey')) {
      throw new AppError(403, 'Customer journey is not available on your current plan');
    }
    next();
  } catch (err) {
    next(err);
  }
});

// ── List customers ────────────────────────────────────────────────────────────
// Advisers see only customers from calls attributed to them.
// Supervisors/admins/viewers see all.

customersRouter.get('/', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const role  = req.user!.role;
    const userId = req.user!.userId;

    const { search, page = '1', limit = '50' } = req.query as Record<string, string>;
    const offset = (Number(page) - 1) * Number(limit);

    const isAdviser = role === 'adviser';

    const params: unknown[] = [orgId];
    const conditions: string[] = ['c.organization_id = $1'];

    if (isAdviser) {
      params.push(userId);
      conditions.push(`c.id IN (
        SELECT DISTINCT customer_id FROM calls
        WHERE organization_id = $1 AND agent_id = $${params.length} AND customer_id IS NOT NULL
      )`);
    }

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(`(c.name ILIKE $${idx} OR c.phone_normalized ILIKE $${idx})`);
    }

    const where = conditions.join(' AND ');

    const customers = await query<{
      id: string;
      phone_normalized: string;
      name: string | null;
      external_crm_id: string | null;
      first_seen_at: string;
      last_seen_at: string;
      call_count: number;
      avg_score: string | null;
    }>(
      `SELECT c.id, c.phone_normalized, c.name, c.external_crm_id,
              c.first_seen_at, c.last_seen_at, c.call_count, c.avg_score
         FROM customers c
        WHERE ${where}
        ORDER BY c.last_seen_at DESC
        LIMIT $${params.push(Number(limit))} OFFSET $${params.push(offset)}`,
      params
    );

    const countRow = await queryOne<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM customers c WHERE ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      customers,
      total: Number(countRow?.total ?? 0),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    next(err);
  }
});

// ── Customer profile ──────────────────────────────────────────────────────────

customersRouter.get('/:id', async (req, res, next) => {
  try {
    const orgId  = req.user!.organizationId;
    const role   = req.user!.role;
    const userId = req.user!.userId;

    const customer = await queryOne<{
      id: string;
      phone_normalized: string;
      name: string | null;
      external_crm_id: string | null;
      first_seen_at: string;
      last_seen_at: string;
      call_count: number;
      avg_score: string | null;
    }>(
      'SELECT * FROM customers WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );

    if (!customer) throw new AppError(404, 'Customer not found');

    // Advisers are restricted to customers from their own calls.
    if (role === 'adviser') {
      const linked = await queryOne<{ id: string }>(
        `SELECT id FROM calls
         WHERE customer_id = $1 AND organization_id = $2 AND agent_id = $3 LIMIT 1`,
        [customer.id, orgId, userId]
      );
      if (!linked) throw new AppError(403, 'Access denied');
    }

    res.json({ customer });
  } catch (err) {
    next(err);
  }
});

// ── Customer journey (all calls chronologically) ──────────────────────────────

customersRouter.get('/:id/journey', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    const customer = await queryOne<{ id: string }>(
      'SELECT id FROM customers WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!customer) throw new AppError(404, 'Customer not found');

    const calls = await query<{
      id: string;
      call_date: string | null;
      created_at: string;
      agent_name: string | null;
      overall_score: number | null;
      pass: boolean | null;
      coaching_summary: string | null;
      breach_count: string;
    }>(
      `SELECT
         ca.id,
         ca.call_date,
         ca.created_at,
         ca.agent_name,
         cs.overall_score,
         cs.pass,
         cs.coaching->>'summary' AS coaching_summary,
         COUNT(b.id)::text       AS breach_count
       FROM calls ca
       LEFT JOIN call_scores cs ON cs.call_id = ca.id
       LEFT JOIN breaches b     ON b.call_id = ca.id AND b.is_false_positive = false
       WHERE ca.customer_id = $1
         AND ca.organization_id = $2
       GROUP BY ca.id, ca.call_date, ca.created_at, ca.agent_name,
                cs.overall_score, cs.pass, cs.coaching
       ORDER BY COALESCE(ca.call_date::timestamptz, ca.created_at) ASC`,
      [req.params.id, orgId]
    );

    res.json({ customer_id: req.params.id, calls });
  } catch (err) {
    next(err);
  }
});

// ── Update customer (name / CRM id) ──────────────────────────────────────────

customersRouter.put('/:id', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const { name, external_crm_id } = req.body as { name?: string; external_crm_id?: string };

    const rows = await query<{ id: string; name: string | null; external_crm_id: string | null }>(
      `UPDATE customers
       SET name            = COALESCE($3, name),
           external_crm_id = COALESCE($4, external_crm_id)
       WHERE id = $1 AND organization_id = $2
       RETURNING id, name, external_crm_id`,
      [req.params.id, orgId, name ?? null, external_crm_id ?? null]
    );

    if (!rows.length) throw new AppError(404, 'Customer not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
