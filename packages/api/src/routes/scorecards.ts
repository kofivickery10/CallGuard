import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { isUuid } from '../services/uuid.js';
import type { Scorecard, ScorecardItem, BranchConfig } from '@callguard/shared';

export const scorecardRouter = Router();
scorecardRouter.use(authenticate);

// Validates the shape of a caller-supplied branch_config before it ever
// reaches the DB or the scoring prompt — a malformed config (e.g. a keyword
// list for a branch not in `branches`) would otherwise silently fail to
// detect that branch at scoring time rather than erroring here at save time.
function validateBranchConfig(branchConfig: unknown): void {
  if (branchConfig === undefined || branchConfig === null) return;
  const bc = branchConfig as Partial<BranchConfig>;
  if (!Array.isArray(bc.branches) || bc.branches.length < 2) {
    throw new AppError(400, 'branch_config.branches must list at least 2 branches');
  }
  if (bc.detect !== 'keyword') {
    throw new AppError(400, "branch_config.detect must be 'keyword'");
  }
  if (bc.keywords) {
    for (const branch of Object.keys(bc.keywords)) {
      if (!bc.branches.includes(branch)) {
        throw new AppError(400, `branch_config.keywords references unknown branch "${branch}"`);
      }
    }
  }
}

// Validate that every product id referenced by an item's applies_to_products
// belongs to this org — a scorecard must never reference (or leak) another
// tenant's products. Returns nothing; throws 400 on any unknown/foreign id.
async function assertItemProductsBelongToOrg(
  organizationId: string,
  items: Array<{ applies_to_products?: string[] | null }>
): Promise<void> {
  const referenced = [
    ...new Set(items.flatMap((it) => it.applies_to_products ?? []).filter(Boolean)),
  ];
  if (referenced.length === 0) return;
  // Only well-formed UUIDs reach the ::uuid[] cast — a malformed value would
  // otherwise raise 22P02 (a 500) instead of the clean 400 below. A non-UUID
  // can't match a real product, so it falls through to the "unknown" set.
  const wellFormed = referenced.filter((id) => isUuid(id));
  const rows = wellFormed.length
    ? await query<{ id: string }>(
        'SELECT id FROM products WHERE organization_id = $1 AND id = ANY($2::uuid[])',
        [organizationId, wellFormed]
      )
    : [];
  const known = new Set(rows.map((r) => r.id));
  const unknown = referenced.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new AppError(400, `applies_to_products references unknown product(s): ${unknown.join(', ')}`);
  }
}

// List scorecards
scorecardRouter.get('/', async (req, res, next) => {
  try {
    const scorecards = await query<Scorecard>(
      'SELECT * FROM scorecards WHERE organization_id = $1 ORDER BY created_at DESC',
      [req.user!.organizationId]
    );
    res.json({ data: scorecards });
  } catch (err) {
    next(err);
  }
});

