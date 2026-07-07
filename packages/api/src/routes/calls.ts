import { Router } from 'express';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin, requireActioner } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { query, queryOne } from '../db/client.js';
import { uploadFile, deleteFile, readFile } from '../services/storage.js';
import { transcriptionQueue } from '../jobs/queue.js';
import { AppError } from '../middleware/errors.js';
import { ingestCall, fetchRemoteAudio } from '../services/ingestion.js';
import { recordAuditEvent } from '../services/audit.js';
import type { Call, CallScore, CallItemScore, BreachSeverity } from '@callguard/shared';
import { deriveSeverity, isItemPass, callPasses } from '@callguard/shared';

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
    if (req.user!.role === 'adviser') {
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

    // A call can have more than one call_scores row (rescored against a
    // different scorecard over time); joining on call_id alone fans a single
    // call out into one row per score, which duplicates it in the page,
    // desyncs `total` from the returned row count, and would double-count it
    // in any aggregate built on top of this query. The LATERAL join picks
    // only the most recent score per call.
    const calls = await query(
      `SELECT c.*, cs.overall_score, cs.pass, u.name as resolved_agent_name
       FROM calls c
       LEFT JOIN LATERAL (
         SELECT overall_score, pass FROM call_scores
         WHERE call_id = c.id
         ORDER BY scored_at DESC
         LIMIT 1
       ) cs ON true
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
    // path.basename strips any directory component a crafted originalname
    // (e.g. "../../../etc/x") would otherwise carry into the storage key.
    const safeFileName = path.basename(req.file.originalname);
    const fileKey = `calls/${req.user!.organizationId}/${callId}/${safeFileName}`;

    await uploadFile(fileKey, req.file.buffer, req.file.mimetype);

    // If member, auto-assign to self
    let agentId = req.body.agent_id || null;
    const agentName = req.body.agent_name || null;

    if (req.user!.role === 'adviser') {
      agentId = req.user!.userId;
    }

    // Validate per-call scorecard selection (BPO multi-campaign use case)
    let scorecardId: string | null = null;
    if (req.body.scorecard_id) {
      const sc = await queryOne<{ id: string }>(
        'SELECT id FROM scorecards WHERE id = $1 AND organization_id = $2',
        [req.body.scorecard_id, req.user!.organizationId]
      );
      if (!sc) throw new AppError(404, `Scorecard ${req.body.scorecard_id} not found`);
      scorecardId = sc.id;
    }

    const rows = await query<Call>(
      `INSERT INTO calls (id, organization_id, uploaded_by, file_name, file_key, file_size_bytes, mime_type, agent_id, agent_name, customer_phone, call_date, tags, status, encrypted_at_rest, scorecard_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'uploaded', true, $13) RETURNING *`,
      [
        callId,
        req.user!.organizationId,
        req.user!.userId,
        safeFileName,
        fileKey,
        req.file.size,
        req.file.mimetype,
        agentId,
        agentName,
        req.body.customer_phone || null,
        req.body.call_date || null,
        req.body.tags ? JSON.parse(req.body.tags) : [],
        scorecardId,
      ]
    );

    // Auto-match agent_name to a member user if no agent_id was set
    if (!agentId && agentName) {
      await query(
        `UPDATE calls SET agent_id = u.id
         FROM users u
         WHERE calls.id = $1
           AND u.organization_id = $2
           AND u.role = 'adviser'
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

// Bulk historical recording import (admin only)
//
// Accepts JSON: { rows: [{ audio_url, agent_name?, customer_phone?,
// call_date?, external_id?, tags? }] }
//
// Each row is downloaded, ingested via the unified ingestion service
// (which handles dedupe by external_id, agent matching, and queue for
// transcription). Capped at 200 rows per request so a typo cannot
// timeout the worker. Returns a per-row outcome summary.
interface BulkImportRow {
  audio_url: string;
  agent_name?: string | null;
  customer_phone?: string | null;
  call_date?: string | null;
  external_id?: string | null;
  tags?: string[] | string;
  scorecard_id?: string | null;
}

callRouter.post('/bulk-import', requireAdmin, async (req, res, next) => {
  try {
    const rows = (req.body?.rows ?? []) as BulkImportRow[];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(400, 'rows[] is required');
    }
    if (rows.length > 200) {
      throw new AppError(400, 'Maximum 200 rows per request');
    }

    const orgId = req.user!.organizationId;
    const userId = req.user!.userId;
    const queued: { row: number; call_id: string; external_id: string | null }[] = [];
    const duplicates: { row: number; call_id: string; external_id: string | null }[] = [];
    const errors: { row: number; audio_url: string; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        if (!r.audio_url || typeof r.audio_url !== 'string') {
          throw new Error('audio_url missing or not a string');
        }
        const { buffer, fileName, mimeType } = await fetchRemoteAudio(r.audio_url);
        const tags = Array.isArray(r.tags)
          ? r.tags
          : typeof r.tags === 'string' && r.tags
            ? r.tags.split(/\s*,\s*/).filter(Boolean)
            : [];

        const { call, isDuplicate } = await ingestCall({
          organizationId: orgId,
          uploadedBy: userId,
          fileName,
          buffer,
          mimeType,
          ingestionSource: 'upload',
          agentName: r.agent_name ?? null,
          customerPhone: r.customer_phone ?? null,
          callDate: r.call_date ?? null,
          externalId: r.external_id ?? null,
          tags,
          scorecardId: r.scorecard_id ?? null,
        });

        (isDuplicate ? duplicates : queued).push({
          row: i,
          call_id: call.id,
          external_id: call.external_id,
        });
      } catch (err) {
        errors.push({
          row: i,
          audio_url: r.audio_url || '',
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }

    void recordAuditEvent({
      organizationId: orgId,
      userId,
      actionType: 'call.bulk_import',
      entityType: 'call',
      summary: `Bulk imported ${queued.length} new + ${duplicates.length} duplicate / ${errors.length} failed`,
      metadata: {
        total_rows: rows.length,
        queued: queued.length,
        duplicates: duplicates.length,
        errors: errors.length,
      },
      req,
    });

    res.json({
      total: rows.length,
      queued: queued.length,
      duplicates: duplicates.length,
      errors: errors.length,
      queued_calls: queued,
      duplicate_calls: duplicates,
      error_rows: errors,
    });
  } catch (err) {
    next(err);
  }
});

// Get single call (role-scoped)
callRouter.get('/:id', async (req, res, next) => {
  try {
    let sql = 'SELECT c.*, u.name as resolved_agent_name FROM calls c LEFT JOIN users u ON u.id = c.agent_id WHERE c.id = $1 AND c.organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'adviser') {
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

// Mark a call reviewed (or clear it). The implicit calibration signal: items
// the reviewer didn't correct on a reviewed call count as agreements.
callRouter.post('/:id/review', requireActioner, async (req, res, next) => {
  try {
    const reviewed = req.body?.reviewed !== false; // default true
    const rows = await query<Call>(
      `UPDATE calls
          SET reviewed_at = ${reviewed ? 'now()' : 'NULL'},
              reviewed_by = ${reviewed ? '$3' : 'NULL'},
              updated_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      reviewed
        ? [req.params.id, req.user!.organizationId, req.user!.userId]
        : [req.params.id, req.user!.organizationId]
    );
    if (rows.length === 0) throw new AppError(404, 'Call not found');
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: reviewed ? 'call.reviewed' : 'call.review_cleared',
      entityType: 'call',
      entityId: req.params.id,
      summary: reviewed ? 'Marked call as reviewed' : 'Cleared call review',
      req,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Delete a call (admin only). DB cascades to call_scores, call_item_scores,
// breaches, score_corrections; we also remove the audio file from storage.
callRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const call = await queryOne<{ id: string; file_key: string | null }>(
      'SELECT id, file_key FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    if (call.file_key) {
      try {
        await deleteFile(call.file_key);
      } catch (err) {
        console.warn(`[Calls] Failed to delete audio for ${call.id}:`, err);
      }
    }

    await query('DELETE FROM calls WHERE id = $1', [call.id]);
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'call.delete',
      entityType: 'call',
      entityId: call.id,
      summary: `Deleted call ${call.id}`,
      req,
    });
    res.json({ message: 'Call deleted', id: call.id });
  } catch (err) {
    next(err);
  }
});

// Stream the decrypted audio file for a call.
// Access is auth-gated and org-scoped — no public URLs exposed.
callRouter.get('/:id/audio', async (req, res, next) => {
  try {
    let sql =
      'SELECT file_key, mime_type, file_name, encrypted_at_rest FROM calls WHERE id = $1 AND organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'adviser') {
      params.push(req.user!.userId);
      sql += ` AND agent_id = $${params.length}`;
    }

    const call = await queryOne<{
      file_key: string | null;
      mime_type: string | null;
      file_name: string | null;
      encrypted_at_rest: boolean;
    }>(sql, params);

    if (!call) throw new AppError(404, 'Call not found');
    if (!call.file_key) throw new AppError(404, 'No audio file for this call');

    const buffer = await readFile(call.file_key, call.encrypted_at_rest);
    const contentType = call.mime_type || 'audio/mpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(call.file_name || 'audio')}"`,
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Get scores for a call
callRouter.get('/:id/scores', async (req, res, next) => {
  try {
    let sql = 'SELECT id FROM calls WHERE id = $1 AND organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'adviser') {
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
        [agent_id, req.user!.organizationId, 'adviser']
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
callRouter.post('/:id/rescore', requireActioner, async (req, res, next) => {
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
callRouter.post('/:id/scores/items/:itemScoreId/correct', requireActioner, async (req, res, next) => {
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
    const originalPass = isItemPass(Number(itemScore.normalized_score));

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
    const items = await query<{ normalized_score: string; weight: string; severity: string | null }>(
      `SELECT cis.normalized_score::text, si.weight::text, si.severity
         FROM call_item_scores cis
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
        WHERE cis.call_score_id = $1`,
      [itemScore.call_score_id]
    );
    let totalWeighted = 0;
    let totalWeight = 0;
    const failingSeverities: BreachSeverity[] = [];
    for (const it of items) {
      const w = Number(it.weight);
      const normalized = Number(it.normalized_score);
      totalWeighted += normalized * w;
      totalWeight += w;
      if (!isItemPass(normalized)) failingSeverities.push(deriveSeverity(w, it.severity));
    }
    const newOverall = totalWeight > 0 ? totalWeighted / totalWeight : 0;
    // Use the same pass gate as initial scoring: a critical-severity failure
    // fails the call regardless of overall score. The old `newOverall >= 70`
    // check ignored this, so correcting one unrelated item could flip a call
    // with a still-unresolved critical breach back to PASS.
    const newPass = callPasses(newOverall, failingSeverities);

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
      const severity = deriveSeverity(w, sItem?.severity);
      await query(
        `INSERT INTO breaches
           (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, detected_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (call_item_score_id) DO NOTHING`,
        [call.organization_id, call.id, itemScore.id, itemScore.scorecard_item_id, severity]
      );
    }

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'score.correct',
      entityType: 'score',
      entityId: req.params.itemScoreId,
      summary: `Corrected scorecard item ${req.params.itemScoreId} on call ${req.params.id} to ${corrected_pass ? 'pass' : 'fail'}`,
      metadata: { call_id: req.params.id, corrected_pass, reason: reason || null, new_overall: newOverall, new_pass: newPass },
      req,
    });

    res.json({ message: 'Correction saved', overall_score: newOverall, pass: newPass });
  } catch (err) {
    next(err);
  }
});

// Toggle exemplar (admin only)
callRouter.post('/:id/exemplar', requireActioner, async (req, res, next) => {
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

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'exemplar.toggle',
      entityType: 'call',
      entityId: req.params.id,
      summary: is_exemplar ? `Marked call ${req.params.id} as exemplar` : `Removed exemplar flag from call ${req.params.id}`,
      metadata: { is_exemplar, reason: reason || null },
      req,
    });

    res.json({ message: 'Exemplar flag updated' });
  } catch (err) {
    next(err);
  }
});
