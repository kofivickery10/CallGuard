import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { TENANT_ASSIGNABLE_ROLES } from '@callguard/shared';

// Tenant admins may only assign tenant-scoped roles — never 'superadmin',
// which has no organization_id and grants cross-tenant platform access.
const isValidRole = (r: unknown): r is string =>
  typeof r === 'string' && (TENANT_ASSIGNABLE_ROLES as readonly string[]).includes(r);

export const agentRouter = Router();
agentRouter.use(authenticate);
agentRouter.use(requireAdmin);

// List all agents with stats
agentRouter.get('/', async (req, res, next) => {
  try {
    // LATERAL join on the latest score per call — a plain join on call_id
    // fans a call with 2+ call_scores rows out into multiple joined rows,
    // double-counting it in total_calls/scored_calls/pass_rate.
    const agents = await query(
      `SELECT
        u.id, u.name, u.email, u.role, u.external_agent_id, u.login_disabled, u.created_at,
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
       LEFT JOIN LATERAL (
         SELECT id, overall_score, pass FROM call_scores
         WHERE call_id = c.id
         ORDER BY scored_at DESC
         LIMIT 1
       ) cs ON true
       WHERE u.organization_id = $1
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

// Create agent. Two shapes:
//   can_login !== false (default) — a normal account: email + password required.
//   can_login === false           — a no-login adviser for call attribution +
//                                    billing only: name alone; email optional,
//                                    no password, login hard-disabled.
agentRouter.post('/', async (req, res, next) => {
  try {
    const name = (req.body.name as string | undefined)?.trim();
    const password = req.body.password as string | undefined;
    const role = isValidRole(req.body.role) ? req.body.role : 'adviser';
    const externalAgentId = (req.body.external_agent_id as string | undefined)?.trim() || null;
    const email = (req.body.email as string | undefined)?.trim() || null;
    const canLogin = req.body.can_login !== false; // default true (backward compatible)

    if (!name) throw new AppError(400, 'name is required');

    let passwordHash: string | null = null;
    if (canLogin) {
      if (!email) throw new AppError(400, 'email is required for an adviser who can sign in');
      if (!password || password.length < 6) {
        throw new AppError(400, 'password (min 6 characters) is required for an adviser who can sign in');
      }
      passwordHash = await bcrypt.hash(password, 12);
    }

    // Uniqueness only applies when an email is provided (multiple no-login
    // advisers can share the "no email" state).
    if (email) {
      const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
      if (existing) throw new AppError(409, 'Email already registered');
    }

    const rows = await query<{ id: string; email: string | null; name: string; role: string; external_agent_id: string | null; login_disabled: boolean; created_at: string }>(
      `INSERT INTO users (organization_id, email, name, password_hash, role, external_agent_id, login_disabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, name, role, external_agent_id, login_disabled, created_at`,
      [req.user!.organizationId, email, name, passwordHash, role, externalAgentId, !canLogin]
    );

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'user.invite',
      entityType: 'user',
      entityId: rows[0].id,
      metadata: { email: rows[0].email, role: rows[0].role, login_disabled: !canLogin },
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Toggle sign-in access for an existing member (admin only, like the rest of
// this router). Enabling a member who has no usable password (a no-login
// adviser) requires a password — and an email if they don't have one — in the
// same request, since you can't sign in without either.
agentRouter.patch('/:id/login', async (req, res, next) => {
  try {
    if (req.params.id === req.user!.userId) {
      throw new AppError(400, 'You cannot change your own sign-in access');
    }
    const canLogin = req.body.can_login === true;
    const password = req.body.password as string | undefined;
    const newEmail = (req.body.email as string | undefined)?.trim() || null;

    const user = await queryOne<{ id: string; email: string | null; password_hash: string | null }>(
      'SELECT id, email, password_hash FROM users WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!user) throw new AppError(404, 'User not found');

    if (!canLogin) {
      // Revoke sign-in. The login_disabled flag blocks fresh logins and refresh
      // (see routes/auth.ts), and we also revoke any outstanding refresh tokens
      // so an existing session can't be renewed. The member's current access
      // token stays valid until it expires (bounded by the short access-token
      // TTL) — stateless JWTs aren't checked against the DB per request.
      await query('UPDATE users SET login_disabled = true, updated_at = now() WHERE id = $1', [user.id]);
      await query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [user.id]
      );
    } else {
      const effectiveEmail = user.email ?? newEmail;
      if (!effectiveEmail) throw new AppError(400, 'an email is required to enable sign-in');
      // A password is required unless the member already has a usable one.
      let passwordHash = user.password_hash;
      if (!passwordHash) {
        if (!password || password.length < 6) {
          throw new AppError(400, 'a password (min 6 characters) is required to enable sign-in');
        }
        passwordHash = await bcrypt.hash(password, 12);
      } else if (password) {
        if (password.length < 6) throw new AppError(400, 'password must be at least 6 characters');
        passwordHash = await bcrypt.hash(password, 12);
      }
      if (newEmail && !user.email) {
        const clash = await queryOne('SELECT id FROM users WHERE email = $1 AND id <> $2', [newEmail, user.id]);
        if (clash) throw new AppError(409, 'Email already registered');
      }
      await query(
        `UPDATE users SET login_disabled = false, password_hash = $2,
                          email = COALESCE(email, $3), updated_at = now()
          WHERE id = $1`,
        [user.id, passwordHash, effectiveEmail]
      );
    }

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: canLogin ? 'user.login_enabled' : 'user.login_revoked',
      entityType: 'user',
      entityId: user.id,
    });

    res.json({ id: user.id, login_disabled: !canLogin });
  } catch (err) {
    next(err);
  }
});

// Update a team member's role and/or dialler mapping (external agent id)
agentRouter.put('/:id', async (req, res, next) => {
  try {
    const externalAgentId = (req.body.external_agent_id as string | undefined)?.trim() || null;
    const role = isValidRole(req.body.role) ? req.body.role : null; // null = leave unchanged
    const rows = await query<{ id: string; name: string; email: string; role: string; external_agent_id: string | null }>(
      `UPDATE users SET external_agent_id = $3, role = COALESCE($4, role), updated_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING id, name, email, role, external_agent_id`,
      [req.params.id, req.user!.organizationId, externalAgentId, role]
    );
    if (rows.length === 0) throw new AppError(404, 'User not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Get agent stats
agentRouter.get('/:id/stats', async (req, res, next) => {
  try {
    const agent = await queryOne(
      'SELECT id, name, email FROM users WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
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
    if (req.params.id === req.user!.userId) {
      throw new AppError(400, 'You cannot remove your own account');
    }
    const agent = await queryOne(
      'SELECT id FROM users WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!agent) throw new AppError(404, 'Agent not found');

    // Unlink calls, don't delete the user (preserve history)
    await query('UPDATE calls SET agent_id = NULL WHERE agent_id = $1', [req.params.id]);
    await query('DELETE FROM users WHERE id = $1', [req.params.id]);

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'user.delete',
      entityType: 'user',
      entityId: req.params.id,
    });

    res.json({ message: 'Agent removed' });
  } catch (err) {
    next(err);
  }
});
