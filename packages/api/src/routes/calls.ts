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
import { ingestCall, fetchRemoteAudio, upsertCustomer, normalizePhone } from '../services/ingestion.js';
import { prepareMediaForIngest } from '../services/media.js';
import { recordAuditEvent } from '../services/audit.js';
import { getScoringSettings } from '../services/tenant-settings.js';
import { resolveTranscriptAccess, withheldTranscript } from '../services/transcript-access.js';
import { evaluateAlertsForResolvedItem } from '../services/alert-evaluator.js';
import {
  FEEDBACK_STATUS_SQL,
  FEEDBACK_SENT_AT_SQL,
  FEEDBACK_CONFIRMED_AT_SQL,
} from '../db/feedback-status.js';
import {
  parseTranscriptBlocks,
  extractUtterances,
  locateEvidenceAgainst,
  blockStartTimesAgainst,
} from '../services/evidence-locator.js';
import type {
  Call,
  CallScore,
  CallItemScore,
  BreachSeverity,
  ItemResult,
  JourneyStatus,
  FeedbackStatus,
  CallJourneyContext,
  CallJourneySibling,
  CallPositionsResponse,
  CallItemPosition,
} from '@callguard/shared';
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
      // Comma-separated group supported so the UI's "Processing" filter can
      // cover uploaded+transcribing+scoring in one option.
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
      params.push(statuses);
      whereClause += ` AND c.status = ANY($${params.length})`;
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

    // Same gate as the detail route. The list selects c.*, so without this every
    // page of the calls list would hand out twenty full transcripts.
    const access = await resolveTranscriptAccess(req.user!.organizationId, req.user!.role);

    res.json({
      data: calls.map((c) => withheldTranscript(c as Record<string, unknown>, access)),
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
    // A Teams/Zoom recording arrives as a video container — reduce it to audio
    // before anything is stored, so the rest of the pipeline only ever handles
    // audio (services/media.ts). A no-op for audio uploads.
    const media = await prepareMediaForIngest({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
    });

    // path.basename strips any directory component a crafted originalname
    // (e.g. "../../../etc/x") would otherwise carry into the storage key.
    const safeFileName = path.basename(media.fileName);
    const fileKey = `calls/${req.user!.organizationId}/${callId}/${safeFileName}`;

    await uploadFile(fileKey, media.buffer, media.mimeType);

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

    // Resolve the customer by phone so this call can join a journey (spec §9)
    // — without a customer_id, marking it as a sale below has nothing to
    // attach the journey to.
    let customerId: string | null = null;
    if (req.body.customer_phone) {
      const normalised = normalizePhone(req.body.customer_phone);
      if (normalised) {
        customerId = await upsertCustomer(req.user!.organizationId, normalised);
      }
    }

    // Manually flags this call as having resulted in a sale — for
    // 'sales_only' tenants, transcribe.ts assembles + scores a journey for
    // this customer once transcription completes, the same way a CRM sale
    // webhook would (see services/journey.ts). Honoured for whoever uploads,
    // not only admins: at a sales_only firm it is one of the three ways a sale
    // arrives, and the Upload page offers it to every uploading role.
    const saleFlagged = req.body.mark_as_sale === 'true';

    const rows = await query<Call>(
      `INSERT INTO calls (id, organization_id, uploaded_by, file_name, file_key, file_size_bytes, mime_type, agent_id, agent_name, customer_phone, customer_id, call_date, tags, status, encrypted_at_rest, scorecard_id, sale_flagged)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'uploaded', true, $14, $15) RETURNING *`,
      [
        callId,
        req.user!.organizationId,
        req.user!.userId,
        safeFileName,
        fileKey,
        // The stored audio's size/type, not the uploaded container's — the
        // video file itself is never persisted.
        media.buffer.length,
        media.mimeType,
        agentId,
        agentName,
        req.body.customer_phone || null,
        customerId,
        req.body.call_date || null,
        req.body.tags ? JSON.parse(req.body.tags) : [],
        scorecardId,
        saleFlagged,
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

    const call = await queryOne<{ id: string; journey_id: string | null }>(sql, params);
    if (!call) throw new AppError(404, 'Call not found');

    // If this call belongs to a scored sale journey, attach a summary + the
    // checkpoints whose evidence came from THIS call, so the call view can link
    // to and surface its journey (per-call scoring doesn't run for journey
    // calls — the score lives on the journey; see jobs/processors/score-journey).
    let journey: CallJourneyContext | null = null;
    if (call.journey_id) {
      const j = await queryOne<{
        id: string;
        status: JourneyStatus;
        branch: string | null;
        overall_score: string | null;
        pass: boolean | null;
        customer_id: string;
        feedback_status: FeedbackStatus;
        feedback_sent_at: string | null;
        feedback_confirmed_at: string | null;
      }>(
        `SELECT j.id, j.status, j.branch, j.overall_score, j.pass, j.customer_id,
                ${FEEDBACK_STATUS_SQL} AS feedback_status,
                ${FEEDBACK_SENT_AT_SQL} AS feedback_sent_at,
                ${FEEDBACK_CONFIRMED_AT_SQL} AS feedback_confirmed_at
           FROM journeys j
          WHERE j.id = $1 AND j.organization_id = $2`,
        [call.journey_id, req.user!.organizationId]
      );
      if (j) {
        const itemRows = await query<{
          id: string;
          scorecard_item_id: string;
          result: ItemResult;
          normalized_score: number | null;
          evidence: string | null;
          reasoning: string | null;
          label: string;
          section: string | null;
          severity: string | null;
          weight: string;
        }>(
          `SELECT jis.id, jis.scorecard_item_id, jis.result, jis.normalized_score, jis.evidence, jis.reasoning,
                  si.label, si.section, si.severity, si.weight::text AS weight
             FROM journey_item_scores jis
             JOIN scorecard_items si ON si.id = jis.scorecard_item_id
            WHERE jis.journey_id = $1 AND jis.source_call_id = $2
            ORDER BY si.sort_order ASC`,
          [call.journey_id, call.id]
        );
        // The severity the sale was actually judged by — see journeys.ts's sale
        // detail endpoint (deriveSeverity) for why the raw column isn't enough
        // on its own.
        const thisCallItems = itemRows.map(({ weight, severity, ...row }) => ({
          ...row,
          severity: deriveSeverity(Number(weight), severity),
        }));

        // Whose sale this is, resolved the same way the sale detail endpoint
        // resolves it: the linked customer's name.
        const customer = await queryOne<{ name: string | null }>(
          'SELECT name FROM customers WHERE id = $1',
          [j.customer_id]
        );

        // Every call in the sale, in the order the sale page numbers them
        // ("Call 1", "Call 2", ...) — only calls with a transcript are
        // numbered, matching score-journey.ts's withTranscript filter, so this
        // call's "Call N of M" and its siblings' numbers agree with the sale.
        const journeyCalls = await query<{
          id: string;
          duration_seconds: number | null;
          has_transcript: boolean;
        }>(
          `SELECT c2.id, c2.duration_seconds,
                  (COALESCE(c2.transcript_text, '') <> '') AS has_transcript
             FROM journey_calls jc2
             JOIN calls c2 ON c2.id = jc2.call_id
            WHERE jc2.journey_id = $1
            ORDER BY COALESCE(c2.call_date::timestamptz, c2.created_at) ASC`,
          [call.journey_id]
        );
        const itemCountRows = await query<{ source_call_id: string; item_count: string }>(
          `SELECT source_call_id, COUNT(*)::text AS item_count
             FROM journey_item_scores
            WHERE journey_id = $1 AND source_call_id IS NOT NULL
            GROUP BY source_call_id`,
          [call.journey_id]
        );
        const itemCountByCall = new Map(
          itemCountRows.map((r) => [r.source_call_id, parseInt(r.item_count, 10)])
        );

        let callTotal = 0;
        const callNumberById = new Map<string, number>();
        for (const jc of journeyCalls) {
          if (jc.has_transcript) callNumberById.set(jc.id, ++callTotal);
        }
        const siblings: CallJourneySibling[] = journeyCalls
          .filter((jc) => jc.id !== call.id)
          .map((jc) => ({
            id: jc.id,
            call_number: callNumberById.get(jc.id) ?? null,
            has_transcript: jc.has_transcript,
            duration_seconds: jc.duration_seconds,
            item_count: itemCountByCall.get(jc.id) ?? 0,
          }));

        journey = {
          id: j.id,
          status: j.status,
          branch: j.branch,
          overall_score: j.overall_score === null ? null : Number(j.overall_score),
          pass: j.pass,
          this_call_items: thisCallItems,
          client_name: customer?.name ?? null,
          call_number: callNumberById.get(call.id) ?? null,
          call_total: callTotal,
          siblings,
          feedback_status: j.feedback_status,
          feedback_sent_at: j.feedback_sent_at,
          feedback_confirmed_at: j.feedback_confirmed_at,
        };
      }
    }

    // Transcript content is withheld from roles below admin where the tenant
    // keeps a redaction category in the clear (DPIA action 11). SELECT c.* means
    // transcript_text and transcript_raw are on this row, so the filter has to be
    // here rather than in the query — a new column carrying transcript content
    // would otherwise arrive ungated.
    const access = await resolveTranscriptAccess(req.user!.organizationId, req.user!.role);

    res.json({ ...withheldTranscript(call as Record<string, unknown>, access), journey });
  } catch (err) {
    next(err);
  }
});

// Where every checkpoint's evidence quote sits in this call, and the time of
// each transcript line — the call detail page's "listen from here" and
// running clock, computed against services/evidence-locator.ts.
//
// Deliberately carries no transcript text of any kind, only positions and
// times, which is why it doesn't need transcript-access.ts's redaction gate
// (see GET /:id above): a user whose transcript is restricted can still be
// told when a quote was said and be sent to that point in the recording
// without ever being shown the words themselves.
callRouter.get('/:id/positions', async (req, res, next) => {
  try {
    let sql =
      'SELECT id, transcript_text, transcript_raw FROM calls WHERE id = $1 AND organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'adviser') {
      params.push(req.user!.userId);
      sql += ` AND agent_id = $${params.length}`;
    }

    const call = await queryOne<{
      id: string;
      transcript_text: string | null;
      transcript_raw: unknown;
    }>(sql, params);
    if (!call) throw new AppError(404, 'Call not found');

    if (!call.transcript_text) {
      const empty: CallPositionsResponse = { lines: [], items: [] };
      res.json(empty);
      return;
    }

    // Parsed once and reused for every checkpoint below (~40 per call) rather
    // than re-parsing the transcript per item.
    const blocks = parseTranscriptBlocks(call.transcript_text);
    const utterances = extractUtterances(call.transcript_raw);

    const times = blockStartTimesAgainst(blocks, utterances);
    const lines = blocks.map((block, i) => ({ index: block.index, start_seconds: times[i] }));

    // A journey call's checkpoints (source_call_id points straight at this
    // call, no journey join needed — it can only name a call already scoped
    // to this org by the WHERE above) plus, if this call was ever scored on
    // its own, its own most recent scoring run's checkpoints.
    const journeyItems = await query<{ id: string; evidence: string | null }>(
      `SELECT id, evidence FROM journey_item_scores
        WHERE source_call_id = $1 AND evidence IS NOT NULL AND evidence <> ''`,
      [call.id]
    );

    const latestCallScore = await queryOne<{ id: string }>(
      `SELECT id FROM call_scores WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [call.id]
    );
    const callItems = latestCallScore
      ? await query<{ id: string; evidence: string | null }>(
          `SELECT id, evidence FROM call_item_scores
            WHERE call_score_id = $1 AND evidence IS NOT NULL AND evidence <> ''`,
          [latestCallScore.id]
        )
      : [];

    const items: CallItemPosition[] = [
      ...journeyItems.map((row) => ({ ...row, kind: 'journey' as const })),
      ...callItems.map((row) => ({ ...row, kind: 'call' as const })),
    ].map(({ id, evidence, kind }) => {
      const located = locateEvidenceAgainst({ quote: evidence, blocks, utterances });
      const lineIndex = located.matched
        ? (located.excerpt.find((l) => l.is_match)?.index ?? null)
        : null;
      return {
        item_score_id: id,
        kind,
        matched: located.matched,
        line_index: lineIndex,
        timestamp_seconds: located.matched ? located.timestamp_seconds : null,
      };
    });

    const response: CallPositionsResponse = { lines, items };
    res.json(response);
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

    // Refuse once the call has been fed back to its adviser (migration 118),
    // for the reason the re-score below refuses — and more so. journey_feedback
    // .call_id is ON DELETE CASCADE, so deleting the call would erase the record
    // of what the adviser was told, their confirmation, and every outcome they
    // recorded about a customer. That cascade exists for retention and
    // data-subject erasure, which are deliberate policy; a delete button is not.
    //
    // Checked before the audio is removed, so a refused delete changes nothing.
    const fedBack = await queryOne<{ adviser_name: string; confirmed_at: string | null }>(
      `SELECT adviser_name, confirmed_at FROM journey_feedback
        WHERE call_id = $1 ORDER BY sent_at DESC LIMIT 1`,
      [call.id]
    );
    if (fedBack) {
      throw new AppError(
        409,
        `This call has been fed back to ${fedBack.adviser_name}` +
          (fedBack.confirmed_at ? ', and they confirmed receipt' : '') +
          '. Deleting it would also delete the record of what they were told, and anything they recorded about what they did. ' +
          'Ask CallGuard support if this call genuinely needs deleting.'
      );
    }

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
        const itemScores = await query<
          CallItemScore & { section: string | null; severity: BreachSeverity | null; weight: string }
        >(
          `SELECT cis.*, si.label, si.description as item_description, si.score_type,
                  si.section, si.severity, si.weight::text AS weight
           FROM call_item_scores cis
           JOIN scorecard_items si ON si.id = cis.scorecard_item_id
           WHERE cis.call_score_id = $1
           ORDER BY si.sort_order`,
          [score.id]
        );
        return {
          ...score,
          // Same rule as the sale's checkpoints (routes/journeys.ts): a
          // scorecard item need not carry an explicit severity, and scoring
          // falls back to its weight, so the page must not be shown a null
          // where the scorer would have read "high".
          item_scores: itemScores.map(({ weight, severity, ...item }) => ({
            ...item,
            severity: deriveSeverity(Number(weight), severity),
          })),
        };
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

// Re-score a call. Admin-only: re-scoring re-spends scoring tokens, so it's a
// considered action, not something every actioner should trigger at will.
callRouter.post('/:id/rescore', requireAdmin, async (req, res, next) => {
  try {
    const call = await queryOne<Call>(
      'SELECT * FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');
    if (!call.transcript_text) {
      throw new AppError(400, 'Call has not been transcribed yet');
    }

    // Refuse once the call has been fed back to its adviser (migration 118) —
    // the per-call twin of the guard on POST /api/journeys/:id/rescore, and for
    // the same reason. A re-score replaces the call's breaches; if the adviser
    // has already been sent the findings, re-scoring rewrites what they were
    // told about, after they were told. The feedback record keeps its own
    // snapshot, but the register would hold a confirmed conversation about
    // findings the call no longer has.
    //
    // Blocked from the moment it is SENT, not from confirmation, and not
    // overridable by the tenant. Superadmins keep the override for support.
    if (req.user!.role !== 'superadmin') {
      const fedBack = await queryOne<{ adviser_name: string; confirmed_at: string | null }>(
        `SELECT adviser_name, confirmed_at FROM journey_feedback
          WHERE call_id = $1 ORDER BY sent_at DESC LIMIT 1`,
        [call.id]
      );
      if (fedBack) {
        throw new AppError(
          409,
          `This call has been fed back to ${fedBack.adviser_name}` +
            (fedBack.confirmed_at ? ', and they confirmed receipt' : '') +
            '. Re-scoring would change the findings they were told about, after they were told. ' +
            'Ask CallGuard support if this call genuinely needs re-scoring.'
        );
      }
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

    const scoringSettings = await getScoringSettings(call.organization_id);
    const correctedNormalized = corrected_pass ? 100 : 0;
    const correctedRawScore = corrected_pass ? 1 : 0;
    const originalPass = isItemPass(Number(itemScore.normalized_score), scoringSettings.passThreshold);

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

    // Recalculate overall score for this call_score. Only pass/fail rows count
    // toward the weighted denominator — na / manual_review rows carry a NULL
    // normalized_score and must be excluded, or Number(null)=0 would drag them
    // in as zero-scored failures, deflating the overall and inventing breaches.
    const items = await query<{ normalized_score: string; weight: string; severity: string | null }>(
      `SELECT cis.normalized_score::text, si.weight::text, si.severity
         FROM call_item_scores cis
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
        WHERE cis.call_score_id = $1
          AND cis.result IN ('pass', 'fail')`,
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
      if (!isItemPass(normalized, scoringSettings.passThreshold)) failingSeverities.push(deriveSeverity(w, it.severity));
    }
    const newOverall = totalWeight > 0 ? totalWeighted / totalWeight : 0;
    // Use the same pass gate as initial scoring: a critical-severity failure
    // fails the call regardless of overall score, and the org's own pass
    // threshold (not a hardcoded 70) decides borderline items.
    const newPass = callPasses(newOverall, failingSeverities, scoringSettings.passThreshold);

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

    // A verdict corrected to a fail is a failure the firm may never have been
    // told about — the AI passed it, so no rule ever matched. Evaluate the
    // rules for this checkpoint now. A correction back to pass matches nothing,
    // and a checkpoint already alerted on is not announced twice (migration
    // 117). Fire-and-forget, after the writes.
    void evaluateAlertsForResolvedItem({
      kind: 'call',
      entityId: call.id,
      scorecardItemId: itemScore.scorecard_item_id,
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
