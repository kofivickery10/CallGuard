import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticate, requireSuperadmin, AuthPayload } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { config } from '../config.js';
import { PLANS, FEATURES } from '@callguard/shared';
import { DEFAULT_USD_TO_GBP } from '@callguard/shared';
import { recordAuditEvent } from '../services/audit.js';
import { REDACTION_CATEGORIES } from '../services/transcription.js';
import {
  billableSeatRows,
  aggregateByOrg,
  mrrFromRows,
  billingForMonth,
  billingHistoryForOrg,
  currentBillingForOrg,
} from '../services/billing.js';
import { deleteOrganizationCascade } from '../services/tenant-deletion.js';
import { MAX_JOURNEY_WINDOW_DAYS, MAX_REVIEW_CONFIDENCE_FLOOR } from '../services/tenant-settings.js';
import { LONDON, inWindow, resolveWindow, windowParams } from '../services/report-window.js';
import {
  getTranscriptionQueue,
  getScoringQueue,
  getIngestionQueue,
  getAlertsQueue,
  getMaintenanceQueue,
} from '../jobs/queue.js';
import { readWorkerHeartbeat } from '../services/redis.js';
import {
  summariseStuckWork,
  STUCK_CALL_SQL,
  STUCK_QUEUED_AFTER_MINUTES,
  STUCK_INFLIGHT_AFTER_MINUTES,
} from '../services/stuck.js';

export const superadminRouter = Router();

superadminRouter.use(authenticate, requireSuperadmin);

// Costs come pre-priced (per event, in USD) from the usage_events ledger; the
// business reports in GBP, so convert for display.
const USD_TO_GBP = Number(process.env.USD_TO_GBP) || DEFAULT_USD_TO_GBP;
const toGbp = (usd: number) => usd * USD_TO_GBP;

// Reporting windows (?days=N or ?from=&to=) — see services/report-window.ts.

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
           WHEN NOT u.billing_exempt THEN u.id
         END)::text                                                          AS active_seats_mtd
       FROM organizations o
       LEFT JOIN users u ON u.organization_id = o.id AND u.role != 'superadmin'
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email)) {
      throw new AppError(400, 'admin_email is not a valid email address');
    }
    if (plan && !PLANS.includes(plan as any)) {
      throw new AppError(400, `Invalid plan. Must be one of: ${PLANS.join(', ')}`);
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [admin_email]);
    if (existing) throw new AppError(409, 'Email already registered');

    // Generate a temporary password — returned in response for superadmin to
    // share securely. crypto.randomBytes, not Math.random, since this is a
    // real (if short-lived) account credential.
    const tempPassword = crypto.randomBytes(9).toString('base64url') + 'Cg1!';
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    // Org + admin-user creation must succeed or fail together — otherwise a
    // failure on the user insert (e.g. a duplicate-email race past the
    // pre-check above) leaves an orphan organisation with no admin.
    const { orgId, userId } = await withTransaction(async (tx) => {
      const orgRows = await tx.query<{ id: string }>(
        `INSERT INTO organizations (name, plan, subscription_notes)
         VALUES ($1, $2, $3) RETURNING id`,
        [org_name, plan || 'core', subscription_notes || null]
      );
      const newOrgId = orgRows[0]!.id;

      const userRows = await tx.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
        [newOrgId, admin_email, admin_name, passwordHash]
      );

      return { orgId: newOrgId, userId: userRows[0]!.id };
    });

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
      admin_user_id: userId,
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
      adviser_channel: number | null;
      scoring_scope: string;
      min_scoreable_seconds: number;
      min_scoreable_words: number;
      pass_threshold: number;
      retention_days: number;
      transcription_mode: string;
      deepgram_region: string;
      journey_window_days: number | null;
      scoring_samples: number;
      review_confidence_floor: string;
      capture_enabled: boolean;
      reconciliation_enabled: boolean;
      pii_unredacted_categories: string[];
      pii_redaction_exempt_note: string | null;
    }>(
      `SELECT id, name, plan, status, created_at, suspended_at, subscription_notes,
              seat_price_override, feature_overrides,
              adviser_channel, scoring_scope, min_scoreable_seconds, min_scoreable_words,
              pass_threshold, retention_days, transcription_mode, deepgram_region,
              journey_window_days, scoring_samples, review_confidence_floor,
              capture_enabled, reconciliation_enabled,
              pii_unredacted_categories, pii_redaction_exempt_note
       FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    if (!org) throw new AppError(404, 'Tenant not found');

    const [users, callStats, billingHistory, currentBilling] = await Promise.all([
      query<{ id: string; name: string; email: string; role: string; last_active_at: string | null; plan_override: string | null; billing_exempt: boolean }>(
        `SELECT id, name, email, role, last_active_at, plan_override, billing_exempt
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
      // Billed-seat history comes from the frozen ledger (headcount at each
      // month's close), not from call activity. History accrues from the first
      // month-end snapshot; the current month is appended live below.
      billingHistoryForOrg(req.params.id),
      currentBillingForOrg(req.params.id),
    ]);

    const currentMonth = new Date().toISOString().slice(0, 7);
    const seatMap = new Map(billingHistory);
    seatMap.set(currentMonth, currentBilling);
    const seatHistory = [...seatMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, b]) => ({ month, active_seats: b.seatCount, total: parseFloat(b.total.toFixed(2)) }));

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

