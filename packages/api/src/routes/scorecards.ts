import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import type { Scorecard, ScorecardItem } from '@callguard/shared';

export const scorecardRouter = Router();
scorecardRouter.use(authenticate);

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
      'SELECT * FROM scorecard_items WHERE scorecard_id = $1 ORDER BY sort_order',
      [scorecard.id]
    );

    res.json({ ...scorecard, items });
  } catch (err) {
    next(err);
  }
});

// Create scorecard with items
scorecardRouter.post('/', async (req, res, next) => {
  try {
    const { name, description, items } = req.body;
    if (!name || !items || !Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'name and at least one item are required');
    }

    const rows = await query<Scorecard>(
      `INSERT INTO scorecards (organization_id, name, description, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user!.organizationId, name, description || null, req.user!.userId]
    );
    const scorecard = rows[0];

    const createdItems: ScorecardItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemRows = await query<ScorecardItem>(
        `INSERT INTO scorecard_items (scorecard_id, label, description, score_type, weight, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          scorecard.id,
          item.label,
          item.description || null,
          item.score_type || 'binary',
          item.weight ?? 1,
          item.sort_order ?? i,
        ]
      );
      createdItems.push(itemRows[0]);
    }

    res.status(201).json({ ...scorecard, items: createdItems });
  } catch (err) {
    next(err);
  }
});

// Update scorecard
scorecardRouter.put('/:id', async (req, res, next) => {
  try {
    const scorecard = await queryOne<Scorecard>(
      'SELECT * FROM scorecards WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!scorecard) throw new AppError(404, 'Scorecard not found');

    const { name, description, is_active, items } = req.body;

    const updated = await queryOne<Scorecard>(
      `UPDATE scorecards SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        is_active = COALESCE($3, is_active),
        updated_at = now()
       WHERE id = $4 RETURNING *`,
      [name, description, is_active, scorecard.id]
    );

    if (items && Array.isArray(items)) {
      // Delete existing items and recreate
      await query('DELETE FROM scorecard_items WHERE scorecard_id = $1', [scorecard.id]);

      const createdItems: ScorecardItem[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemRows = await query<ScorecardItem>(
          `INSERT INTO scorecard_items (scorecard_id, label, description, score_type, weight, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            scorecard.id,
            item.label,
            item.description || null,
            item.score_type || 'binary',
            item.weight ?? 1,
            item.sort_order ?? i,
          ]
        );
        createdItems.push(itemRows[0]);
      }

      res.json({ ...updated, items: createdItems });
    } else {
      const existingItems = await query<ScorecardItem>(
        'SELECT * FROM scorecard_items WHERE scorecard_id = $1 ORDER BY sort_order',
        [scorecard.id]
      );
      res.json({ ...updated, items: existingItems });
    }
  } catch (err) {
    next(err);
  }
});

// Delete scorecard (soft delete)
scorecardRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await queryOne(
      `UPDATE scorecards SET is_active = false, updated_at = now()
       WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'Scorecard not found');
    res.json({ message: 'Scorecard deactivated' });
  } catch (err) {
    next(err);
  }
});
