import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticate, requireSuperadmin, AuthPayload } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { config } from '../config.js';
import { PLANS, SEAT_PRICING, effectivePlan, FEATURES } from '@callguard/shared';
import type { Plan } from '@callguard/shared';
import { CLAUDE_PRICING, DEEPGRAM_PRICING, DEFAULT_USD_TO_GBP } from '@callguard/shared';
import { recordAuditEvent } from '../services/audit.js';
import {
  getTranscriptionQueue,
  getScoringQueue,
  getIngestionQueue,
  getAlertsQueue,
} from '../jobs/queue.js';

export const superadminRouter = Router();

superadminRouter.use(authenticate, requireSuperadmin);

// Monthly revenue for one active seat. If the tenant has a negotiated override,
// every seat bills at that flat rate; otherwise the seat's effective tier
// (org plan, bumped by any per-user override) sets the price.
function seatIncome(orgPlan: string, override: number | null, planOverride: string | null): number {
  if (override != null) return Number(override);
  const tier = effectivePlan(orgPlan as Plan, (planOverride ?? null) as Plan | null);
  return SEAT_PRICING[tier] ?? 0;
}

// Sum Claude cost across per-model token rows, pricing each model at its own
// rate (Haiku is ~4x cheaper than Sonnet, so a single blended rate is wrong).
// Provider pricing is in USD; the business reports in GBP. Convert for display.
const USD_TO_GBP = Number(process.env.USD_TO_GBP) || DEFAULT_USD_TO_GBP;
const toGbp = (usd: number) => usd * USD_TO_GBP;

// Unknown/null model ids can't be priced and are skipped.
function claudeCostFromModelRows(
  rows: Array<{ model_id: string | null; prompt_tokens: string; completion_tokens: string }>
): number {
  let cost = 0;
  for (const r of rows) {
    const pricing = r.model_id ? CLAUDE_PRICING[r.model_id] : undefined;
    if (!pricing) continue;
    cost +=
      (Number(r.prompt_tokens)     / 1_000_000) * pricing.input_per_1m +
      (Number(r.completion_tokens) / 1_000_000) * pricing.output_per_1m;
  }
  return cost;
}

// ── Tenant list ───────────────────────────────────────────────────────────────

superadminRouter.get('/tenants', async (_req, res, next) => {
  try {
    const tenants = await query<{
      id: string;
      name: string;
      plan: string;
      status: string;
      created_at: string;
      suspended_at: string | null;
      subscription_notes: string | null;
      user_count: string;
      active_seats_mtd: string;
    }>(
      `SELECT
         o.id,
         o.name,
         o.plan,
         o.status,
         o.created_at,
         o.suspended_at,
         o.subscription_notes,
         COUNT(DISTINCT u.id)::text                                          AS user_count,
         COUNT(DISTINCT CASE
           WHEN c.created_at >= date_trunc('month', now())
            AND c.status = 'scored' THEN c.agent_id
         END)::text                                                          AS active_seats_mtd
       FROM organizations o
       LEFT JOIN users u ON u.organization_id = o.id AND u.role != 'superadmin'
       LEFT JOIN calls c ON c.organization_id = o.id
       GROUP BY o.id
       ORDER BY o.created_at DESC`
    );
    res.json({ tenants });
  } catch (err) {
    next(err);
  }
});

// ── Create tenant ─────────────────────────────────────────────────────────────

superadminRouter.post('/tenants', async (req, res, next) => {
  try {
    const { org_name, admin_name, admin_email, plan, subscription_notes } = req.body as {
      org_name?: string;
      admin_name?: string;
      admin_email?: string;
      plan?: string;
      subscription_notes?: string;
    };

    if (!org_name || !admin_name || !admin_email) {
      throw new AppError(400, 'org_name, admin_name and admin_email are required');
    }
    if (plan && !PLANS.includes(plan as any)) {
      throw new AppError(400, `Invalid plan. Must be one of: ${PLANS.join(', ')}`);
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [admin_email]);
    if (existing) throw new AppError(409, 'Email already registered');

    // Generate a temporary password — returned in response for superadmin to share securely.
    const tempPassword = Math.random().toString(36).slice(2, 10) + 'Cg1!';
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const orgRows = await query<{ id: string }>(
      `INSERT INTO organizations (name, plan, subscription_notes)
       VALUES ($1, $2, $3) RETURNING id`,
      [org_name, plan || 'core', subscription_notes || null]
    );
    const orgId = orgRows[0].id;

    const userRows = await query<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
      [orgId, admin_email, admin_name, passwordHash]
    );

    await recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: 'tenant.create',
      entityType: 'organization',
      entityId: orgId,
      summary: `Created tenant "${org_name}" (${plan || 'core'}) with admin ${admin_email}`,
      req,
    });

    res.status(201).json({
      org_id: orgId,
      admin_user_id: userRows[0].id,
      temp_password: tempPassword,
    });
  } catch (err) {
    next(err);
  }
});

