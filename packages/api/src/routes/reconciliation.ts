import { Router } from 'express';
import { authenticate, requireAdmin, requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { scoringQueue } from '../jobs/queue.js';
import { isUuid } from '../services/uuid.js';
import { isReconciliationEnabled, learnProfileFromSale } from '../services/reconciliation-runs.js';
import { attemptJobId } from '../services/reconciliation-sweep.js';
import { detectDrift } from '../services/application-pdf.js';
import type {
  ReconciliationRun,
  ReconciliationItem,
  DocumentProfile,
} from '@callguard/shared';

type ProfileRow = DocumentProfile;

// ============================================================
// Application reconciliation routes.
//
// Org-wide read (excludes advisers, like the rest of the Quality/Compliance
// surfaces — a reconciliation finding is about an adviser's own conduct, so it
// belongs with their supervisor rather than with them). Mutations are admin only.
// ============================================================

export const reconciliationRouter = Router();
reconciliationRouter.use(authenticate, requireOrgView);

/**
 * The reconciliation record for one sale.
 *
 * Returns `{ run: null }` rather than 404 when there is nothing, because "this
 * tenant does not have the module" and "this sale predates it" are both normal
 * and the panel renders nothing for them.
 */
reconciliationRouter.get('/journeys/:journeyId', async (req, res, next) => {
  try {
    const { journeyId } = req.params;
    if (!isUuid(journeyId)) throw new AppError(400, 'Invalid journey id');

    const run = await queryOne<ReconciliationRun>(
      `SELECT * FROM capture_reconciliation_runs
        WHERE journey_id = $1 AND organization_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [journeyId, req.user!.organizationId]
    );
    if (!run) return res.json({ run: null, items: [] });

    const items = await query<ReconciliationItem>(
      `SELECT * FROM capture_reconciliation_items WHERE run_id = $1 ORDER BY sort_order ASC`,
      [run.id]
    );
    res.json({ run, items });
  } catch (err) {
    next(err);
  }
});

/** Queue (or re-queue) reconciliation for a sale. Admin only. */
reconciliationRouter.post('/journeys/:journeyId/run', requireAdmin, async (req, res, next) => {
  try {
    const { journeyId } = req.params;
    if (!isUuid(journeyId)) throw new AppError(400, 'Invalid journey id');
    const organizationId = req.user!.organizationId;

    if (!(await isReconciliationEnabled(organizationId))) {
      throw new AppError(400, 'The reconciliation module is not enabled for this organisation');
    }

    const journey = await queryOne<{ id: string; zoho_record_id: string | null }>(
      'SELECT id, zoho_record_id FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, organizationId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');
    if (!journey.zoho_record_id) {
      throw new AppError(
        400,
        'This sale has no CRM record, so there is no application document to fetch.'
      );
    }

    // A deliberate re-run replaces the previous record rather than accumulating
    // rows: the run is keyed one-per-sale, and stale items alongside fresh ones
    // would be indistinguishable in the UI.
    await query(
      'DELETE FROM capture_reconciliation_runs WHERE journey_id = $1 AND organization_id = $2',
      [journeyId, organizationId]
    );
    const created = await queryOne<{ id: string }>(
      `INSERT INTO capture_reconciliation_runs (organization_id, journey_id, status)
       VALUES ($1, $2, 'pending') RETURNING id`,
      [organizationId, journeyId]
    );
    if (!created) throw new AppError(500, 'Could not create the reconciliation run');

    await scoringQueue.add(
      'reconcile',
      { runId: created.id },
      { jobId: attemptJobId(created.id, 0) }
    );

    await recordAuditEvent({
      organizationId,
      userId: req.user!.userId,
      actionType: 'reconciliation.run',
      entityType: 'journey',
      entityId: journeyId,
      summary: 'Application reconciliation re-run',
      req,
    });

    res.json({ id: created.id, status: 'pending' });
  } catch (err) {
    next(err);
  }
});

/**
 * Learn a document profile from this sale's application. Admin only.
 *
 * The bootstrap and the drift fix in one route, because they are the same act:
 * read the document as it is now and propose how to parse it. Nothing learned
 * here judges anything until it is confirmed.
 */
reconciliationRouter.post('/journeys/:journeyId/learn', requireAdmin, async (req, res, next) => {
  try {
    const { journeyId } = req.params;
    if (!isUuid(journeyId)) throw new AppError(400, 'Invalid journey id');
    const organizationId = req.user!.organizationId;

    if (!(await isReconciliationEnabled(organizationId))) {
      throw new AppError(400, 'The reconciliation module is not enabled for this organisation');
    }

    const attachmentId =
      typeof req.body?.attachmentId === 'string' && req.body.attachmentId.trim() !== ''
        ? req.body.attachmentId.trim()
        : null;

    const journey = await queryOne<{ zoho_record_id: string | null }>(
      'SELECT zoho_record_id FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, organizationId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');
    if (!journey.zoho_record_id) {
      throw new AppError(400, 'This sale has no CRM record, so there is no document to learn from.');
    }

    const outcome = await learnProfileFromSale(
      organizationId,
      journeyId,
      journey.zoho_record_id,
      attachmentId
    );

    if (outcome.profileId && !outcome.reusedExisting) {
      await recordAuditEvent({
        organizationId,
        userId: req.user!.userId,
        actionType: 'reconciliation.profile_learned',
        entityType: 'capture_document_profile',
        entityId: outcome.profileId,
        summary: `Document profile proposed for ${outcome.insurer ?? 'an unidentified insurer'} from ${outcome.attachment?.file_name ?? 'an attachment'}`,
        req,
      });
    }

    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

/**
 * The attention queue: runs with findings, or waiting on something.
 *
 * `undetermined` items are deliberately NOT counted as findings. They mean the
 * system could not tell, usually because health redaction removed the words
 * identifying the question, and surfacing them here would bury the real flags
 * under noise of our own making.
 */
reconciliationRouter.get('/runs', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await query<Record<string, unknown>>(
      `SELECT r.id, r.journey_id, r.status, r.attachment_name, r.error_message,
              r.created_at, r.completed_at,
              c.name AS customer_name,
              p.insurer, p.product,
              count(i.id) FILTER (WHERE i.outcome = 'mismatch')::int         AS mismatches,
              count(i.id) FILTER (WHERE i.outcome = 'not_asked')::int        AS not_asked,
              count(i.id) FILTER (WHERE i.outcome = 'asked_no_answer')::int  AS no_answer,
              count(i.id) FILTER (WHERE i.outcome = 'undetermined')::int     AS undetermined,
              count(i.id) FILTER (WHERE i.amendment_type = 'disclosure_withdrawn')::int AS withdrawn,
              count(i.id)::int AS total_questions
         FROM capture_reconciliation_runs r
         JOIN journeys j ON j.id = r.journey_id
         JOIN customers c ON c.id = j.customer_id
         LEFT JOIN capture_document_profiles p ON p.id = r.profile_id
         LEFT JOIN capture_reconciliation_items i ON i.run_id = r.id
        WHERE r.organization_id = $1
        GROUP BY r.id, c.name, p.insurer, p.product
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [req.user!.organizationId, limit]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

/** Document profiles for this tenant, including any awaiting confirmation. */
reconciliationRouter.get('/profiles', async (req, res, next) => {
  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT id, insurer, product, strategy, status, version, question_fingerprint,
              jsonb_array_length(questions) AS question_count,
              confirmed_by, confirmed_at, created_at
         FROM capture_document_profiles
        WHERE organization_id = $1
        ORDER BY insurer, product, version DESC`,
      [req.user!.organizationId]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * The full profile, including its question list — for the confirmation review.
 *
 * When the profile is awaiting confirmation, the currently-active profile for the
 * same insurer and product comes with it, plus the difference between the two.
 * That difference is the actual decision: confirming a set with a question
 * missing means that question stops being checked on every future sale, and
 * nothing on the screen would otherwise say so.
 *
 * The diff is computed here rather than in the browser so it uses the same
 * detectDrift — and therefore the same normalisation — that decided the
 * question set had changed in the first place. A second implementation would
 * eventually disagree with the detector about what counts as a change.
 */
reconciliationRouter.get('/profiles/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new AppError(400, 'Invalid profile id');
    const profile = await queryOne<ProfileRow>(
      'SELECT * FROM capture_document_profiles WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!profile) throw new AppError(404, 'Profile not found');

    if (profile.status !== 'needs_confirmation') {
      return res.json({ profile, incumbent: null, drift: null });
    }

    const incumbent = await queryOne<ProfileRow>(
      `SELECT * FROM capture_document_profiles
        WHERE organization_id = $1 AND insurer = $2
          AND COALESCE(product, '') = COALESCE($3, '')
          AND status = 'active'`,
      [req.user!.organizationId, profile.insurer, profile.product]
    );

    const drift = incumbent
      ? detectDrift(
          (incumbent.questions ?? []).map((q) => q.question),
          (profile.questions ?? []).map((q) => q.question)
        )
      : null;

    res.json({ profile, incumbent, drift });
  } catch (err) {
    next(err);
  }
});

/**
 * Confirm a learned or changed profile. Admin only.
 *
 * Supersedes the previous active profile for the same insurer and product in one
 * transaction-free but ordered pair of statements — the partial unique index over
 * (org, insurer, product) WHERE status = 'active' means the old one MUST be
 * demoted before the new one is promoted, or the promotion violates it.
 */
reconciliationRouter.put('/profiles/:id/confirm', requireAdmin, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new AppError(400, 'Invalid profile id');
    const organizationId = req.user!.organizationId;

    const profile = await queryOne<{
      id: string;
      insurer: string;
      product: string | null;
      status: string;
    }>(
      'SELECT id, insurer, product, status FROM capture_document_profiles WHERE id = $1 AND organization_id = $2',
      [req.params.id, organizationId]
    );
    if (!profile) throw new AppError(404, 'Profile not found');
    if (profile.status === 'active') return res.json({ id: profile.id, status: 'active' });
    if (profile.status === 'superseded') {
      throw new AppError(400, 'This profile has been superseded and cannot be reactivated');
    }

    await query(
      `UPDATE capture_document_profiles
          SET status = 'superseded', superseded_at = now(), updated_at = now()
        WHERE organization_id = $1 AND insurer = $2
          AND COALESCE(product, '') = COALESCE($3, '')
          AND status = 'active'`,
      [organizationId, profile.insurer, profile.product]
    );
    await query(
      `UPDATE capture_document_profiles
          SET status = 'active', confirmed_by = $1, confirmed_at = now(), updated_at = now()
        WHERE id = $2`,
      [req.user!.userId, profile.id]
    );

    await recordAuditEvent({
      organizationId,
      userId: req.user!.userId,
      actionType: 'reconciliation.profile_confirmed',
      entityType: 'capture_document_profile',
      entityId: profile.id,
      summary: `Document profile confirmed for ${profile.insurer}${profile.product ? ` — ${profile.product}` : ''}`,
      req,
    });

    // Sales parked on the old question set — and any whose format we had never
    // seen — can now be reconciled.
    const waiting = await query<{ id: string; attempts: number }>(
      `SELECT id, attempts FROM capture_reconciliation_runs
        WHERE organization_id = $1 AND status = 'needs_profile'`,
      [organizationId]
    );
    for (const run of waiting) {
      // Attempt-scoped id: the scoring queue retains completed jobs, so a plain
      // `reconcile-<run id>` would be silently deduped against the attempt that
      // parked this run in the first place, and confirming the profile would
      // appear to do nothing.
      await scoringQueue.add(
        'reconcile',
        { runId: run.id },
        { jobId: attemptJobId(run.id, run.attempts) }
      );
    }

    res.json({ id: profile.id, status: 'active', requeued: waiting.length });
  } catch (err) {
    next(err);
  }
});
