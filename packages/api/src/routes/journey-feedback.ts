import { Router } from 'express';
import { authenticate, requireActioner } from '../middleware/auth.js';
import { queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { pushJourneyFeedbackRelease } from '../services/score-writeback.js';
import { isUuid } from '../services/uuid.js';
import {
  resolveAdviser,
  resolveRecipients,
  breachesForFeedback,
  openReviewCount,
  latestFeedback,
  sendFeedback,
  lookupFeedback,
  confirmFeedback,
  hashFeedbackToken,
} from '../services/journey-feedback.js';
import { organisationKeepsHealthUnredacted } from '../services/transcript-access.js';

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

    const [adviser, breaches, openReviews, existing, recipients, keepsHealthUnredacted, sale] =
      await Promise.all([
        resolveAdviser(journeyId),
        breachesForFeedback(organizationId, journeyId),
        openReviewCount(journeyId),
        latestFeedback(organizationId, journeyId),
        // Sent with the panel rather than fetched when the picker opens: it is a
        // handful of rows for a brokerage this size, and one request keeps the
        // suggested adviser and the list they are chosen from consistent.
        resolveRecipients(organizationId),
        organisationKeepsHealthUnredacted(organizationId),
        // Named client, and whether the reasons will travel. The supervisor is
        // authorising a client's name to leave the platform next to compliance
        // findings, and until now they could see neither — only labels and
        // severities. A supervisor who believes the reasons went and finds they did
        // not has been misled by their own send button.
        //
        // The reasons themselves are still NOT returned here. This says what will
        // happen, not what it will say; a rendered preview is its own change.
        queryOne<{ client_name: string | null; customer_name: string | null }>(
          `SELECT j.client_name, cust.name AS customer_name
             FROM journeys j
             LEFT JOIN customers cust ON cust.id = j.customer_id
            WHERE j.id = $1 AND j.organization_id = $2`,
          [journeyId, organizationId]
        ),
      ]);

    res.json({
      adviser: {
        user_id: adviser.userId,
        name: adviser.name,
        email: adviser.email,
        problem: adviser.problem,
      },
      breach_count: breaches.length,
      // Guidance travels with the label so the supervisor can see what the
      // adviser will be told to DO, not merely what was flagged (CG-24). A
      // panel that exists to show what is about to be sent is worth nothing if
      // it omits the only actionable line in the email.
      breaches: breaches.map((b) => ({
        label: b.item_label,
        severity: b.severity,
        remediation_guidance: b.remediation_guidance?.trim() || null,
      })),
      open_reviews: openReviews,
      feedback: existing,
      recipients,
      client_name: sale?.client_name?.trim() || sale?.customer_name?.trim() || null,
      reasoning_included: !keepsHealthUnredacted && breaches.some((b) => !!b.reasoning),
      // Distinguishes "the reasons were suppressed by policy" from "there were
      // no reasons to send". The panel previously blamed the tenant's redaction
      // setting for both, telling a firm that does NOT keep health unredacted
      // that it does.
      reasoning_withheld: keepsHealthUnredacted && breaches.some((b) => !!b.reasoning),
      // Whether any finding carries an instruction the adviser will be asked to
      // act on (CG-24) — the panel says so, because it changes what the
      // acknowledgement means.
      guidance_included: breaches.some((b) => !!b.remediation_guidance?.trim()),
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

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : null;

    // Absent means "use the sale's own adviser". Present but malformed is a
    // client bug, not a fallback: silently defaulting would send the feedback to
    // someone other than the person the supervisor picked. Settled before the
    // journey lookup — shape checks are free, a query is not.
    const rawRecipient = req.body?.adviser_user_id;
    const adviserUserId =
      rawRecipient === undefined || rawRecipient === null || rawRecipient === ''
        ? null
        : String(rawRecipient);
    if (adviserUserId !== null && !isUuid(adviserUserId)) {
      throw new AppError(400, 'Invalid recipient');
    }

    const journey = await queryOne<{ id: string; status: string }>(
      'SELECT id, status FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, organizationId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');
    if (journey.status !== 'scored') {
      throw new AppError(400, 'This sale has not been scored yet, so there is nothing to feed back.');
    }

    let result;
    try {
      result = await sendFeedback({
        organizationId,
        journeyId,
        sentBy: req.user!.userId,
        message: message || null,
        adviserUserId,
      });
    } catch (err) {
      // resolveAdviser's refusals are the supervisor's problem to fix, not a
      // server fault: surface the reason rather than a 500.
      throw new AppError(400, (err as Error).message);
    }

    // Release the sale to Zoho, on a tenant that pushes on feedback (CG-4).
    //
    // This is the trigger Trust Point asked for: nothing reaches the CRM — and
    // so nothing reaches the adviser's commission process — until a person has
    // reviewed the sale and pressed this button. Scoped to this feedback round,
    // so a second round appends its own QA record rather than overwriting what
    // the adviser was told the first time.
    //
    // Best-effort and after the send, exactly like every other write-back: a
    // Zoho outage must not fail a feedback email that has already gone out, and
    // the delivery row it creates carries its own retry.
    void pushJourneyFeedbackRelease(organizationId, journeyId, result.feedbackId);

    await recordAuditEvent({
      organizationId,
      userId: req.user!.userId,
      actionType: 'journey.feedback_sent',
      entityType: 'journey',
      entityId: journeyId,
      // The override is spelled out in the summary, not left in metadata: the
      // summary is the line a supervisor or an auditor actually reads, and
      // "someone chose this recipient" is the whole point of the record. It
      // names who was displaced, because "chosen" without that is a claim an
      // auditor cannot check. On an unattributed sale nobody was displaced, so
      // saying "not the sale's own adviser" would invent one.
      summary:
        result.recipientSource === 'manual'
          ? result.suggestedAdviserName
            ? `Fed back ${result.itemCount} finding(s) on this sale to ${result.adviser.name}, chosen instead of ${result.suggestedAdviserName}`
            : `Fed back ${result.itemCount} finding(s) on this sale to ${result.adviser.name}, chosen — no adviser is attributed to this sale`
          : `Fed back ${result.itemCount} finding(s) on this sale to ${result.adviser.name}`,
      metadata: {
        feedback_id: result.feedbackId,
        adviser_user_id: result.adviser.userId,
        item_count: result.itemCount,
        recipient_source: result.recipientSource,
        suggested_adviser_user_id: result.suggestedAdviserUserId,
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