// ── Set a tenant's call-recording + scoring policy ───────────────────────────
// These settings (stereo channel mapping, scoring scope/thresholds, retention,
// transcription mode and Deepgram region) are configured by CallGuard staff, not
// self-served by tenants — they carry cost, compliance (retention) and data
// residency implications. The equivalent tenant-facing routes were removed; this
// is the only place they can be changed via the API.
superadminRouter.put('/tenants/:id/scoring-settings', async (req, res, next) => {
  try {
    const body = req.body as {
      adviser_channel?: number | null;
      scoring_scope?: string;
      min_scoreable_seconds?: number;
      min_scoreable_words?: number;
      pass_threshold?: number;
      retention_days?: number;
      transcription_mode?: string;
      deepgram_region?: string;
      journey_window_days?: number | null;
      scoring_samples?: number;
      review_confidence_floor?: number;
    };

    if (
      body.adviser_channel !== undefined &&
      body.adviser_channel !== null &&
      body.adviser_channel !== 0 &&
      body.adviser_channel !== 1
    ) {
      throw new AppError(400, 'adviser_channel must be 0 (left), 1 (right), or null (auto)');
    }
    if (body.scoring_scope && !['sales_only', 'over_threshold', 'everything'].includes(body.scoring_scope)) {
      throw new AppError(400, 'Invalid scoring_scope');
    }
    if (body.transcription_mode && !['mono_diarize', 'stereo_multichannel'].includes(body.transcription_mode)) {
      throw new AppError(400, 'Invalid transcription_mode');
    }
    if (body.deepgram_region && !['eu', 'us'].includes(body.deepgram_region)) {
      throw new AppError(400, 'Invalid deepgram_region');
    }
    if (body.pass_threshold !== undefined && (body.pass_threshold < 0 || body.pass_threshold > 100)) {
      throw new AppError(400, 'pass_threshold must be between 0 and 100');
    }
    // Each extra sample multiplies the tenant's scoring spend, so the ceiling is
    // the column's CHECK (migration 076) and not a matter of taste.
    if (
      body.scoring_samples !== undefined &&
      (!Number.isInteger(body.scoring_samples) || body.scoring_samples < 1 || body.scoring_samples > 5)
    ) {
      throw new AppError(400, 'scoring_samples must be a whole number between 1 and 5');
    }
    // 0 = off. The ceiling stops short of 1 because a floor of 1 routes every
    // checkpoint to a human and scores nothing (migration 082).
    if (
      body.review_confidence_floor !== undefined &&
      (!Number.isFinite(body.review_confidence_floor) ||
        body.review_confidence_floor < 0 ||
        body.review_confidence_floor > MAX_REVIEW_CONFIDENCE_FLOOR)
    ) {
      throw new AppError(
        400,
        `review_confidence_floor must be between 0 and ${MAX_REVIEW_CONFIDENCE_FLOOR} (0 = off)`
      );
    }
    // Floor retention at 30 days — a retention_days of 0 (or negative) makes the
    // nightly purge delete every call, recording, score and breach within 24h.
    if (body.retention_days !== undefined && (!Number.isInteger(body.retention_days) || body.retention_days < 30)) {
      throw new AppError(400, 'retention_days must be a whole number of at least 30');
    }
    if (
      body.min_scoreable_seconds !== undefined &&
      (!Number.isInteger(body.min_scoreable_seconds) || body.min_scoreable_seconds < 0)
    ) {
      throw new AppError(400, 'min_scoreable_seconds must be a non-negative whole number');
    }
    if (
      body.min_scoreable_words !== undefined &&
      (!Number.isInteger(body.min_scoreable_words) || body.min_scoreable_words < 0)
    ) {
      throw new AppError(400, 'min_scoreable_words must be a non-negative whole number');
    }
    // null is a legitimate value (fall back to the dialler window, then 30 days).
    // A zero or negative window would match no calls at all, so the journey would
    // be skipped silently rather than scored badly — reject it here as well as in
    // the column's CHECK.
    if (
      body.journey_window_days !== undefined &&
      body.journey_window_days !== null &&
      (!Number.isInteger(body.journey_window_days) ||
        body.journey_window_days < 1 ||
        body.journey_window_days > MAX_JOURNEY_WINDOW_DAYS)
    ) {
      throw new AppError(
        400,
        `journey_window_days must be a whole number between 1 and ${MAX_JOURNEY_WINDOW_DAYS}, or null to use the default`
      );
    }

    const rows = await query(
      `UPDATE organizations SET
         adviser_channel        = CASE WHEN $10::boolean THEN $1 ELSE adviser_channel END,
         scoring_scope          = COALESCE($2, scoring_scope),
         min_scoreable_seconds  = COALESCE($3, min_scoreable_seconds),
         min_scoreable_words    = COALESCE($4, min_scoreable_words),
         pass_threshold         = COALESCE($5, pass_threshold),
         retention_days         = COALESCE($6, retention_days),
         transcription_mode     = COALESCE($7, transcription_mode),
         deepgram_region        = COALESCE($8, deepgram_region),
         journey_window_days    = CASE WHEN $12::boolean THEN $11 ELSE journey_window_days END,
         scoring_samples        = COALESCE($13, scoring_samples),
         review_confidence_floor = COALESCE($14, review_confidence_floor),
         updated_at             = now()
       WHERE id = $9
       RETURNING id, adviser_channel, scoring_scope, min_scoreable_seconds,
                 min_scoreable_words, pass_threshold, retention_days,
                 transcription_mode, deepgram_region, journey_window_days,
                 scoring_samples, review_confidence_floor`,
      [
        // adviser_channel's "unset" state is itself a real value (null =
        // auto-detect), so it can't be COALESCE'd. $10 says whether the caller
        // supplied it at all — only then do we overwrite the stored value.
        body.adviser_channel ?? null,
        body.scoring_scope,
        body.min_scoreable_seconds,
        body.min_scoreable_words,
        body.pass_threshold,
        body.retention_days,
        body.transcription_mode,
        body.deepgram_region,
        req.params.id,
        body.adviser_channel !== undefined,
        // Same treatment as adviser_channel: null means "use the fallback", so
        // clearing it has to be distinguishable from not mentioning it.
        body.journey_window_days ?? null,
        body.journey_window_days !== undefined,
        body.scoring_samples,
        // 0 is a real value here ("off"), not an absence — so it has to reach
        // COALESCE as 0 and only an omitted field as null. Hence the explicit
        // undefined check rather than a falsy test.
        body.review_confidence_floor === undefined ? null : body.review_confidence_floor,
      ]
    );
    if (!rows.length) throw new AppError(404, 'Tenant not found');

    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'org.scoring_settings.change',
      entityType: 'organization',
      entityId: req.params.id,
      summary: 'Call-recording & scoring policy changed by CallGuard staff',
      metadata: body,
      req,
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Seed an admin login into an existing tenant ─────────────────────────────────
// Bootstraps an admin for a tenant that has none — e.g. one onboarded via the DB
// script, or where all admins were removed. The Agents "invite" flow can't do
// this (it needs an existing admin session), so this is the chicken-and-egg
// escape hatch. Also used to seed a temporary setup admin during onboarding that
// gets removed before go-live. Returns a one-time temp password to share securely.

superadminRouter.post('/tenants/:id/admin', async (req, res, next) => {
  try {
    const { admin_name, admin_email, skip_2fa } = req.body as {
      admin_name?: string;
      admin_email?: string;
      skip_2fa?: boolean;
    };
    if (!admin_name || !admin_email) {
      throw new AppError(400, 'admin_name and admin_email are required');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email)) {
      throw new AppError(400, 'admin_email is not a valid email address');
    }

    const org = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [req.params.id]
    );
    if (!org) throw new AppError(404, 'Tenant not found');

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [admin_email]);
    if (existing) throw new AppError(409, 'Email already registered');

    // crypto.randomBytes (not Math.random) — this is a real, if short-lived,
    // credential. The admin changes it (and, unless exempt, enrols 2FA) on login.
    const tempPassword = crypto.randomBytes(9).toString('base64url') + 'Cg1!';
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    // skip_2fa marks the account 2FA-exempt: it bypasses the mandatory enrolment
    // gate. Intended for a temporary internal setup login, removed before go-live.
    const exempt = skip_2fa === true;
    const rows = await query<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, password_hash, role, two_factor_exempt)
       VALUES ($1, $2, $3, $4, 'admin', $5) RETURNING id`,
      [org.id, admin_email, admin_name, passwordHash, exempt]
    );

    await recordAuditEvent({
      organizationId: org.id,
      userId: req.user!.userId,
      actionType: 'user.invite',
      entityType: 'user',
      entityId: rows[0]!.id,
      summary: `Seeded admin ${admin_email} for tenant "${org.name}"${exempt ? ' (2FA-exempt setup login)' : ''}`,
      req,
    });

    res.status(201).json({ user_id: rows[0]!.id, admin_email, temp_password: tempPassword, two_factor_exempt: exempt });
  } catch (err) {
    next(err);
  }
});

// ── Delete tenant (hard delete) ─────────────────────────────────────────────────
// Permanently removes an organization and ALL of its data — calls, scores,
// scorecards, breaches, knowledge base, users, audit log, everything — in one
// transaction. Irreversible, and distinct from setting status to 'cancelled'
// (the reversible soft option above). The caller must echo the exact tenant name
// in `confirm_name` as a guard against accidental deletion.

superadminRouter.delete('/tenants/:id', async (req, res, next) => {
  try {
    const { confirm_name } = req.body as { confirm_name?: string };
    const org = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [req.params.id]
    );
    if (!org) throw new AppError(404, 'Tenant not found');
    if (!confirm_name || confirm_name !== org.name) {
      throw new AppError(
        400,
        `To confirm deletion, confirm_name must exactly match the tenant name ("${org.name}").`
      );
    }

    const cfIp = req.headers['cf-connecting-ip'];
    const result = await deleteOrganizationCascade(org.id, {
      userId: req.user?.userId ?? null,
      orgName: org.name,
      ip: (Array.isArray(cfIp) ? cfIp[0] : cfIp) || req.ip || null,
      userAgent: req.headers['user-agent']?.toString().slice(0, 500) || null,
    });

    // The tenant's own audit_log is purged with it; the deletion is recorded as a
    // retained platform-level audit event (organization_id NULL) inside the same
    // transaction. Also log to the operator stream.
    console.warn(
      `[superadmin] Tenant deleted: "${org.name}" (${org.id}) by user ` +
        `${req.user?.userId ?? 'unknown'} — ${result.total} rows removed`
    );

    res.json({ deleted: true, id: org.id, name: org.name, ...result });
  } catch (err) {
    next(err);
  }
});

// ── Impersonate tenant admin ──────────────────────────────────────────────────
// Issues a short-lived (1 h) JWT as the org's first admin user.
// Intended for support; all activity is under the org admin's identity.

superadminRouter.post('/tenants/:id/impersonate', async (req, res, next) => {
  try {
    // Only impersonate an admin who can actually sign in — a login_disabled
    // admin is barred from authenticating, so minting a session as them would
    // bypass that guard entirely.
    const admin = await queryOne<{ id: string; organization_id: string; role: string }>(
      `SELECT id, organization_id, role FROM users
       WHERE organization_id = $1 AND role = 'admin' AND login_disabled = false
       ORDER BY created_at LIMIT 1`,
      [req.params.id]
    );
    if (!admin) throw new AppError(404, 'No admin user found for this tenant');

    const payload: AuthPayload = {
      userId: admin.id,
      organizationId: admin.organization_id,
      role: admin.role,
      // The superadmin already authenticated (with their own 2FA), so the
      // impersonated session bypasses the tenant user's enrolment gate.
      mfa: true,
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

    // The admin console doesn't know the tenant app's origin (it's a separate
    // deployment); the API does (APP_URL), so build the ready-to-use link here
    // rather than have the frontend guess it or make ops paste a raw JWT into
    // devtools localStorage.
    const url = `${config.appUrl}/impersonate#token=${encodeURIComponent(token)}`;
    res.json({ token, url, note: 'Impersonation link — expires in 1 hour' });
  } catch (err) {
    next(err);
  }
});