// ── Tenant detail ─────────────────────────────────────────────────────────────

superadminRouter.get('/tenants/:id', async (req, res, next) => {
  try {
    const org = await queryOne<{
      id: string;
      name: string;
      plan: string;
      status: string;
      created_at: string;
      suspended_at: string | null;
      subscription_notes: string | null;
      seat_price_override: string | null;
      feature_overrides: Record<string, boolean>;
    }>(
      `SELECT id, name, plan, status, created_at, suspended_at, subscription_notes,
              seat_price_override, feature_overrides
       FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    if (!org) throw new AppError(404, 'Tenant not found');

    const [users, callStats, seatHistory] = await Promise.all([
      query<{ id: string; name: string; email: string; role: string; last_active_at: string | null; plan_override: string | null }>(
        `SELECT id, name, email, role, last_active_at, plan_override
         FROM users WHERE organization_id = $1 ORDER BY name`,
        [req.params.id]
      ),
      queryOne<{
        total_calls: string;
        scored_calls: string;
        failed_calls: string;
        total_duration_seconds: string;
      }>(
        `SELECT
           COUNT(*)::text                                        AS total_calls,
           COUNT(*) FILTER (WHERE status = 'scored')::text      AS scored_calls,
           COUNT(*) FILTER (WHERE status = 'failed')::text      AS failed_calls,
           COALESCE(SUM(duration_seconds), 0)::text             AS total_duration_seconds
         FROM calls WHERE organization_id = $1`,
        [req.params.id]
      ),
      query<{ month: string; active_seats: string }>(
        `SELECT
           to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS month,
           COUNT(DISTINCT c.agent_id)::text                       AS active_seats
         FROM calls c
         WHERE c.organization_id = $1
           AND c.status = 'scored'
           AND c.created_at >= now() - interval '12 months'
         GROUP BY 1
         ORDER BY 1`,
        [req.params.id]
      ),
    ]);

    res.json({ org, users, call_stats: callStats, seat_history: seatHistory });
  } catch (err) {
    next(err);
  }
});

// ── Update tenant plan ────────────────────────────────────────────────────────

superadminRouter.put('/tenants/:id/plan', async (req, res, next) => {
  try {
    const { plan, subscription_notes } = req.body as { plan?: string; subscription_notes?: string };
    if (!plan || !PLANS.includes(plan as any)) {
      throw new AppError(400, `plan must be one of: ${PLANS.join(', ')}`);
    }
    const rows = await query<{ id: string; plan: string }>(
      `UPDATE organizations
       SET plan = $1,
           subscription_notes = COALESCE($2, subscription_notes)
       WHERE id = $3
       RETURNING id, plan`,
      [plan, subscription_notes || null, req.params.id]
    );
    if (!rows.length) throw new AppError(404, 'Tenant not found');
    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'plan.change',
      entityType: 'organization',
      entityId: req.params.id,
      summary: `Plan changed to ${plan}`,
      req,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Set per-tenant seat price override (negotiated/discounted rate) ───────────
// Pass null to clear and fall back to the default tier price.

superadminRouter.put('/tenants/:id/seat-price', async (req, res, next) => {
  try {
    const { seat_price_override } = req.body as { seat_price_override?: number | null };
    if (seat_price_override != null && (typeof seat_price_override !== 'number' || seat_price_override < 0)) {
      throw new AppError(400, 'seat_price_override must be a non-negative number or null');
    }
    const rows = await query<{ id: string; seat_price_override: string | null }>(
      `UPDATE organizations SET seat_price_override = $1
       WHERE id = $2 RETURNING id, seat_price_override`,
      [seat_price_override ?? null, req.params.id]
    );
    if (!rows.length) throw new AppError(404, 'Tenant not found');
    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'tenant.seat_price',
      entityType: 'organization',
      entityId: req.params.id,
      summary: seat_price_override == null
        ? 'Seat price override cleared (reverted to tier default)'
        : `Seat price override set to £${seat_price_override}/seat`,
      req,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Update tenant status ──────────────────────────────────────────────────────

superadminRouter.put('/tenants/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body as { status?: string };
    const allowed = ['active', 'suspended', 'cancelled'];
    if (!status || !allowed.includes(status)) {
      throw new AppError(400, `status must be one of: ${allowed.join(', ')}`);
    }
    const rows = await query<{ id: string; status: string }>(
      `UPDATE organizations
       SET status      = $1,
           suspended_at = CASE WHEN $1 = 'suspended' THEN now() ELSE suspended_at END
       WHERE id = $2
       RETURNING id, status`,
      [status, req.params.id]
    );
    if (!rows.length) throw new AppError(404, 'Tenant not found');
    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'tenant.status_change',
      entityType: 'organization',
      entityId: req.params.id,
      summary: `Status changed to ${status}`,
      req,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Impersonate tenant admin ──────────────────────────────────────────────────
// Issues a short-lived (1 h) JWT as the org's first admin user.
// Intended for support; all activity is under the org admin's identity.

superadminRouter.post('/tenants/:id/impersonate', async (req, res, next) => {
  try {
    const admin = await queryOne<{ id: string; organization_id: string; role: string }>(
      `SELECT id, organization_id, role FROM users
       WHERE organization_id = $1 AND role = 'admin' ORDER BY created_at LIMIT 1`,
      [req.params.id]
    );
    if (!admin) throw new AppError(404, 'No admin user found for this tenant');

    const payload: AuthPayload = {
      userId: admin.id,
      organizationId: admin.organization_id,
      role: admin.role,
      imp: true,
      impBy: req.user!.userId,
    };
    const token = jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' });

    await recordAuditEvent({
      organizationId: admin.organization_id,
      userId: req.user!.userId,
      actionType: 'tenant.impersonate',
      entityType: 'user',
      entityId: admin.id,
      summary: 'Superadmin started a 1-hour impersonation session as the tenant admin',
      req,
    });

    res.json({ token, note: 'Impersonation token — expires in 1 hour' });
  } catch (err) {
    next(err);
  }
});

// ── Usage & cost ledger ───────────────────────────────────────────────────────
// Actual per-operation cost from usage_events (written live by every processor).
// Window defaults to 30 days, clamped to 1..365.
superadminRouter.get('/usage', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const n = (v: unknown) => Number(v ?? 0);
    const since = `now() - make_interval(0, 0, 0, $1)`;

    const [byProvider, byOperation, byModel, daily, topTenants, scored, totals] = await Promise.all([
      query<{ provider: string; events: string; cost_usd: string }>(
        `SELECT provider, COUNT(*)::text AS events, COALESCE(SUM(est_cost_usd),0)::text AS cost_usd
           FROM usage_events WHERE created_at >= ${since} GROUP BY provider ORDER BY 3 DESC`, [days]),
      query<{ operation: string; events: string; input_tokens: string; output_tokens: string; cache_read_tokens: string; cache_creation_tokens: string; cost_usd: string }>(
        `SELECT operation, COUNT(*)::text AS events,
                COALESCE(SUM(input_tokens),0)::text AS input_tokens,
                COALESCE(SUM(output_tokens),0)::text AS output_tokens,
                COALESCE(SUM(cache_read_tokens),0)::text AS cache_read_tokens,
                COALESCE(SUM(cache_creation_tokens),0)::text AS cache_creation_tokens,
                COALESCE(SUM(est_cost_usd),0)::text AS cost_usd
           FROM usage_events WHERE created_at >= ${since} GROUP BY operation ORDER BY 7 DESC`, [days]),
      query<{ model_id: string | null; events: string; input_tokens: string; output_tokens: string; cost_usd: string }>(
        `SELECT model_id, COUNT(*)::text AS events,
                COALESCE(SUM(input_tokens),0)::text AS input_tokens,
                COALESCE(SUM(output_tokens),0)::text AS output_tokens,
                COALESCE(SUM(est_cost_usd),0)::text AS cost_usd
           FROM usage_events WHERE created_at >= ${since} GROUP BY model_id ORDER BY 5 DESC`, [days]),
      query<{ day: string; cost_usd: string }>(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                COALESCE(SUM(est_cost_usd),0)::text AS cost_usd
           FROM usage_events WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`, [days]),
      query<{ organization_id: string | null; name: string | null; cost_usd: string; events: string }>(
        `SELECT ue.organization_id, o.name,
                COALESCE(SUM(ue.est_cost_usd),0)::text AS cost_usd, COUNT(*)::text AS events
           FROM usage_events ue LEFT JOIN organizations o ON o.id = ue.organization_id
          WHERE ue.created_at >= ${since} GROUP BY ue.organization_id, o.name ORDER BY 3 DESC LIMIT 20`, [days]),
      queryOne<{ scored_calls: string }>(
        `SELECT COUNT(*)::text AS scored_calls FROM calls
          WHERE status = 'scored' AND created_at >= ${since}`, [days]),
      queryOne<{ cost_usd: string; events: string; cache_read: string; uncached_input: string }>(
        `SELECT COALESCE(SUM(est_cost_usd),0)::text AS cost_usd, COUNT(*)::text AS events,
                COALESCE(SUM(cache_read_tokens),0)::text AS cache_read,
                COALESCE(SUM(input_tokens),0)::text AS uncached_input
           FROM usage_events WHERE created_at >= ${since}`, [days]),
    ]);

    const totalCostGbp = toGbp(n(totals?.cost_usd));
    const scoredCalls = n(scored?.scored_calls);
    const cacheRead = n(totals?.cache_read);
    const uncachedInput = n(totals?.uncached_input);

    res.json({
      period_days: days,
      currency: 'GBP',
      totals: {
        cost_gbp: totalCostGbp,
        events: n(totals?.events),
        scored_calls: scoredCalls,
        cost_per_call: scoredCalls > 0 ? totalCostGbp / scoredCalls : 0,
        cache_hit_ratio: cacheRead + uncachedInput > 0 ? cacheRead / (cacheRead + uncachedInput) : 0,
      },
      by_provider: byProvider.map((r) => ({ provider: r.provider, events: n(r.events), cost_gbp: toGbp(n(r.cost_usd)) })),
      by_operation: byOperation.map((r) => ({
        operation: r.operation, events: n(r.events),
        input_tokens: n(r.input_tokens), output_tokens: n(r.output_tokens),
        cache_read_tokens: n(r.cache_read_tokens), cache_creation_tokens: n(r.cache_creation_tokens),
        cost_gbp: toGbp(n(r.cost_usd)),
      })),
      by_model: byModel.map((r) => ({
        model_id: r.model_id ?? '(none)', events: n(r.events),
        input_tokens: n(r.input_tokens), output_tokens: n(r.output_tokens), cost_gbp: toGbp(n(r.cost_usd)),
      })),
      daily: daily.map((r) => ({ day: r.day, cost_gbp: toGbp(n(r.cost_usd)) })),
      top_tenants: topTenants.map((r) => ({
        organization_id: r.organization_id, name: r.name ?? '(platform)',
        cost_gbp: toGbp(n(r.cost_usd)), events: n(r.events),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── Live dashboard ────────────────────────────────────────────────────────────

superadminRouter.get('/dashboard', async (_req, res, next) => {
  try {
    const [activity, queue, scored, costs, liveSessions] = await Promise.all([
      queryOne<{ active_users_15min: string }>(
        `SELECT COUNT(*)::text AS active_users_15min
         FROM users
         WHERE last_active_at >= now() - interval '15 minutes'
           AND role != 'superadmin'`
      ),
      queryOne<{ calls_in_queue: string }>(
        `SELECT COUNT(*)::text AS calls_in_queue
         FROM calls WHERE status IN ('uploaded','transcribing','scoring')`
      ),
      queryOne<{ calls_processed_today: string }>(
        `SELECT COUNT(*)::text AS calls_processed_today
         FROM calls WHERE status = 'scored' AND created_at >= date_trunc('day', now())`
      ),
      query<{ model_id: string; prompt_tokens: string; completion_tokens: string }>(
        `SELECT model_id,
                SUM(prompt_tokens)::text     AS prompt_tokens,
                SUM(completion_tokens)::text AS completion_tokens
         FROM call_scores
         WHERE created_at >= date_trunc('month', now())
           AND model_id IS NOT NULL
         GROUP BY model_id`
      ),
      queryOne<{ active_live_sessions: string }>(
        `SELECT COUNT(*)::text AS active_live_sessions
         FROM live_sessions WHERE status = 'active'`
      ),
    ]);

    // Compute Claude cost estimate from token usage per model.
    let claudeCostMtd = 0;
    for (const row of costs) {
      const pricing = CLAUDE_PRICING[row.model_id];
      if (pricing) {
        claudeCostMtd +=
          (Number(row.prompt_tokens)     / 1_000_000) * pricing.input_per_1m +
          (Number(row.completion_tokens) / 1_000_000) * pricing.output_per_1m;
      }
    }

    // Compute Deepgram cost estimate from call durations this month.
    const durationRow = await queryOne<{ total_minutes: string }>(
      `SELECT COALESCE(SUM(duration_seconds) / 60.0, 0)::text AS total_minutes
       FROM calls WHERE created_at >= date_trunc('month', now())`
    );
    const deepgramCostMtd = Number(durationRow?.total_minutes || 0) * DEEPGRAM_PRICING.per_minute;

    // Platform MRR: each active seat this month priced by the tenant's override
    // or the seat's effective tier (one row per active org+agent pair).
    const mrrRows = await query<{ org_plan: string; seat_price_override: string | null; plan_override: string | null }>(
      `SELECT o.plan AS org_plan, o.seat_price_override, u.plan_override
         FROM organizations o
         JOIN calls c ON c.organization_id = o.id
           AND c.status = 'scored'
           AND c.created_at >= date_trunc('month', now())
         JOIN users u ON u.id = c.agent_id
        WHERE o.status = 'active'
        GROUP BY o.id, o.plan, o.seat_price_override, u.id, u.plan_override`
    );
    let platformMrr = 0;
    for (const r of mrrRows) {
      platformMrr += seatIncome(r.org_plan, r.seat_price_override == null ? null : Number(r.seat_price_override), r.plan_override);
    }

    res.json({
      active_users_15min:    Number(activity?.active_users_15min || 0),
      calls_in_queue:        Number(queue?.calls_in_queue || 0),
      calls_processed_today: Number(scored?.calls_processed_today || 0),
      active_live_sessions:  Number(liveSessions?.active_live_sessions || 0),
      platform_claude_cost_mtd:   parseFloat(toGbp(claudeCostMtd).toFixed(4)),
      platform_deepgram_cost_mtd: parseFloat(toGbp(deepgramCostMtd).toFixed(4)),
      platform_mrr:               parseFloat(platformMrr.toFixed(2)),
    });
  } catch (err) {
    next(err);
  }
});

// ── Billing overview ──────────────────────────────────────────────────────────

superadminRouter.get('/billing', async (req, res, next) => {
  try {
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    // Validate YYYY-MM format.
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new AppError(400, 'month must be in YYYY-MM format');
    }
    const monthStart = `${month}-01`;

    // Per-org seats + audio duration (one row per call, so no re-score inflation).
    const orgRows = await query<{
      org_id: string;
      org_name: string;
      plan: string;
      seat_price_override: string | null;
      active_seats: string;
      total_duration_seconds: string;
    }>(
      `SELECT
         o.id                                       AS org_id,
         o.name                                     AS org_name,
         o.plan,
         o.seat_price_override,
         COUNT(DISTINCT c.agent_id)::text           AS active_seats,
         COALESCE(SUM(c.duration_seconds), 0)::text AS total_duration_seconds
       FROM organizations o
       LEFT JOIN calls c
         ON c.organization_id = o.id
        AND c.status = 'scored'
        AND c.created_at >= $1::date
        AND c.created_at <  $1::date + interval '1 month'
       WHERE o.status = 'active'
       GROUP BY o.id
       ORDER BY o.name`,
      [monthStart]
    );

    // Per-(org, active agent) rows so income can price each seat by the tenant
    // override or the seat's effective tier (per-user bumps included).
    const seatRows = await query<{
      org_id: string;
      org_plan: string;
      seat_price_override: string | null;
      plan_override: string | null;
    }>(
      `SELECT o.id AS org_id, o.plan AS org_plan, o.seat_price_override, u.plan_override
         FROM organizations o
         JOIN calls c ON c.organization_id = o.id
           AND c.status = 'scored'
           AND c.created_at >= $1::date
           AND c.created_at <  $1::date + interval '1 month'
         JOIN users u ON u.id = c.agent_id
        WHERE o.status = 'active'
        GROUP BY o.id, o.plan, o.seat_price_override, u.id, u.plan_override`,
      [monthStart]
    );
    const incomeByOrg = new Map<string, number>();
    for (const r of seatRows) {
      const inc = seatIncome(r.org_plan, r.seat_price_override == null ? null : Number(r.seat_price_override), r.plan_override);
      incomeByOrg.set(r.org_id, (incomeByOrg.get(r.org_id) ?? 0) + inc);
    }

    // Per-(org, model) token sums from each call's latest score, so cost is
    // priced at the model the org actually ran on (Haiku vs Sonnet differ ~4x).
    const tokenRows = await query<{
      org_id: string;
      model_id: string | null;
      prompt_tokens: string;
      completion_tokens: string;
    }>(
      `SELECT
         c.organization_id            AS org_id,
         cs.model_id,
         SUM(cs.prompt_tokens)::text     AS prompt_tokens,
         SUM(cs.completion_tokens)::text AS completion_tokens
       FROM calls c
       CROSS JOIN LATERAL (
         SELECT model_id, prompt_tokens, completion_tokens
         FROM call_scores
         WHERE call_id = c.id
         ORDER BY scored_at DESC
         LIMIT 1
       ) cs
       WHERE c.status = 'scored'
         AND c.created_at >= $1::date
         AND c.created_at <  $1::date + interval '1 month'
       GROUP BY c.organization_id, cs.model_id`,
      [monthStart]
    );

    const tokensByOrg = new Map<string, typeof tokenRows>();
    for (const r of tokenRows) {
      const list = tokensByOrg.get(r.org_id) ?? [];
      list.push(r);
      tokensByOrg.set(r.org_id, list);
    }

    const billing = orgRows.map((r) => {
      const claudeCost = claudeCostFromModelRows(tokensByOrg.get(r.org_id) ?? []);
      const deepgramCost = (Number(r.total_duration_seconds) / 60) * DEEPGRAM_PRICING.per_minute;

      return {
        org_id:                r.org_id,
        org_name:              r.org_name,
        plan:                  r.plan,
        month,
        active_seats:          Number(r.active_seats),
        seat_price_override:   r.seat_price_override == null ? null : Number(r.seat_price_override),
        monthly_income:        parseFloat((incomeByOrg.get(r.org_id) ?? 0).toFixed(2)),
        claude_cost_estimate:  parseFloat(toGbp(claudeCost).toFixed(4)),
        deepgram_cost_estimate: parseFloat(toGbp(deepgramCost).toFixed(4)),
      };
    });

    res.json({ month, billing });
  } catch (err) {
    next(err);
  }
});

// ── Billing detail for one tenant (last 12 months) ───────────────────────────

superadminRouter.get('/billing/:orgId', async (req, res, next) => {
  try {
    const org = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [req.params.orgId]
    );
    if (!org) throw new AppError(404, 'Tenant not found');

    // Per-month seats + audio duration (one row per call, no re-score inflation).
    const monthRows = await query<{
      month: string;
      active_seats: string;
      calls: string;
      total_duration_seconds: string;
    }>(
      `SELECT
         to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS month,
         COUNT(DISTINCT c.agent_id)::text                       AS active_seats,
         COUNT(*)::text                                         AS calls,
         COALESCE(SUM(c.duration_seconds), 0)::text             AS total_duration_seconds
       FROM calls c
       WHERE c.organization_id = $1
         AND c.status = 'scored'
         AND c.created_at >= now() - interval '12 months'
       GROUP BY 1
       ORDER BY 1`,
      [req.params.orgId]
    );

    // Per-(month, model) token sums from each call's latest score.
    const tokenRows = await query<{
      month: string;
      model_id: string | null;
      prompt_tokens: string;
      completion_tokens: string;
    }>(
      `SELECT
         to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS month,
         cs.model_id,
         SUM(cs.prompt_tokens)::text     AS prompt_tokens,
         SUM(cs.completion_tokens)::text AS completion_tokens
       FROM calls c
       CROSS JOIN LATERAL (
         SELECT model_id, prompt_tokens, completion_tokens
         FROM call_scores
         WHERE call_id = c.id
         ORDER BY scored_at DESC
         LIMIT 1
       ) cs
       WHERE c.organization_id = $1
         AND c.status = 'scored'
         AND c.created_at >= now() - interval '12 months'
       GROUP BY 1, cs.model_id`,
      [req.params.orgId]
    );

    const tokensByMonth = new Map<string, typeof tokenRows>();
    for (const r of tokenRows) {
      const list = tokensByMonth.get(r.month) ?? [];
      list.push(r);
      tokensByMonth.set(r.month, list);
    }

    const breakdown = monthRows.map((r) => {
      const claudeCost = claudeCostFromModelRows(tokensByMonth.get(r.month) ?? []);
      const deepgramCost = (Number(r.total_duration_seconds) / 60) * DEEPGRAM_PRICING.per_minute;
      return {
        month:                  r.month,
        active_seats:           Number(r.active_seats),
        calls:                  Number(r.calls),
        claude_cost_estimate:   parseFloat(toGbp(claudeCost).toFixed(4)),
        deepgram_cost_estimate: parseFloat(toGbp(deepgramCost).toFixed(4)),
      };
    });

    res.json({ org_id: org.id, org_name: org.name, breakdown });
  } catch (err) {
    next(err);
  }
});

// ── Per-user tier override ────────────────────────────────────────────────────
// Bump (or clear) a specific user's plan above their org's base tier.
// The effective plan is max(org.plan, user.plan_override).

superadminRouter.put('/tenants/:id/users/:userId/tier', async (req, res, next) => {
  try {
    const { tier } = req.body as { tier?: string | null };

    // tier = null clears the override (user reverts to org plan)
    if (tier !== null && tier !== undefined && !PLANS.includes(tier as any)) {
      throw new AppError(400, `tier must be one of: ${PLANS.join(', ')}, or null to clear`);
    }

    // Verify the user belongs to this tenant
    const user = await queryOne<{ id: string; name: string; email: string; role: string }>(
      `SELECT id, name, email, role FROM users
       WHERE id = $1 AND organization_id = $2`,
      [req.params.userId, req.params.id]
    );
    if (!user) throw new AppError(404, 'User not found in this tenant');

    const rows = await query<{ id: string; plan_override: string | null }>(
      `UPDATE users SET plan_override = $1 WHERE id = $2
       RETURNING id, plan_override`,
      [tier ?? null, req.params.userId]
    );

    res.json({
      user_id:       rows[0].id,
      plan_override: rows[0].plan_override,
    });
  } catch (err) {
    next(err);
  }
});

// ── Per-tenant feature overrides ──────────────────────────────────────────────
// Grant or deny a plan-gated feature for one tenant, beyond their plan tier.
// Body: { feature: <flag>, value: true | false | null }. null removes the override.

superadminRouter.put('/tenants/:id/features', async (req, res, next) => {
  try {
    const { feature, value } = req.body as { feature?: string; value?: boolean | null };
    const validFeatures = Object.keys(FEATURES);
    if (!feature || !validFeatures.includes(feature)) {
      throw new AppError(400, `feature must be one of: ${validFeatures.join(', ')}`);
    }
    if (value !== null && value !== undefined && typeof value !== 'boolean') {
      throw new AppError(400, 'value must be true, false or null');
    }

    // Merge in SQL so concurrent edits to different keys don't clobber each other.
    // value null removes the key; otherwise set it to the boolean.
    const sql = value == null
      ? `UPDATE organizations SET feature_overrides = feature_overrides - $1
         WHERE id = $2 RETURNING feature_overrides`
      : `UPDATE organizations
           SET feature_overrides = feature_overrides || jsonb_build_object($1::text, $2::boolean)
         WHERE id = $3 RETURNING feature_overrides`;
    const params = value == null ? [feature, req.params.id] : [feature, value, req.params.id];

    const rows = await query<{ feature_overrides: Record<string, boolean> }>(sql, params);
    if (!rows.length) throw new AppError(404, 'Tenant not found');

    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'tenant.feature_override',
      entityType: 'organization',
      entityId: req.params.id,
      summary: value == null
        ? `Feature override removed for "${feature}"`
        : `Feature "${feature}" ${value ? 'granted' : 'denied'} by override`,
      req,
    });

    res.json({ feature_overrides: rows[0].feature_overrides });
  } catch (err) {
    next(err);
  }
});

// ── Failed / stuck calls for one tenant ───────────────────────────────────────
// Calls that failed, or have sat in a processing state for over 15 minutes
// (a sign the worker died or a job is wedged). Newest first.

superadminRouter.get('/tenants/:id/failed-calls', async (req, res, next) => {
  try {
    const rows = await query<{
      id: string;
      status: string;
      file_name: string | null;
      external_id: string | null;
      agent_name: string | null;
      customer_phone: string | null;
      error_message: string | null;
      created_at: string;
      updated_at: string;
      stuck: boolean;
    }>(
      `SELECT id, status, file_name, external_id, agent_name, customer_phone,
              error_message, created_at, updated_at,
              (status IN ('uploaded','transcribing','transcribed','scoring')
               AND updated_at < now() - interval '15 minutes') AS stuck
       FROM calls
       WHERE organization_id = $1
         AND (status = 'failed'
              OR (status IN ('uploaded','transcribing','transcribed','scoring')
                  AND updated_at < now() - interval '15 minutes'))
       ORDER BY updated_at DESC
       LIMIT 100`,
      [req.params.id]
    );
    res.json({ calls: rows });
  } catch (err) {
    next(err);
  }
});

// ── Platform-wide audit log ───────────────────────────────────────────────────
// Read-only, paged, time-ordered across all tenants. Filters: org_id,
// action_type, from/to (ISO date). Joins org name and actor email.

superadminRouter.get('/audit', async (req, res, next) => {
  try {
    const limit  = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      conditions.push(clause.replace('$?', `$${params.length}`));
    };

    if (req.query.org_id)      add('a.organization_id = $?', req.query.org_id);
    if (req.query.action_type) add('a.action_type = $?', req.query.action_type);
    if (req.query.from)        add('a.created_at >= $?', req.query.from);
    if (req.query.to)          add('a.created_at <= $?', req.query.to);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const events = await query<{
      id: string;
      organization_id: string;
      org_name: string | null;
      user_email: string | null;
      action_type: string;
      entity_type: string;
      entity_id: string | null;
      summary: string | null;
      ip_address: string | null;
      created_at: string;
    }>(
      `SELECT a.id, a.organization_id, o.name AS org_name, u.email AS user_email,
              a.action_type, a.entity_type, a.entity_id, a.summary,
              a.ip_address, a.created_at
       FROM audit_log a
       LEFT JOIN organizations o ON o.id = a.organization_id
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ events, limit, offset });
  } catch (err) {
    next(err);
  }
});

// ── System health ─────────────────────────────────────────────────────────────
// Redis reachability, per-queue depth + last completed job, and stuck calls.
// Used by the dashboard health strip — distinguishes "quiet" from "worker down".

superadminRouter.get('/health', async (_req, res, next) => {
  try {
    const queues = [
      { name: 'transcription', q: getTranscriptionQueue() },
      { name: 'scoring',       q: getScoringQueue() },
      { name: 'ingestion',     q: getIngestionQueue() },
      { name: 'alerts',        q: getAlertsQueue() },
    ];

    let redisOk = true;
    try {
      // BullMQ's client type doesn't surface ping(), but the underlying ioredis
      // client provides it; a successful PONG confirms Redis is reachable.
      const client = await queues[0].q.client;
      await (client as unknown as { ping: () => Promise<string> }).ping();
    } catch {
      redisOk = false;
    }

    const queueStats = await Promise.all(
      queues.map(async ({ name, q }) => {
        try {
          const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
          const [lastCompleted] = await q.getJobs(['completed'], 0, 0);
          return {
            name,
            waiting:  counts.waiting ?? 0,
            active:   counts.active ?? 0,
            delayed:  counts.delayed ?? 0,
            failed:   counts.failed ?? 0,
            last_completed_at: lastCompleted?.finishedOn
              ? new Date(lastCompleted.finishedOn).toISOString()
              : null,
          };
        } catch {
          return { name, waiting: 0, active: 0, delayed: 0, failed: 0, last_completed_at: null, error: true };
        }
      })
    );

    const stuck = await queryOne<{ stuck_calls: string }>(
      `SELECT COUNT(*)::text AS stuck_calls
       FROM calls
       WHERE status IN ('uploaded','transcribing','transcribed','scoring')
         AND updated_at < now() - interval '15 minutes'`
    );

    res.json({
      redis_ok: redisOk,
      queues: queueStats,
      stuck_calls: Number(stuck?.stuck_calls || 0),
    });
  } catch (err) {
    next(err);
  }
});

// ── Global search ─────────────────────────────────────────────────────────────
// Jump to any tenant, user, customer or call by name / email / phone / id.

superadminRouter.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (q.length < 2) return res.json({ tenants: [], users: [], customers: [], calls: [] });
    const like = `%${q}%`;

    const [tenants, users, customers, calls] = await Promise.all([
      query<{ id: string; name: string; plan: string; status: string }>(
        `SELECT id, name, plan, status FROM organizations
         WHERE name ILIKE $1 ORDER BY name LIMIT 10`,
        [like]
      ),
      query<{ id: string; name: string; email: string; role: string; organization_id: string; org_name: string | null }>(
        `SELECT u.id, u.name, u.email, u.role, u.organization_id, o.name AS org_name
         FROM users u LEFT JOIN organizations o ON o.id = u.organization_id
         WHERE (u.email ILIKE $1 OR u.name ILIKE $1) AND u.role != 'superadmin'
         ORDER BY u.email LIMIT 10`,
        [like]
      ),
      query<{ id: string; name: string | null; phone_normalized: string; organization_id: string; org_name: string | null }>(
        `SELECT c.id, c.name, c.phone_normalized, c.organization_id, o.name AS org_name
         FROM customers c LEFT JOIN organizations o ON o.id = c.organization_id
         WHERE c.phone_normalized ILIKE $1 OR c.name ILIKE $1
         ORDER BY c.last_seen_at DESC LIMIT 10`,
        [like]
      ),
      query<{ id: string; external_id: string | null; customer_phone: string | null; status: string; organization_id: string; org_name: string | null }>(
        `SELECT cl.id, cl.external_id, cl.customer_phone, cl.status, cl.organization_id, o.name AS org_name
         FROM calls cl LEFT JOIN organizations o ON o.id = cl.organization_id
         WHERE cl.external_id ILIKE $1 OR cl.customer_phone ILIKE $1
         ORDER BY cl.created_at DESC LIMIT 10`,
        [like]
      ),
    ]);

    res.json({ tenants, users, customers, calls });
  } catch (err) {
    next(err);
  }
});

// ── Platform announcements ────────────────────────────────────────────────────
// Banners shown across every tenant app (maintenance, incidents).

superadminRouter.get('/announcements', async (_req, res, next) => {
  try {
    const announcements = await query(
      `SELECT a.id, a.title, a.body, a.level, a.active, a.starts_at, a.ends_at,
              a.created_at, a.updated_at, u.email AS created_by_email
       FROM announcements a
       LEFT JOIN users u ON u.id = a.created_by
       ORDER BY a.created_at DESC`
    );
    res.json({ announcements });
  } catch (err) {
    next(err);
  }
});

superadminRouter.post('/announcements', async (req, res, next) => {
  try {
    const { title, body, level, active, starts_at, ends_at } = req.body as {
      title?: string; body?: string; level?: string;
      active?: boolean; starts_at?: string | null; ends_at?: string | null;
    };
    if (!title || !body) throw new AppError(400, 'title and body are required');
    if (level && !['info', 'warning', 'critical'].includes(level)) {
      throw new AppError(400, 'level must be info, warning or critical');
    }
    const rows = await query<{ id: string }>(
      `INSERT INTO announcements (title, body, level, active, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, COALESCE($4, true), $5, $6, $7) RETURNING id`,
      [title, body, level || 'info', active ?? true, starts_at || null, ends_at || null, req.user!.userId]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});

superadminRouter.put('/announcements/:id', async (req, res, next) => {
  try {
    const { title, body, level, active, starts_at, ends_at } = req.body as {
      title?: string; body?: string; level?: string;
      active?: boolean; starts_at?: string | null; ends_at?: string | null;
    };
    if (level && !['info', 'warning', 'critical'].includes(level)) {
      throw new AppError(400, 'level must be info, warning or critical');
    }
    const rows = await query<{ id: string }>(
      `UPDATE announcements SET
         title      = COALESCE($1, title),
         body       = COALESCE($2, body),
         level      = COALESCE($3, level),
         active     = COALESCE($4, active),
         starts_at  = $5,
         ends_at    = $6,
         updated_at = now()
       WHERE id = $7 RETURNING id`,
      [title ?? null, body ?? null, level ?? null, active ?? null, starts_at || null, ends_at || null, req.params.id]
    );
    if (!rows.length) throw new AppError(404, 'Announcement not found');
    res.json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});
