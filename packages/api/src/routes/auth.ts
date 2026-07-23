import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { authenticate, AuthPayload } from '../middleware/auth.js';
import { countUnusedBackupCodes, maskEmail } from '../services/two-factor.js';
import { effectivePlan } from '@callguard/shared';
import type { Plan } from '@callguard/shared';

export const authRouter = Router();

// ── Refresh token helpers ─────────────────────────────────────────────────────

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function createRefreshToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(48).toString('base64url');
  const hash = hashToken(raw);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + config.jwt.refreshExpiresInDays);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt.toISOString()]
  );
  return raw;
}

async function revokeRefreshToken(raw: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(raw)]
  );
}

// ── Session issuance ──────────────────────────────────────────────────────────

export interface SessionResponse {
  token: string;
  refresh_token: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    is_staff: boolean;
    organization_id: string | null;
    organization_name: string;
    organization_plan: Plan | null;
    // Per-tenant feature grants/denials beyond the plan tier (e.g. score_only).
    feature_overrides: Record<string, boolean>;
    totp_enabled: boolean;
  };
}

// Mint a full access + refresh session for a user. `mfa` records on the access
// token whether the second factor is satisfied — the auth middleware gates any
// token where it isn't true. Used by login (unenrolled), 2FA login verify, and
// enrolment completion.
export async function issueSession(userId: string, mfa: boolean): Promise<SessionResponse> {
  const user = await queryOne<{
    id: string;
    email: string;
    name: string;
    role: string;
    is_staff: boolean;
    organization_id: string | null;
    plan_override: string | null;
    totp_enabled: boolean;
    login_disabled: boolean;
  }>(
    `SELECT id, email, name, role, is_staff, organization_id, plan_override, totp_enabled, login_disabled
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!user) throw new AppError(401, 'User not found');
  // Defence in depth — a no-login account must never be handed a session,
  // whichever path reached here (login, 2FA verify, enrolment completion).
  if (user.login_disabled) throw new AppError(403, 'This account cannot sign in');

  const org = user.organization_id
    ? await queryOne<{ name: string; plan: string; feature_overrides: Record<string, boolean> }>(
        'SELECT name, plan, feature_overrides FROM organizations WHERE id = $1',
        [user.organization_id]
      )
    : null;

  const payload: AuthPayload = {
    userId: user.id,
    organizationId: user.organization_id ?? '',
    role: user.role,
    mfa,
  };
  const token = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
  const refresh_token = await createRefreshToken(user.id);

  const orgPlan = org?.plan as Plan | undefined;
  const organization_plan = orgPlan
    ? effectivePlan(orgPlan, user.plan_override as Plan | null)
    : null;

  return {
    token,
    refresh_token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      is_staff: user.is_staff,
      organization_id: user.organization_id,
      organization_name: org?.name || '',
      organization_plan,
      feature_overrides: org?.feature_overrides ?? {},
      totp_enabled: user.totp_enabled,
    },
  };
}

// Sign a short-lived (5 min) challenge token that unlocks only the 2FA login
// verification endpoints. Rejected by `authenticate` for normal API access.
export function signChallengeToken(userId: string): string {
  return jwt.sign({ userId, typ: 'mfa' } as AuthPayload, config.jwt.secret, { expiresIn: '5m' });
}

// NOTE: Public registration is intentionally removed. Tenants are provisioned
// by superadmin via POST /superadmin/tenants.

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new AppError(400, 'email and password are required');
    }

    const user = await queryOne<{
      id: string;
      email: string;
      password_hash: string | null;
      totp_enabled: boolean;
      two_factor_exempt: boolean;
      login_disabled: boolean;
    }>(
      `SELECT u.id, u.email, u.password_hash, u.totp_enabled, u.two_factor_exempt, u.login_disabled
       FROM users u WHERE u.email = $1`,
      [email]
    );

    if (!user) {
      throw new AppError(401, 'Invalid email or password');
    }

    // No-login advisers (login_disabled, or simply no password set) can never
    // sign in. Return the same neutral error as a bad password so this doesn't
    // become an account-enumeration oracle.
    if (user.login_disabled || !user.password_hash) {
      throw new AppError(401, 'Invalid email or password');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new AppError(401, 'Invalid email or password');
    }

    // 2FA is mandatory. If the user has enrolled, the password is only the first
    // factor — hand back a short-lived challenge token and stop here. The client
    // completes the second factor at /auth/2fa/login/verify.
    if (user.totp_enabled) {
      const backupCodes = await countUnusedBackupCodes(user.id);
      res.json({
        two_factor_required: true,
        challenge_token: signChallengeToken(user.id),
        methods: ['totp', 'email', ...(backupCodes > 0 ? ['backup'] : [])],
        email_hint: maskEmail(user.email),
      });
      return;
    }

    // 2FA-exempt accounts (superadmin-seeded internal/setup logins) skip both the
    // challenge and mandatory enrolment: issue a full session with mfa satisfied.
    if (user.two_factor_exempt) {
      const session = await issueSession(user.id, true);
      res.json(session);
      return;
    }

    // Not yet enrolled. Issue a session, but without mfa satisfied — the auth gate
    // confines this token to the enrolment endpoints until the user sets up TOTP.
    const session = await issueSession(user.id, false);
    res.json({ ...session, mfa_enrolment_required: true });
  } catch (err) {
    next(err);
  }
});

// Exchange a valid refresh token for a new access JWT.
// Rotates the refresh token on each use (prevents replay attacks).
authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body as { refresh_token?: string };
    if (!refresh_token || typeof refresh_token !== 'string') {
      throw new AppError(400, 'refresh_token is required');
    }

    const hash = hashToken(refresh_token);
    const record = await queryOne<{
      id: string;
      user_id: string;
      expires_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, revoked_at
         FROM refresh_tokens
        WHERE token_hash = $1`,
      [hash]
    );

    if (!record || record.revoked_at || new Date(record.expires_at) < new Date()) {
      throw new AppError(401, 'Invalid or expired refresh token');
    }

    // Revoke the used token and issue a fresh one (rotation).
    await revokeRefreshToken(refresh_token);
    const newRefreshToken = await createRefreshToken(record.user_id);

    // Update last_used_at on the old token (fire-and-forget; already revoked above).
    query('UPDATE refresh_tokens SET last_used_at = now() WHERE id = $1', [record.id]).catch(
      () => undefined
    );

    const user = await queryOne<{
      id: string;
      organization_id: string | null;
      role: string;
      totp_enabled: boolean;
      two_factor_exempt: boolean;
      login_disabled: boolean;
    }>(
      'SELECT id, organization_id, role, totp_enabled, two_factor_exempt, login_disabled FROM users WHERE id = $1',
      [record.user_id]
    );
    if (!user) throw new AppError(401, 'User not found');
    // Access tokens are short-lived (15m); refusing to refresh a now-disabled
    // account bounds any lingering session to at most one token lifetime.
    if (user.login_disabled) throw new AppError(401, 'Invalid or expired refresh token');

    const payload: AuthPayload = {
      userId: user.id,
      organizationId: user.organization_id ?? '',
      role: user.role,
      // Re-derive the second-factor state from the DB on every refresh so the gate
      // stays correct without a re-login (enrolment grants mfa; a reset revokes it).
      // Exempt accounts stay satisfied without enrolling.
      mfa: user.totp_enabled || user.two_factor_exempt,
    };
    const token = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

    res.json({ token, refresh_token: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

// Revoke the refresh token (logout). The short-lived access JWT will expire naturally.
authRouter.post('/logout', async (req, res, next) => {
  try {
    const { refresh_token } = req.body as { refresh_token?: string };
    if (refresh_token && typeof refresh_token === 'string') {
      await revokeRefreshToken(refresh_token);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await queryOne<{
      id: string;
      email: string;
      name: string;
      role: string;
      is_staff: boolean;
      organization_id: string;
      plan_override: string | null;
      totp_enabled: boolean;
    }>(
      'SELECT id, email, name, role, is_staff, organization_id, plan_override, totp_enabled FROM users WHERE id = $1',
      [req.user!.userId]
    );

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const org = await queryOne<{ name: string; plan: string; feature_overrides: Record<string, boolean> }>(
      'SELECT name, plan, feature_overrides FROM organizations WHERE id = $1',
      [user.organization_id]
    );

    const orgPlan = org?.plan as Plan | undefined;
    const organization_plan = orgPlan
      ? effectivePlan(orgPlan, user.plan_override as Plan | null)
      : null;

    res.json({
      user: {
        ...user,
        organization_name: org?.name || '',
        organization_plan,
        feature_overrides: org?.feature_overrides ?? {},
        // True when the caller is a superadmin impersonating this user.
        impersonated: req.user?.imp === true,
      },
    });
  } catch (err) {
    next(err);
  }
});