// ── Reset a user's 2FA ────────────────────────────────────────────────────────
// Support escape hatch for a user locked out of their authenticator and backup
// codes. Clears their enrolment, drops pending codes, and revokes active refresh
// tokens so they must re-authenticate and re-enrol (2FA is mandatory).

superadminRouter.post('/users/:id/reset-2fa', async (req, res, next) => {
  try {
    const target = await queryOne<{ id: string; email: string; organization_id: string | null }>(
      'SELECT id, email, organization_id FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!target) throw new AppError(404, 'User not found');

    await query(
      `UPDATE users
          SET totp_secret = NULL, totp_enabled = false, two_factor_enrolled_at = NULL
        WHERE id = $1`,
      [target.id]
    );
    await query('DELETE FROM two_factor_backup_codes WHERE user_id = $1', [target.id]);
    await query('DELETE FROM two_factor_email_codes WHERE user_id = $1', [target.id]);
    // Force a fresh login (and re-enrolment) by revoking active refresh tokens.
    await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [target.id]
    );

    if (target.organization_id) {
      await recordAuditEvent({
        organizationId: target.organization_id,
        userId: req.user!.userId,
        actionType: 'auth.2fa.reset',
        entityType: 'user',
        entityId: target.id,
        summary: `Superadmin reset 2FA for ${target.email}`,
        req,
      });
    }

    res.json({ ok: true, note: 'User must log in again and re-enrol in 2FA' });
  } catch (err) {
    next(err);
  }
});

