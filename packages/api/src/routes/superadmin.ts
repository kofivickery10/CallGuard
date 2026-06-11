import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticate, requireSuperadmin, AuthPayload } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { config } from '../config.js';
import { PLANS } from '@callguard/shared';
import { CLAUDE_PRICING, DEEPGRAM_PRICING } from '@callguard/shared';

export const superadminRouter = Router();

superadminRouter.use(authenticate, requireSuperadmin);

// Sum Claude cost across per-model token rows, pricing each model at its own
// rate (Haiku is ~4x cheaper than Sonnet, so a single blended rate is wrong).
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
    }>(
      `SELECT id, name, plan, status, created_at, suspended_at, subscription_notes
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
    };
    const token = jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' });
    res.json({ token, note: 'Impersonation token — expires in 1 hour' });
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

    res.json({
      active_users_15min:    Number(activity?.active_users_15min || 0),
      calls_in_queue:        Number(queue?.calls_in_queue || 0),
      calls_processed_today: Number(scored?.calls_processed_today || 0),
      active_live_sessions:  Number(liveSessions?.active_live_sessions || 0),
      platform_claude_cost_mtd:   parseFloat(claudeCostMtd.toFixed(4)),
      platform_deepgram_cost_mtd: parseFloat(deepgramCostMtd.toFixed(4)),
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
      active_seats: string;
      total_duration_seconds: string;
    }>(
      `SELECT
         o.id                                       AS org_id,
         o.name                                     AS org_name,
         o.plan,
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
        claude_cost_estimate:  parseFloat(claudeCost.toFixed(4)),
        deepgram_cost_estimate: parseFloat(deepgramCost.toFixed(4)),
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
      total_duration_seconds: string;
    }>(
      `SELECT
         to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS month,
         COUNT(DISTINCT c.agent_id)::text                       AS active_seats,
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
        claude_cost_estimate:   parseFloat(claudeCost.toFixed(4)),
        deepgram_cost_estimate: parseFloat(deepgramCost.toFixed(4)),
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
