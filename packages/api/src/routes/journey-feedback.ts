import { Router } from 'express';
import type { RequestHandler } from 'express';
import { authenticate, requireActioner } from '../middleware/auth.js';
import { queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import type { AuditActionType } from '../services/audit.js';
import { pushCallFeedbackRelease, pushJourneyFeedbackRelease } from '../services/score-writeback.js';
import { getScoringSettings, scoresCallsIndividually } from '../services/tenant-settings.js';
import { isUuid } from '../services/uuid.js';
import {
  resolveAdviser,
  resolveRecipients,
  breachesForFeedback,
  openReviewCount,
  latestFeedback,
  sendFeedback,
  subjectSummary,
  subjectNoun,
  lookupFeedback,
  confirmFeedback,
  recordRemediationOutcome,
  feedbackAuditContext,
} from '../services/journey-feedback.js';
import type { FeedbackSubject } from '../services/journey-feedback.js';
import { REMEDIATION_OUTCOME_LABELS } from '@callguard/shared';
import type { RemediationOutcome } from '@callguard/shared';
import { organisationKeepsHealthUnredacted } from '../services/transcript-access.js';

// ============================================================
// Adviser feedback on a reviewed sale, or on a call scored on its own
// (migration 118).
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
// live under /journeys/:journeyId/feedback and /calls/:callId/feedback, not
// /feedback), so `authenticate` and `requireActioner` MUST be applied per-route
// rather than with `router.use(...)`. Express 4 runs router-level `use()`
// middleware for every request that reaches the router, even ones that match no
// route inside it — so a router-level auth guard here would 401 any other
// `/api/*` request that happens to be routed to this file before it can fall
// through.
//
// The call routes are reached by falling THROUGH callRouter, which is mounted
// at /api/calls earlier in app.ts and has no /:id/feedback route of its own.
// That is the same fall-through adminShareRouter already relies on for
// /api/calls/:id/share-links, and it is why an unauthenticated request here
// gets its 401 from callRouter's own authenticate before it arrives.
// ============================================================

export const feedbackRouter = Router();

/**
 * What differs between feeding back a sale and feeding back a call, on the
 * supervisor's side. Everything not in here is one handler for both, so the two
 * cannot drift into different rules about who is told what.
 */
interface SubjectRoute {
  kind: FeedbackSubject['kind'];
  param: 'journeyId' | 'callId';
  invalidId: string;
  /**
   * 404s a subject that is not in the organisation. Otherwise returns why a NEW
   * round may not be sent, as the sentence to show, or null when it may.
   *
   * A refusal here stops SENDING only. Reading is never refused: rounds already
   * sent stay visible whatever has changed since — the firm's scoring setting,
   * or the call being assembled into a sale — because the backlog links to them
   * and the re-score and delete refusals name them. A panel that 400s on those
   * would point people at a round they cannot open.
   */
  sendRefusal(organizationId: string, id: string): Promise<string | null>;
  release(organizationId: string, id: string, feedbackId: string): Promise<void>;
  audit: { sent: AuditActionType; entityType: 'journey' | 'call' };
}

const SALE: SubjectRoute = {
  kind: 'journey',
  param: 'journeyId',
  invalidId: 'Invalid sale id',
  async sendRefusal(organizationId, id) {
    const journey = await queryOne<{ id: string; status: string }>(
      'SELECT id, status FROM journeys WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');
    if (journey.status !== 'scored') {
      return 'This sale has not been scored yet, so there is nothing to feed back.';
    }
    return null;
  },
  release: pushJourneyFeedbackRelease,
  audit: { sent: 'journey.feedback_sent', entityType: 'journey' },
};

const CALL: SubjectRoute = {
  kind: 'call',
  param: 'callId',
  invalidId: 'Invalid call id',
  async sendRefusal(organizationId, id) {
    const call = await queryOne<{ id: string; status: string; in_sale: boolean }>(
      // Either marker, not just one: assembly writes journey_calls and
      // calls.journey_id together (services/journey.ts), and the refusal must
      // not depend on the two never having drifted.
      `SELECT c.id, c.status,
              (c.journey_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM journey_calls jc WHERE jc.call_id = c.id)) AS in_sale
         FROM calls c
        WHERE c.id = $1 AND c.organization_id = $2`,
      [id, organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    // Only where the firm's scoring setting is not sales_only
    // (scoresCallsIndividually — the one rule, shared with the Zoho write-back
    // hold). Checked before sale membership so a sales_only firm always gets
    // this sentence rather than one about the particular call it opened.
    //
    // Read live on every request, and never by the public token endpoints
    // below: a call round already sent stays confirmable and answerable if the
    // firm later changes its setting, because the adviser has the email and the
    // record of what they were told must be able to complete.
    const settings = await getScoringSettings(organizationId);
    if (!scoresCallsIndividually(settings)) {
      return 'Your firm scores sales rather than single calls, so feedback is sent from the sale.';
    }

    // The sale owns the conversation. Feeding the call back on its own would
    // give the adviser two acknowledgements for one set of findings, and two
    // follow-up asks for each checkpoint in the backlog. Checked before the
    // score state so a sale's call is never told it merely needs scoring.
    if (call.in_sale) {
      return 'This call is part of a sale. Send feedback from the sale, which covers every call in it.';
    }
    if (call.status !== 'scored') {
      return 'This call has not been scored yet, so there is nothing to feed back.';
    }
    return null;
  },
  release: pushCallFeedbackRelease,
  audit: { sent: 'call.feedback_sent', entityType: 'call' },
};

/**
 * What feeding this subject back would involve, and what has happened already.
 * Drives the button's enabled state and the warning text, so the supervisor sees
 * the blockers before they click rather than as an error afterwards.
 */
function panelHandler(route: SubjectRoute): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = req.params[route.param];
      if (!isUuid(id)) throw new AppError(400, route.invalidId);
      const organizationId = req.user!.organizationId;

      // Computed, never thrown: see sendRefusal. The panel shows the history
      // read-only and says why, rather than failing to load.
      const cannotSendReason = await route.sendRefusal(organizationId, id);
      const subject: FeedbackSubject = { kind: route.kind, id };

      const [adviser, breaches, openReviews, existing, recipients, keepsHealthUnredacted, summary] =
        await Promise.all([
          resolveAdviser(subject),
          breachesForFeedback(organizationId, subject),
          openReviewCount(subject),
          latestFeedback(organizationId, subject),
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
          // The same reader sendFeedback uses, so the name shown here is the name
          // that goes.
          //
          // The reasons themselves are still NOT returned here. This says what will
          // happen, not what it will say; a rendered preview is its own change.
          subjectSummary(organizationId, subject),
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
        client_name: summary.clientName,
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
        // Whether a NEW round may be sent, and if not the sentence the POST
        // would refuse with — the same check, so the button and the send cannot
        // disagree. Existing rounds (`feedback`) are returned either way.
        can_send: cannotSendReason === null,
        cannot_send_reason: cannotSendReason,
      });
    } catch (err) {
      next(err);
    }
  };
}

