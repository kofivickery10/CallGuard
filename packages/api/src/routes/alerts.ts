import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { alertsQueue } from '../jobs/queue.js';
import {
  ALERT_TRIGGER_TYPES,
  type AlertRule,
  type AlertTriggerType,
  type Notification,
} from '@callguard/shared';
import type { AlertPayload } from '../services/alert-evaluator.js';

export const alertsRouter = Router();
alertsRouter.use(authenticate);

// ============================================================
// Rules (admin only)
// ============================================================

alertsRouter.get('/rules', requireAdmin, async (req, res, next) => {
  try {
    const rules = await query<AlertRule>(
      `SELECT * FROM alert_rules WHERE organization_id = $1 ORDER BY created_at DESC`,
      [req.user!.organizationId]
    );
    res.json({ data: rules });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/rules', requireAdmin, async (req, res, next) => {
  try {
    const { name, description, trigger_type, trigger_config, channels, is_active = true } = req.body;

    if (!name || !trigger_type || !channels) {
      throw new AppError(400, 'name, trigger_type, and channels are required');
    }
    if (!ALERT_TRIGGER_TYPES.includes(trigger_type as AlertTriggerType)) {
      throw new AppError(400, `Invalid trigger_type: ${trigger_type}`);
    }

    const rows = await query<AlertRule>(
      `INSERT INTO alert_rules
         (organization_id, name, description, trigger_type, trigger_config, channels, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.user!.organizationId,
        name,
        description || null,
        trigger_type,
        JSON.stringify(trigger_config || {}),
        JSON.stringify(channels),
        is_active,
        req.user!.userId,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

alertsRouter.put('/rules/:id', requireAdmin, async (req, res, next) => {
  try {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM alert_rules WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.user!.organizationId]
    );
    if (!existing) throw new AppError(404, 'Alert rule not found');

    const { name, description, trigger_type, trigger_config, channels, is_active } = req.body;

    const rows = await query<AlertRule>(
      `UPDATE alert_rules SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         trigger_type = COALESCE($3, trigger_type),
         trigger_config = COALESCE($4, trigger_config),
         channels = COALESCE($5, channels),
         is_active = COALESCE($6, is_active),
         updated_at = now()
       WHERE id = $7
       RETURNING *`,
      [
        name,
        description,
        trigger_type,
        trigger_config ? JSON.stringify(trigger_config) : null,
        channels ? JSON.stringify(channels) : null,
        is_active,
        existing.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

alertsRouter.delete('/rules/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await queryOne(
      `DELETE FROM alert_rules WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'Alert rule not found');
    res.json({ message: 'Alert rule deleted' });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/rules/:id/test', requireAdmin, async (req, res, next) => {
  try {
    const rule = await queryOne<AlertRule>(
      `SELECT * FROM alert_rules WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.user!.organizationId]
    );
    if (!rule) throw new AppError(404, 'Alert rule not found');

    const channels = rule.channels;
    const payload: AlertPayload = {
      title: `Test alert: ${rule.name}`,
      body: `This is a test alert to verify delivery channels are working. It was triggered manually by an admin.`,
      severity: 'info',
      call_id: '',
      call_file_name: 'test-call.mp3',
      agent_name: 'Test Agent',
      overall_score: 75,
      matched_reason: 'Manual test',
    };

    if (channels.email?.recipients?.length) {
      for (const recipient of channels.email.recipients) {
        await alertsQueue.add('deliver', {
          ruleId: rule.id,
          callId: null,
          channel: 'email',
          target: recipient,
          payload,
        });
      }
    }
    if (channels.slack?.webhook_url) {
      await alertsQueue.add('deliver', {
        ruleId: rule.id,
        callId: null,
        channel: 'slack',
        target: channels.slack.webhook_url,
        payload,
      });
    }
    if (channels.in_app) {
      let userIds: string[] = [];
      if (channels.in_app.user_ids === 'all_admins') {
        const admins = await query<{ id: string }>(
          `SELECT id FROM users WHERE organization_id = $1 AND role = 'admin'`,
          [req.user!.organizationId]
        );
        userIds = admins.map((a) => a.id);
      } else if (Array.isArray(channels.in_app.user_ids)) {
        userIds = channels.in_app.user_ids;
      }
      for (const userId of userIds) {
        await alertsQueue.add('deliver', {
          ruleId: rule.id,
          callId: null,
          channel: 'in_app',
          target: userId,
          payload,
        });
      }
    }

    res.json({ message: 'Test alert queued for delivery' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Notifications (any authenticated user)
// ============================================================

alertsRouter.get('/notifications', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const unreadOnly = req.query.unread_only === 'true';

    let sql = `SELECT * FROM notifications WHERE user_id = $1`;
    const params: unknown[] = [req.user!.userId];
    if (unreadOnly) sql += ` AND read_at IS NULL`;
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const notifications = await query<Notification>(sql, params);
    res.json({ data: notifications });
  } catch (err) {
    next(err);
  }
});

alertsRouter.get('/notifications/unread-count', async (req, res, next) => {
  try {
    const result = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM notifications
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user!.userId]
    );
    res.json({ count: parseInt(result?.count || '0') });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/notifications/:id/read', async (req, res, next) => {
  try {
    const result = await queryOne(
      `UPDATE notifications SET read_at = now()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL
        RETURNING id`,
      [req.params.id, req.user!.userId]
    );
    if (!result) throw new AppError(404, 'Notification not found or already read');
    res.json({ message: 'Marked as read' });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/notifications/mark-all-read', async (req, res, next) => {
  try {
    await query(
      `UPDATE notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user!.userId]
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    next(err);
  }
});
