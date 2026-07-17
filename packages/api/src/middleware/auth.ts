import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AppError } from './errors.js';
import { query, queryOne } from '../db/client.js';
import { hashApiKey } from '../services/api-keys.js';

export interface AuthPayload {
  userId: string;
  // Empty string for superadmin users (no org context).
  organizationId: string;
  role: string;
  // Token kind. Access tokens omit this (treated as 'access'); short-lived 2FA
  // login-challenge tokens set 'mfa' and are rejected by `authenticate`.
  typ?: 'access' | 'mfa';
  // True once the second factor is satisfied (enrolled + verified). Derived from
  // the user's totp_enabled state at token-issue time. Access tokens without it
  // are gated out of the app until the user enrols — see the MFA gate below.
  mfa?: boolean;
  // Set on impersonation tokens minted by a superadmin for support. `imp` flags
  // the session so the tenant app can show a banner; `impBy` is the superadmin's
  // user id for the audit trail.
  imp?: boolean;
  impBy?: string;
}

// Authenticated paths an unenrolled user may still reach so they can complete
// (or be told to complete) 2FA enrolment. Everything else is gated until the
// access token carries `mfa: true`. Matched against req.originalUrl.
const MFA_EXEMPT_PREFIXES = ['/api/auth/2fa', '/api/auth/me', '/api/auth/logout'];

function isMfaExempt(originalUrl: string): boolean {
  const path = originalUrl.split('?')[0] ?? originalUrl;
  // Exact match or a sub-path (so /api/auth/2fa covers /api/auth/2fa/setup, but
  // /api/auth/me does NOT loosely match a hypothetical /api/auth/members).
  return MFA_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

// Routes an org-less token (a superadmin — no organization_id) is allowed to
// reach: their own auth/session endpoints, the cross-tenant superadmin API, and
// the shared support inbox. Everything else is tenant-scoped and would pass an
// empty organizationId into a UUID-typed WHERE clause (Postgres: "invalid input
// syntax for type uuid: \"\""). Matched against req.originalUrl.
const ORG_OPTIONAL_PREFIXES = ['/api/auth', '/api/superadmin', '/api/support'];

function isOrgOptional(originalUrl: string): boolean {
  const path = originalUrl.split('?')[0] ?? originalUrl;
  return ORG_OPTIONAL_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

// Track which user IDs had last_active_at updated in the current 5-min window.
// Cleared on a rolling timer so the memory footprint stays bounded.
const recentlyActiveUsers = new Set<string>();
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function touchLastActive(userId: string): void {
  if (recentlyActiveUsers.has(userId)) return;
  recentlyActiveUsers.add(userId);
  // Write fire-and-forget; never throws on the request path.
  query('UPDATE users SET last_active_at = now() WHERE id = $1', [userId]).catch(
    (err) => console.error('[auth] last_active_at update failed:', err)
  );
  // Reset the dedup window every 5 minutes.
  if (!clearTimer) {
    clearTimer = setTimeout(() => {
      recentlyActiveUsers.clear();
      clearTimer = null;
    }, 5 * 60 * 1000);
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
  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, config.jwt.secret) as AuthPayload;
  } catch {
    throw new AppError(401, 'Invalid or expired token');
  }

  // 2FA login-challenge tokens are not valid for API access — they only unlock
  // the /api/auth/2fa/login/* endpoints, which verify them out of the body.
  if (payload.typ === 'mfa') {
    throw new AppError(401, 'Invalid or expired token');
  }

  // MFA enrolment gate. 2FA is mandatory: any access token that has not satisfied
  // the second factor (mfa !== true) is blocked from every route except the
  // enrolment endpoints. API-key sessions are exempt (machine-to-machine).
  if (payload.mfa !== true && payload.role !== 'api' && !isMfaExempt(req.originalUrl)) {
    throw new AppError(403, 'Two-factor enrolment required', 'MFA_ENROLMENT_REQUIRED');
  }

  // Tenant routes are org-scoped. An org-less token (superadmin, whose
  // organizationId is '') would otherwise pass an empty string into a UUID
  // column and surface as a cryptic DB error on every query the page fires.
  // Superadmins belong in the admin console (/api/superadmin, /api/support), so
  // reject them from tenant routes cleanly rather than letting the query blow up.
  if (!payload.organizationId && payload.role !== 'api' && !isOrgOptional(req.originalUrl)) {
    throw new AppError(403, 'This account has no organisation context; use the admin console', 'NO_ORG_CONTEXT');
  }

  req.user = payload;
  touchLastActive(payload.userId);
  next();
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

// Platform superadmin — full cross-tenant access. Superadmins have no
// organization_id (see seed-superadmin.ts); requiring it be empty here is
// defence-in-depth against a tenant-scoped user ever ending up with the
// 'superadmin' role (e.g. a future bug in a tenant-facing role-assignment
// endpoint) being able to reach these routes.
export function requireSuperadmin(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== 'superadmin' || req.user.organizationId) {
    throw new AppError(403, 'Superadmin access required');
  }
  next();
}

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

// Support-inbox access: platform superadmins (the admin app) OR is_staff operators
// (the staff view in the tenant app). Superadmin comes from the token; is_staff is
// looked up live, so it never depends on a stale token claim.
export async function requireSuperadminOrStaff(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    if (req.user.role === 'superadmin') return next();
    const row = await queryOne<{ is_staff: boolean }>(
      'SELECT is_staff FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!row?.is_staff) throw new AppError(403, 'Support access required');
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
  try {
    // Prefer the header — some webhook senders (e.g. a dialler's basic
    // "webhook URL" field, with no way to add custom headers) can only reach
    // us via the URL itself, so a query-string fallback is accepted too.
    // Header wins if somehow both are present.
    const headerKey = req.headers['x-api-key'];
    const queryKey = req.query.api_key;
    const apiKey =
      typeof headerKey === 'string' ? headerKey : typeof queryKey === 'string' ? queryKey : null;
    if (!apiKey) {
      throw new AppError(401, 'Missing API key (X-API-Key header or ?api_key= query parameter)');
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
  } catch (err) {
    next(err);
  }
}
