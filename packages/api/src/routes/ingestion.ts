import { Router } from 'express';
import {
  authenticate,
  requireAdmin,
  authenticateApiKey,
} from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { generateApiKey } from '../services/api-keys.js';
import { encrypt } from '../services/crypto.js';
import { ingestCall, inferMimeType } from '../services/ingestion.js';
import * as sftp from '../services/sftp.js';
import type { ApiKey, SFTPSource, SFTPPollLog } from '@callguard/shared';

export const ingestionRouter = Router();

// ============================================================
// API ingestion endpoint (X-API-Key auth)
// ============================================================

ingestionRouter.post(
  '/calls',
  authenticateApiKey,
  upload.single('audio'),
  async (req, res, next) => {
    try {
      const orgId = req.user!.organizationId;

      let buffer: Buffer;
      let fileName: string;
      let mimeType: string;

      // Pull metadata from body (works for both JSON and multipart)
      const agent_name = (req.body.agent_name as string | undefined) || null;
      const customer_phone =
        (req.body.customer_phone as string | undefined) || null;
      const call_date = (req.body.call_date as string | undefined) || null;
      const external_id = (req.body.external_id as string | undefined) || null;
      const tags = parseTags(req.body.tags);

      if (req.file) {
        buffer = req.file.buffer;
        fileName = req.file.originalname;
        mimeType = req.file.mimetype;
      } else if (req.body.audio_url) {
        const audioUrl = req.body.audio_url as string;
        const downloaded = await downloadUrl(audioUrl);
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
        customerPhone: customer_phone,
        callDate: call_date,
        externalId: external_id,
        tags,
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

async function downloadUrl(url: string): Promise<{
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AppError(400, `Failed to download audio from URL: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Derive filename from URL path
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/');
  const lastPart = pathParts[pathParts.length - 1] || 'call.mp3';
  const fileName = lastPart.includes('.') ? lastPart : `${lastPart}.mp3`;

  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || inferMimeType(fileName);
  return { buffer, fileName, mimeType };
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
