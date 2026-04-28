import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { authenticate, AuthPayload } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, organization_name } = req.body;

    if (!email || !password || !name || !organization_name) {
      throw new AppError(400, 'email, password, name, and organization_name are required');
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) {
      throw new AppError(409, 'Email already registered');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create org and user in a transaction
    const orgRows = await query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [organization_name]
    );
    const orgId = orgRows[0].id;

    const userRows = await query<{ id: string; email: string; name: string; role: string }>(
      `INSERT INTO users (organization_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id, email, name, role`,
      [orgId, email, name, passwordHash]
    );
    const user = userRows[0];

    const payload: AuthPayload = {
      userId: user.id,
      organizationId: orgId,
      role: user.role,
    };

    const token = jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organization_id: orgId,
        organization_name,
        organization_plan: 'growth',
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
      password_hash: string;
      organization_id: string;
    }>(
      `SELECT u.id, u.email, u.name, u.role, u.password_hash, u.organization_id
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
      organization_id: string;
    }>(
      'SELECT id, email, name, role, organization_id FROM users WHERE id = $1',
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