/** Send it. */
function sendHandler(route: SubjectRoute): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = req.params[route.param];
      if (!isUuid(id)) throw new AppError(400, route.invalidId);
      const organizationId = req.user!.organizationId;
      const noun = subjectNoun(route.kind);

      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : null;

      // Absent means "use the subject's own adviser". Present but malformed is a
      // client bug, not a fallback: silently defaulting would send the feedback to
      // someone other than the person the supervisor picked. Settled before the
      // subject lookup — shape checks are free, a query is not.
      const rawRecipient = req.body?.adviser_user_id;
      const adviserUserId =
        rawRecipient === undefined || rawRecipient === null || rawRecipient === ''
          ? null
          : String(rawRecipient);
      if (adviserUserId !== null && !isUuid(adviserUserId)) {
        throw new AppError(400, 'Invalid recipient');
      }

      const refusal = await route.sendRefusal(organizationId, id);
      if (refusal) throw new AppError(400, refusal);
      const subject: FeedbackSubject = { kind: route.kind, id };

      let result;
      try {
        result = await sendFeedback({
          organizationId,
          subject,
          sentBy: req.user!.userId,
          message: message || null,
          adviserUserId,
        });
      } catch (err) {
        // resolveAdviser's refusals are the supervisor's problem to fix, not a
        // server fault: surface the reason rather than a 500.
        throw new AppError(400, (err as Error).message);
      }

      // Release the subject to Zoho, on a tenant that pushes on feedback (CG-4).
      //
      // This is the trigger Trust Point asked for: nothing reaches the CRM — and
      // so nothing reaches the adviser's commission process — until a person has
      // reviewed the sale (or the call) and pressed this button. A sale's release
      // is scoped to this feedback round, so a second round appends its own QA
      // record rather than overwriting what the adviser was told the first time.
      //
      // Best-effort and after the send, exactly like every other write-back: a
      // Zoho outage must not fail a feedback email that has already gone out, and
      // the delivery row it creates carries its own retry.
      void route.release(organizationId, id, result.feedbackId);

      await recordAuditEvent({
        organizationId,
        userId: req.user!.userId,
        actionType: route.audit.sent,
        entityType: route.audit.entityType,
        entityId: id,
        // The override is spelled out in the summary, not left in metadata: the
        // summary is the line a supervisor or an auditor actually reads, and
        // "someone chose this recipient" is the whole point of the record. It
        // names who was displaced, because "chosen" without that is a claim an
        // auditor cannot check. On an unattributed subject nobody was displaced,
        // so saying "not its own adviser" would invent one.
        summary:
          result.recipientSource === 'manual'
            ? result.suggestedAdviserName
              ? `Fed back ${result.itemCount} finding(s) on this ${noun} to ${result.adviser.name}, chosen instead of ${result.suggestedAdviserName}`
              : `Fed back ${result.itemCount} finding(s) on this ${noun} to ${result.adviser.name}, chosen — no adviser is attributed to this ${noun}`
            : `Fed back ${result.itemCount} finding(s) on this ${noun} to ${result.adviser.name}`,
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
  };
}

