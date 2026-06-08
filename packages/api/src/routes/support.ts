import { Router } from 'express';
import { authenticate, requireStaff } from '../middleware/auth.js';
import { query } from '../db/client.js';
import { AppError } from '../middleware/errors.js';

export const supportRouter = Router();
supportRouter.use(authenticate);

interface SupportMessage {
  id: string;
  organization_id: string;
  sender_user_id: string | null;
  from_staff: boolean;
  body: string;
  created_at: string;
}

// ── Tenant side: a user's conversation with CallGuard support (own org only) ──

supportRouter.get('/messages', async (req, res, next) => {
  try {
    const rows = await query<SupportMessage & { sender_name: string | null }>(
      `SELECT m.*, u.name AS sender_name
         FROM support_messages m
         LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.organization_id = $1
        ORDER BY m.created_at`,
      [req.user!.organizationId]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

supportRouter.post('/messages', async (req, res, next) => {
  try {
    const body = (req.body?.body as string | undefined)?.trim();
    if (!body) throw new AppError(400, 'Message body is required');
    const rows = await query<SupportMessage>(
      `INSERT INTO support_messages (organization_id, sender_user_id, from_staff, body)
       VALUES ($1, $2, false, $3) RETURNING *`,
      [req.user!.organizationId, req.user!.userId, body.slice(0, 5000)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Staff side: cross-tenant inbox for the platform operator ──

supportRouter.get('/threads', requireStaff, async (_req, res, next) => {
  try {
    // One row per org that has any support messages, newest activity first.
    const rows = await query<{
      organization_id: string;
      organization_name: string;
      message_count: string;
      last_message_at: string;
      last_body: string;
      last_from_staff: boolean;
    }>(
      `SELECT m.organization_id,
              o.name AS organization_name,
              COUNT(*)::text AS message_count,
              MAX(m.created_at) AS last_message_at,
              (ARRAY_AGG(m.body ORDER BY m.created_at DESC))[1] AS last_body,
              (ARRAY_AGG(m.from_staff ORDER BY m.created_at DESC))[1] AS last_from_staff
         FROM support_messages m
         JOIN organizations o ON o.id = m.organization_id
        GROUP BY m.organization_id, o.name
        ORDER BY MAX(m.created_at) DESC`,
      []
    );
    res.json({
      data: rows.map((r) => ({
        organization_id: r.organization_id,
        organization_name: r.organization_name,
        message_count: parseInt(r.message_count, 10),
        last_message_at: r.last_message_at,
        last_body: r.last_body,
        // The tenant spoke last → it's awaiting your reply.
        awaiting_reply: !r.last_from_staff,
      })),
    });
  } catch (err) {
    next(err);
  }
});

supportRouter.get('/threads/:orgId/messages', requireStaff, async (req, res, next) => {
  try {
    const rows = await query<SupportMessage & { sender_name: string | null }>(
      `SELECT m.*, u.name AS sender_name
         FROM support_messages m
         LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.organization_id = $1
        ORDER BY m.created_at`,
      [req.params.orgId]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

supportRouter.post('/threads/:orgId/messages', requireStaff, async (req, res, next) => {
  try {
    const body = (req.body?.body as string | undefined)?.trim();
    if (!body) throw new AppError(400, 'Message body is required');
    const rows = await query<SupportMessage>(
      `INSERT INTO support_messages (organization_id, sender_user_id, from_staff, body)
       VALUES ($1, $2, true, $3) RETURNING *`,
      [req.params.orgId, req.user!.userId, body.slice(0, 5000)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});
