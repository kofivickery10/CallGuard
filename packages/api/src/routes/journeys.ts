import { Router } from 'express';
import { authenticate, requireOrgView, requireActioner, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { assembleJourney } from '../services/journey.js';
import type { Journey, JourneyItemScore, JourneyCallRole, JourneyListItem, JourneyStatus, JourneyProduct } from '@callguard/shared';

export const journeysRouter = Router();
journeysRouter.use(authenticate);

// GET /api/journeys — paginated list of journeys for the org, newest first,
// optionally filtered by status or customer. This is the primary discovery
// surface for journey-mode tenants (the default scoring_mode).
journeysRouter.get('/', requireOrgView, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    const parts = ['j.organization_id = $1'];
    const params: unknown[] = [req.user!.organizationId];
    const status = req.query.status as string | undefined;
    if (status && ['pending', 'scoring', 'scored', 'failed'].includes(status)) {
      params.push(status as JourneyStatus);
      parts.push(`j.status = $${params.length}`);
    }
    if (typeof req.query.customer_id === 'string') {
      params.push(req.query.customer_id);
      parts.push(`j.customer_id = $${params.length}`);
    }
    const whereSQL = parts.join(' AND ');

    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM journeys j WHERE ${whereSQL}`,
      params
    );

    const rows = await query<JourneyListItem>(
      `SELECT j.*,
              cust.name AS customer_name,
              cust.phone_normalized AS customer_phone,
              sc.name AS scorecard_name,
              (SELECT COUNT(*)::int FROM journey_calls jc WHERE jc.journey_id = j.id) AS call_count
         FROM journeys j
         LEFT JOIN customers cust ON cust.id = j.customer_id
         LEFT JOIN scorecards sc ON sc.id = j.scorecard_id
        WHERE ${whereSQL}
        ORDER BY j.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    // SELECT j.* pulls the server-only trigger_context (raw Zoho payload, can
    // carry PII) — strip it from every row before responding.
    const data = (rows as Array<JourneyListItem & { trigger_context?: unknown }>).map(
      ({ trigger_context: _t, ...r }) => r as JourneyListItem
    );

    res.json({ data, total: parseInt(countRow?.count || '0'), page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/journeys/:id — full journey detail: which calls composed it, and
// the per-checkpoint result across the whole set (spec §9).
journeysRouter.get('/:id', requireOrgView, async (req, res, next) => {
  try {
    const journey = await queryOne<Journey>(
      'SELECT * FROM journeys WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!journey) throw new AppError(404, 'Journey not found');

    const calls = await query<{ id: string; role: JourneyCallRole; call_date: string | null; agent_name: string | null }>(
      `SELECT c.id, jc.role, c.call_date, c.agent_name
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
        WHERE jc.journey_id = $1
        ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
      [journey.id]
    );

    const itemScores = await query<JourneyItemScore & { label: string; section: string | null; severity: string | null; applies_to_products: string[] | null }>(
      `SELECT jis.*, si.label, si.section, si.severity, si.applies_to_products
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.journey_id = $1
        ORDER BY si.sort_order`,
      [journey.id]
    );

    // Whose journey this is — the detail page titles itself with the customer
    // and links back to the profile.
    const customer = await queryOne<{ name: string | null; phone_normalized: string }>(
      'SELECT name, phone_normalized FROM customers WHERE id = $1',
      [journey.customer_id]
    );

    // The products this sale covered (empty for orgs not using product scoping)
    // — shown on the detail page and used to explain why product-scoped items
    // resolved to N/A.
    const products = await query<JourneyProduct>(
      `SELECT id, journey_id, product_id, product_name, source, created_at
         FROM journey_products WHERE journey_id = $1
        ORDER BY product_name`,
      [journey.id]
    );

    // trigger_context is a server-only routing field: a raw snapshot of the
    // Zoho sale-trigger payload (used to resolve capture forms), which can
    // carry customer PII. It's kept off the shared Journey type, but SELECT *
    // returns it at runtime — strip it before responding.
    const { trigger_context: _triggerContext, ...journeyPublic } =
      journey as Journey & { trigger_context?: unknown };

    res.json({
      ...journeyPublic,
      calls,
      item_scores: itemScores,
      products,
      customer_name: customer?.name ?? null,
      customer_phone: customer?.phone_normalized ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/trigger — manually assemble + score a journey for a
// customer (fallback path when there's no Zoho sale trigger, or for
// re-scoring). Body: { customer_id, scorecard_id? }.
journeysRouter.post('/trigger', requireActioner, async (req, res, next) => {
  try {
    const { customer_id, scorecard_id } = req.body as { customer_id?: string; scorecard_id?: string };
    if (!customer_id) throw new AppError(400, 'customer_id is required');

    const customer = await queryOne<{ id: string }>(
      'SELECT id FROM customers WHERE id = $1 AND organization_id = $2',
      [customer_id, req.user!.organizationId]
    );
    if (!customer) throw new AppError(404, 'Customer not found');

    const journeyId = await assembleJourney({
      organizationId: req.user!.organizationId,
      customerId: customer_id,
      scorecardId: scorecard_id ?? null,
      triggerSource: 'manual',
    });

    if (!journeyId) {
      res.status(202).json({ message: 'No transcribed calls in the journey window — nothing to score' });
      return;
    }

    // assembleJourney is idempotent: for an already-scored sale over the same
    // calls it returns the existing journey without re-scoring. Tell the user
    // which happened so the button never looks like it did nothing.
    const j = await queryOne<{ status: JourneyStatus }>(
      'SELECT status FROM journeys WHERE id = $1',
      [journeyId]
    );
    const message =
      j?.status === 'scored'
        ? 'This sale is already scored. An admin can re-score it from the sale page.'
        : 'Scoring started — the result will appear below shortly.';

    res.status(202).json({ journey_id: journeyId, message });
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/:id/rescore — admin-only forced re-score of an existing
// sale (e.g. after a transcript correction). Re-runs the scorecard on the same
// calls: score-journey clears the sale's prior breaches and upserts its item
// scores, so this replaces the result in place rather than duplicating it, and
// re-pushes to the CRM. Deliberately admin-only and not a general button —
// each run spends scoring tokens, so it must be a considered action.
journeysRouter.post('/:id/rescore', requireAdmin, async (req, res, next) => {
  try {
    const journey = await queryOne<{ id: string; status: JourneyStatus }>(
      'SELECT id, status FROM journeys WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');
    if (journey.status === 'pending' || journey.status === 'scoring') {
      throw new AppError(409, 'This sale is already being scored');
    }

    await query(
      "UPDATE journeys SET status = 'scoring', updated_at = now() WHERE id = $1",
      [journey.id]
    );

    const { scoringQueue } = await import('../jobs/queue.js');
    await scoringQueue.add(
      'score-journey',
      { journeyId: journey.id },
      { jobId: `rescore-journey-${journey.id}-${Date.now()}` }
    );

    res.json({ message: 'Re-scoring initiated' });
  } catch (err) {
    next(err);
  }
});
