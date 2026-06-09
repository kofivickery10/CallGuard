import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { authenticate, AuthPayload } from '../middleware/auth.js';
import { acceptInvite, getInvitePreview } from '../services/invites.js';

export const authRouter = Router();

// Self-service registration has been removed. Organisations are provisioned by
// a superadmin (POST /api/admin/tenants), and their users join via emailed
// invitations (/auth/invite/:token + /auth/accept-invite below).

// Preview an invitation (for the accept page) — no auth, no token leakage.
authRouter.get('/invite/:token', async (req, res, next) => {
  try {
    const preview = await getInvitePreview(req.params.token);
    if (!preview) throw new AppError(404, 'This invitation is invalid or has expired');
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

// Accept an invitation: set a password, create the user, return a session.
authRouter.post('/accept-invite', async (req, res, next) => {
  try {
    const { token, password } = req.body as { token?: string; password?: string };
    if (!token) throw new AppError(400, 'token is required');

    const accepted = await acceptInvite(token, password || '');

    const org = await queryOne<{ name: string; plan: string }>(
      'SELECT name, plan FROM organizations WHERE id = $1',
      [accepted.organizationId]
    );

    const payload: AuthPayload = {
      userId: accepted.userId,
      organizationId: accepted.organizationId,
      role: accepted.role,
    };
    const sessionToken = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

    res.status(201).json({
      token: sessionToken,
      user: {
        id: accepted.userId,
        email: accepted.email,
        name: accepted.name,
        role: accepted.role,
        is_staff: false,
        organization_id: accepted.organizationId,
        organization_name: org?.name || '',
        organization_plan: org?.plan || 'starter',
      },
    });
  } catch (err) {
    next(err);
  }
});

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
      organization_id: string;
    }>(
      `SELECT u.id, u.email, u.name, u.role, u.is_staff, u.password_hash, u.organization_id
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

    const org = await queryOne<{ name: string; plan: string }>(
      'SELECT name, plan FROM organizations WHERE id = $1',
      [user.organization_id]
    );

    const payload: AuthPayload = {
      userId: user.id,
      organizationId: user.organization_id,
      role: user.role,
    };

    const token = jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        is_staff: user.is_staff,
        organization_id: user.organization_id,
        organization_name: org?.name || '',
        organization_plan: org?.plan || 'starter',
      },
    });
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
    }>(
      'SELECT id, email, name, role, is_staff, organization_id FROM users WHERE id = $1',
      [req.user!.userId]
    );

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const org = await queryOne<{ name: string; plan: string }>(
      'SELECT name, plan FROM organizations WHERE id = $1',
      [user.organization_id]
    );

    res.json({
      user: {
        ...user,
        organization_name: org?.name || '',
        organization_plan: org?.plan || 'starter',
      },
    });
  } catch (err) {
    next(err);
  }
});
