import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticate } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';

export const usersRouter = Router();

usersRouter.use(authenticate);

// ── GET /users/me — current user profile ──────────────────────────────────────

usersRouter.get('/me', async (req, res, next) => {
  try {
    const user = await queryOne<{
      id: string;
      email: string;
      name: string;
      role: string;
      organization_id: string | null;
    }>(
      'SELECT id, email, name, role, organization_id FROM users WHERE id = $1',
      [req.user!.userId]
    );
    if (!user) throw new AppError(404, 'User not found');
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// ── PUT /users/me — update display name ──────────────────────────────────────

usersRouter.put('/me', async (req, res, next) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError(400, 'name is required');
    }
    const rows = await query<{ id: string; name: string }>(
      'UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name',
      [name.trim(), req.user!.userId]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── PUT /users/me/password — change password ─────────────────────────────────

usersRouter.put('/me/password', async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body as {
      current_password?: string;
      new_password?: string;
    };

    if (!current_password || !new_password) {
      throw new AppError(400, 'current_password and new_password are required');
    }
    if (new_password.length < 8) {
      throw new AppError(400, 'New password must be at least 8 characters');
    }

    const user = await queryOne<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user!.userId]
    );
    if (!user) throw new AppError(404, 'User not found');

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) throw new AppError(400, 'Current password is incorrect');

    const newHash = await bcrypt.hash(new_password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user!.userId]);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
