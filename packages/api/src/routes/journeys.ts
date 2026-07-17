import { Router } from 'express';
import { authenticate, requireOrgView, requireActioner } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { assembleJourney } from '../services/journey.js';
import type { Journey, JourneyItemScore, JourneyCallRole, JourneyListItem, JourneyStatus } from '@callguard/shared';

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

    res.json({ data: rows, total: parseInt(countRow?.count || '0'), page, limit });
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

    const itemScores = await query<JourneyItemScore & { label: string; section: string | null; severity: string | null }>(
      `SELECT jis.*, si.label, si.section, si.severity
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

    res.json({
      ...journey,
      calls,
      item_scores: itemScores,
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

    res.status(202).json({ journey_id: journeyId });
  } catch (err) {
    next(err);
  }
});
