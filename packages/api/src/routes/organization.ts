import { Router } from 'express';
import { authenticate, requireAdmin, requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import type { OrganizationInfo } from '@callguard/shared';

export const organizationRouter = Router();
organizationRouter.use(authenticate);

// Any authenticated user in the org can see the org info + plan
organizationRouter.get('/', async (req, res, next) => {
  try {
    const org = await queryOne<OrganizationInfo>(
      `SELECT id, name, plan, industry, adviser_channel,
              data_improvement_opt_in, data_improvement_opt_in_at,
              scoring_scope, min_scoreable_seconds, min_scoreable_words,
              pass_threshold, retention_days, transcription_mode, mono_first_speaker,
              deepgram_region, deepgram_mip_opt_out, status, cancelled_at
         FROM organizations WHERE id = $1`,
      [req.user!.organizationId]
    );
    if (!org) throw new AppError(404, 'Organisation not found');
    res.json(org);
  } catch (err) {
    next(err);
  }
});

// Scoring/ingestion policy (spec §10) and the stereo channel mapping are set by
// CallGuard staff, not self-served by tenants — they carry cost, compliance
// (retention floor) and data-residency implications. The write path is
// superadmin-only: PUT /superadmin/tenants/:id/scoring-settings. There is
// deliberately no tenant-facing PUT for these; GET /organization still returns
// the values read-only. Likewise plan changes are billing-relevant and
// superadmin-only (PUT /superadmin/tenants/:id/plan), so a tenant admin can't
// self-upgrade for free.

// Admins set the organisation's industry / advice domain. This frames the AI
// scoring prompt so calls are judged in the right regulatory/commercial context
// (e.g. "FCA-regulated protection insurance advice"). Empty/null clears it.
organizationRouter.put('/industry', requireAdmin, async (req, res, next) => {
  try {
    const { industry } = req.body as { industry: unknown };
    if (industry !== null && typeof industry !== 'string') {
      throw new AppError(400, 'industry must be a string or null');
    }
    const trimmed = typeof industry === 'string' ? industry.trim() : null;
    if (trimmed && trimmed.length > 200) {
      throw new AppError(400, 'industry must be 200 characters or fewer');
    }
    const rows = await query<OrganizationInfo>(
      `UPDATE organizations SET industry = $1, updated_at = now()
        WHERE id = $2
        RETURNING id, name, plan, industry, adviser_channel`,
      [trimmed || null, req.user!.organizationId]
    );
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'org.industry.change',
      entityType: 'organization',
      entityId: req.user!.organizationId,
      metadata: { industry: trimmed || null },
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Admins opt the organisation in/out of anonymised data use for Service
// improvement (DPA §4.2). Default is OFF; this is the explicit consent record.
organizationRouter.put('/data-improvement', requireAdmin, async (req, res, next) => {
  try {
    const { opt_in } = req.body as { opt_in: unknown };
    if (typeof opt_in !== 'boolean') {
      throw new AppError(400, 'opt_in must be a boolean');
    }
    const rows = await query<OrganizationInfo>(
      `UPDATE organizations
          SET data_improvement_opt_in = $1,
              data_improvement_opt_in_at = CASE WHEN $1 THEN now() ELSE NULL END,
              data_improvement_opt_in_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
              updated_at = now()
        WHERE id = $3
        RETURNING id, name, plan, adviser_channel,
                  data_improvement_opt_in, data_improvement_opt_in_at`,
      [opt_in, req.user!.userId, req.user!.organizationId]
    );

    await recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'org.data_improvement_optin',
      entityType: 'organization',
      entityId: req.user!.organizationId,
      summary: opt_in
        ? 'Opted in to anonymised data use for Service improvement (DPA §4.2)'
        : 'Opted out of anonymised data use for Service improvement (DPA §4.2)',
      metadata: { opt_in },
      req,
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Active seats = distinct advisers with at least one scored call in a month.
// Returns the current and previous calendar month (basis for per-seat billing).
organizationRouter.get('/active-seats', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    const byMonth = await query<{ month: string; active_seats: string }>(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
              COUNT(DISTINCT agent_id)::text AS active_seats
         FROM calls
        WHERE organization_id = $1
          AND status = 'scored'
          AND agent_id IS NOT NULL
          AND agent_id NOT IN (SELECT id FROM users WHERE billing_exempt)
          AND created_at >= date_trunc('month', now()) - interval '1 month'
        GROUP BY 1`,
      [orgId]
    );

    const advisers = await query<{ id: string; name: string; scored_calls: string; plan_override: string | null }>(
      `SELECT u.id, u.name, COUNT(c.id)::text AS scored_calls, u.plan_override
         FROM calls c
         JOIN users u ON u.id = c.agent_id
        WHERE c.organization_id = $1
          AND c.status = 'scored'
          AND NOT u.billing_exempt
          AND c.created_at >= date_trunc('month', now())
        GROUP BY u.id, u.name, u.plan_override
        ORDER BY u.name`,
      [orgId]
    );

    const now = new Date();
    const fmt = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const currentMonth = fmt(now);
    const prevMonth = fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    const seatsFor = (m: string) =>
      parseInt(byMonth.find((r) => r.month === m)?.active_seats || '0', 10);

    res.json({
      current_month: currentMonth,
      current_active_seats: seatsFor(currentMonth),
      previous_month: prevMonth,
      previous_active_seats: seatsFor(prevMonth),
      current_advisers: advisers.map((a) => ({
        id: a.id,
        name: a.name,
        scored_calls: parseInt(a.scored_calls, 10),
        plan_override: a.plan_override,
      })),
    });
  } catch (err) {
    next(err);
  }
});