feedbackRouter.get('/journeys/:journeyId/feedback', authenticate, requireActioner, panelHandler(SALE));
feedbackRouter.post('/journeys/:journeyId/feedback', authenticate, requireActioner, sendHandler(SALE));

// A call scored on its own (migration 118). Same guards, same shapes, same
// handlers; only the subject's preconditions and its Zoho release differ.
feedbackRouter.get('/calls/:callId/feedback', authenticate, requireActioner, panelHandler(CALL));
feedbackRouter.post('/calls/:callId/feedback', authenticate, requireActioner, sendHandler(CALL));

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
 *
 * On a live link the response carries `subject_kind` ('journey' | 'call') so
 * the page can say "call" rather than "sale". It never carries which one, and a
 * dead or unknown link gets no kind at all — see lookupFeedback.
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
      // Audited against the sale or call it was about, so the trail sits with
      // the rest of that subject's history. The kind comes off the feedback row
      // itself — never off the tenant's current scoring setting, which may have
      // changed since the round was sent and has no bearing on what was.
      const ctx = await feedbackAuditContext(token);
      if (ctx) {
        const isCall = ctx.subject.kind === 'call';
        await recordAuditEvent({
          organizationId: ctx.organizationId,
          userId: ctx.adviserUserId,
          actionType: isCall ? 'call.feedback_confirmed' : 'journey.feedback_confirmed',
          entityType: isCall ? 'call' : 'journey',
          entityId: ctx.subject.id,
          summary: `${result.adviserName} confirmed they received feedback on this ${subjectNoun(ctx.subject.kind)}`,
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

/**
 * What the adviser did about one finding (CG-25).
 *
 * Unauthenticated for the same unavoidable reason as the confirmation above,
 * and behind the same limiter. The token authorises only the findings on its
 * own feedback row — the service puts `feedback_id` in the UPDATE's WHERE
 * clause, so a valid token handed someone else's item id writes nothing.
 *
 * Answers with a status rather than an error code wherever the cause is the
 * link's own state, because a person in a mail client is reading this. A
 * malformed outcome is different: that is a client bug and gets a 400, since
 * nothing sensible can be rendered for it and silently storing the nearest
 * valid answer would put words in an adviser's mouth about a customer.
 */
publicFeedbackRouter.post('/:token/items/:itemId/outcome', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 20 || token.length > 200) {
      res.json({ status: 'not_found' });
      return;
    }
    // Shape-checked before the token is hashed: a malformed id cannot match
    // anything, and rejecting it here keeps a junk value out of a UUID column
    // comparison.
    if (!isUuid(req.params.itemId)) {
      res.json({ status: 'not_found' });
      return;
    }

    const outcome = typeof req.body?.outcome === 'string' ? req.body.outcome : '';
    const note = typeof req.body?.note === 'string' ? req.body.note : null;

    const result = await recordRemediationOutcome(token, req.params.itemId, outcome, note);

    if (result.status === 'invalid_outcome') {
      throw new AppError(400, 'Unrecognised outcome');
    }

    if (result.status === 'recorded') {
      // Filed against the sale or call, so it sits with the rest of that
      // subject's history. userId is frequently null here and that is not a gap in the
      // record: the token is the credential and many advisers have no account
      // at all (061), so the summary names the person from the snapshot on the
      // feedback row rather than relying on a join that would come back empty.
      const ctx = await feedbackAuditContext(token);
      if (ctx) {
        const label = REMEDIATION_OUTCOME_LABELS[outcome as RemediationOutcome];
        const isCall = ctx.subject.kind === 'call';
        await recordAuditEvent({
          organizationId: ctx.organizationId,
          userId: ctx.adviserUserId,
          actionType: isCall ? 'call.remediation_recorded' : 'journey.remediation_recorded',
          entityType: isCall ? 'call' : 'journey',
          entityId: ctx.subject.id,
          // The finding is named and the answer is spelled out, because this is
          // the line a compliance officer reads a year later. The adviser's own
          // note is NOT copied here: it can be revised, and a revised account
          // must not leave an uncorrectable second copy in the register — the
          // same rule journey.note.add follows.
          summary: `${ctx.adviserName} recorded "${label}" on ${result.item?.label ?? 'a finding'} for this ${subjectNoun(ctx.subject.kind)}`,
          metadata: {
            feedback_item_id: req.params.itemId,
            outcome,
            note_given: !!result.item?.note,
          },
          req,
        });
      }
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});
