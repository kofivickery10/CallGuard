import { Router } from 'express';
import { authenticate, requireAdmin, requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { scoringQueue } from '../jobs/queue.js';
import { isUuid } from '../services/uuid.js';
import {
  isReconciliationEnabled,
  learnProfileFromSale,
  activateProfile,
  dismissProfile,
} from '../services/reconciliation-runs.js';
import { attemptJobId } from '../services/reconciliation-sweep.js';
import { detectDrift } from '../services/application-pdf.js';
import { isPlaceholder } from '../services/document-profile-learner.js';
import type {
  ReconciliationRun,
  ReconciliationItem,
  DocumentProfile,
  ReconciliationDashboardSummary,
  ReconciliationTrendPoint,
  ReconciliationInsurerRow,
  ReconciliationFlaggedQuestion,
  ReconciliationAdviserRow,
  UncoveredSale,
  DocumentProfileQuestion,
  QuestionCheckMode,
} from '@callguard/shared';

type ProfileRow = DocumentProfile;

// ============================================================
// Shared SQL fragments for the dashboard aggregates below.
//
// One definition of "a finding" and one of "conclusive", used by every
// endpoint, so the tiles, the trend and the two breakdowns can never disagree
// about the same sale. 'undetermined' and 'no_application_answer' are in
// neither: the first means we could not tell (usually redaction removed the
// identifying words), the second means the insurer's form was left blank where
// blank is legitimate. Both are silence, and silence is not evidence in either
// direction.
// ============================================================

/**
 * Mirrors ACTIONABLE_RECONCILIATION_OUTCOMES in @callguard/shared, plus the one
 * amendment worth surfacing. Kept as SQL rather than interpolated from the
 * shared constant so the predicate reads as the query it is; if that list
 * changes, this changes with it.
 */
const ITEM_IS_FINDING = `(i.outcome IN ('mismatch', 'not_asked', 'asked_no_answer', 'missing_from_application')
  OR i.amendment_type = 'disclosure_withdrawn')`;

/**
 * The match-rate denominator: questions actually compared against the call.
 *
 * Presence-mode outcomes are deliberately absent from BOTH sides. 'recorded' is
 * excluded because nothing was verified — migration 094 is explicit that
 * counting it would inflate the one number a firm quotes back at us — and
 * 'missing_from_application' is excluded with it, because a denominator holding
 * a presence question's failures but not its successes would depress the rate
 * by exactly the fields nobody checked.
 */
const ITEM_IS_CONCLUSIVE = `i.outcome IN ('match', 'mismatch', 'not_asked', 'asked_no_answer')`;

/**
 * Match rate over conclusive items, as a percentage. NULL when none were.
 *
 * Restricted to runs parsed with a stored profile. A model-read run is the
 * fallback for a format no profile fits yet: migration 093 is explicit that it
 * "cannot be re-derived" and "must never be mistaken for" a deterministic
 * parse, and it is thrown away and re-read the moment a profile goes live. The
 * match rate is the one number a firm quotes back at us, so it is computed only
 * from results that will still say the same thing tomorrow.
 *
 * Model-read findings are NOT suppressed elsewhere — they are real enough to
 * action, and the attention queue shows them. It is only the published *rate*
 * that refuses to average provisional data into a headline.
 *
 * @param runAlias the query's alias for capture_reconciliation_runs.
 */
const matchRateSql = (runAlias: string) => {
  const deterministic = `${runAlias}.extraction_method = 'profile'`;
  return `CASE
    WHEN count(i.id) FILTER (WHERE ${ITEM_IS_CONCLUSIVE} AND ${deterministic}) > 0
    THEN (count(i.id) FILTER (WHERE i.outcome = 'match' AND ${deterministic})::numeric
          / count(i.id) FILTER (WHERE ${ITEM_IS_CONCLUSIVE} AND ${deterministic}) * 100)
    ELSE NULL
  END`;
};

/** Runs that have not finished and have not given up — a live backlog. */
const RUN_IS_PARKED = `status IN ('pending', 'running', 'needs_document', 'needs_profile')`;

/** How many example sales a flagged question carries for the drill-through. */
const FLAGGED_SALE_SAMPLE = 8;

/** Clamp a ?days= window to something a dashboard can actually render. */
function windowDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

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
              -- A presence-mode field left blank: a finding, and the reason
              -- this list is not just the three call-based outcomes (094).
              count(i.id) FILTER (WHERE i.outcome = 'missing_from_application')::int AS missing,
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
              confirmed_by, confirmed_at, created_at,
              dismissed_at, dismissed_reason
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
      questions_vary: boolean;
    }>(
      'SELECT id, insurer, product, status, questions_vary FROM capture_document_profiles WHERE id = $1 AND organization_id = $2',
      [req.params.id, organizationId]
    );
    if (!profile) throw new AppError(404, 'Profile not found');
    if (profile.status === 'active') return res.json({ id: profile.id, status: 'active' });
    if (profile.status === 'superseded') {
      throw new AppError(400, 'This profile has been superseded and cannot be reactivated');
    }

    // Naming the insurer is part of confirming, not part of learning.
    //
    // A broker portal export carries no insurer name anywhere in it — it is a
    // quotation request covering several — so the learner genuinely cannot
    // supply one, and refusing to learn without it would discard the documents
    // that hold the actual health disclosures. But insurer+product is the unique
    // key for an ACTIVE profile, so two unnamed formats going live would collide
    // and the second would displace the first.
    //
    // This is the point where both are true at once: the collision is about to
    // become possible, and there is a person here who knows the answer.
    const {
      insurer: suppliedInsurer,
      product: suppliedProduct,
      questions_vary: suppliedVary,
      check_modes: suppliedModes,
    } = (req.body ?? {}) as {
      insurer?: string;
      product?: string;
      questions_vary?: boolean;
      check_modes?: Record<string, unknown>;
    };
    const insurer = (suppliedInsurer ?? '').trim() || profile.insurer;
    const product = suppliedProduct === undefined ? profile.product : suppliedProduct.trim() || null;

    if (isPlaceholder(insurer)) {
      throw new AppError(
        400,
        'This document does not name its insurer, so it cannot be filed as it stands. ' +
          'Confirm again with the insurer name to activate it.'
      );
    }
    // Whether this insurer's form asks conditional follow-ups is a fact about
    // the form that only a person can settle, and getting it wrong in either
    // direction has a cost: leave it off for a variable form and every sale
    // after the first parks itself; turn it on for a fixed form and a genuine
    // change to the insurer's questions stops being noticed. So it is asked,
    // never guessed.
    const questionsVary =
      typeof suppliedVary === 'boolean' ? suppliedVary : profile.questions_vary;

    // Per-question check modes, keyed by the question's order.
    //
    // The heuristic that stamped these at proposal time is a pair of narrow
    // regexes over a field's label, and it cannot know that one insurer calls a
    // sort code something nobody anticipated, or that a field it took for a bank
    // detail is genuinely read out. This is the screen where somebody who has
    // the document in front of them can say so.
    //
    // Only recognised values are applied, and only to questions that exist. A
    // malformed body must not be able to switch a disclosure question's checking
    // off, which is what an unvalidated write here would allow.
    const modeOverrides = new Map<number, QuestionCheckMode>();
    for (const [key, value] of Object.entries(suppliedModes ?? {})) {
      const order = Number(key);
      if (!Number.isInteger(order)) continue;
      if (value === 'reconcile' || value === 'presence' || value === 'none') {
        modeOverrides.set(order, value);
      }
    }

    const questionsChanged = modeOverrides.size > 0;
    if (questionsChanged) {
      const current = await queryOne<{ questions: DocumentProfileQuestion[] }>(
        'SELECT questions FROM capture_document_profiles WHERE id = $1',
        [profile.id]
      );
      const updated = (current?.questions ?? []).map((q) => {
        const mode = modeOverrides.get(q.order);
        return mode ? { ...q, check_mode: mode } : q;
      });
      await query(
        'UPDATE capture_document_profiles SET questions = $2::jsonb, updated_at = now() WHERE id = $1',
        [profile.id, JSON.stringify(updated)]
      );
    }

    if (
      insurer !== profile.insurer ||
      product !== profile.product ||
      questionsVary !== profile.questions_vary
    ) {
      await query(
        `UPDATE capture_document_profiles
            SET insurer = $2, product = $3, questions_vary = $4, updated_at = now()
          WHERE id = $1`,
        [profile.id, insurer, product, questionsVary]
      );
      profile.insurer = insurer;
      profile.product = product;
      profile.questions_vary = questionsVary;
    }

    const activated = await activateProfile(organizationId, profile.id, {
      auto: false,
      userId: req.user!.userId,
    });
    if (!activated) throw new AppError(409, 'This profile is no longer awaiting confirmation');

    await recordAuditEvent({
      organizationId,
      userId: req.user!.userId,
      actionType: 'reconciliation.profile_confirmed',
      entityType: 'capture_document_profile',
      entityId: profile.id,
      summary: `Document profile confirmed for ${profile.insurer}${profile.product ? ` — ${profile.product}` : ''}`,
      req,
    });

    res.json({ id: profile.id, status: 'active', requeued: activated.requeued });
  } catch (err) {
    next(err);
  }
});

