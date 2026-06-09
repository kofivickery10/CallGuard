import { Router } from 'express';
import { authenticate, requireStaff } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { createInvite, sendInviteEmail } from '../services/invites.js';
import {
  getTranscriptionQueue,
  getScoringQueue,
  getIngestionQueue,
  getAlertsQueue,
} from '../jobs/queue.js';
import { PLANS, type Plan } from '@callguard/shared';

/**
 * Superadmin (platform operator) API. All routes are gated by requireStaff.
 *
 * PRIVACY BOUNDARY: the analytics endpoints return AGGREGATES ONLY — counts,
 * rates and dates. They never select call content, transcripts, evidence,
 * breach detail, end-customer data, or any individual's performance. The
 * provisioning endpoints are operational (create tenants / users / settings)
 * and only handle the account details the operator is entering or managing.
 */
export const adminRouter = Router();
adminRouter.use(authenticate, requireStaff);

const ROLES = ['admin', 'supervisor', 'viewer', 'adviser'];

// ─────────────────────────── Provisioning ───────────────────────────

// List all tenants with aggregate stats (no call content / PII).
adminRouter.get('/tenants', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT o.id, o.name, o.plan, o.created_at,
              (SELECT COUNT(*)::int FROM users u WHERE u.organization_id = o.id) AS user_count,
              (SELECT COUNT(DISTINCT c.agent_id)::int FROM calls c
                 WHERE c.organization_id = o.id AND c.status = 'scored'
                   AND c.created_at >= date_trunc('month', now())) AS active_seats,
              (SELECT COUNT(*)::int FROM calls c
                 WHERE c.organization_id = o.id AND c.status = 'scored') AS calls_scored
         FROM organizations o
        ORDER BY o.created_at DESC`
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// Create a tenant + invite its first admin by email.
adminRouter.post('/tenants', async (req, res, next) => {
  try {
    const { name, plan, admin_email, admin_name } = req.body as {
      name?: string;
      plan?: string;
      admin_email?: string;
      admin_name?: string;
    };
    if (!name || !admin_email || !admin_name) {
      throw new AppError(400, 'name, admin_email and admin_name are required');
    }
    const chosenPlan: Plan = PLANS.includes(plan as Plan) ? (plan as Plan) : 'growth';

    const orgRows = await query<{ id: string; name: string; plan: string; created_at: string }>(
      `INSERT INTO organizations (name, plan) VALUES ($1, $2)
       RETURNING id, name, plan, created_at`,
      [name, chosenPlan]
    );
    const org = orgRows[0];

    const { invite, rawToken } = await createInvite({
      organizationId: org.id,
      email: admin_email,
      name: admin_name,
      role: 'admin',
      invitedBy: req.user!.userId,
    });
    const emailResult = await sendInviteEmail({
      to: admin_email,
      name: admin_name,
      organizationName: name,
      rawToken,
    });

    await recordAuditEvent({
      organizationId: org.id,
      userId: req.user!.userId,
      actionType: 'tenant.create',
      entityType: 'organization',
      entityId: org.id,
      summary: `Provisioned tenant "${name}" and invited admin ${admin_email}`,
      metadata: { plan: chosenPlan, admin_email },
      req,
    });

    res.status(201).json({
      organization: org,
      invite,
      email_sent: emailResult.ok,
      email_error: emailResult.error,
    });
  } catch (err) {
    next(err);
  }
});

// Tenant detail: settings + aggregate stats (no PII / call content).
adminRouter.get('/tenants/:id', async (req, res, next) => {
  try {
    const org = await queryOne<{
      id: string;
      name: string;
      plan: string;
      adviser_channel: number | null;
      data_improvement_opt_in: boolean;
      created_at: string;
    }>(
      `SELECT id, name, plan, adviser_channel, data_improvement_opt_in, created_at
         FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    if (!org) throw new AppError(404, 'Tenant not found');

    const stats = await queryOne<{ user_count: number; active_seats: number; calls_scored: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM users u WHERE u.organization_id = $1) AS user_count,
         (SELECT COUNT(DISTINCT c.agent_id)::int FROM calls c
            WHERE c.organization_id = $1 AND c.status='scored'
              AND c.created_at >= date_trunc('month', now())) AS active_seats,
         (SELECT COUNT(*)::int FROM calls c WHERE c.organization_id=$1 AND c.status='scored') AS calls_scored`,
      [req.params.id]
    );

    res.json({ ...org, stats });
  } catch (err) {
    next(err);
  }
});

// Update tenant settings.
adminRouter.put('/tenants/:id', async (req, res, next) => {
  try {
    const { name, plan, adviser_channel } = req.body as {
      name?: string;
      plan?: string;
      adviser_channel?: number | null;
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (typeof name === 'string' && name.trim()) {
      sets.push(`name = $${i++}`);
      vals.push(name.trim());
    }
    if (plan !== undefined) {
      if (!PLANS.includes(plan as Plan)) throw new AppError(400, 'Invalid plan');
      sets.push(`plan = $${i++}`);
      vals.push(plan);
    }
    if (adviser_channel !== undefined) {
      if (adviser_channel !== null && adviser_channel !== 0 && adviser_channel !== 1) {
        throw new AppError(400, 'adviser_channel must be 0, 1 or null');
      }
      sets.push(`adviser_channel = $${i++}`);
      vals.push(adviser_channel);
    }
    if (!sets.length) throw new AppError(400, 'No valid fields to update');

    vals.push(req.params.id);
    const rows = await query(
      `UPDATE organizations SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${i} RETURNING id, name, plan, adviser_channel, data_improvement_opt_in`,
      vals
    );
    if (!rows.length) throw new AppError(404, 'Tenant not found');

    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'tenant.update',
      entityType: 'organization',
      entityId: req.params.id,
      summary: `Updated tenant settings (${sets.map((s) => s.split(' ')[0]).join(', ')})`,
      req,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// List a tenant's users (operational: account management only).
adminRouter.get('/tenants/:id/users', async (req, res, next) => {
  try {
    const users = await query(
      `SELECT id, name, email, role, is_staff, created_at
         FROM users WHERE organization_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    const pending = await query(
      `SELECT id, name, email, role, expires_at, created_at
         FROM invites WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ users, pending_invites: pending });
  } catch (err) {
    next(err);
  }
});

// Add a user to a tenant (invite by email).
adminRouter.post('/tenants/:id/users', async (req, res, next) => {
  try {
    const { email, name, role } = req.body as { email?: string; name?: string; role?: string };
    if (!email || !name) throw new AppError(400, 'email and name are required');
    const chosenRole = ROLES.includes(role || '') ? (role as string) : 'viewer';

    const org = await queryOne<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [
      req.params.id,
    ]);
    if (!org) throw new AppError(404, 'Tenant not found');

    const { invite, rawToken } = await createInvite({
      organizationId: req.params.id,
      email,
      name,
      role: chosenRole,
      invitedBy: req.user!.userId,
    });
    const emailResult = await sendInviteEmail({
      to: email,
      name,
      organizationName: org.name,
      rawToken,
    });

    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'user.invite',
      entityType: 'user',
      summary: `Invited ${email} (${chosenRole}) to ${org.name}`,
      req,
    });
    res.status(201).json({ invite, email_sent: emailResult.ok, email_error: emailResult.error });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────── Analytics (aggregate only) ───────────────────────────

adminRouter.get('/overview', async (_req, res, next) => {
  try {
    const tenants = await queryOne<{ total: number; active: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE EXISTS (SELECT 1 FROM calls c
                              WHERE c.organization_id = o.id
                                AND c.created_at >= now() - interval '30 days')
              )::int AS active
         FROM organizations o`
    );

    const usage = await queryOne<{
      total_users: number;
      active_agents: number;
      scored_today: number;
      scored_week: number;
      scored_month: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS total_users,
         (SELECT COUNT(DISTINCT agent_id)::int FROM calls
            WHERE status='scored' AND created_at >= date_trunc('month', now())) AS active_agents,
         (SELECT COUNT(*)::int FROM calls WHERE status='scored' AND created_at >= date_trunc('day', now())) AS scored_today,
         (SELECT COUNT(*)::int FROM calls WHERE status='scored' AND created_at >= now() - interval '7 days') AS scored_week,
         (SELECT COUNT(*)::int FROM calls WHERE status='scored' AND created_at >= date_trunc('month', now())) AS scored_month`
    );

    const passRate = await queryOne<{ current: number | null; previous: number | null }>(
      `SELECT
         ROUND(AVG(CASE WHEN pass THEN 100.0 ELSE 0 END) FILTER (WHERE scored_at >= now() - interval '30 days'), 1) AS current,
         ROUND(AVG(CASE WHEN pass THEN 100.0 ELSE 0 END) FILTER (WHERE scored_at >= now() - interval '60 days' AND scored_at < now() - interval '30 days'), 1) AS previous
       FROM call_scores`
    );

    const jobs = await getJobCounts();

    res.json({
      tenants: tenants ?? { total: 0, active: 0 },
      usage: usage ?? {},
      pass_rate: {
        current: passRate?.current ?? null,
        previous: passRate?.previous ?? null,
        improvement:
          passRate?.current != null && passRate?.previous != null
            ? Math.round((passRate.current - passRate.previous) * 10) / 10
            : null,
      },
      jobs,
    });
  } catch (err) {
    next(err);
  }
});

// Pass-rate time series across all tenants. bucket = day | week | month.
adminRouter.get('/pass-rate', async (req, res, next) => {
  try {
    const bucketParam = String(req.query.bucket || 'day');
    const bucket = ['day', 'week', 'month'].includes(bucketParam) ? bucketParam : 'day';
    const windows: Record<string, string> = {
      day: '30 days',
      week: '12 weeks',
      month: '12 months',
    };
    const rows = await query(
      `SELECT date_trunc('${bucket}', scored_at) AS bucket,
              COUNT(*)::int AS scored,
              ROUND(AVG(CASE WHEN pass THEN 100.0 ELSE 0 END), 1) AS pass_rate
         FROM call_scores
        WHERE scored_at >= now() - interval '${windows[bucket]}'
        GROUP BY 1 ORDER BY 1`
    );
    res.json({ bucket, data: rows });
  } catch (err) {
    next(err);
  }
});

// Live processing-job counts across all queues.
adminRouter.get('/jobs', async (_req, res, next) => {
  try {
    res.json(await getJobCounts());
  } catch (err) {
    next(err);
  }
});

async function getJobCounts() {
  try {
    const queues: Record<string, () => ReturnType<typeof getScoringQueue>> = {
      transcription: getTranscriptionQueue,
      scoring: getScoringQueue,
      ingestion: getIngestionQueue,
      alerts: getAlertsQueue,
    };
    const entries = await Promise.all(
      Object.entries(queues).map(async ([name, getter]) => {
        const counts = await getter().getJobCounts('active', 'waiting', 'delayed', 'failed');
        return [name, counts] as const;
      })
    );
    const byQueue = Object.fromEntries(entries);
    const totals = entries.reduce(
      (acc, [, c]) => ({
        active: acc.active + (c.active || 0),
        waiting: acc.waiting + (c.waiting || 0),
        delayed: acc.delayed + (c.delayed || 0),
        failed: acc.failed + (c.failed || 0),
      }),
      { active: 0, waiting: 0, delayed: 0, failed: 0 }
    );
    return { available: true, totals, by_queue: byQueue };
  } catch (err) {
    return { available: false, error: (err as Error).message, totals: null, by_queue: null };
  }
}
