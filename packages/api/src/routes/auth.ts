import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { authenticate, AuthPayload } from '../middleware/auth.js';
import { effectivePlan } from '@callguard/shared';
import type { Plan } from '@callguard/shared';

export const authRouter = Router();

// ── Refresh token helpers ─────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function createRefreshToken(userId: string): Promise<string> {
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
      name: string;
      role: string;
      is_staff: boolean;
      password_hash: string;
      organization_id: string | null;
      plan_override: string | null;
    }>(
      `SELECT u.id, u.email, u.name, u.role, u.is_staff, u.password_hash,
              u.organization_id, u.plan_override
       FROM users u WHERE u.email = $1`,
      [email]
    );

    if (!user) {
      throw new AppError(401, 'Invalid email or password');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new AppError(401, 'Invalid email or password');
    }

    const org = user.organization_id
      ? await queryOne<{ name: string; plan: string }>(
          'SELECT name, plan FROM organizations WHERE id = $1',
          [user.organization_id]
        )
      : null;

    const payload: AuthPayload = {
      userId: user.id,
      // Superadmin has no org — store empty string as sentinel so the type stays string.
      organizationId: user.organization_id ?? '',
      role: user.role,
    };

    const token = jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });
    const refresh_token = await createRefreshToken(user.id);

    const orgPlan = org?.plan as Plan | undefined;
    const organization_plan = orgPlan
      ? effectivePlan(orgPlan, user.plan_override as Plan | null)
      : null;

    res.json({
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
      },
    });
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

    const user = await queryOne<{ id: string; organization_id: string | null; role: string }>(
      'SELECT id, organization_id, role FROM users WHERE id = $1',
      [record.user_id]
    );
    if (!user) throw new AppError(401, 'User not found');

    const payload: AuthPayload = {
      userId: user.id,
      organizationId: user.organization_id ?? '',
      role: user.role,
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
    }>(
      'SELECT id, email, name, role, is_staff, organization_id, plan_override FROM users WHERE id = $1',
      [req.user!.userId]
    );

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const org = await queryOne<{ name: string; plan: string }>(
      'SELECT name, plan FROM organizations WHERE id = $1',
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
        // True when the caller is a superadmin impersonating this user.
        impersonated: req.user?.imp === true,
      },
    });
  } catch (err) {
    next(err);
  }
});
