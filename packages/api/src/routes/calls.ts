import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { query, queryOne } from '../db/client.js';
import { uploadFile } from '../services/storage.js';
import { transcriptionQueue } from '../jobs/queue.js';
import { AppError } from '../middleware/errors.js';
import type { Call, CallScore, CallItemScore } from '@callguard/shared';

export const callRouter = Router();
callRouter.use(authenticate);

// List calls (paginated, role-scoped)
callRouter.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;
    const agentId = req.query.agent_id as string | undefined;

    let whereClause = 'WHERE c.organization_id = $1';
    const params: unknown[] = [req.user!.organizationId];

    // Members can only see their own calls
    if (req.user!.role === 'member') {
      params.push(req.user!.userId);
      whereClause += ` AND c.agent_id = $${params.length}`;
    } else if (agentId) {
      // Admins can filter by agent
      params.push(agentId);
      whereClause += ` AND c.agent_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      whereClause += ` AND c.status = $${params.length}`;
    }

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM calls c ${whereClause}`,
      params
    );

    const calls = await query(
      `SELECT c.*, u.name as resolved_agent_name
       FROM calls c
       LEFT JOIN users u ON u.id = c.agent_id
       ${whereClause}
       ORDER BY c.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      data: calls,
      total: parseInt(countResult?.count || '0'),
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

// Upload a call
callRouter.post('/upload', upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new AppError(400, 'No audio file provided');
    }

    const callId = uuid();
    const fileKey = `calls/${req.user!.organizationId}/${callId}/${req.file.originalname}`;

    await uploadFile(fileKey, req.file.buffer, req.file.mimetype);

    // If member, auto-assign to self
    let agentId = req.body.agent_id || null;
    const agentName = req.body.agent_name || null;

    if (req.user!.role === 'member') {
      agentId = req.user!.userId;
    }

    const rows = await query<Call>(
      `INSERT INTO calls (id, organization_id, uploaded_by, file_name, file_key, file_size_bytes, mime_type, agent_id, agent_name, customer_phone, call_date, tags, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'uploaded') RETURNING *`,
      [
        callId,
        req.user!.organizationId,
        req.user!.userId,
        req.file.originalname,
        fileKey,
        req.file.size,
        req.file.mimetype,
        agentId,
        agentName,
        req.body.customer_phone || null,
        req.body.call_date || null,
        req.body.tags ? JSON.parse(req.body.tags) : [],
      ]
    );

    // Auto-match agent_name to a member user if no agent_id was set
    if (!agentId && agentName) {
      await query(
        `UPDATE calls SET agent_id = u.id
         FROM users u
         WHERE calls.id = $1
           AND u.organization_id = $2
           AND u.role = 'member'
           AND lower(trim(u.name)) = lower(trim($3))`,
        [callId, req.user!.organizationId, agentName]
      );
    }

    // Enqueue transcription job
    await transcriptionQueue.add('transcribe', { callId }, { jobId: callId });

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Get single call (role-scoped)
callRouter.get('/:id', async (req, res, next) => {
  try {
    let sql = 'SELECT c.*, u.name as resolved_agent_name FROM calls c LEFT JOIN users u ON u.id = c.agent_id WHERE c.id = $1 AND c.organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'member') {
      params.push(req.user!.userId);
      sql += ` AND c.agent_id = $${params.length}`;
    }

    const call = await queryOne(sql, params);
    if (!call) throw new AppError(404, 'Call not found');
    res.json(call);
  } catch (err) {
    next(err);
  }
});

// Get scores for a call
callRouter.get('/:id/scores', async (req, res, next) => {
  try {
    let sql = 'SELECT id FROM calls WHERE id = $1 AND organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'member') {
      params.push(req.user!.userId);
      sql += ` AND agent_id = $${params.length}`;
    }

    const call = await queryOne(sql, params);
    if (!call) throw new AppError(404, 'Call not found');

    const scores = await query<CallScore>(
      'SELECT * FROM call_scores WHERE call_id = $1',
      [req.params.id]
    );

    const result = await Promise.all(
      scores.map(async (score) => {
        const itemScores = await query<CallItemScore>(
          `SELECT cis.*, si.label, si.description as item_description, si.score_type
           FROM call_item_scores cis
           JOIN scorecard_items si ON si.id = cis.scorecard_item_id
           WHERE cis.call_score_id = $1
           ORDER BY si.sort_order`,
          [score.id]
        );
        return { ...score, item_scores: itemScores };
      })
    );

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// Assign agent to a call (admin only)
callRouter.patch('/:id/assign-agent', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { agent_id } = req.body;

    const call = await queryOne(
      'SELECT id FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    if (agent_id) {
      const agent = await queryOne(
        'SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = $3',
        [agent_id, req.user!.organizationId, 'member']
      );
      if (!agent) throw new AppError(404, 'Agent not found');
    }

    await query(
      'UPDATE calls SET agent_id = $1, updated_at = now() WHERE id = $2',
      [agent_id || null, req.params.id]
    );

    res.json({ message: 'Agent assigned' });
  } catch (err) {
    next(err);
  }
});

// Re-score a call
callRouter.post('/:id/rescore', async (req, res, next) => {
  try {
    const call = await queryOne<Call>(
      'SELECT * FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');
    if (!call.transcript_text) {
      throw new AppError(400, 'Call has not been transcribed yet');
    }

    await query(
      "UPDATE calls SET status = 'scoring', updated_at = now() WHERE id = $1",
      [call.id]
    );

    const { scoringQueue } = await import('../jobs/queue.js');
    await scoringQueue.add('score', { callId: call.id }, { jobId: `rescore-${call.id}-${Date.now()}` });

    res.json({ message: 'Re-scoring initiated' });
  } catch (err) {
    next(err);
  }
});

// Correct a scorecard item score (admin only) - feeds the AI learning loop
callRouter.post('/:id/scores/items/:itemScoreId/correct', requireAdmin, async (req, res, next) => {
  try {
    const { corrected_pass, reason } = req.body;
    if (typeof corrected_pass !== 'boolean') {
      throw new AppError(400, 'corrected_pass must be boolean');
    }

    // Verify call belongs to this org
    const call = await queryOne<{ id: string; organization_id: string }>(
      'SELECT id, organization_id FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    // Load the item score row (must belong to this call)
    const itemScore = await queryOne<{
      id: string;
      call_score_id: string;
      scorecard_item_id: string;
      score: number;
      normalized_score: number;
      evidence: string | null;
    }>(
      `SELECT cis.id, cis.call_score_id, cis.scorecard_item_id, cis.score, cis.normalized_score, cis.evidence
         FROM call_item_scores cis
         JOIN call_scores cs ON cs.id = cis.call_score_id
        WHERE cis.id = $1 AND cs.call_id = $2`,
      [req.params.itemScoreId, call.id]
    );
    if (!itemScore) throw new AppError(404, 'Item score not found');

    const correctedNormalized = corrected_pass ? 100 : 0;
    const correctedRawScore = corrected_pass ? 1 : 0;
    const originalPass = Number(itemScore.normalized_score) >= 70;

    // Upsert correction record (unique on call_item_score_id)
    await query(
      `INSERT INTO score_corrections
         (organization_id, call_id, call_item_score_id, scorecard_item_id, corrected_by,
          original_score, corrected_score, original_pass, corrected_pass, reason, transcript_excerpt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (call_item_score_id) DO UPDATE SET
         corrected_score = EXCLUDED.corrected_score,
         corrected_pass = EXCLUDED.corrected_pass,
         reason = EXCLUDED.reason,
         corrected_by = EXCLUDED.corrected_by,
         created_at = now()`,
      [
        call.organization_id,
        call.id,
        itemScore.id,
        itemScore.scorecard_item_id,
        req.user!.userId,
        itemScore.normalized_score,
        correctedNormalized,
        originalPass,
        corrected_pass,
        reason || null,
        itemScore.evidence,
      ]
    );

    // Update the actual item score to reflect the correction
    await query(
      'UPDATE call_item_scores SET score = $1, normalized_score = $2 WHERE id = $3',
      [correctedRawScore, correctedNormalized, itemScore.id]
    );

    // Recalculate overall score for this call_score
    const items = await query<{ normalized_score: string; weight: string }>(
      `SELECT cis.normalized_score::text, si.weight::text
         FROM call_item_scores cis
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
        WHERE cis.call_score_id = $1`,
      [itemScore.call_score_id]
    );
    let totalWeighted = 0;
    let totalWeight = 0;
    for (const it of items) {
      const w = Number(it.weight);
      totalWeighted += Number(it.normalized_score) * w;
      totalWeight += w;
    }
    const newOverall = totalWeight > 0 ? totalWeighted / totalWeight : 0;
    const newPass = newOverall >= 70;

    await query(
      'UPDATE call_scores SET overall_score = $1, pass = $2 WHERE id = $3',
      [newOverall, newPass, itemScore.call_score_id]
    );

    // Also update/create a breach record based on new state
    if (corrected_pass) {
      // Passing - delete any breach for this item score
      await query(
        'DELETE FROM breaches WHERE call_item_score_id = $1',
        [itemScore.id]
      );
    } else {
      // Failing - ensure breach exists (derive severity from item weight)
      const sItem = await queryOne<{ weight: string; severity: string | null }>(
        'SELECT weight::text, severity FROM scorecard_items WHERE id = $1',
        [itemScore.scorecard_item_id]
      );
      const w = sItem ? Number(sItem.weight) : 1;
      const severity = sItem?.severity || (w >= 2 ? 'critical' : w >= 1.5 ? 'high' : 'medium');
      await query(
        `INSERT INTO breaches
           (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, detected_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (call_item_score_id) DO NOTHING`,
        [call.organization_id, call.id, itemScore.id, itemScore.scorecard_item_id, severity]
      );
    }

    res.json({ message: 'Correction saved', overall_score: newOverall, pass: newPass });
  } catch (err) {
    next(err);
  }
});

// Toggle exemplar (admin only)
callRouter.post('/:id/exemplar', requireAdmin, async (req, res, next) => {
  try {
    const { is_exemplar, reason } = req.body;
    if (typeof is_exemplar !== 'boolean') {
      throw new AppError(400, 'is_exemplar must be boolean');
    }

    const result = await queryOne(
      `UPDATE calls SET
         is_exemplar = $1,
         exemplar_reason = CASE WHEN $1 THEN $2 ELSE NULL END,
         updated_at = now()
       WHERE id = $3 AND organization_id = $4
       RETURNING id`,
      [is_exemplar, reason || 'Manually marked by admin', req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'Call not found');

    res.json({ message: 'Exemplar flag updated' });
  } catch (err) {
    next(err);
  }
});