/**
 * Reject a proposed format — the other exit from the review queue.
 *
 * Until this existed the queue had one exit, so a proposal that should never go
 * live had nowhere to go. One tenant's queue held seven formats of which three
 * were duplicates: the same form learned twice under two names, and a copy of a
 * profile already active and reading ten sales. A queue showing work that is not
 * work is one people stop reading, and this queue is where an unread application
 * format turns into sales nobody is checking.
 *
 * Dismissing does NOT stop those sales being checked. With no active profile the
 * run lands at 'needs_profile' and the model fallback reads the document, as it
 * does for any insurer never seen before.
 */
reconciliationRouter.put('/profiles/:id/dismiss', requireAdmin, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new AppError(400, 'Invalid profile id');
    const organizationId = req.user!.organizationId;

    const { reason: suppliedReason } = (req.body ?? {}) as { reason?: string };
    const reason = (suppliedReason ?? '').trim() || null;

    const dismissed = await dismissProfile(organizationId, req.params.id, req.user!.userId, reason);

    if (!dismissed) {
      // Either it does not exist, or it is not awaiting a decision. Told apart
      // here so an admin is not left guessing which — and so dismissing an
      // ACTIVE profile refuses loudly rather than appearing to work. Retiring a
      // live format is done by confirming its successor, which supersedes it and
      // re-checks the sales that were on it; there is no path that quietly stops
      // an insurer being read.
      const existing = await queryOne<{ status: string }>(
        'SELECT status FROM capture_document_profiles WHERE id = $1 AND organization_id = $2',
        [req.params.id, organizationId]
      );
      if (!existing) throw new AppError(404, 'Profile not found');
      if (existing.status === 'dismissed') {
        return res.json({ id: req.params.id, status: 'dismissed' });
      }
      throw new AppError(
        409,
        existing.status === 'active'
          ? 'This format is in use. Confirm a replacement for it instead — dismissing it would stop these sales being read with nothing to take its place.'
          : 'This format is no longer awaiting a decision.'
      );
    }

    await recordAuditEvent({
      organizationId,
      userId: req.user!.userId,
      actionType: 'reconciliation.profile_dismissed',
      entityType: 'capture_document_profile',
      entityId: req.params.id,
      summary:
        `Proposed format dismissed for ${dismissed.insurer}` +
        `${dismissed.product ? ` — ${dismissed.product}` : ''}` +
        `${reason ? `: ${reason}` : ''}`,
      req,
    });

    res.json({ id: req.params.id, status: 'dismissed' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Dashboard aggregates.
//
// The same records the attention queue reads, rolled up. The queue answers
// "what do I do next"; these answer "is the checking working, and where is it
// concentrated" — which is a different question and needs whole-population
// figures rather than a top-N list.
//
// Every window is over the run's created_at, not its completion, so a sale that
// is still parked stays visible in the period it belongs to instead of quietly
// leaving the denominator.
// ============================================================

/** Headline figures for the tile row. */
reconciliationRouter.get('/dashboard/summary', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const days = windowDays(req.query.days);

    const runStats = await queryOne<{
      sales_checked: number;
      model_read: number;
      summary_only: number;
      failed: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'completed')::int AS sales_checked,
         count(*) FILTER (WHERE status = 'completed' AND extraction_method = 'model')::int AS model_read,
         -- Parsed fine, but the document carried no question set. Counted on its
         -- own because it belongs to none of the others: it is not a check, not
         -- a failure, and not something waiting. Without this the tiles silently
         -- fail to account for every run.
         count(*) FILTER (WHERE status = 'summary_only')::int AS summary_only,
         count(*) FILTER (WHERE status IN ('failed','abandoned'))::int AS failed
       FROM capture_reconciliation_runs
      WHERE organization_id = $1
        AND created_at >= now() - make_interval(days => $2::int)`,
      [orgId, days]
    );

    // The backlog is deliberately NOT windowed.
    //
    // A run parked before the window opened is the one that matters most: parked
    // runs retry for 30 days and 'needs_document' gives up after 7, after which
    // nothing self-heals. Counting only the last N days would hide exactly the
    // sales about to age out permanently, which is the opposite of the job.
    const backlog = await queryOne<{ parked: number; oldest_days: number | null }>(
      `SELECT count(*)::int AS parked,
              floor(EXTRACT(EPOCH FROM (now() - min(created_at))) / 86400)::int AS oldest_days
         FROM capture_reconciliation_runs
        WHERE organization_id = $1 AND ${RUN_IS_PARKED}`,
      [orgId]
    );

    // Coverage: sales that should have been checked, against those that were.
    //
    // Every other figure here counts runs that exist, so none of them can see a
    // sale that never got one. That is the failure mode worth catching — if
    // reconciliation quietly stopped being enqueued, a page built only on run
    // rows would look perfectly healthy while nothing was being checked at all.
    const coverage = await queryOne<{ sales_due: number; missing_a_run: number }>(
      `SELECT count(*)::int AS sales_due,
              count(*) FILTER (WHERE r.id IS NULL)::int AS missing_a_run
         FROM journeys j
         LEFT JOIN capture_reconciliation_runs r ON r.journey_id = j.id
        WHERE j.organization_id = $1
          AND j.status = 'scored'
          -- No CRM record means no application document could ever be attached,
          -- so such a sale is not owed a check and must not count against us.
          AND j.zoho_record_id IS NOT NULL
          AND j.scored_at >= now() - make_interval(days => $2::int)`,
      [orgId, days]
    );

    // Item figures come only from runs that actually completed a comparison —
    // a parked run has no items, and counting its absence as a pass or a
    // finding would be a lie in either direction.
    const itemStats = await queryOne<{
      questions_compared: number;
      findings: number;
      sales_with_findings: number;
      undetermined: number;
      recorded: number;
      missing_from_application: number;
      match_rate: string | null;
    }>(
      `SELECT
         count(i.id)::int AS questions_compared,
         count(i.id) FILTER (WHERE ${ITEM_IS_FINDING})::int AS findings,
         count(DISTINCT i.run_id) FILTER (WHERE ${ITEM_IS_FINDING})::int AS sales_with_findings,
         count(i.id) FILTER (WHERE i.outcome = 'undetermined')::int AS undetermined,
         count(i.id) FILTER (WHERE i.outcome = 'recorded')::int AS recorded,
         count(i.id) FILTER (WHERE i.outcome = 'missing_from_application')::int AS missing_from_application,
         ${matchRateSql('r')}::text AS match_rate
       FROM capture_reconciliation_items i
       JOIN capture_reconciliation_runs r ON r.id = i.run_id
      WHERE r.organization_id = $1
        AND r.status = 'completed'
        AND r.created_at >= now() - make_interval(days => $2::int)`,
      [orgId, days]
    );

    // Not windowed on purpose: an unconfirmed question set parks every sale on
    // that format, whenever it was proposed.
    const awaiting = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM capture_document_profiles
        WHERE organization_id = $1 AND status = 'needs_confirmation'`,
      [orgId]
    );

    const parked = backlog?.parked ?? 0;
    const payload: ReconciliationDashboardSummary = {
      days,
      sales_due: coverage?.sales_due ?? 0,
      missing_a_run: coverage?.missing_a_run ?? 0,
      sales_checked: runStats?.sales_checked ?? 0,
      summary_only: runStats?.summary_only ?? 0,
      questions_compared: itemStats?.questions_compared ?? 0,
      match_rate: itemStats?.match_rate != null ? parseFloat(itemStats.match_rate) : null,
      findings: itemStats?.findings ?? 0,
      sales_with_findings: itemStats?.sales_with_findings ?? 0,
      undetermined: itemStats?.undetermined ?? 0,
      recorded: itemStats?.recorded ?? 0,
      missing_from_application: itemStats?.missing_from_application ?? 0,
      model_read: runStats?.model_read ?? 0,
      parked,
      // Only meaningful when something is actually waiting.
      oldest_waiting_days: parked > 0 ? (backlog?.oldest_days ?? 0) : null,
      failed: runStats?.failed ?? 0,
      awaiting_confirmation: awaiting?.n ?? 0,
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/** Weekly checking volume and match rate, gap-filled so quiet weeks show as zero. */
reconciliationRouter.get('/dashboard/trends', async (req, res, next) => {
  try {
    const weeks = Math.min(Math.max(parseInt(req.query.weeks as string) || 12, 1), 52);

    const rows = await query<{
      week_start: string;
      checked: number;
      unchecked: number;
      match_rate: string | null;
    }>(
      `WITH weeks AS (
         SELECT generate_series(
                  date_trunc('week', now() AT TIME ZONE 'Europe/London')
                    - make_interval(weeks => $2::int - 1),
                  date_trunc('week', now() AT TIME ZONE 'Europe/London'),
                  '1 week'::interval
                ) AS wk
       ),
       runs AS (
         SELECT r.id, r.status, r.extraction_method,
                date_trunc('week', r.created_at AT TIME ZONE 'Europe/London') AS wk
           FROM capture_reconciliation_runs r
          WHERE r.organization_id = $1
            AND r.created_at >= now() - make_interval(weeks => $2::int)
       ),
       agg AS (
         SELECT ru.wk,
                count(DISTINCT ru.id) FILTER (WHERE ru.status = 'completed')::int AS checked,
                count(DISTINCT ru.id) FILTER (WHERE ru.status <> 'completed')::int AS unchecked,
                ${matchRateSql('ru')}::text AS match_rate
           FROM runs ru
           LEFT JOIN capture_reconciliation_items i
                  ON i.run_id = ru.id AND ru.status = 'completed'
          GROUP BY ru.wk
       )
       SELECT to_char(w.wk, 'YYYY-MM-DD') AS week_start,
              COALESCE(a.checked, 0) AS checked,
              COALESCE(a.unchecked, 0) AS unchecked,
              a.match_rate
         FROM weeks w
         LEFT JOIN agg a ON a.wk = w.wk
        ORDER BY w.wk`,
      [req.user!.organizationId, weeks]
    );

    const data: ReconciliationTrendPoint[] = rows.map((r) => ({
      week_start: r.week_start,
      checked: r.checked,
      unchecked: r.unchecked,
      match_rate: r.match_rate != null ? parseFloat(r.match_rate) : null,
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/**
 * Findings grouped by the insurer whose form was used.
 *
 * Runs read by the model fallback have no profile, so they group under a single
 * "no stored format" row rather than being dropped — they are exactly the ones
 * worth noticing, being the formats nobody has set up yet.
 */
reconciliationRouter.get('/dashboard/by-insurer', async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const rows = await query<{
      profile_id: string | null;
      insurer: string;
      product: string | null;
      sales: number;
      questions: number;
      match_rate: string | null;
      mismatches: number;
      not_asked: number;
      no_answer: number;
      missing: number;
      withdrawn: number;
    }>(
      `SELECT p.id AS profile_id,
              COALESCE(p.insurer, 'No stored format') AS insurer,
              p.product,
              count(DISTINCT r.id)::int AS sales,
              count(i.id)::int AS questions,
              -- Null for the "no stored format" row by construction: its runs
              -- are all model-read, and there is no rate we would stand behind.
              ${matchRateSql('r')}::text AS match_rate,
              count(i.id) FILTER (WHERE i.outcome = 'mismatch')::int        AS mismatches,
              count(i.id) FILTER (WHERE i.outcome = 'not_asked')::int       AS not_asked,
              count(i.id) FILTER (WHERE i.outcome = 'asked_no_answer')::int AS no_answer,
              count(i.id) FILTER (WHERE i.outcome = 'missing_from_application')::int AS missing,
              count(i.id) FILTER (WHERE i.amendment_type = 'disclosure_withdrawn')::int AS withdrawn
         FROM capture_reconciliation_runs r
         LEFT JOIN capture_document_profiles p ON p.id = r.profile_id
         LEFT JOIN capture_reconciliation_items i ON i.run_id = r.id
        WHERE r.organization_id = $1
          AND r.status = 'completed'
          AND r.created_at >= now() - make_interval(days => $2::int)
        GROUP BY p.id, p.insurer, p.product
        ORDER BY count(DISTINCT r.id) DESC, insurer ASC`,
      [req.user!.organizationId, days]
    );

    const data: ReconciliationInsurerRow[] = rows.map((r) => ({
      profile_id: r.profile_id,
      insurer: r.insurer,
      product: r.product,
      sales: r.sales,
      questions: r.questions,
      match_rate: r.match_rate != null ? parseFloat(r.match_rate) : null,
      mismatches: r.mismatches,
      not_asked: r.not_asked,
      no_answer: r.no_answer,
      missing: r.missing,
      withdrawn: r.withdrawn,
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/**
 * The sales owed a check that do not have one, so the coverage tile can be
 * acted on rather than only believed.
 *
 * Ordered oldest first: a sale that has gone longest without a check is the one
 * closest to being unexplainable to a regulator.
 */
reconciliationRouter.get('/dashboard/uncovered-sales', async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);

    const rows = await query<{
      journey_id: string;
      customer_name: string | null;
      scored_at: string;
    }>(
      `SELECT j.id AS journey_id, c.name AS customer_name, j.scored_at
         FROM journeys j
         JOIN customers c ON c.id = j.customer_id
         LEFT JOIN capture_reconciliation_runs r ON r.journey_id = j.id
        WHERE j.organization_id = $1
          AND j.status = 'scored'
          AND j.zoho_record_id IS NOT NULL
          AND j.scored_at >= now() - make_interval(days => $2::int)
          AND r.id IS NULL
        ORDER BY j.scored_at ASC
        LIMIT $3`,
      [req.user!.organizationId, days, limit]
    );

    const data: UncoveredSale[] = rows.map((r) => ({
      journey_id: r.journey_id,
      customer_name: r.customer_name,
      scored_at: r.scored_at,
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/**
 * Findings per adviser, attributed to the wrap-up (closing) agent — the same
 * attribution the Zoho QA owner and the call dashboard already use, so one sale
 * is never credited to two different people depending on which page you opened.
 *
 * Restricted to deterministic runs. This is the one view that puts a named
 * person against a finding, and migration 094 exists because this system was
 * generating false accusations at scale — one sale ranked worst in its tenant
 * on eight findings, none of them real. A provisional model reading must never
 * be what a supervisor confronts someone with.
 *
 * Ordered by volume, never by findings. A table sorted worst-first reads as a
 * league table of wrongdoing, and with small per-adviser sample sizes the top
 * of it is mostly noise.
 */
reconciliationRouter.get('/dashboard/by-adviser', async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const rows = await query<{
      adviser_id: string;
      adviser_name: string;
      sales: number;
      questions: number;
      match_rate: string | null;
      findings: number;
      mismatches: number;
      not_asked: number;
      no_answer: number;
      missing: number;
      withdrawn: number;
    }>(
      `SELECT u.id AS adviser_id,
              u.name AS adviser_name,
              count(DISTINCT r.id)::int AS sales,
              count(i.id)::int AS questions,
              ${matchRateSql('r')}::text AS match_rate,
              count(i.id) FILTER (WHERE ${ITEM_IS_FINDING})::int AS findings,
              count(i.id) FILTER (WHERE i.outcome = 'mismatch')::int        AS mismatches,
              count(i.id) FILTER (WHERE i.outcome = 'not_asked')::int       AS not_asked,
              count(i.id) FILTER (WHERE i.outcome = 'asked_no_answer')::int AS no_answer,
              count(i.id) FILTER (WHERE i.outcome = 'missing_from_application')::int AS missing,
              count(i.id) FILTER (WHERE i.amendment_type = 'disclosure_withdrawn')::int AS withdrawn
         FROM capture_reconciliation_runs r
         JOIN journeys j ON j.id = r.journey_id
         JOIN journey_calls jc ON jc.journey_id = j.id AND jc.role = 'wrap_up'
         JOIN calls wc ON wc.id = jc.call_id
         JOIN users u ON u.id = wc.agent_id
         LEFT JOIN capture_reconciliation_items i ON i.run_id = r.id
        WHERE r.organization_id = $1
          AND r.status = 'completed'
          AND r.extraction_method = 'profile'
          AND r.created_at >= now() - make_interval(days => $2::int)
        GROUP BY u.id, u.name
        ORDER BY count(DISTINCT r.id) DESC, u.name ASC`,
      [req.user!.organizationId, days]
    );

    const data: ReconciliationAdviserRow[] = rows.map((r) => ({
      adviser_id: r.adviser_id,
      adviser_name: r.adviser_name,
      sales: r.sales,
      questions: r.questions,
      match_rate: r.match_rate != null ? parseFloat(r.match_rate) : null,
      findings: r.findings,
      mismatches: r.mismatches,
      not_asked: r.not_asked,
      no_answer: r.no_answer,
      missing: r.missing,
      withdrawn: r.withdrawn,
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/**
 * The questions flagged most often.
 *
 * Grouped by question AND insurer, never by wording alone: the same sentence on
 * two insurers' forms is two questions, parsed by two different profiles, and
 * merging them would hide which format is actually misbehaving.
 */
reconciliationRouter.get('/dashboard/flagged-questions', async (req, res, next) => {
  try {
    const days = windowDays(req.query.days);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);

    const rows = await query<{
      question: string;
      insurer: string | null;
      flagged: number;
      compared: number;
      mismatches: number;
      not_asked: number;
      no_answer: number;
      missing: number;
      sales: { journey_id: string; customer_name: string | null }[] | null;
    }>(
      `SELECT i.question,
              p.insurer,
              count(DISTINCT r.id) FILTER (WHERE ${ITEM_IS_FINDING})::int AS flagged,
              count(DISTINCT r.id)::int AS compared,
              -- The sales behind the count, so "flagged on 9" can be opened
              -- rather than hunted for. Capped: this is a way in, not a report,
              -- and the number beside it already says how many there are.
              (array_agg(DISTINCT jsonb_build_object('journey_id', r.journey_id, 'customer_name', cu.name))
                 FILTER (WHERE ${ITEM_IS_FINDING}))[1:${FLAGGED_SALE_SAMPLE}] AS sales,
              count(i.id) FILTER (WHERE i.outcome = 'mismatch')::int        AS mismatches,
              count(i.id) FILTER (WHERE i.outcome = 'not_asked')::int       AS not_asked,
              count(i.id) FILTER (WHERE i.outcome = 'asked_no_answer')::int AS no_answer,
              count(i.id) FILTER (WHERE i.outcome = 'missing_from_application')::int AS missing
         FROM capture_reconciliation_items i
         JOIN capture_reconciliation_runs r ON r.id = i.run_id
         JOIN journeys j ON j.id = r.journey_id
         JOIN customers cu ON cu.id = j.customer_id
         LEFT JOIN capture_document_profiles p ON p.id = r.profile_id
        WHERE r.organization_id = $1
          AND r.status = 'completed'
          AND r.created_at >= now() - make_interval(days => $2::int)
        GROUP BY i.question, p.insurer
       HAVING count(*) FILTER (WHERE ${ITEM_IS_FINDING}) > 0
        ORDER BY flagged DESC, compared DESC
        LIMIT $3`,
      [req.user!.organizationId, days, limit]
    );

    const data: ReconciliationFlaggedQuestion[] = rows.map((r) => ({
      question: r.question,
      insurer: r.insurer,
      flagged: r.flagged,
      compared: r.compared,
      mismatches: r.mismatches,
      not_asked: r.not_asked,
      no_answer: r.no_answer,
      missing: r.missing,
      sales: r.sales ?? [],
    }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