// ── Usage & cost ledger ───────────────────────────────────────────────────────
// Actual per-operation cost from usage_events (written live by every processor).
// Window: ?days=N (rolling, default 30) or ?from=&to= (explicit London days).
superadminRouter.get('/usage', async (req, res, next) => {
  try {
    const w = resolveWindow(req.query as Record<string, unknown>, 30);
    const p = windowParams(w);
    const n = (v: unknown) => Number(v ?? 0);
    const range = inWindow('created_at');

    const [byProvider, byOperation, byModel, daily, topTenants, scored, totals] = await Promise.all([
      query<{ provider: string; events: string; cost_usd: string }>(
        `SELECT provider, COUNT(*)::text AS events, COALESCE(SUM(est_cost_usd),0)::text AS cost_usd
           FROM usage_events WHERE ${range} GROUP BY provider ORDER BY 3 DESC`, p),
      query<{ operation: string; events: string; input_tokens: string; output_tokens: string; cache_read_tokens: string; cache_creation_tokens: string; cost_usd: string }>(
        `SELECT operation, COUNT(*)::text AS events,
                COALESCE(SUM(input_tokens),0)::text AS input_tokens,
                COALESCE(SUM(output_tokens),0)::text AS output_tokens,
                COALESCE(SUM(cache_read_tokens),0)::text AS cache_read_tokens,
                COALESCE(SUM(cache_creation_tokens),0)::text AS cache_creation_tokens,
                COALESCE(SUM(est_cost_usd),0)::text AS cost_usd
           FROM usage_events WHERE ${range} GROUP BY operation ORDER BY 7 DESC`, p),
      query<{ model_id: string | null; events: string; input_tokens: string; output_tokens: string; cost_usd: string }>(
        `SELECT model_id, COUNT(*)::text AS events,
                COALESCE(SUM(input_tokens),0)::text AS input_tokens,
                COALESCE(SUM(output_tokens),0)::text AS output_tokens,
                COALESCE(SUM(est_cost_usd),0)::text AS cost_usd
           FROM usage_events WHERE ${range} GROUP BY model_id ORDER BY 5 DESC`, p),
      // One row per London day in the window, including days with no spend —
      // otherwise the chart silently closes the gaps and the bars stop lining up
      // with the dates they claim to represent.
      query<{ day: string; cost_usd: string; events: string }>(
        `SELECT to_char(g.d, 'YYYY-MM-DD') AS day,
                COALESCE(SUM(ue.est_cost_usd),0)::text AS cost_usd,
                COUNT(ue.id)::text AS events
           FROM generate_series($1::date, $2::date, interval '1 day') AS g(d)
           LEFT JOIN usage_events ue
             ON ue.created_at >= g.d AT TIME ZONE '${LONDON}'
            AND ue.created_at <  (g.d + interval '1 day') AT TIME ZONE '${LONDON}'
          GROUP BY g.d ORDER BY g.d`, p),
      query<{ organization_id: string | null; name: string | null; cost_usd: string; events: string }>(
        `SELECT ue.organization_id, o.name,
                COALESCE(SUM(ue.est_cost_usd),0)::text AS cost_usd, COUNT(*)::text AS events
           FROM usage_events ue LEFT JOIN organizations o ON o.id = ue.organization_id
          WHERE ${inWindow('ue.created_at')} GROUP BY ue.organization_id, o.name ORDER BY 3 DESC LIMIT 20`, p),
      // Scored *in the window* — the ledger's costs are incurred at scoring time,
      // so the denominator has to be keyed off when scoring happened, not when the
      // call was ingested (a call can be ingested months before it is scored, and
      // journey/sale scoring never touches calls.status at all).
      queryOne<{ scored_calls: string; scored_journeys: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM call_scores WHERE ${inWindow('created_at')}) AS scored_calls,
           (SELECT COUNT(*)::text FROM journeys
             WHERE scored_at IS NOT NULL AND ${inWindow('scored_at')})              AS scored_journeys`, p),
      queryOne<{ cost_usd: string; events: string; cache_read: string; uncached_input: string }>(
        `SELECT COALESCE(SUM(est_cost_usd),0)::text AS cost_usd, COUNT(*)::text AS events,
                COALESCE(SUM(cache_read_tokens),0)::text AS cache_read,
                COALESCE(SUM(input_tokens),0)::text AS uncached_input
           FROM usage_events WHERE ${range}`, p),
    ]);

    const totalCostGbp = toGbp(n(totals?.cost_usd));
    const scoredCalls = n(scored?.scored_calls);
    const scoredJourneys = n(scored?.scored_journeys);
    const scoredUnits = scoredCalls + scoredJourneys;
    const cacheRead = n(totals?.cache_read);
    const uncachedInput = n(totals?.uncached_input);

    res.json({
      period_days: w.days,
      from: w.from,
      to: w.to,
      currency: 'GBP',
      totals: {
        cost_gbp: totalCostGbp,
        events: n(totals?.events),
        scored_calls: scoredCalls,
        scored_journeys: scoredJourneys,
        scored_units: scoredUnits,
        cost_per_unit: scoredUnits > 0 ? totalCostGbp / scoredUnits : 0,
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
      daily: daily.map((r) => ({ day: r.day, cost_gbp: toGbp(n(r.cost_usd)), events: n(r.events) })),
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

superadminRouter.get('/dashboard', async (req, res, next) => {
  try {
    // Live tiles, MRR and the month-to-date cost are period-independent; the
    // window only drives the "selected range" block.
    const w = resolveWindow(req.query as Record<string, unknown>, 7);
    const p = windowParams(w);

    const [activity, queue, scored, costRows, liveSessions, rangeCost, rangeScored] = await Promise.all([
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
      // Scored today, keyed off when scoring happened (calls.created_at is the
      // ingest time — a call scored today may have been ingested weeks ago) and
      // counting sales alongside calls, since journey scoring never sets
      // calls.status = 'scored'.
      queryOne<{ scored_today: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM call_scores
             WHERE created_at >= date_trunc('day', now() AT TIME ZONE '${LONDON}') AT TIME ZONE '${LONDON}')
         + (SELECT COUNT(*) FROM journeys
             WHERE scored_at >= date_trunc('day', now() AT TIME ZONE '${LONDON}') AT TIME ZONE '${LONDON}')
         )::text AS scored_today`
      ),
      // Actual month-to-date cost from the usage ledger (every operation —
      // transcribe, cleanup, score, verify, live-score, insights — priced at
      // record time, including the mono Deepgram rate and cache multipliers).
      query<{ provider: string; cost_usd: string }>(
        `SELECT provider, COALESCE(SUM(est_cost_usd), 0)::text AS cost_usd
           FROM usage_events
          WHERE created_at >= date_trunc('month', now())
          GROUP BY provider`
      ),
      queryOne<{ active_live_sessions: string }>(
        `SELECT COUNT(*)::text AS active_live_sessions
         FROM live_sessions WHERE status = 'active'`
      ),
      query<{ provider: string; cost_usd: string }>(
        `SELECT provider, COALESCE(SUM(est_cost_usd), 0)::text AS cost_usd
           FROM usage_events WHERE ${inWindow('created_at')} GROUP BY provider`, p),
      queryOne<{ scored_calls: string; scored_journeys: string; calls_ingested: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM call_scores WHERE ${inWindow('created_at')}) AS scored_calls,
           (SELECT COUNT(*)::text FROM journeys
             WHERE scored_at IS NOT NULL AND ${inWindow('scored_at')})              AS scored_journeys,
           (SELECT COUNT(*)::text FROM calls WHERE ${inWindow('created_at')})       AS calls_ingested`, p),
    ]);

    const costByProvider = new Map(costRows.map((r) => [r.provider, Number(r.cost_usd)]));
    const claudeCostMtd = costByProvider.get('anthropic') ?? 0;
    const deepgramCostMtd = costByProvider.get('deepgram') ?? 0;

    const rangeByProvider = new Map(rangeCost.map((r) => [r.provider, Number(r.cost_usd)]));
    const rangeClaude = toGbp(rangeByProvider.get('anthropic') ?? 0);
    const rangeDeepgram = toGbp(rangeByProvider.get('deepgram') ?? 0);
    // Total across every provider, not just the two broken out, so a new
    // provider appearing in the ledger can't go missing from the headline.
    const rangeTotal = toGbp(rangeCost.reduce((sum, r) => sum + Number(r.cost_usd), 0));
    const gbp4 = (v: number) => parseFloat(v.toFixed(4));

    // Platform MRR: headcount billing — every billable seat (all non-exempt
    // tenant users) across active tenants, priced by the tenant's override or
    // the seat's effective tier (per-user bumps included), independent of call
    // activity this month.
    const platformMrr = mrrFromRows(await billableSeatRows());

    res.json({
      active_users_15min:    Number(activity?.active_users_15min || 0),
      calls_in_queue:        Number(queue?.calls_in_queue || 0),
      scored_today:          Number(scored?.scored_today || 0),
      active_live_sessions:  Number(liveSessions?.active_live_sessions || 0),
      platform_claude_cost_mtd:   gbp4(toGbp(claudeCostMtd)),
      platform_deepgram_cost_mtd: gbp4(toGbp(deepgramCostMtd)),
      platform_mrr:               parseFloat(platformMrr.toFixed(2)),
      range: {
        from: w.from,
        to: w.to,
        days: w.days,
        claude_cost_gbp:   gbp4(rangeClaude),
        deepgram_cost_gbp: gbp4(rangeDeepgram),
        total_cost_gbp:    gbp4(rangeTotal),
        scored_calls:      Number(rangeScored?.scored_calls || 0),
        scored_journeys:   Number(rangeScored?.scored_journeys || 0),
        calls_ingested:    Number(rangeScored?.calls_ingested || 0),
      },
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

    // Derive "current" / "previous" month from the DB so the comparison matches
    // the SQL date_trunc basis (avoids a UTC-vs-server-TZ mismatch at the
    // month boundary).
    const monthMeta = await queryOne<{ now_month: string; prev_month: string }>(
      `SELECT to_char(date_trunc('month', now()), 'YYYY-MM')                       AS now_month,
              to_char(date_trunc('month', now()) - interval '1 month', 'YYYY-MM') AS prev_month`
    );
    const isCurrentMonth = month === monthMeta?.now_month;
    const isPrevMonth = month === monthMeta?.prev_month;

    // Tenants to show: currently-active ones, plus any tenant (e.g. since
    // cancelled) that has a frozen ledger row for this month, so historical
    // billing isn't hidden once a tenant churns.
    const orgRows = await query<{
      org_id: string;
      org_name: string;
      plan: string;
      seat_price_override: string | null;
    }>(
      `SELECT o.id AS org_id, o.name AS org_name, o.plan, o.seat_price_override
         FROM organizations o
        WHERE o.status = 'active'
           OR EXISTS (
                SELECT 1 FROM billing_periods bp
                 WHERE bp.organization_id = o.id AND bp.period_month = $1::date
              )
        ORDER BY o.name`,
      [monthStart]
    );

    // Headcount billing per org: the current month is priced live; a past month
    // reads the frozen ledger (so history can't be rewritten). The just-ended
    // month falls back to live headcount until the daily snapshot freezes it.
    const billingByOrg = await billingForMonth(monthStart, { live: isCurrentMonth, liveFallback: isPrevMonth });

    // Actual cost per org from the usage ledger — the complete, correctly-priced
    // spend (every operation: transcribe, cleanup, score, verify, live-score,
    // insights; mono Deepgram rate and cache multipliers included). Split by
    // provider for the Claude/Deepgram columns.
    const costRows = await query<{ org_id: string; provider: string; cost_usd: string }>(
      `SELECT organization_id AS org_id, provider, COALESCE(SUM(est_cost_usd), 0)::text AS cost_usd
         FROM usage_events
        WHERE created_at >= $1::date
          AND created_at <  $1::date + interval '1 month'
          AND organization_id IS NOT NULL
        GROUP BY organization_id, provider`,
      [monthStart]
    );
    const costByOrg = new Map<string, { claude: number; deepgram: number }>();
    for (const r of costRows) {
      const cur = costByOrg.get(r.org_id) ?? { claude: 0, deepgram: 0 };
      if (r.provider === 'anthropic') cur.claude += Number(r.cost_usd);
      else if (r.provider === 'deepgram') cur.deepgram += Number(r.cost_usd);
      costByOrg.set(r.org_id, cur);
    }

    const billing = orgRows.map((r) => {
      const cost = costByOrg.get(r.org_id) ?? { claude: 0, deepgram: 0 };
      const billed = billingByOrg.get(r.org_id);

      return {
        org_id:                r.org_id,
        org_name:              r.org_name,
        plan:                  r.plan,
        month,
        // Billed seats = headcount of billable users (live for the current
        // month, frozen ledger for past months) — not call activity.
        active_seats:          billed?.seatCount ?? 0,
        seat_price_override:   r.seat_price_override == null ? null : Number(r.seat_price_override),
        monthly_income:        parseFloat((billed?.total ?? 0).toFixed(2)),
        claude_cost_estimate:  parseFloat(toGbp(cost.claude).toFixed(4)),
        deepgram_cost_estimate: parseFloat(toGbp(cost.deepgram).toFixed(4)),
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
         to_char(date_trunc('month', c.created_at AT TIME ZONE 'Europe/London'), 'YYYY-MM') AS month,
         COUNT(DISTINCT c.agent_id) FILTER (
           WHERE c.agent_id NOT IN (SELECT id FROM users WHERE billing_exempt)
         )::text                                               AS active_seats,
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

    // Actual cost per month from the usage ledger (complete + correctly priced),
    // split by provider for the Claude/Deepgram columns.
    const costRows = await query<{ month: string; provider: string; cost_usd: string }>(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Europe/London'), 'YYYY-MM') AS month,
              provider, COALESCE(SUM(est_cost_usd), 0)::text AS cost_usd
         FROM usage_events
        WHERE organization_id = $1
          AND created_at >= now() - interval '12 months'
        GROUP BY 1, provider`,
      [req.params.orgId]
    );
    const costByMonth = new Map<string, { claude: number; deepgram: number }>();
    for (const r of costRows) {
      const cur = costByMonth.get(r.month) ?? { claude: 0, deepgram: 0 };
      if (r.provider === 'anthropic') cur.claude += Number(r.cost_usd);
      else if (r.provider === 'deepgram') cur.deepgram += Number(r.cost_usd);
      costByMonth.set(r.month, cur);
    }

    // Billed seats + income per month: frozen ledger for past months, live
    // headcount for the current month.
    const billingHistory = await billingHistoryForOrg(req.params.orgId);
    const currentBilling = await currentBillingForOrg(req.params.orgId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const billedFor = (m: string) =>
      m === currentMonth ? currentBilling : billingHistory.get(m) ?? { seatCount: 0, total: 0 };
    const callsByMonth = new Map(monthRows.map((r) => [r.month, Number(r.calls)]));

    // Union of every month that has call activity, cost, or billing — so a
    // month with real cost/billing but no scored calls isn't dropped.
    const months = [
      ...new Set<string>([
        ...monthRows.map((r) => r.month),
        ...costByMonth.keys(),
        ...billingHistory.keys(),
        currentMonth,
      ]),
    ].sort();

    const breakdown = months.map((month) => {
      const cost = costByMonth.get(month) ?? { claude: 0, deepgram: 0 };
      const billed = billedFor(month);
      return {
        month,
        active_seats:           billed.seatCount,
        calls:                  callsByMonth.get(month) ?? 0,
        monthly_income:         parseFloat(billed.total.toFixed(2)),
        claude_cost_estimate:   parseFloat(toGbp(cost.claude).toFixed(4)),
        deepgram_cost_estimate: parseFloat(toGbp(cost.deepgram).toFixed(4)),
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

// ── Per-user billing exemption ────────────────────────────────────────────────
// Drop a user from the tenant's billable seat count. Intended for an internal
// CallGuard login seeded into a tenant (setup/support admin) so it never bills
// the tenant a seat, even if test calls get attributed to it. Body: { exempt }.

superadminRouter.put('/tenants/:id/users/:userId/billing-exempt', async (req, res, next) => {
  try {
    const { exempt } = req.body as { exempt?: unknown };
    if (typeof exempt !== 'boolean') {
      throw new AppError(400, 'exempt must be a boolean');
    }

    // Verify the user belongs to this tenant before mutating.
    const user = await queryOne<{ id: string; name: string; email: string }>(
      `SELECT id, name, email FROM users WHERE id = $1 AND organization_id = $2`,
      [req.params.userId, req.params.id]
    );
    if (!user) throw new AppError(404, 'User not found in this tenant');

    const rows = await query<{ id: string; billing_exempt: boolean }>(
      `UPDATE users SET billing_exempt = $1 WHERE id = $2
       RETURNING id, billing_exempt`,
      [exempt, req.params.userId]
    );

    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'tenant.billing_exempt',
      entityType: 'user',
      entityId: req.params.userId,
      summary: `${user.email} ${exempt ? 'excluded from' : 'included in'} billable seat count`,
      req,
    });

    res.json({ user_id: rows[0].id, billing_exempt: rows[0].billing_exempt });
  } catch (err) {
    next(err);
  }
});

// ── Data Forms module toggles ─────────────────────────────────────────────────
// Separate from feature_overrides above: those grant a plan-gated feature, these
// switch on a module that is off for everyone by default regardless of plan.
//
// Staff-controlled, not tenant self-serve. Both modules need setup work done
// alongside the flag — a question set for capture, a confirmed document profile
// for reconciliation — so a tenant switching them on unaided would see an empty
// or misleading surface.
//
// NB: before this existed, capture_enabled had no write path anywhere in the
// codebase. It was read on GET /organization and set by nothing, so Part A could
// only be enabled with direct SQL against production.

const DATA_FORMS_MODULES = {
  capture_enabled: 'Data Capture',
  reconciliation_enabled: 'Application reconciliation',
} as const;

type DataFormsModule = keyof typeof DATA_FORMS_MODULES;

superadminRouter.put('/tenants/:id/modules', async (req, res, next) => {
  try {
    const { module, enabled } = req.body as { module?: string; enabled?: boolean };
    if (!module || !(module in DATA_FORMS_MODULES)) {
      throw new AppError(400, `module must be one of: ${Object.keys(DATA_FORMS_MODULES).join(', ')}`);
    }
    if (typeof enabled !== 'boolean') throw new AppError(400, 'enabled must be true or false');
    const key = module as DataFormsModule;

    // Column name comes from the allow-list above, never from the request body.
    const rows = await query<Record<string, boolean>>(
      `UPDATE organizations SET ${key} = $1, updated_at = now()
        WHERE id = $2
       RETURNING capture_enabled, reconciliation_enabled`,
      [enabled, req.params.id]
    );
    if (!rows.length) throw new AppError(404, 'Tenant not found');

    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'tenant.module_toggle',
      entityType: 'organization',
      entityId: req.params.id,
      summary: `${DATA_FORMS_MODULES[key]} module ${enabled ? 'ENABLED' : 'disabled'}`,
      req,
    });

    res.json(rows[0]);
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

// ── PII/PHI redaction exemption (Data Capture value reconciliation) ──────────
// Turns off Deepgram's health + identity redaction (phi, name, dob, email,
// address) for every call this tenant sends to transcription — pci/numbers
// stay redacted unconditionally regardless (see services/transcription.ts).
// This is the mechanism behind Data Capture value-level reconciliation
// (comparing what the customer actually said to what was submitted on their
// behalf) for a tenant whose capture form needs real health/personal answers,
// not just confirmation a question was asked. Superadmin-only rather than
// tenant self-serve, because switching it on is a joint CallGuard/tenant
// compliance decision requiring a DPIA — note is mandatory when enabling so
// there is a durable record of what authorised the exposure.
superadminRouter.put('/tenants/:id/pii-redaction-exemption', async (req, res, next) => {
  try {
    // Migration 079: an explicit list of redaction categories this tenant may
    // keep in the clear, replacing the old all-or-nothing boolean. Identity
    // fields (Article 6) and health (Article 9) are separate decisions with
    // separate legal bars, so they are permitted separately.
    const { categories, note } = req.body as { categories?: unknown; note?: string };
    if (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string')) {
      throw new AppError(400, 'categories must be an array of strings (empty array redacts everything)');
    }
    const requested = [...new Set(categories as string[])];

    // 'pci' is rejected outright rather than silently dropped: a caller asking
    // for it has misunderstood something, and a silent success would leave them
    // believing card data is in the clear when it never will be.
    if (requested.includes('pci')) {
      throw new AppError(400, 'pci redaction can never be disabled — card and bank data is out of scope for any exemption');
    }
    const permittable: string[] = REDACTION_CATEGORIES.filter((c) => c !== 'pci');
    const unknown = requested.filter((c) => !permittable.includes(c));
    if (unknown.length) {
      throw new AppError(400, `unknown redaction categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')}. Valid: ${permittable.join(', ')}`);
    }

    const trimmedNote = typeof note === 'string' ? note.trim().slice(0, 2000) : '';
    if (requested.length > 0 && !trimmedNote) {
      throw new AppError(400, 'note is required when permitting any category (record the DPIA reference/approver)');
    }

    const rows = await query<{
      id: string;
      pii_unredacted_categories: string[];
      pii_redaction_exempt_note: string | null;
    }>(
      `UPDATE organizations SET pii_unredacted_categories = $1, pii_redaction_exempt_note = $2
       WHERE id = $3 RETURNING id, pii_unredacted_categories, pii_redaction_exempt_note`,
      [requested, requested.length ? trimmedNote : null, req.params.id]
    );
    if (!rows.length) throw new AppError(404, 'Tenant not found');

    await recordAuditEvent({
      organizationId: req.params.id,
      userId: req.user!.userId,
      actionType: 'tenant.pii_redaction_exemption',
      entityType: 'organization',
      entityId: req.params.id,
      summary: requested.length
        ? `Redaction exemption set — unredacted: ${requested.join(', ')} — ${trimmedNote}`
        : 'Redaction exemption cleared — all categories redacted',
      req,
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Failed / stuck calls for one tenant ───────────────────────────────────────
// Calls that failed, or that services/stuck.ts calls stuck — the same test the
// repair sweep and the dashboard health strip use. This panel used to define
// "stuck" itself as any pre-terminal status older than 15 minutes, which
// permanently flagged the calls of every sales_only tenant: 'transcribed' is
// where their calls rest by design until the sale trigger fires. Newest first.

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
      `SELECT c.id, c.status, c.file_name, c.external_id, c.agent_name, c.customer_phone,
              c.error_message, c.created_at, c.updated_at,
              (${STUCK_CALL_SQL}) AS stuck
       FROM calls c
       WHERE c.organization_id = $3
         AND (c.status = 'failed' OR (${STUCK_CALL_SQL}))
       ORDER BY c.updated_at DESC
       LIMIT 100`,
      [STUCK_QUEUED_AFTER_MINUTES, STUCK_INFLIGHT_AFTER_MINUTES, req.params.id]
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
    // `to` is a date-only value from a date picker. An inclusive `<=` casts
    // to midnight on that date, excluding the rest of the day — an exclusive
    // bound at the start of the following day includes the whole end date.
    if (req.query.to)          add('a.created_at < ($?::date + interval \'1 day\')', req.query.to);

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
// Redis reachability, worker liveness, per-queue depth + last completed job,
// and genuinely stuck work. Used by the dashboard health strip.
//
// Three things this deliberately gets right, having got them wrong before:
//  * Worker liveness is reported, not inferred. All-zero queues plus "Redis up"
//    used to look identical whether the worker was idle or dead.
//  * Failures are split into retained (the whole failed set, which BullMQ keeps
//    for hundreds of jobs and never expires) and recent (the last hour). Only
//    recent failures mean something is wrong *now*; the retained total alone
//    pinned the panel red forever.
//  * "Stuck" comes from services/stuck.ts, the same definition the repair sweep
//    acts on, so the number is always something that can actually be fixed.

const HEALTH_QUEUES = () => [
  { name: 'transcription', q: getTranscriptionQueue() },
  { name: 'scoring',       q: getScoringQueue() },
  { name: 'ingestion',     q: getIngestionQueue() },
  { name: 'alerts',        q: getAlertsQueue() },
  { name: 'maintenance',   q: getMaintenanceQueue() },
];

// Failures older than this are history, not a live incident.
const RECENT_FAILURE_WINDOW_MS = 60 * 60 * 1000;
// How many of the newest failed jobs we inspect for a timestamp. A queue with
// more than this many failures inside the window reports the cap and sets
// failed_recent_capped, rather than implying a smaller number.
const FAILED_SCAN_LIMIT = 100;
// The worker writes its heartbeat every 30s (jobs/worker.ts); allow 2.5×
// before calling it stale, matching /api/health/ready.
const HEARTBEAT_STALE_MS = 75_000;

superadminRouter.get('/health', async (_req, res, next) => {
  try {
    const queues = HEALTH_QUEUES();

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
          const failedTotal = counts.failed ?? 0;

          // The failed set is returned newest-first, so we can stop counting
          // once a job falls outside the window.
          let failedRecent = 0;
          if (failedTotal > 0) {
            const recent = await q.getJobs(['failed'], 0, FAILED_SCAN_LIMIT - 1);
            const cutoff = Date.now() - RECENT_FAILURE_WINDOW_MS;
            for (const job of recent) {
              // A failed job with no finishedOn is mid-retry bookkeeping; count
              // it as recent rather than silently dropping it.
              if (!job.finishedOn || job.finishedOn >= cutoff) failedRecent++;
              else break;
            }
          }

          return {
            name,
            waiting:  counts.waiting ?? 0,
            active:   counts.active ?? 0,
            delayed:  counts.delayed ?? 0,
            failed:   failedTotal,
            failed_recent: failedRecent,
            failed_recent_capped: failedRecent >= FAILED_SCAN_LIMIT,
            last_completed_at: lastCompleted?.finishedOn
              ? new Date(lastCompleted.finishedOn).toISOString()
              : null,
          };
        } catch {
          return {
            name, waiting: 0, active: 0, delayed: 0, failed: 0,
            failed_recent: 0, failed_recent_capped: false,
            last_completed_at: null, error: true,
          };
        }
      })
    );

    let worker: { ok: boolean; last_beat_at: string | null; age_seconds: number | null; detail?: string };
    try {
      const beat = await readWorkerHeartbeat();
      if (!beat) {
        worker = { ok: false, last_beat_at: null, age_seconds: null, detail: 'no heartbeat (worker down or never started)' };
      } else {
        const ageMs = Date.now() - new Date(beat).getTime();
        worker = {
          ok: ageMs < HEARTBEAT_STALE_MS,
          last_beat_at: beat,
          age_seconds: Math.round(ageMs / 1000),
        };
      }
    } catch (err) {
      worker = { ok: false, last_beat_at: null, age_seconds: null, detail: (err as Error).message };
    }

    const stuck = await summariseStuckWork();

    res.json({
      redis_ok: redisOk,
      worker,
      queues: queueStats,
      stuck,
      // Retained for older clients; `stuck` above is the full picture.
      stuck_calls: stuck.calls,
    });
  } catch (err) {
    next(err);
  }
});

// ── Queue administration ──────────────────────────────────────────────────────
// Inspect, retry and clear the failed sets, and force a repair sweep. Without
// these, a failed job could only be cleared by hand in Redis, so the health
// panel stayed red with no way to act on it from the console.

const QUEUE_BY_NAME = (name: string) => HEALTH_QUEUES().find((q) => q.name === name)?.q ?? null;

// Job payloads are internal ids, but echo an allowlist rather than the raw
// object so a payload that later grows a sensitive field can't leak through.
const JOB_ID_KEYS = ['callId', 'journeyId', 'sourceId', 'organizationId', 'runId', 'ruleId', 'breachId'] as const;

function safeJobRef(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (data && typeof data === 'object') {
    for (const key of JOB_ID_KEYS) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === 'string') out[key] = value;
    }
  }
  return out;
}

superadminRouter.get('/queues/:name/failed', async (req, res, next) => {
  try {
    const queue = QUEUE_BY_NAME(req.params.name);
    if (!queue) throw new AppError(404, `Unknown queue "${req.params.name}"`);

    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const jobs = await queue.getJobs(['failed'], 0, limit - 1);

    res.json({
      queue: req.params.name,
      jobs: jobs.map((job) => ({
        id: String(job.id),
        name: job.name,
        failed_reason: job.failedReason?.slice(0, 500) ?? null,
        failed_at: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        attempts_made: job.attemptsMade,
        ref: safeJobRef(job.data),
      })),
    });
  } catch (err) {
    next(err);
  }
});

superadminRouter.post('/queues/:name/failed/retry', async (req, res, next) => {
  try {
    const queue = QUEUE_BY_NAME(req.params.name);
    if (!queue) throw new AppError(404, `Unknown queue "${req.params.name}"`);

    const { job_ids: jobIds } = req.body as { job_ids?: unknown };
    if (jobIds !== undefined && (!Array.isArray(jobIds) || jobIds.some((id) => typeof id !== 'string'))) {
      throw new AppError(400, 'job_ids must be an array of strings');
    }

    // No job_ids means "everything currently failed", capped so one click can't
    // stampede thousands of Deepgram/Claude calls.
    const targets = jobIds?.length
      ? (await Promise.all((jobIds as string[]).map((id) => queue.getJob(id)))).filter((j) => !!j)
      : await queue.getJobs(['failed'], 0, FAILED_SCAN_LIMIT - 1);

    let retried = 0;
    const failures: string[] = [];
    for (const job of targets) {
      try {
        await job!.retry();
        retried++;
      } catch (err) {
        failures.push(`${job!.id}: ${(err as Error).message}`);
      }
    }

    // "Retry all" is capped, so report what is still failed rather than letting
    // the caller assume the queue was emptied.
    const remainingFailed = (await queue.getJobCounts('failed')).failed ?? 0;

    await recordAuditEvent({
      organizationId: null,
      userId: req.user!.userId,
      actionType: 'platform.queue_retry',
      entityType: 'queue',
      entityId: req.params.name,
      summary: `Retried ${retried} failed job(s) on the ${req.params.name} queue`,
      metadata: { requested: jobIds?.length ?? 'all', retried, remaining_failed: remainingFailed, failures },
      req,
    });

    res.json({
      queue: req.params.name,
      retried,
      failures,
      remaining_failed: remainingFailed,
      batch_limit: FAILED_SCAN_LIMIT,
    });
  } catch (err) {
    next(err);
  }
});

superadminRouter.delete('/queues/:name/failed', async (req, res, next) => {
  try {
    const queue = QUEUE_BY_NAME(req.params.name);
    if (!queue) throw new AppError(404, `Unknown queue "${req.params.name}"`);

    const { job_ids: jobIds } = req.body as { job_ids?: unknown };
    if (jobIds !== undefined && (!Array.isArray(jobIds) || jobIds.some((id) => typeof id !== 'string'))) {
      throw new AppError(400, 'job_ids must be an array of strings');
    }

    let removed = 0;
    if (jobIds?.length) {
      for (const id of jobIds as string[]) {
        const job = await queue.getJob(id);
        if (job) {
          await job.remove();
          removed++;
        }
      }
    } else {
      // grace=0, i.e. regardless of age. clean() returns the ids it removed.
      removed = (await queue.clean(0, 10_000, 'failed')).length;
    }

    await recordAuditEvent({
      organizationId: null,
      userId: req.user!.userId,
      actionType: 'platform.queue_clear',
      entityType: 'queue',
      entityId: req.params.name,
      summary: `Cleared ${removed} failed job(s) from the ${req.params.name} queue`,
      metadata: { requested: jobIds?.length ?? 'all', removed },
      req,
    });

    res.json({ queue: req.params.name, removed });
  } catch (err) {
    next(err);
  }
});

// Force the stuck-repair sweep instead of waiting up to 10 minutes for the
// scheduled one. Runs through the queue so it executes on the worker, using the
// same code path as the scheduled sweep.
superadminRouter.post('/maintenance/stuck-repair', async (req, res, next) => {
  try {
    const job = await getMaintenanceQueue().add(
      'stuck-repair',
      {},
      { jobId: `stuck-repair-manual-${Date.now()}` }
    );

    await recordAuditEvent({
      organizationId: null,
      userId: req.user!.userId,
      actionType: 'platform.stuck_repair',
      entityType: 'queue',
      entityId: 'maintenance',
      summary: 'Triggered a manual stuck-work repair sweep',
      req,
    });

    res.status(202).json({ enqueued: true, job_id: String(job.id) });
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
