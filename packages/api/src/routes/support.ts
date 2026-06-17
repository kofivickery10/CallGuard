import { Router, Request } from 'express';
import { authenticate, requireSuperadminOrStaff } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
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

// True for users who see the cross-tenant inbox (admin app superadmins or
// is_staff operators in the tenant app). is_staff is looked up live so it never
// depends on a stale token claim.
async function isOperator(req: Request): Promise<boolean> {
  if (req.user!.role === 'superadmin') return true;
  const row = await queryOne<{ is_staff: boolean }>(
    'SELECT is_staff FROM users WHERE id = $1',
    [req.user!.userId]
  );
  return !!row?.is_staff;
}

// Upsert a viewer's read watermark for one org thread to "now".
async function markRead(organizationId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO support_thread_reads (organization_id, user_id, last_read_at)
     VALUES ($1, $2, now())
     ON CONFLICT (organization_id, user_id)
     DO UPDATE SET last_read_at = now()`,
    [organizationId, userId]
  );
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
    // Viewing the thread marks the tenant's staff replies as read.
    await markRead(req.user!.organizationId, req.user!.userId);
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

// ── Unread badges ──

// Count of unread messages for the current viewer. Operators see unanswered
// customer messages across ALL orgs; tenant users see unread staff replies in
// their own org. Drives the red-dot badges on both surfaces.
supportRouter.get('/unread-count', async (req, res, next) => {
  try {
    if (await isOperator(req)) {
      const row = await queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM support_messages m
           LEFT JOIN support_thread_reads r
             ON r.organization_id = m.organization_id AND r.user_id = $1
          WHERE m.from_staff = false
            AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)`,
        [req.user!.userId]
      );
      res.json({ count: parseInt(row?.count ?? '0', 10) });
    } else {
      const row = await queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM support_messages m
           LEFT JOIN support_thread_reads r
             ON r.organization_id = m.organization_id AND r.user_id = $1
          WHERE m.organization_id = $2
            AND m.from_staff = true
            AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)`,
        [req.user!.userId, req.user!.organizationId]
      );
      res.json({ count: parseInt(row?.count ?? '0', 10) });
    }
  } catch (err) {
    next(err);
  }
});

// ── Staff side: cross-tenant inbox for the platform operator ──

supportRouter.get('/threads', requireSuperadminOrStaff, async (req, res, next) => {
  try {
    // One row per org that has any support messages, newest activity first.
    // unread_count = customer messages newer than THIS operator's read watermark.
    const rows = await query<{
      organization_id: string;
      organization_name: string;
      message_count: string;
      last_message_at: string;
      last_body: string;
      last_from_staff: boolean;
      unread_count: string;
    }>(
      `SELECT m.organization_id,
              o.name AS organization_name,
              COUNT(*)::text AS message_count,
              MAX(m.created_at) AS last_message_at,
              (ARRAY_AGG(m.body ORDER BY m.created_at DESC))[1] AS last_body,
              (ARRAY_AGG(m.from_staff ORDER BY m.created_at DESC))[1] AS last_from_staff,
              COUNT(*) FILTER (
                WHERE m.from_staff = false
                  AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
              )::text AS unread_count
         FROM support_messages m
         JOIN organizations o ON o.id = m.organization_id
         LEFT JOIN support_thread_reads r
           ON r.organization_id = m.organization_id AND r.user_id = $1
        GROUP BY m.organization_id, o.name, r.last_read_at
        ORDER BY MAX(m.created_at) DESC`,
      [req.user!.userId]
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
        unread_count: parseInt(r.unread_count, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
});

supportRouter.get('/threads/:orgId/messages', requireSuperadminOrStaff, async (req, res, next) => {
  try {
    const rows = await query<SupportMessage & { sender_name: string | null }>(
      `SELECT m.*, u.name AS sender_name
         FROM support_messages m
         LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.organization_id = $1
        ORDER BY m.created_at`,
      [req.params.orgId]
    );
    // Viewing the thread marks this operator's caught-up on the customer's messages.
    await markRead(String(req.params.orgId), req.user!.userId);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

supportRouter.post('/threads/:orgId/messages', requireSuperadminOrStaff, async (req, res, next) => {
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
