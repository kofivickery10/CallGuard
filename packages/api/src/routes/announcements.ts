import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { query } from '../db/client.js';

// Tenant-facing: the active platform announcements to show as a banner.
// Any authenticated user may read them. Authoring lives in /superadmin.
export const announcementsRouter = Router();

announcementsRouter.use(authenticate);

announcementsRouter.get('/', async (_req, res, next) => {
  try {
    const announcements = await query<{
      id: string;
      title: string;
      body: string;
      level: string;
      starts_at: string | null;
      ends_at: string | null;
    }>(
      `SELECT id, title, body, level, starts_at, ends_at
       FROM announcements
       WHERE active = true
         AND (starts_at IS NULL OR starts_at <= now())
         AND (ends_at   IS NULL OR ends_at   >= now())
       ORDER BY
         CASE level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
         created_at DESC`
    );
    res.json({ announcements });
  } catch (err) {
    next(err);
  }
});