// Get scorecard with items
scorecardRouter.get('/:id', async (req, res, next) => {
  try {
    const scorecard = await queryOne<Scorecard>(
      'SELECT * FROM scorecards WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!scorecard) throw new AppError(404, 'Scorecard not found');

    const items = await query<ScorecardItem>(
      'SELECT * FROM scorecard_items WHERE scorecard_id = $1 AND archived_at IS NULL ORDER BY sort_order',
      [scorecard.id]
    );

    res.json({ ...scorecard, items });
  } catch (err) {
    next(err);
  }
});

// Create scorecard with items
scorecardRouter.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, description, items, branch_config, scoring_mode } = req.body;
    if (!name || !items || !Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'name and at least one item are required');
    }
    validateBranchConfig(branch_config);
    await assertItemProductsBelongToOrg(req.user!.organizationId, items);

    const rows = await query<Scorecard>(
      `INSERT INTO scorecards (organization_id, name, description, created_by, branch_config, scoring_mode)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        req.user!.organizationId,
        name,
        description || null,
        req.user!.userId,
        branch_config ? JSON.stringify(branch_config) : null,
        scoring_mode || 'journey',
      ]
    );
    const scorecard = rows[0];

    const createdItems: ScorecardItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemRows = await query<ScorecardItem>(
        `INSERT INTO scorecard_items
           (scorecard_id, label, description, score_type, weight, sort_order,
            severity, section, item_type, applies_when, expectation, ai_check, consent_gate,
            applies_to_products)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid[]) RETURNING *`,
        [
          scorecard.id,
          item.label,
          item.description || null,
          item.score_type || 'binary',
          item.weight ?? 1,
          item.sort_order ?? i,
          item.severity || null,
          item.section || null,
          item.item_type || 'ai',
          item.applies_when ? JSON.stringify(item.applies_when) : null,
          item.expectation || null,
          item.ai_check || null,
          item.consent_gate ?? false,
          item.applies_to_products?.length ? item.applies_to_products : null,
        ]
      );
      createdItems.push(itemRows[0]);
    }

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'scorecard.create',
      entityType: 'scorecard',
      entityId: scorecard.id,
      metadata: { name: scorecard.name, item_count: createdItems.length },
    });

    res.status(201).json({ ...scorecard, items: createdItems });
  } catch (err) {
    next(err);
  }
});

// Update scorecard
scorecardRouter.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const scorecard = await queryOne<Scorecard>(
      'SELECT * FROM scorecards WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!scorecard) throw new AppError(404, 'Scorecard not found');

    const { name, description, is_active, items, branch_config, scoring_mode } = req.body;
    validateBranchConfig(branch_config);
    if (items && Array.isArray(items)) {
      await assertItemProductsBelongToOrg(req.user!.organizationId, items);
    }

    // A structural edit (the items array is present) bumps the version so
    // scores taken before this edit stay pinned to what they were actually
    // scored against (call_scores.scorecard_version) — editing a live
    // scorecard never retroactively changes how a past call/journey appears
    // to have been judged.
    const bumpVersion = items && Array.isArray(items);

    const updated = await queryOne<Scorecard>(
      `UPDATE scorecards SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        is_active = COALESCE($3, is_active),
        branch_config = CASE WHEN $4::jsonb IS NOT NULL THEN $4::jsonb ELSE branch_config END,
        scoring_mode = COALESCE($5, scoring_mode),
        version = CASE WHEN $6 THEN version + 1 ELSE version END,
        updated_at = now()
       WHERE id = $7 RETURNING *`,
      [
        name,
        description,
        is_active,
        branch_config !== undefined ? JSON.stringify(branch_config) : null,
        scoring_mode,
        bumpVersion,
        scorecard.id,
      ]
    );

    if (items && Array.isArray(items)) {
      // Upsert by id rather than delete-all-and-recreate: scorecard_items can
      // be referenced by historical call_item_scores/breaches (deliberately
      // no ON DELETE there — a compliance record shouldn't vanish because the
      // scorecard was edited later), so a blind DELETE would throw a foreign
      // key violation on any scorecard that has ever been scored against.
      // Items removed from the payload are archived (kept for history, hidden
      // from future scoring) if they have prior scores, otherwise deleted.
      const existingBefore = await query<ScorecardItem>(
        'SELECT * FROM scorecard_items WHERE scorecard_id = $1',
        [scorecard.id]
      );
      const existingById = new Map(existingBefore.map((i) => [i.id, i]));
      const keptIds = new Set<string>();

      const savedItems = await withTransaction(async (tx) => {
        const result: ScorecardItem[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const existing = item.id ? existingById.get(item.id) : undefined;

          if (existing) {
            keptIds.add(existing.id);
            const rows = await tx.query<ScorecardItem>(
              `UPDATE scorecard_items SET
                 label = $2, description = $3, score_type = $4, weight = $5,
                 sort_order = $6, severity = $7, section = $8, item_type = $9,
                 applies_when = $10, expectation = $11, ai_check = $12,
                 consent_gate = $13, applies_to_products = $14::uuid[], archived_at = NULL
               WHERE id = $1 RETURNING *`,
              [
                existing.id,
                item.label,
                item.description || null,
                item.score_type || 'binary',
                item.weight ?? 1,
                item.sort_order ?? i,
                item.severity || null,
                item.section || null,
                item.item_type || 'ai',
                item.applies_when ? JSON.stringify(item.applies_when) : null,
                item.expectation || null,
                item.ai_check || null,
                item.consent_gate ?? false,
                item.applies_to_products?.length ? item.applies_to_products : null,
              ]
            );
            result.push(rows[0]!);
          } else {
            const rows = await tx.query<ScorecardItem>(
              `INSERT INTO scorecard_items
                 (scorecard_id, label, description, score_type, weight, sort_order,
                  severity, section, item_type, applies_when, expectation, ai_check, consent_gate,
                  applies_to_products)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid[]) RETURNING *`,
              [
                scorecard.id,
                item.label,
                item.description || null,
                item.score_type || 'binary',
                item.weight ?? 1,
                item.sort_order ?? i,
                item.severity || null,
                item.section || null,
                item.item_type || 'ai',
                item.applies_when ? JSON.stringify(item.applies_when) : null,
                item.expectation || null,
                item.ai_check || null,
                item.consent_gate ?? false,
                item.applies_to_products?.length ? item.applies_to_products : null,
              ]
            );
            result.push(rows[0]!);
          }
        }

        // Items dropped from the payload: hard-delete if never scored,
        // otherwise archive so history stays intact.
        const removed = existingBefore.filter((i) => !keptIds.has(i.id));
        for (const item of removed) {
          // A scorecard item can be referenced from per-call scoring
          // (call_item_scores) or per-journey/sale scoring (journey_item_scores);
          // both FK to scorecard_items with no ON DELETE. Check both, or a
          // journey-scored item slips past and the DELETE throws a FK violation.
          const scored = await tx.queryOne<{ id: string }>(
            `SELECT id FROM call_item_scores WHERE scorecard_item_id = $1 LIMIT 1
             UNION ALL
             SELECT id FROM journey_item_scores WHERE scorecard_item_id = $1 LIMIT 1`,
            [item.id]
          );
          if (scored) {
            await tx.query('UPDATE scorecard_items SET archived_at = now() WHERE id = $1', [item.id]);
          } else {
            await tx.query('DELETE FROM scorecard_items WHERE id = $1', [item.id]);
          }
        }

        return result;
      });

      res.json({ ...updated, items: savedItems });
    } else {
      const existingItems = await query<ScorecardItem>(
        'SELECT * FROM scorecard_items WHERE scorecard_id = $1 AND archived_at IS NULL ORDER BY sort_order',
        [scorecard.id]
      );
      res.json({ ...updated, items: existingItems });
    }
  } catch (err) {
    next(err);
  }
});

// Delete scorecard (soft delete)
scorecardRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await queryOne(
      `UPDATE scorecards SET is_active = false, updated_at = now()
       WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'Scorecard not found');
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'scorecard.deactivate',
      entityType: 'scorecard',
      entityId: req.params.id,
    });
    res.json({ message: 'Scorecard deactivated' });
  } catch (err) {
    next(err);
  }
});
