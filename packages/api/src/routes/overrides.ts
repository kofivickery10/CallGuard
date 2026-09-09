import { Router } from 'express';
import { authenticate, requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import type { OverrideRegisterEntry, OverrideRegisterSummary } from '@callguard/shared';

// ============================================================
// The override register (CG-7).
//
// Every time a person overturns the AI: who, when, on what, from what, to what,
// and why. `score_corrections` has recorded all of that since migration 068 —
// what did not exist was any way to READ it as a record. The claims-defence
// pack shows the rulings on one sale, and /insights/calibration aggregates them
// into rates per criterion, but nothing answered "show me every override this
// month and who made it", which is the question an auditor actually asks.
//
// WHY THIS IS NOT ON THE INSIGHTS ROUTER: /insights is gated behind the Pro
// plan's `insights` feature, because calibration analytics are a product extra.
// This is not an extra. Trust Point's QA score feeds adviser commission, and
// CG-7's own framing is that "a defensible single record of what the score was
// and who changed it is not optional". Putting the audit record behind an
// upsell would mean a tenant on the cheaper plan cannot produce their own
// override history for a regulator — so it is org-view, on every plan.
//
// Read-only by construction: there is no write path here. The register is
// written as a side effect of the correction endpoints (routes/journeys.ts,
// routes/review.ts), which is what keeps it honest — nothing can add an entry
// except an actual override.
// ============================================================

export const overridesRouter = Router();
overridesRouter.use(authenticate);
overridesRouter.use(requireOrgView);

// Direction of an override, derived rather than stored.
//
// Three cases, and they are not the same event:
//   ai_too_harsh   — the AI failed it, a person passed it
//   ai_too_lenient — the AI passed it, a person failed it
//   ai_undecided   — the AI could not decide (original_pass NULL) and a person
//                    ruled. Not an override of a verdict at all; counting it as
//                    one would inflate the override rate with cases where the
//                    model correctly declined to guess (migration 077).
const DIRECTION_SQL = `CASE
        WHEN sc.original_pass IS NULL THEN 'ai_undecided'
        WHEN sc.original_pass = false AND sc.corrected_pass = true THEN 'ai_too_harsh'
        WHEN sc.original_pass = true AND sc.corrected_pass = false THEN 'ai_too_lenient'
        ELSE 'unchanged'
      END`;

// GET /api/overrides — the register, newest first.
//
// Filters: from, to (ISO dates), direction, item (scorecard_item_id),
// user (corrected_by), missing_reason=true.
overridesRouter.get('/', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    const parts = ['sc.organization_id = $1'];
    const params: unknown[] = [orgId];

    if (typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) {
      params.push(req.query.from);
      parts.push(`sc.created_at >= $${params.length}::date`);
    }
    if (typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      params.push(req.query.to);
      parts.push(`sc.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const direction = typeof req.query.direction === 'string' ? req.query.direction : '';
    if (['ai_too_harsh', 'ai_too_lenient', 'ai_undecided'].includes(direction)) {
      params.push(direction);
      parts.push(`${DIRECTION_SQL} = $${params.length}`);
    }
    if (typeof req.query.item === 'string' && req.query.item) {
      params.push(req.query.item);
      parts.push(`sc.scorecard_item_id = $${params.length}`);
    }
    if (typeof req.query.user === 'string' && req.query.user) {
      params.push(req.query.user);
      parts.push(`sc.corrected_by = $${params.length}`);
    }
    // The weak link in the chain, made findable. `reason` is optional at the
    // point of override, so an entry can exist with no stated basis — which is
    // exactly the entry that cannot be defended later. Filtering for them turns
    // "we log overrides" into something a compliance lead can actually chase.
    if (req.query.missing_reason === 'true') {
      parts.push(`(sc.reason IS NULL OR btrim(sc.reason) = '')`);
    }

    const where = parts.join(' AND ');

    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM score_corrections sc WHERE ${where}`,
      params
    );

    const rows = await query<OverrideRegisterEntry>(
      `SELECT sc.id,
              sc.created_at,
              si.label AS item_label,
              si.section AS item_section,
              sc.scorecard_item_id,
              -- Who. LEFT JOIN, and null-tolerant downstream: corrected_by is
              -- NOT NULL, but the user row can be deleted, and an override
              -- whose author has left the firm still belongs in the register.
              sc.corrected_by AS user_id,
              u.name AS user_name,
              sc.original_pass,
              sc.corrected_pass,
              ${DIRECTION_SQL} AS direction,
              sc.reason,
              -- Which record it was on. Exactly one of these is set: migration
              -- 068 covers per-call overrides, 077 the sale side.
              sc.call_id,
              sc.journey_id,
              COALESCE(j.client_name, cust.name, jcust.name) AS subject_name
         FROM score_corrections sc
         JOIN scorecard_items si ON si.id = sc.scorecard_item_id
         LEFT JOIN users u ON u.id = sc.corrected_by
         LEFT JOIN journeys j ON j.id = sc.journey_id
         LEFT JOIN customers jcust ON jcust.id = j.customer_id
         LEFT JOIN calls c ON c.id = sc.call_id
         LEFT JOIN customers cust ON cust.id = c.customer_id
        WHERE ${where}
        ORDER BY sc.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      data: rows,
      total: parseInt(countRow?.count || '0', 10),
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/overrides/summary — the shape of the register under the same
// filters, for the header strip. Deliberately a separate call from the page of
// rows: the counts describe the whole filtered set, not the page.
overridesRouter.get('/summary', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const parts = ['sc.organization_id = $1'];
    const params: unknown[] = [orgId];

    if (typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) {
      params.push(req.query.from);
      parts.push(`sc.created_at >= $${params.length}::date`);
    }
    if (typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      params.push(req.query.to);
      parts.push(`sc.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const row = await queryOne<OverrideRegisterSummary>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${DIRECTION_SQL} = 'ai_too_harsh')::int   AS ai_too_harsh,
              COUNT(*) FILTER (WHERE ${DIRECTION_SQL} = 'ai_too_lenient')::int AS ai_too_lenient,
              COUNT(*) FILTER (WHERE ${DIRECTION_SQL} = 'ai_undecided')::int   AS ai_undecided,
              COUNT(*) FILTER (WHERE sc.reason IS NULL OR btrim(sc.reason) = '')::int AS missing_reason,
              COUNT(DISTINCT sc.corrected_by)::int AS reviewers
         FROM score_corrections sc
        WHERE ${parts.join(' AND ')}`,
      params
    );

    res.json(
      row ?? {
        total: 0,
        ai_too_harsh: 0,
        ai_too_lenient: 0,
        ai_undecided: 0,
        missing_reason: 0,
        reviewers: 0,
      }
    );
  } catch (err) {
    next(err);
  }
});
