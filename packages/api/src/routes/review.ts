import { Router } from 'express';
import { authenticate, requireOrgView, requireActioner } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { getScoringSettings } from '../services/tenant-settings.js';
import { deriveSeverity, isItemPass, callPasses } from '@callguard/shared';
import type { ManualReviewItem, BreachSeverity } from '@callguard/shared';

export const reviewRouter = Router();
reviewRouter.use(authenticate);

// GET /api/review-items — checkpoints awaiting human sign-off: manual items and
// consent gates routed to manual_review. Spans per-call and journey scoring.
reviewRouter.get('/', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    const callItems = await query<ManualReviewItem>(
      `SELECT 'call' AS kind, cis.id AS item_score_id, cis.scorecard_item_id,
              si.label, si.section, si.severity,
              cs.call_id AS parent_id,
              cust.name AS customer_name, c.agent_name,
              cis.created_at AS detected_at
         FROM call_item_scores cis
         JOIN call_scores cs ON cs.id = cis.call_score_id
         JOIN calls c ON c.id = cs.call_id
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
         LEFT JOIN customers cust ON cust.id = c.customer_id
        WHERE c.organization_id = $1 AND cis.result = 'manual_review'`,
      [orgId]
    );

    const journeyItems = await query<ManualReviewItem>(
      `SELECT 'journey' AS kind, jis.id AS item_score_id, jis.scorecard_item_id,
              si.label, si.section, si.severity,
              jis.journey_id AS parent_id,
              cust.name AS customer_name, NULL AS agent_name,
              jis.created_at AS detected_at
         FROM journey_item_scores jis
         JOIN journeys j ON j.id = jis.journey_id
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
         LEFT JOIN customers cust ON cust.id = j.customer_id
        WHERE j.organization_id = $1 AND jis.result = 'manual_review'`,
      [orgId]
    );

    const items = [...callItems, ...journeyItems].sort(
      (a, b) => new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime()
    );
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

// POST /api/review-items/resolve — a reviewer marks a manual_review checkpoint
// pass/fail. Recomputes the parent overall score (scored items only) and
// raises/clears the breach, mirroring the per-call correction path.
reviewRouter.post('/resolve', requireActioner, async (req, res, next) => {
  try {
    const { kind, item_score_id, result, note } = req.body as {
      kind?: 'call' | 'journey';
      item_score_id?: string;
      result?: 'pass' | 'fail';
      note?: string;
    };
    if (kind !== 'call' && kind !== 'journey') throw new AppError(400, "kind must be 'call' or 'journey'");
    if (!item_score_id) throw new AppError(400, 'item_score_id is required');
    if (result !== 'pass' && result !== 'fail') throw new AppError(400, "result must be 'pass' or 'fail'");

    const orgId = req.user!.organizationId;
    const settings = await getScoringSettings(orgId);
    const normalized = result === 'pass' ? 100 : 0;
    const rawScore = result === 'pass' ? 1 : 0;

    if (kind === 'call') {
      await resolveCallItem(orgId, item_score_id, result, normalized, rawScore, settings.passThreshold);
    } else {
      await resolveJourneyItem(orgId, item_score_id, result, normalized, rawScore, settings.passThreshold);
    }

    void recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: 'review.resolve',
      entityType: 'score',
      entityId: item_score_id,
      summary: `Resolved manual-review ${kind} checkpoint to ${result}`,
      metadata: { kind, result, note: note || null },
      req,
    });

    res.json({ message: 'Resolved' });
  } catch (err) {
    next(err);
  }
});

