import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AppError } from './errors.js';
import { query, queryOne } from '../db/client.js';
import { hashApiKey } from '../services/api-keys.js';

export interface AuthPayload {
  userId: string;
  organizationId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

export function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError(401, 'Missing or invalid authorization header');
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.secret) as AuthPayload;
    req.user = payload;
    next();
  } catch {
    throw new AppError(401, 'Invalid or expired token');
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new AppError(403, 'Insufficient permissions');
    }
    next();
  };
}

// Configuration / management - admin only.
export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== 'admin') {
    throw new AppError(403, 'Admin access required');
  }
  next();
}

// Org-wide read access (dashboards, breaches, insights, audit). Advisers are
// scoped to their own calls and are intentionally excluded.
export const requireOrgView = requireRole('admin', 'supervisor', 'viewer');

// Actioning calls (review breaches, correct scores, coach). Not viewers/advisers.
export const requireActioner = requireRole('admin', 'supervisor');

// CallGuard platform operator (cross-tenant support inbox). Looked up live so it
// never depends on a stale token claim.
export async function requireStaff(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    const row = await queryOne<{ is_staff: boolean }>(
      'SELECT is_staff FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!row?.is_staff) throw new AppError(403, 'Staff access required');
    next();
  } catch (err) {
    next(err);
  }
}

export async function authenticateApiKey(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    throw new AppError(401, 'Missing X-API-Key header');
  }

  const keyHash = hashApiKey(apiKey);
  const record = await queryOne<{ id: string; organization_id: string }>(
    'SELECT id, organization_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
    [keyHash]
  );

  if (!record) {
    throw new AppError(401, 'Invalid or revoked API key');
  }

  req.user = {
    userId: record.id,
    organizationId: record.organization_id,
    role: 'api',
  };

  // Fire-and-forget last_used_at update
  query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [record.id]).catch(
    (err) => console.error('[auth] failed to update api_key last_used_at:', err)
  );

  next();
}
