import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import type { Product } from '@callguard/shared';

export const productsRouter = Router();
productsRouter.use(authenticate);

// List the org's products. Available to any authenticated tenant user — the
// scorecard editor needs it to render the per-item "Required for" picker.
productsRouter.get('/', async (req, res, next) => {
  try {
    const products = await query<Product>(
      'SELECT * FROM products WHERE organization_id = $1 ORDER BY sort_order, name',
      [req.user!.organizationId]
    );
    res.json({ data: products });
  } catch (err) {
    next(err);
  }
});

// Create a product.
productsRouter.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, external_key, sort_order } = req.body as {
      name?: string;
      external_key?: string | null;
      sort_order?: number;
    };
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError(400, 'name is required');
    }
    const externalKey = external_key?.trim() || null;

    let row: Product | null;
    try {
      row = await queryOne<Product>(
        `INSERT INTO products (organization_id, name, external_key, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user!.organizationId, name.trim(), externalKey, sort_order ?? 0]
      );
    } catch (err) {
      // Unique on (org, name) and (org, lower(external_key)).
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'A product with that name or CRM key already exists');
      }
      throw err;
    }

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'product.create',
      entityType: 'product',
      entityId: row!.id,
      metadata: { name: row!.name },
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// Update a product's name / CRM key / active state / order.
productsRouter.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, external_key, is_active, sort_order } = req.body as {
      name?: string;
      external_key?: string | null;
      is_active?: boolean;
      sort_order?: number;
    };
    if (name !== undefined && (!name || !name.trim())) {
      throw new AppError(400, 'name cannot be empty');
    }

    let row: Product | null;
    try {
      row = await queryOne<Product>(
        `UPDATE products SET
           name        = COALESCE($3, name),
           external_key = CASE WHEN $4::boolean THEN $5 ELSE external_key END,
           is_active   = COALESCE($6, is_active),
           sort_order  = COALESCE($7, sort_order),
           updated_at  = now()
         WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [
          req.params.id,
          req.user!.organizationId,
          name?.trim() ?? null,
          // Only touch external_key when the key is present in the body (so
          // COALESCE-style omission is distinguishable from clearing it).
          external_key !== undefined,
          external_key?.trim() || null,
          is_active ?? null,
          sort_order ?? null,
        ]
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'A product with that name or CRM key already exists');
      }
      throw err;
    }
    if (!row) throw new AppError(404, 'Product not found');

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'product.update',
      entityType: 'product',
      entityId: row.id,
      metadata: { name: row.name },
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Retire a product (soft delete). Kept, not hard-deleted, because scorecard
// items reference it via applies_to_products and journeys via journey_products
// — retiring hides it from new selections without breaking historical scores.
productsRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const row = await queryOne<{ id: string }>(
      `UPDATE products SET is_active = false, updated_at = now()
       WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (!row) throw new AppError(404, 'Product not found');
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'product.deactivate',
      entityType: 'product',
      entityId: req.params.id,
    });
    res.json({ message: 'Product retired' });
  } catch (err) {
    next(err);
  }
});
