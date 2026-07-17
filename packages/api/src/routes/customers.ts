import { Router } from 'express';
import { authenticate, requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { normalizePhone } from '../services/ingestion.js';
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
      // Phone-ish input ("07700 900123", "+44 7700…") is normalised to match
      // the stored E.164 form — a raw ILIKE on "07700" would never match
      // "+447700…". Name searches pass through untouched.
      const digits = search.replace(/[\s()-]/g, '');
      const phoneSearch = /^\+?\d[\d\s()-]*$/.test(search.trim())
        ? (normalizePhone(digits) ?? digits)
        : search;
      params.push(`%${search}%`, `%${phoneSearch}%`);
      conditions.push(`(c.name ILIKE $${params.length - 1} OR c.phone_normalized ILIKE $${params.length})`);
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
      journey_count: number;
      last_journey_score: string | null;
      last_journey_pass: boolean | null;
      last_journey_at: string | null;
    }>(
      // call_count is computed live rather than read from the denormalised
      // customers.call_count column: under the capture/journey model calls stay
      // 'captured'/'transcribed' (never per-call 'scored'), and that column is
      // only ever recomputed by the per-call scorer — so it reads 0 for
      // sales-only tenants. Count every real (non-failed) call instead.
      // Likewise customers.avg_score is dead under the journey model (scores
      // live on journeys) — surface the latest scored journey instead.
      `SELECT c.id, c.phone_normalized, c.name, c.external_crm_id,
              c.first_seen_at, c.last_seen_at,
              (SELECT COUNT(*) FROM calls ca
                WHERE ca.customer_id = c.id AND ca.status <> 'failed')::int AS call_count,
              (SELECT COUNT(*) FROM journeys j
                WHERE j.customer_id = c.id AND j.status = 'scored')::int AS journey_count,
              lj.overall_score AS last_journey_score,
              lj.pass          AS last_journey_pass,
              lj.scored_at     AS last_journey_at
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT overall_score, pass, scored_at FROM journeys
            WHERE customer_id = c.id AND status = 'scored'
            ORDER BY scored_at DESC LIMIT 1
         ) lj ON true
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
      // Live call_count + journey outcomes (see the list query above for why
      // the denormalised call_count/avg_score columns are unreliable under the
      // capture/journey model).
      `SELECT c.id, c.organization_id, c.phone_normalized, c.name, c.external_crm_id,
              c.first_seen_at, c.last_seen_at,
              (SELECT COUNT(*) FROM calls ca
                WHERE ca.customer_id = c.id AND ca.status <> 'failed')::int AS call_count,
              (SELECT COUNT(*) FROM journeys j
                WHERE j.customer_id = c.id AND j.status = 'scored')::int AS journey_count,
              lj.overall_score AS last_journey_score,
              lj.pass          AS last_journey_pass,
              lj.scored_at     AS last_journey_at
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT overall_score, pass, scored_at FROM journeys
            WHERE customer_id = c.id AND status = 'scored'
            ORDER BY scored_at DESC LIMIT 1
         ) lj ON true
        WHERE c.id = $1 AND c.organization_id = $2`,
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
         ca.status,
         ca.duration_seconds,
         cs.overall_score,
         cs.pass,
         cs.coaching->>'summary' AS coaching_summary,
         COUNT(b.id)::text       AS breach_count
       FROM calls ca
       LEFT JOIN call_scores cs ON cs.call_id = ca.id
       LEFT JOIN breaches b     ON b.call_id = ca.id AND b.is_false_positive = false
       WHERE ca.customer_id = $1
         AND ca.organization_id = $2
       GROUP BY ca.id, ca.call_date, ca.created_at, ca.agent_name, ca.status,
                ca.duration_seconds, cs.overall_score, cs.pass, cs.coaching
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
      // Distinguish "field not sent" (undefined → keep current) from an
      // explicit empty string (→ clear to NULL). Without this a wrongly
      // backfilled name could never be removed from the UI.
      `UPDATE customers
       SET name            = CASE WHEN $3::boolean THEN NULLIF($4, '') ELSE name END,
           external_crm_id = CASE WHEN $5::boolean THEN NULLIF($6, '') ELSE external_crm_id END
       WHERE id = $1 AND organization_id = $2
       RETURNING id, name, external_crm_id`,
      [req.params.id, orgId, name !== undefined, name ?? '', external_crm_id !== undefined, external_crm_id ?? '']
    );

    if (!rows.length) throw new AppError(404, 'Customer not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