async function resolveCallItem(
  orgId: string,
  itemScoreId: string,
  result: 'pass' | 'fail',
  normalized: number,
  rawScore: number,
  threshold: number
): Promise<void> {
  const row = await queryOne<{ call_score_id: string; scorecard_item_id: string; call_id: string; weight: string; severity: string | null }>(
    `SELECT cis.call_score_id, cis.scorecard_item_id, cs.call_id, si.weight::text, si.severity
       FROM call_item_scores cis
       JOIN call_scores cs ON cs.id = cis.call_score_id
       JOIN calls c ON c.id = cs.call_id
       JOIN scorecard_items si ON si.id = cis.scorecard_item_id
      WHERE cis.id = $1 AND c.organization_id = $2 AND cis.result = 'manual_review'`,
    [itemScoreId, orgId]
  );
  if (!row) throw new AppError(404, 'Manual-review item not found');
  const severity = deriveSeverity(Number(row.weight), row.severity);

  await withTransaction(async (tx) => {
    await tx.query(
      "UPDATE call_item_scores SET result = $2, score = $3, normalized_score = $4 WHERE id = $1",
      [itemScoreId, result, rawScore, normalized]
    );

    const items = await tx.query<{ normalized_score: string; weight: string; severity: string | null }>(
      `SELECT cis.normalized_score::text, si.weight::text, si.severity
         FROM call_item_scores cis
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
        WHERE cis.call_score_id = $1 AND cis.result IN ('pass', 'fail')`,
      [row.call_score_id]
    );
    const { overall, failing } = recompute(items, threshold);
    await tx.query('UPDATE call_scores SET overall_score = $1, pass = $2 WHERE id = $3', [
      overall,
      callPasses(overall, failing, threshold),
      row.call_score_id,
    ]);

    if (result === 'fail') {
      await tx.query(
        `INSERT INTO breaches (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, detected_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (call_item_score_id) DO NOTHING`,
        [orgId, row.call_id, itemScoreId, row.scorecard_item_id, severity]
      );
    } else {
      await tx.query('DELETE FROM breaches WHERE call_item_score_id = $1', [itemScoreId]);
    }
  });
}

async function resolveJourneyItem(
  orgId: string,
  itemScoreId: string,
  result: 'pass' | 'fail',
  normalized: number,
  rawScore: number,
  threshold: number
): Promise<void> {
  const row = await queryOne<{ journey_id: string; scorecard_item_id: string; weight: string; severity: string | null }>(
    `SELECT jis.journey_id, jis.scorecard_item_id, si.weight::text, si.severity
       FROM journey_item_scores jis
       JOIN journeys j ON j.id = jis.journey_id
       JOIN scorecard_items si ON si.id = jis.scorecard_item_id
      WHERE jis.id = $1 AND j.organization_id = $2 AND jis.result = 'manual_review'`,
    [itemScoreId, orgId]
  );
  if (!row) throw new AppError(404, 'Manual-review item not found');
  const severity = deriveSeverity(Number(row.weight), row.severity);

  await withTransaction(async (tx) => {
    await tx.query(
      "UPDATE journey_item_scores SET result = $2, score = $3, normalized_score = $4 WHERE id = $1",
      [itemScoreId, result, rawScore, normalized]
    );

    const items = await tx.query<{ normalized_score: string; weight: string; severity: string | null }>(
      `SELECT jis.normalized_score::text, si.weight::text, si.severity
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.journey_id = $1 AND jis.result IN ('pass', 'fail')`,
      [row.journey_id]
    );
    const { overall, failing } = recompute(items, threshold);
    await tx.query('UPDATE journeys SET overall_score = $1, pass = $2, updated_at = now() WHERE id = $3', [
      overall,
      callPasses(overall, failing, threshold),
      row.journey_id,
    ]);

    if (result === 'fail') {
      await tx.query(
        `INSERT INTO breaches (organization_id, journey_id, journey_item_score_id, scorecard_item_id, severity, detected_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (journey_item_score_id) DO NOTHING`,
        [orgId, row.journey_id, itemScoreId, row.scorecard_item_id, severity]
      );
    } else {
      await tx.query('DELETE FROM breaches WHERE journey_item_score_id = $1', [itemScoreId]);
    }
  });
}

// Weighted overall + list of failing severities, over the pass/fail items only
// (na / manual_review carry no numeric score and are excluded).
function recompute(
  items: Array<{ normalized_score: string; weight: string; severity: string | null }>,
  threshold: number
): { overall: number; failing: BreachSeverity[] } {
  let totalWeighted = 0;
  let totalWeight = 0;
  const failing: BreachSeverity[] = [];
  for (const it of items) {
    const w = Number(it.weight);
    const n = Number(it.normalized_score);
    totalWeighted += n * w;
    totalWeight += w;
    if (!isItemPass(n, threshold)) failing.push(deriveSeverity(w, it.severity));
  }
  return { overall: totalWeight > 0 ? totalWeighted / totalWeight : 0, failing };
}
