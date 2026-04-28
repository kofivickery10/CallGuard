import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { config } from '../config.js';
import type {
  PublicCallView,
  PublicCallViewItem,
  CallShareLink,
} from '@callguard/shared';

interface ShareTokenPayload {
  call_id: string;
  organization_id: string;
  jti: string;
}

// ============================================================
// Admin router (attached under /api/calls/:id/share-links)
// ============================================================

export const adminShareRouter = Router({ mergeParams: true });
adminShareRouter.use(authenticate);
adminShareRouter.use(requireAdmin);

adminShareRouter.get('/', async (req, res, next) => {
  try {
    const callId = (req.params as { id?: string }).id;
    if (!callId) throw new AppError(400, 'Missing call id');

    // Verify call belongs to org
    const call = await queryOne<{ id: string }>(
      'SELECT id FROM calls WHERE id = $1 AND organization_id = $2',
      [callId, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    const links = await query<{
      id: string;
      call_id: string;
      token_jti: string;
      expires_at: string;
      revoked_at: string | null;
      view_count: number;
      last_viewed_at: string | null;
      created_at: string;
      feedback_count: string;
      avg_stars: string | null;
    }>(
      `SELECT sl.*,
              COUNT(f.id)::text as feedback_count,
              AVG(f.stars)::text as avg_stars
         FROM call_share_links sl
         LEFT JOIN call_feedback f ON f.share_link_id = sl.id
        WHERE sl.call_id = $1
        GROUP BY sl.id
        ORDER BY sl.created_at DESC`,
      [callId]
    );

    const appUrl = config.appUrl.replace(/\/$/, '');
    const data: CallShareLink[] = links.map((l) => {
      const token = jwt.sign(
        { call_id: l.call_id, organization_id: req.user!.organizationId, jti: l.token_jti } as ShareTokenPayload,
        config.jwt.secret,
        { expiresIn: Math.max(1, Math.floor((new Date(l.expires_at).getTime() - Date.now()) / 1000)) }
      );
      return {
        id: l.id,
        call_id: l.call_id,
        url: `${appUrl}/shared/${token}`,
        expires_at: l.expires_at,
        revoked_at: l.revoked_at,
        view_count: l.view_count,
        last_viewed_at: l.last_viewed_at,
        created_at: l.created_at,
        feedback_count: parseInt(l.feedback_count),
        avg_stars: l.avg_stars ? parseFloat(l.avg_stars) : null,
      };
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminShareRouter.post('/', async (req, res, next) => {
  try {
    const callId = (req.params as { id?: string }).id;
    if (!callId) throw new AppError(400, 'Missing call id');

    const { expires_in_days = 7 } = req.body;
    const days = Math.max(1, Math.min(90, Number(expires_in_days) || 7));

    const call = await queryOne<{ id: string }>(
      'SELECT id FROM calls WHERE id = $1 AND organization_id = $2',
      [callId, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    const jti = uuid();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const rows = await query<{ id: string; expires_at: string; created_at: string }>(
      `INSERT INTO call_share_links
         (call_id, organization_id, token_jti, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, expires_at, created_at`,
      [callId, req.user!.organizationId, jti, req.user!.userId, expiresAt]
    );

    const token = jwt.sign(
      { call_id: callId, organization_id: req.user!.organizationId, jti } as ShareTokenPayload,
      config.jwt.secret,
      { expiresIn: `${days}d` }
    );

    const appUrl = config.appUrl.replace(/\/$/, '');
    const url = `${appUrl}/shared/${token}`;

    res.status(201).json({
      id: rows[0]!.id,
      url,
      expires_at: rows[0]!.expires_at,
      created_at: rows[0]!.created_at,
    });
  } catch (err) {
    next(err);
  }
});

adminShareRouter.delete('/:link_id', async (req, res, next) => {
  try {
    const callId = (req.params as { id?: string; link_id?: string }).id;
    const linkId = (req.params as { id?: string; link_id?: string }).link_id;

    const result = await queryOne(
      `UPDATE call_share_links SET revoked_at = now()
        WHERE id = $1 AND call_id = $2 AND organization_id = $3 AND revoked_at IS NULL
        RETURNING id`,
      [linkId, callId, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'Share link not found or already revoked');
    res.json({ message: 'Share link revoked' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Public router (attached under /api/public/shared-calls)
// No authentication - uses the signed JWT token from URL
// ============================================================

export const publicShareRouter = Router();

async function verifyShareToken(token: string): Promise<{ payload: ShareTokenPayload; linkId: string; callId: string; orgId: string }> {
  let payload: ShareTokenPayload;
  try {
    payload = jwt.verify(token, config.jwt.secret) as ShareTokenPayload;
  } catch {
    throw new AppError(401, 'Invalid or expired share link');
  }

  if (!payload.jti || !payload.call_id || !payload.organization_id) {
    throw new AppError(401, 'Invalid share link');
  }

  const link = await queryOne<{ id: string; revoked_at: string | null; expires_at: string }>(
    `SELECT id, revoked_at, expires_at FROM call_share_links WHERE token_jti = $1`,
    [payload.jti]
  );
  if (!link) throw new AppError(404, 'Share link not found');
  if (link.revoked_at) throw new AppError(410, 'This link has been revoked');
  if (new Date(link.expires_at) < new Date()) throw new AppError(410, 'This link has expired');

  return {
    payload,
    linkId: link.id,
    callId: payload.call_id,
    orgId: payload.organization_id,
  };
}

publicShareRouter.get('/:token', async (req, res, next) => {
  try {
    const { linkId, callId, orgId } = await verifyShareToken(req.params.token);

    // Increment view count
    await query(
      `UPDATE call_share_links SET view_count = view_count + 1, last_viewed_at = now() WHERE id = $1`,
      [linkId]
    );

    // Load call summary
    const call = await queryOne<{
      file_name: string;
      call_date: string | null;
      duration_seconds: number | null;
      org_name: string;
    }>(
      `SELECT c.file_name, c.call_date, c.duration_seconds, o.name as org_name
         FROM calls c
         JOIN organizations o ON o.id = c.organization_id
        WHERE c.id = $1 AND c.organization_id = $2`,
      [callId, orgId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    const score = await queryOne<{ id: string; overall_score: number | null; pass: boolean | null }>(
      `SELECT id, overall_score, pass FROM call_scores WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [callId]
    );

    let items: PublicCallViewItem[] = [];
    if (score) {
      const raw = await query<{ label: string; normalized_score: string }>(
        `SELECT si.label, cis.normalized_score::text
           FROM call_item_scores cis
           JOIN scorecard_items si ON si.id = cis.scorecard_item_id
          WHERE cis.call_score_id = $1
          ORDER BY si.sort_order`,
        [score.id]
      );
      items = raw.map((r) => {
        const ns = parseFloat(r.normalized_score);
        return { label: r.label, normalized_score: ns, passed: ns >= 70 };
      });
    }

    // Has feedback been submitted already for this link?
    const fb = await queryOne<{ id: string }>(
      `SELECT id FROM call_feedback WHERE share_link_id = $1 LIMIT 1`,
      [linkId]
    );

    const view: PublicCallView = {
      file_name: call.file_name,
      organization_name: call.org_name,
      call_date: call.call_date,
      duration_seconds: call.duration_seconds,
      overall_score: score?.overall_score != null ? Number(score.overall_score) : null,
      pass: score?.pass ?? null,
      items,
      feedback_submitted: !!fb,
    };

    res.json(view);
  } catch (err) {
    next(err);
  }
});

publicShareRouter.post('/:token/feedback', async (req, res, next) => {
  try {
    const { linkId, callId } = await verifyShareToken(req.params.token);

    const { stars, comment } = req.body;
    const starInt = parseInt(stars);
    if (!Number.isFinite(starInt) || starInt < 1 || starInt > 5) {
      throw new AppError(400, 'stars must be 1-5');
    }

    // Only one feedback per share link
    const existing = await queryOne(
      'SELECT id FROM call_feedback WHERE share_link_id = $1',
      [linkId]
    );
    if (existing) throw new AppError(409, 'Feedback already submitted for this link');

    await query(
      `INSERT INTO call_feedback (call_id, share_link_id, stars, comment)
       VALUES ($1, $2, $3, $4)`,
      [callId, linkId, starInt, typeof comment === 'string' ? comment.slice(0, 2000) : null]
    );

    res.json({ message: 'Feedback received - thank you!' });
  } catch (err) {
    next(err);
  }
});
