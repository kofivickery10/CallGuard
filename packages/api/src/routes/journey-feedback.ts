import { Router } from 'express';
import { authenticate, requireActioner } from '../middleware/auth.js';
import { queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { isUuid } from '../services/uuid.js';
import {
  resolveAdviser,
  breachesForFeedback,
  openReviewCount,
  latestFeedback,
  sendFeedback,
  lookupFeedback,
  confirmFeedback,
  hashFeedbackToken,
} from '../services/journey-feedback.js';

// ============================================================
// Sale-level adviser feedback.
//
// Two very different surfaces in one file, and the difference matters:
//
//  * feedbackRouter is authenticated and org-scoped, for the supervisor.
//  * publicFeedbackRouter is UNAUTHENTICATED, because the adviser confirming
//    may have no login at all (061). The token is the credential.
//
// Within publicFeedbackRouter, GET and POST are also deliberately different:
// GET /:token is a read-only status check (what the page load does), and
// POST /:token/confirm is the actual acknowledgment (what the button click
// does). They are split so that a mail-security gateway prefetching the
// emailed link — which only ever GETs it — cannot fabricate a confirmation.
//
// feedbackRouter is mounted at the bare `/api` prefix in app.ts (its routes
// live under /journeys/:journeyId/feedback, not /feedback), so `authenticate`
// and `requireActioner` MUST be applied per-route rather than with
// `router.use(...)`. Express 4 runs router-level `use()` middleware for every
// request that reaches the router, even ones that match no route inside it —
// so a router-level auth guard here would 401 any other `/api/*` request that
// happens to be routed to this file before it can fall through.
// ============================================================

export const feedbackRouter = Router();

/**
 * What feeding this sale back would involve, and what has happened already.
 * Drives the button's enabled state and the warning text, so the supervisor sees
 * the blockers before they click rather than as an error afterwards.
 */
feedbackRouter.get('/journeys/:journeyId/feedback', authenticate, requireActioner, async (req, res, next) => {
  try {
    const { journeyId } = req.params;
    if (!isUuid(journeyId)) throw new AppError(400, 'Invalid sale id');
    const organizationId = req.user!.organizationId;

    const journey = await queryOne<{ id: string }>(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, organizationId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');

    const [adviser, breaches, openReviews, existing] = await Promise.all([
      resolveAdviser(journeyId),
      breachesForFeedback(organizationId, journeyId),
      openReviewCount(journeyId),
      latestFeedback(organizationId, journeyId),
    ]);

    res.json({
      adviser: { name: adviser.name, email: adviser.email, problem: adviser.problem },
      breach_count: breaches.length,
      breaches: breaches.map((b) => ({ label: b.item_label, severity: b.severity })),
      open_reviews: openReviews,
      feedback: existing,
    });
  } catch (err) {
    next(err);
  }
});

/** Send it. */
feedbackRouter.post('/journeys/:journeyId/feedback', authenticate, requireActioner, async (req, res, next) => {
  try {
    const { journeyId } = req.params;
    if (!isUuid(journeyId)) throw new AppError(400, 'Invalid sale id');
    const organizationId = req.user!.organizationId;

    const journey = await queryOne<{ id: string; status: string }>(
      'SELECT id, status FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, organizationId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');
    if (journey.status !== 'scored') {
      throw new AppError(400, 'This sale has not been scored yet, so there is nothing to feed back.');
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : null;

    let result;
    try {
      result = await sendFeedback({
        organizationId,
        journeyId,
        sentBy: req.user!.userId,
        message: message || null,
      });
    } catch (err) {
      // resolveAdviser's refusals are the supervisor's problem to fix, not a
      // server fault: surface the reason rather than a 500.
      throw new AppError(400, (err as Error).message);
    }

    await recordAuditEvent({
      organizationId,
      userId: req.user!.userId,
      actionType: 'journey.feedback_sent',
      entityType: 'journey',
      entityId: journeyId,
      summary: `Fed back ${result.itemCount} finding(s) on this sale to ${result.adviser.name}`,
      metadata: {
        feedback_id: result.feedbackId,
        adviser_user_id: result.adviser.userId,
        item_count: result.itemCount,
      },
      req,
    });

    res.status(201).json({
      id: result.feedbackId,
      adviser_name: result.adviser.name,
      item_count: result.itemCount,
    });
  } catch (err) {
    next(err);
  }
});

// ── The adviser's side ────────────────────────────────────────────────────────

export const publicFeedbackRouter = Router();

/**
 * A read-only status check, opened by loading the page from the emailed link.
 * Mounted outside `authenticate` on purpose. Deliberately does NOT confirm
 * anything — mail-security gateways routinely prefetch links in emails, and a
 * GET that recorded an acknowledgment as a side effect could produce a
 * compliance record of an adviser having "seen" feedback they never opened.
 * Confirmation is the separate POST below, behind a button click on the page.
 *
 * Always answers with a 200 and a status rather than an error code: this is
 * opened by a person in a mail client, not by a program, and "410 Gone" is not
 * something to show an adviser. The page renders the outcome.
 */
publicFeedbackRouter.get('/:token', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 20 || token.length > 200) {
      res.json({ status: 'not_found' });
      return;
    }

    const result = await lookupFeedback(token);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * The adviser's deliberate click. This is the only path that can confirm a
 * feedback record — split out from the GET above so that a prefetched or
 * scanned link can never do it on the adviser's behalf.
 */
publicFeedbackRouter.post('/:token/confirm', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 20 || token.length > 200) {
      res.json({ status: 'not_found' });
      return;
    }

    const cfIp = req.headers['cf-connecting-ip'];
    const ip = (Array.isArray(cfIp) ? cfIp[0] : cfIp) || req.ip || null;

    const result = await confirmFeedback(token, {
      ip,
      userAgent: req.headers['user-agent']?.toString() ?? null,
    });

    if (result.status === 'confirmed') {
      // Audited against the sale so the trail sits with the rest of its history.
      const row = await queryOne<{ organization_id: string; journey_id: string; adviser_user_id: string | null }>(
        `SELECT organization_id, journey_id, adviser_user_id FROM journey_feedback
          WHERE token_hash = $1`,
        [hashFeedbackToken(token)]
      );
      if (row) {
        await recordAuditEvent({
          organizationId: row.organization_id,
          userId: row.adviser_user_id,
          actionType: 'journey.feedback_confirmed',
          entityType: 'journey',
          entityId: row.journey_id,
          summary: `${result.adviserName} confirmed they received feedback on this sale`,
          metadata: { item_count: result.itemCount },
          req,
        });
      }
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});
