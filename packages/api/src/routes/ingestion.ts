import { Router } from 'express';
import crypto from 'crypto';
import {
  authenticate,
  requireAdmin,
  authenticateApiKey,
} from '../middleware/auth.js';
import { apiKeyLimiter } from '../middleware/rate-limits.js';
import { upload } from '../middleware/upload.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { generateApiKey } from '../services/api-keys.js';
import { encrypt } from '../services/crypto.js';
import { ingestCall, fetchRemoteAudio, captureCallMetadata } from '../services/ingestion.js';
import { recordAuditEvent } from '../services/audit.js';
import * as sftp from '../services/sftp.js';
import {
  getDialerConnection,
  verifyDialerSignature,
  getScoringSettings,
  hasUsableSaleTrigger,
} from '../services/tenant-settings.js';
import { ingestionQueue } from '../jobs/queue.js';
import { isItemPass } from '@callguard/shared';
import type { ApiKey, SFTPSource, SFTPPollLog, DialerConnection, DialerFieldMap } from '@callguard/shared';

export const ingestionRouter = Router();

// ============================================================
// API ingestion endpoint (X-API-Key auth)
// ============================================================

ingestionRouter.post(
  '/calls',
  authenticateApiKey,
  apiKeyLimiter,
  upload.single('audio'),
  async (req, res, next) => {
    try {
      const orgId = req.user!.organizationId;

      let buffer: Buffer;
      let fileName: string;
      let mimeType: string;

      // Pull metadata from body (works for both JSON and multipart)
      const agent_name = (req.body.agent_name as string | undefined) || null;
      const agent_id = (req.body.agent_id as string | undefined) || null;
      const agent_email = (req.body.agent_email as string | undefined) || null;
      const agent_external_id = (req.body.agent_external_id as string | undefined) || null;
      const customer_phone = (req.body.customer_phone as string | undefined) || null;
      const customer_name = (req.body.customer_name as string | undefined) || null;
      const customer_external_crm_id = (req.body.customer_external_crm_id as string | undefined) || null;
      const call_date = (req.body.call_date as string | undefined) || null;
      const external_id = (req.body.external_id as string | undefined) || null;
      const scorecard_id = (req.body.scorecard_id as string | undefined) || null;
      const tags = parseTags(req.body.tags);

      if (req.file) {
        buffer = req.file.buffer;
        fileName = req.file.originalname;
        mimeType = req.file.mimetype;
      } else if (req.body.audio_url) {
        const audioUrl = req.body.audio_url as string;
        const downloaded = await fetchRemoteAudio(audioUrl);
        buffer = downloaded.buffer;
        fileName = downloaded.fileName;
        mimeType = downloaded.mimeType;
      } else {
        throw new AppError(
          400,
          'Provide either an `audio` multipart file or `audio_url` JSON field'
        );
      }

      const { call, isDuplicate } = await ingestCall({
        organizationId: orgId,
        uploadedBy: null,
        fileName,
        buffer,
        mimeType,
        ingestionSource: 'api',
        agentName: agent_name,
        agentId: agent_id,
        agentEmail: agent_email,
        agentExternalId: agent_external_id,
        customerPhone: customer_phone,
        customerName: customer_name,
        customerExternalCrmId: customer_external_crm_id,
        callDate: call_date,
        externalId: external_id,
        tags,
        scorecardId: scorecard_id,
      });

      res.status(isDuplicate ? 200 : 201).json({
        id: call.id,
        status: call.status,
        external_id: call.external_id,
        created_at: call.created_at,
        is_duplicate: isDuplicate,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// POST /api/ingestion/cloudtalk (X-API-Key auth)
// CloudTalk "Recording Uploaded" / "Call Ended" webhook receiver. Does NOT
// download or ingest inline — it validates, dedupes, and enqueues an
// `ingest-call` job with a delay (the recording is often still processing on
// CloudTalk's side when the event fires), then returns immediately. If the
// org has a dialer_connections row configured (Integrations → CloudTalk),
// its per-tenant signing secret, field-name mapping and fetch delay are used;
// otherwise this falls back to the historical default mapping and a 60s
// delay so orgs that haven't configured a connection yet keep working.
// ============================================================

const DEFAULT_CLOUDTALK_FIELD_MAP: DialerFieldMap = {
  call_id: ['call_uuid', 'uuid', 'call_id', 'id'],
  recording_url: ['recording_url', 'recording', 'call_recording_url', 'recording_link', 'audio_url', 'url'],
  agent_email: ['agent_email', 'agent_mail', 'internal_email'],
  agent_external_id: ['agent_id', 'agent', 'internal_id'],
  agent_name: ['agent_name', 'internal_name'],
  customer_phone: ['external_number', 'public_external_number', 'contact_number', 'phone_number'],
  customer_name: ['contact_name', 'customer_name', 'client_name', 'name'],
  // Candidate keys only — not confirmed present in CloudTalk's actual payload
  // (their public docs don't spell out the "Call Ended" webhook shape). Tried
  // the same tolerant way as every other field; if none match, direction is
  // just null and ingestion falls back to the org's mono_first_speaker default.
  direction: ['direction', 'type', 'call_type', 'call_direction'],
  duration: ['talking_time', 'billsec', 'call_duration', 'duration', 'duration_seconds'],
};
const DEFAULT_RECORDING_FETCH_DELAY_SECONDS = 60;

// Loosely normalise a dialler's direction value. Returns null (not a guess)
// for anything unrecognised, rather than risk silently mislabelling a call.
function normalizeCallDirection(raw: string | null): 'inbound' | 'outbound' | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (['inbound', 'incoming', 'in'].includes(v)) return 'inbound';
  if (['outbound', 'outgoing', 'out'].includes(v)) return 'outbound';
  return null;
}

// Find the first non-empty string at any of the candidate keys, checking the
// body and one level of common nesting (call / Call / data / payload).
function pickField(body: Record<string, unknown>, keys: string[]): string | null {
  const containers: Record<string, unknown>[] = [body];
  for (const c of ['call', 'Call', 'data', 'payload']) {
    const nested = body[c];
    if (nested && typeof nested === 'object') containers.push(nested as Record<string, unknown>);
  }
  for (const container of containers) {
    for (const key of keys) {
      const v = container[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
  }
  return null;
}

// Named export so app.ts can also mount this at POST /webhooks/cloudtalk to
// match the spec's literal path, without exposing the rest of this router.
export async function handleCloudTalkWebhook(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
): Promise<void> {
  try {
    const orgId = req.user!.organizationId;
    const body = (req.body || {}) as Record<string, unknown>;
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(body));

    const conn = await getDialerConnection(orgId, 'cloudtalk');

    // Second layer on top of X-API-Key possession — a no-op until the tenant
    // sets a signing secret on their CloudTalk connection, at which point a
    // request without a matching signature is rejected outright.
    const signatureHeader = req.headers['x-callguard-dialer-signature'] as string | undefined;
    if (!verifyDialerSignature(conn, rawBody, signatureHeader)) {
      throw new AppError(401, 'Invalid or missing dialer webhook signature');
    }

    // Merge over the defaults (not a plain fallback) so a connection saved
    // before a new field_map key existed (e.g. direction) still tries it,
    // instead of silently having that key be undefined.
    const fieldMap: DialerFieldMap = { ...DEFAULT_CLOUDTALK_FIELD_MAP, ...(conn?.field_map ?? {}) };
    const recordingUrl = pickField(body, fieldMap.recording_url);
    const cloudtalkCallId = pickField(body, fieldMap.call_id);
    // A webhook retry without a native call id in the payload would otherwise
    // skip the idempotency check entirely — fall back to hashing the
    // recording URL, which is stable across retries of the same delivery.
    const externalId =
      cloudtalkCallId ??
      (recordingUrl ? `cloudtalk:${crypto.createHash('sha256').update(recordingUrl).digest('hex')}` : null);
    const agentEmail = pickField(body, fieldMap.agent_email);
    const agentExternalId = pickField(body, fieldMap.agent_external_id);
    const agentName = pickField(body, fieldMap.agent_name);
    const customerPhone = pickField(body, fieldMap.customer_phone);
    const customerName = pickField(body, fieldMap.customer_name ?? []);
    const direction = normalizeCallDirection(pickField(body, fieldMap.direction));
    const durationRaw = pickField(body, fieldMap.duration ?? []);
    const durationSeconds = durationRaw && /^\d+$/.test(durationRaw) ? parseInt(durationRaw, 10) : null;

    // One-line diagnostic of what CloudTalk actually sent, so field mapping can
    // be verified against a real payload without logging PII values. Lists the
    // top-level keys and which of our fields resolved.
    console.log(
      `[CloudTalk] webhook keys=[${Object.keys(body).join(',')}] ` +
        `resolved: phone=${customerPhone ? 'y' : 'n'} name=${customerName ? 'y' : 'n'} ` +
        `agent=${agentEmail || agentExternalId || agentName ? 'y' : 'n'} ` +
        `dur=${durationSeconds ?? 'n'} dir=${direction ?? 'n'}`
    );

    // CloudTalk fires events before the recording exists too - acknowledge and skip.
    if (!recordingUrl && !cloudtalkCallId) {
      res.status(202).json({ status: 'ignored', reason: 'no recording URL or call id in payload' });
      return;
    }
    if (!externalId) {
      // Unreachable in practice (recordingUrl or cloudtalkCallId implies
      // externalId), but keeps the type narrow for the queue add below.
      res.status(202).json({ status: 'ignored', reason: 'could not derive an idempotency key' });
      return;
    }

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM calls WHERE organization_id = $1 AND external_id = $2',
      [orgId, externalId]
    );
    if (existing) {
      res.status(200).json({ status: 'duplicate', call_id: existing.id, external_id: externalId });
      return;
    }

    // sales_only capture: record the call's metadata only and defer audio fetch
    // + transcription to the Zoho sale trigger, so nothing but metadata touches
    // CallGuard until the customer converts. Only when a working sale trigger
    // exists to eventually score — otherwise fall through to the download path
    // below, so an org without a configured trigger never silently stops
    // ingesting. (Mirrors the deferral guard in jobs/processors/transcribe.ts.)
    const scoringSettings = await getScoringSettings(orgId);
    if (scoringSettings.scoringScope === 'sales_only' && (await hasUsableSaleTrigger(orgId))) {
      await captureCallMetadata({
        organizationId: orgId,
        externalId,
        cloudtalkCallId,
        recordingPointer: recordingUrl,
        agentEmail,
        agentExternalId,
        agentName,
        customerPhone,
        customerName,
        direction,
        durationSeconds,
        dialerConnectionId: conn?.id ?? null,
      });
      if (conn) {
        query('UPDATE dialer_connections SET last_event_at = now(), last_error = NULL WHERE id = $1', [
          conn.id,
        ]).catch(() => {});
      }
      res.status(202).json({ status: 'captured', external_id: externalId });
      return;
    }

    const delaySeconds = conn?.recording_fetch_delay_seconds ?? DEFAULT_RECORDING_FETCH_DELAY_SECONDS;
    const ingestJobId = `ingest-${orgId}-${externalId}`;

    // If a previous delivery's job for this call already exhausted its retries
    // and is sitting in the failed set, re-adding under the same jobId is a
    // silent no-op — so an eventual CloudTalk webhook retry would be lost and
    // the recording never ingested. Revive the failed job instead.
    const existingJob = await ingestionQueue.getJob(ingestJobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'failed') {
        await existingJob.retry();
      }
      // Any other state (waiting/delayed/active/completed) already covers this
      // call — the idempotency check in processIngestCall handles completed.
    } else {
      await ingestionQueue.add(
        'ingest-call',
        {
          organizationId: orgId,
          provider: 'cloudtalk',
          dialerConnectionId: conn?.id ?? null,
          recordingUrl,
          cloudtalkCallId,
          externalId,
          agentEmail,
          agentExternalId,
          agentName,
          customerPhone,
          direction,
        },
        {
          delay: delaySeconds * 1000,
          // Recordings can take minutes to finish processing on CloudTalk's
          // side; give the fetch generous retry headroom (~30 min of backoff)
          // rather than losing the call after ~90s.
          attempts: 6,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: ingestJobId,
        }
      );
    }

    if (conn) {
      query('UPDATE dialer_connections SET last_event_at = now(), last_error = NULL WHERE id = $1', [
        conn.id,
      ]).catch(() => {});
    }

    res.status(202).json({ status: 'accepted', external_id: externalId });
  } catch (err) {
    next(err);
  }
}

ingestionRouter.post('/cloudtalk', authenticateApiKey, apiKeyLimiter, handleCloudTalkWebhook);

// ============================================================
// Dialer connection management (admin JWT auth). CloudTalk today; the
// `provider` column + field_map shape generalise to other inbound dialers
// without a schema change (see migration 039).
// ============================================================

const dialerRouter = Router();
dialerRouter.use(authenticate);
dialerRouter.use(requireAdmin);

const DIALER_PUBLIC_COLUMNS = `id, organization_id, provider, name, api_base_url,
  recording_fetch_delay_seconds, history_window_days, field_map, is_active,
  last_event_at, last_error, created_at, updated_at,
  (signing_secret_encrypted IS NOT NULL) AS signing_secret_configured,
  (api_key_id_encrypted IS NOT NULL AND api_secret_encrypted IS NOT NULL) AS api_credentials_configured`;

dialerRouter.get('/', async (req, res, next) => {
  try {
    const rows = await query<DialerConnection>(
      `SELECT ${DIALER_PUBLIC_COLUMNS} FROM dialer_connections
        WHERE organization_id = $1 ORDER BY created_at DESC`,
      [req.user!.organizationId]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

dialerRouter.post('/', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const body = req.body as {
      provider?: string;
      name?: string;
      api_base_url?: string;
      recording_fetch_delay_seconds?: number;
      history_window_days?: number;
      field_map?: Partial<DialerFieldMap>;
      is_active?: boolean;
      signing_secret?: string;
      api_key_id?: string;
      api_secret?: string;
    };

    const provider = body.provider ?? 'cloudtalk';
    if (provider !== 'cloudtalk') throw new AppError(400, 'Unsupported dialer provider');

    const fieldMap: DialerFieldMap = { ...DEFAULT_CLOUDTALK_FIELD_MAP, ...(body.field_map ?? {}) };

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM dialer_connections WHERE organization_id = $1 AND provider = $2',
      [orgId, provider]
    );

    const rows = await query<DialerConnection>(
      `INSERT INTO dialer_connections
         (organization_id, provider, name, api_base_url, recording_fetch_delay_seconds,
          history_window_days, field_map, is_active, signing_secret_encrypted,
          api_key_id_encrypted, api_secret_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (organization_id, provider) DO UPDATE SET
         name                          = EXCLUDED.name,
         api_base_url                  = EXCLUDED.api_base_url,
         recording_fetch_delay_seconds = EXCLUDED.recording_fetch_delay_seconds,
         history_window_days           = EXCLUDED.history_window_days,
         field_map                     = EXCLUDED.field_map,
         is_active                     = EXCLUDED.is_active,
         signing_secret_encrypted      = COALESCE(EXCLUDED.signing_secret_encrypted, dialer_connections.signing_secret_encrypted),
         api_key_id_encrypted          = COALESCE(EXCLUDED.api_key_id_encrypted, dialer_connections.api_key_id_encrypted),
         api_secret_encrypted          = COALESCE(EXCLUDED.api_secret_encrypted, dialer_connections.api_secret_encrypted),
         updated_at                    = now()
       RETURNING ${DIALER_PUBLIC_COLUMNS}`,
      [
        orgId,
        provider,
        body.name || 'CloudTalk',
        body.api_base_url || 'https://my.cloudtalk.io/api',
        body.recording_fetch_delay_seconds ?? 60,
        body.history_window_days ?? 30,
        JSON.stringify(fieldMap),
        body.is_active ?? true,
        body.signing_secret ? encrypt(body.signing_secret) : null,
        body.api_key_id ? encrypt(body.api_key_id) : null,
        body.api_secret ? encrypt(body.api_secret) : null,
      ]
    );

    void recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: existing ? 'dialer_connection.update' : 'dialer_connection.create',
      entityType: 'dialer_connection',
      entityId: rows[0].id,
      summary: `${existing ? 'Updated' : 'Configured'} ${provider} dialer connection`,
      req,
    });

    res.status(existing ? 200 : 201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

dialerRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await queryOne(
      `DELETE FROM dialer_connections WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'Dialer connection not found');
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'dialer_connection.delete',
      entityType: 'dialer_connection',
      entityId: req.params.id,
      req,
    });
    res.json({ message: 'Dialer connection deleted' });
  } catch (err) {
    next(err);
  }
});

ingestionRouter.use('/dialer-connections', dialerRouter);

// ============================================================
// GET /api/ingestion/scorecards (X-API-Key auth)
// Lets an integrator list the scorecards available to their org so
// they can pick the right one when ingesting per-campaign calls.
// Returns id + name + description + is_active. No items leaked.
// ============================================================

ingestionRouter.get(
  '/scorecards',
  authenticateApiKey,
  apiKeyLimiter,
  async (req, res, next) => {
    try {
      const orgId = req.user!.organizationId;
      const scorecards = await query<{
        id: string;
        name: string;
        description: string | null;
        is_active: boolean;
        created_at: string;
      }>(
        `SELECT id, name, description, is_active, created_at
           FROM scorecards
          WHERE organization_id = $1
          ORDER BY is_active DESC, created_at DESC`,
        [orgId]
      );
      res.json({ data: scorecards });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// API result-fetch endpoint (X-API-Key auth)
//
// Tenant integrators call this with the call id returned from
// POST /api/ingestion/calls to pull the score, pass/fail, item
// breakdown, breaches and coaching.
//
// While the call is still being processed, status is one of
// 'uploaded' | 'transcribing' | 'transcribed' | 'scoring' and
// `result` is null. Poll until status is terminal: 'scored',
// 'failed', or 'skipped' (call too short to score — result stays null).
// ============================================================

ingestionRouter.get(
  '/calls/:id/result',
  authenticateApiKey,
  apiKeyLimiter,
  async (req, res, next) => {
    try {
      const orgId = req.user!.organizationId;

      const call = await queryOne<{
        id: string;
        external_id: string | null;
        status: string;
        agent_name: string | null;
        call_date: string | null;
        duration_seconds: number | null;
        created_at: string;
      }>(
        `SELECT id, external_id, status, agent_name, call_date,
                duration_seconds, created_at
           FROM calls
          WHERE id = $1 AND organization_id = $2`,
        [req.params.id, orgId]
      );
      if (!call) throw new AppError(404, 'Call not found');

      if (call.status !== 'scored') {
        res.json({
          id: call.id,
          external_id: call.external_id,
          status: call.status,
          agent_name: call.agent_name,
          call_date: call.call_date,
          duration_seconds: call.duration_seconds,
          created_at: call.created_at,
          result: null,
        });
        return;
      }

      const score = await queryOne<{
        id: string;
        scorecard_id: string;
        overall_score: string | null;
        pass: boolean | null;
        scored_at: string;
        coaching: unknown;
      }>(
        `SELECT id, scorecard_id, overall_score, pass, scored_at, coaching
           FROM call_scores WHERE call_id = $1
           ORDER BY scored_at DESC LIMIT 1`,
        [call.id]
      );

      if (!score) {
        res.json({
          id: call.id,
          external_id: call.external_id,
          status: call.status,
          agent_name: call.agent_name,
          call_date: call.call_date,
          duration_seconds: call.duration_seconds,
          created_at: call.created_at,
          result: null,
        });
        return;
      }

      const items = await query<{
        scorecard_item_id: string;
        label: string;
        description: string | null;
        normalized_score: string | null;
        evidence: string | null;
        reasoning: string | null;
      }>(
        `SELECT cis.scorecard_item_id, si.label,
                si.description, cis.normalized_score,
                cis.evidence, cis.reasoning
           FROM call_item_scores cis
           JOIN scorecard_items si ON si.id = cis.scorecard_item_id
          WHERE cis.call_score_id = $1
          ORDER BY si.sort_order`,
        [score.id]
      );

      const breaches = await query<{
        scorecard_item_id: string;
        label: string;
        severity: string;
        evidence: string | null;
      }>(
        `SELECT b.scorecard_item_id, si.label, b.severity, cis.evidence
           FROM breaches b
           JOIN scorecard_items si ON si.id = b.scorecard_item_id
           LEFT JOIN call_item_scores cis ON cis.id = b.call_item_score_id
          WHERE b.call_id = $1
          ORDER BY
            CASE b.severity
              WHEN 'critical' THEN 0
              WHEN 'high'     THEN 1
              WHEN 'medium'   THEN 2
              WHEN 'low'      THEN 3
            END`,
        [call.id]
      );

      res.json({
        id: call.id,
        external_id: call.external_id,
        status: call.status,
        agent_name: call.agent_name,
        call_date: call.call_date,
        duration_seconds: call.duration_seconds,
        created_at: call.created_at,
        result: {
          scorecard_id: score.scorecard_id,
          scored_at: score.scored_at,
          overall_score:
            score.overall_score == null ? null : Number(score.overall_score),
          pass: score.pass,
          items: items.map((it) => {
            const normalized =
              it.normalized_score == null ? null : Number(it.normalized_score);
            return {
              scorecard_item_id: it.scorecard_item_id,
              label: it.label,
              description: it.description,
              normalized_score: normalized,
              pass: normalized == null ? null : isItemPass(normalized),
              evidence: it.evidence,
              reasoning: it.reasoning,
            };
          }),
          breaches: breaches.map((b) => ({
            scorecard_item_id: b.scorecard_item_id,
            label: b.label,
            severity: b.severity,
            evidence: b.evidence,
          })),
          coaching: score.coaching,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// API key management (admin JWT auth)
// ============================================================

const apiKeyRouter = Router();
apiKeyRouter.use(authenticate);
apiKeyRouter.use(requireAdmin);

apiKeyRouter.get('/', async (req, res, next) => {
  try {
    const keys = await query<ApiKey>(
      `SELECT id, organization_id, name, key_prefix, last_used_at, revoked_at, created_at
         FROM api_keys
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [req.user!.organizationId]
    );
    res.json({ data: keys });
  } catch (err) {
    next(err);
  }
});

apiKeyRouter.post('/', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) throw new AppError(400, 'name is required');

    const { plaintext, hash, prefix } = generateApiKey();

    const rows = await query<ApiKey>(
      `INSERT INTO api_keys (organization_id, name, key_hash, key_prefix, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, organization_id, name, key_prefix, last_used_at, revoked_at, created_at`,
      [req.user!.organizationId, name, hash, prefix, req.user!.userId]
    );

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'api_key.create',
      entityType: 'api_key',
      entityId: rows[0].id,
      summary: `Created API key "${name}" (prefix ${prefix})`,
      metadata: { key_prefix: prefix, name },
      req,
    });

    res.status(201).json({
      ...rows[0],
      plaintext_key: plaintext,
    });
  } catch (err) {
    next(err);
  }
});

apiKeyRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await queryOne(
      `UPDATE api_keys SET revoked_at = now()
        WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'API key not found or already revoked');

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'api_key.revoke',
      entityType: 'api_key',
      entityId: req.params.id,
      summary: `Revoked API key ${req.params.id}`,
      req,
    });

    res.json({ message: 'API key revoked' });
  } catch (err) {
    next(err);
  }
});

ingestionRouter.use('/api-keys', apiKeyRouter);

// ============================================================
// SFTP source management (admin JWT auth)
// ============================================================

const sftpRouter = Router();
sftpRouter.use(authenticate);
sftpRouter.use(requireAdmin);

const SFTP_PUBLIC_COLUMNS = `id, organization_id, name, host, port, username,
  auth_method, remote_path, file_pattern, filename_template,
  poll_interval_minutes, is_active, last_polled_at, last_error,
  created_at, updated_at`;

sftpRouter.get('/', async (req, res, next) => {
  try {
    const sources = await query<SFTPSource>(
      `SELECT ${SFTP_PUBLIC_COLUMNS}
         FROM sftp_sources
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [req.user!.organizationId]
    );
    res.json({ data: sources });
  } catch (err) {
    next(err);
  }
});

sftpRouter.post('/', async (req, res, next) => {
  try {
    const {
      name,
      host,
      port = 22,
      username,
      auth_method,
      password,
      private_key,
      remote_path = '/',
      file_pattern = '*.mp3',
      filename_template,
      poll_interval_minutes = 15,
    } = req.body;

    if (!name || !host || !username || !auth_method) {
      throw new AppError(400, 'name, host, username, auth_method are required');
    }
    if (auth_method === 'password' && !password) {
      throw new AppError(400, 'password is required for password auth');
    }
    if (auth_method === 'privatekey' && !private_key) {
      throw new AppError(400, 'private_key is required for privatekey auth');
    }

    const passwordEncrypted = password ? encrypt(password) : null;
    const privateKeyEncrypted = private_key ? encrypt(private_key) : null;

    const rows = await query<SFTPSource>(
      `INSERT INTO sftp_sources
         (organization_id, name, host, port, username, auth_method,
          password_encrypted, private_key_encrypted, remote_path, file_pattern,
          filename_template, poll_interval_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${SFTP_PUBLIC_COLUMNS}`,
      [
        req.user!.organizationId,
        name,
        host,
        port,
        username,
        auth_method,
        passwordEncrypted,
        privateKeyEncrypted,
        remote_path,
        file_pattern,
        filename_template || null,
        poll_interval_minutes,
      ]
    );

    // Trigger scheduler refresh
    await refreshSchedulerIfAvailable();

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'sftp.create',
      entityType: 'sftp_source',
      entityId: rows[0].id,
      metadata: { name: rows[0].name, host: rows[0].host },
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

sftpRouter.put('/:id', async (req, res, next) => {
  try {
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM sftp_sources WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!existing) throw new AppError(404, 'SFTP source not found');

    const {
      name,
      host,
      port,
      username,
      auth_method,
      password,
      private_key,
      remote_path,
      file_pattern,
      filename_template,
      poll_interval_minutes,
      is_active,
    } = req.body;

    const passwordEncrypted = password ? encrypt(password) : undefined;
    const privateKeyEncrypted = private_key ? encrypt(private_key) : undefined;

    const rows = await query<SFTPSource>(
      `UPDATE sftp_sources SET
         name = COALESCE($1, name),
         host = COALESCE($2, host),
         port = COALESCE($3, port),
         username = COALESCE($4, username),
         auth_method = COALESCE($5, auth_method),
         password_encrypted = COALESCE($6, password_encrypted),
         private_key_encrypted = COALESCE($7, private_key_encrypted),
         remote_path = COALESCE($8, remote_path),
         file_pattern = COALESCE($9, file_pattern),
         filename_template = COALESCE($10, filename_template),
         poll_interval_minutes = COALESCE($11, poll_interval_minutes),
         is_active = COALESCE($12, is_active),
         updated_at = now()
       WHERE id = $13
       RETURNING ${SFTP_PUBLIC_COLUMNS}`,
      [
        name,
        host,
        port,
        username,
        auth_method,
        passwordEncrypted,
        privateKeyEncrypted,
        remote_path,
        file_pattern,
        filename_template,
        poll_interval_minutes,
        is_active,
        existing.id,
      ]
    );

    await refreshSchedulerIfAvailable();
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'sftp.update',
      entityType: 'sftp_source',
      entityId: existing.id,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

sftpRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await queryOne(
      `DELETE FROM sftp_sources WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'SFTP source not found');
    await refreshSchedulerIfAvailable();
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'sftp.delete',
      entityType: 'sftp_source',
      entityId: req.params.id,
    });
    res.json({ message: 'SFTP source deleted' });
  } catch (err) {
    next(err);
  }
});

sftpRouter.post('/:id/test', async (req, res, next) => {
  try {
    const row = await queryOne<{
      host: string;
      port: number;
      username: string;
      auth_method: 'password' | 'privatekey';
      password_encrypted: string | null;
      private_key_encrypted: string | null;
      remote_path: string;
    }>(
      `SELECT host, port, username, auth_method,
              password_encrypted, private_key_encrypted, remote_path
         FROM sftp_sources
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.user!.organizationId]
    );
    if (!row) throw new AppError(404, 'SFTP source not found');

    const result = await sftp.testConnection(row, row.remote_path);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

sftpRouter.post('/:id/poll-now', async (req, res, next) => {
  try {
    const row = await queryOne<{ id: string }>(
      'SELECT id FROM sftp_sources WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!row) throw new AppError(404, 'SFTP source not found');

    const { ingestionQueue } = await import('../jobs/queue.js');
    await ingestionQueue.add(
      'sftp-poll',
      { sourceId: row.id },
      { jobId: `sftp-manual-${row.id}-${Date.now()}` }
    );

    res.json({ message: 'Poll queued' });
  } catch (err) {
    next(err);
  }
});

sftpRouter.get('/:id/logs', async (req, res, next) => {
  try {
    const source = await queryOne<{ id: string }>(
      'SELECT id FROM sftp_sources WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!source) throw new AppError(404, 'SFTP source not found');

    const logs = await query<SFTPPollLog>(
      `SELECT * FROM sftp_poll_logs
        WHERE source_id = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [source.id]
    );
    res.json({ data: logs });
  } catch (err) {
    next(err);
  }
});

ingestionRouter.use('/sftp-sources', sftpRouter);

// ============================================================
// Helpers
// ============================================================

function parseTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === 'string');
    } catch {
      return raw.split(',').map((t) => t.trim()).filter(Boolean);
    }
  }
  return [];
}

async function refreshSchedulerIfAvailable(): Promise<void> {
  try {
    const { refreshSFTPSchedules } = await import('../jobs/scheduler.js');
    await refreshSFTPSchedules();
  } catch {
    // Scheduler runs in worker process; API may not have it available.
    // That's OK - the worker polls its schedule refresh periodically.
  }
}
