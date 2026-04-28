import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';

export const agentRouter = Router();
agentRouter.use(authenticate);
agentRouter.use(requireAdmin);

// List all agents with stats
agentRouter.get('/', async (req, res, next) => {
  try {
    const agents = await query(
      `SELECT
        u.id, u.name, u.email, u.created_at,
        COUNT(c.id) as total_calls,
        COUNT(c.id) FILTER (WHERE c.status = 'scored') as scored_calls,
        AVG(cs.overall_score) as average_score,
        CASE
          WHEN COUNT(cs.id) > 0
          THEN (COUNT(cs.id) FILTER (WHERE cs.pass = true)::numeric / COUNT(cs.id) * 100)
          ELSE NULL
        END as pass_rate
       FROM users u
       LEFT JOIN calls c ON c.agent_id = u.id
       LEFT JOIN call_scores cs ON cs.call_id = c.id
       WHERE u.organization_id = $1 AND u.role = 'member'
       GROUP BY u.id
       ORDER BY u.name`,
      [req.user!.organizationId]
    );

    res.json({
      data: agents.map((a: Record<string, unknown>) => ({
        ...a,
        total_calls: parseInt(a.total_calls as string) || 0,
        scored_calls: parseInt(a.scored_calls as string) || 0,
        average_score: a.average_score ? parseFloat(a.average_score as string) : null,
        pass_rate: a.pass_rate ? parseFloat(a.pass_rate as string) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Create agent (invite)
agentRouter.post('/', async (req, res, next) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      throw new AppError(400, 'email, name, and password are required');
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) {
      throw new AppError(409, 'Email already registered');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const rows = await query<{ id: string; email: string; name: string; role: string; created_at: string }>(
      `INSERT INTO users (organization_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'member') RETURNING id, email, name, role, created_at`,
      [req.user!.organizationId, email, name, passwordHash]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Get agent stats
agentRouter.get('/:id/stats', async (req, res, next) => {
  try {
    const agent = await queryOne(
      'SELECT id, name, email FROM users WHERE id = $1 AND organization_id = $2 AND role = $3',
      [req.params.id, req.user!.organizationId, 'member']
    );
    if (!agent) throw new AppError(404, 'Agent not found');

    const stats = await queryOne<{
      total_calls: string;
      scored_calls: string;
      average_score: string | null;
      pass_rate: string | null;
    }>(
      `SELECT
        COUNT(c.id) as total_calls,
        COUNT(c.id) FILTER (WHERE c.status = 'scored') as scored_calls,
        AVG(cs.overall_score) as average_score,
        CASE
          WHEN COUNT(cs.id) > 0
          THEN (COUNT(cs.id) FILTER (WHERE cs.pass = true)::numeric / COUNT(cs.id) * 100)
          ELSE NULL
        END as pass_rate
       FROM calls c
       LEFT JOIN call_scores cs ON cs.call_id = c.id
       WHERE c.agent_id = $1`,
      [req.params.id]
    );

    res.json({
      ...agent,
      total_calls: parseInt(stats?.total_calls || '0'),
      scored_calls: parseInt(stats?.scored_calls || '0'),
      average_score: stats?.average_score ? parseFloat(stats.average_score) : null,
      pass_rate: stats?.pass_rate ? parseFloat(stats.pass_rate) : null,
    });
  } catch (err) {
    next(err);
  }
});

// Delete agent
agentRouter.delete('/:id', async (req, res, next) => {
  try {
    const agent = await queryOne(
      'SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = $3',
      [req.params.id, req.user!.organizationId, 'member']
    );
    if (!agent) throw new AppError(404, 'Agent not found');

    // Unlink calls, don't delete the user (preserve history)
    await query('UPDATE calls SET agent_id = NULL WHERE agent_id = $1', [req.params.id]);
    await query('DELETE FROM users WHERE id = $1', [req.params.id]);

    res.json({ message: 'Agent removed' });
  } catch (err) {
    next(err);
  }
});
