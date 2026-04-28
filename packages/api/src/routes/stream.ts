import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { config } from '../config.js';
import { authenticateApiKey } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { query, queryOne } from '../db/client.js';
import { encrypt } from '../services/crypto.js';
import type { MintTokenRequest, MintTokenResponse } from '@callguard/shared';

export const streamRouter = Router();

const SESSION_TOKEN_TTL_SEC = 60 * 60; // 1 hour

interface StreamTokenPayload {
  session_id: string;
  organization_id: string;
  api_key_id: string;
  source: 'sdk';
}

/**
 * Mint a short-lived session token for an SDK client.
 *
 * Server-to-server: the partner's backend calls this with their API key,
 * receives a JWT that the mobile/browser client uses to open the WebSocket.
 */
streamRouter.post('/sessions/mint-token', authenticateApiKey, async (req, res, next) => {
  try {
    const apiKeyId = req.user!.userId;
    const orgId = req.user!.organizationId;

    const apiKey = await queryOne<{ allow_streaming: boolean }>(
      `SELECT allow_streaming FROM api_keys WHERE id = $1 AND revoked_at IS NULL`,
      [apiKeyId],
    );
    if (!apiKey || !apiKey.allow_streaming) {
      throw new AppError(403, 'API key not authorised for streaming');
    }

    const body = (req.body || {}) as MintTokenRequest;

    // Default scorecard if none provided: org's active scorecard
    let scorecardId = body.scorecard_id;
    if (!scorecardId) {
      const sc = await queryOne<{ id: string }>(
        `SELECT id FROM scorecards WHERE organization_id = $1 AND is_active = true LIMIT 1`,
        [orgId],
      );
      scorecardId = sc?.id;
    }

    // Validate agent ID if provided
    if (body.agent_id) {
      const agent = await queryOne<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 AND organization_id = $2`,
        [body.agent_id, orgId],
      );
      if (!agent) throw new AppError(400, 'agent_id not found in organisation');
    }

    const sessionId = uuid();
    await query(
      `INSERT INTO live_sessions
         (id, organization_id, api_key_id, source, external_id, agent_id, scorecard_id,
          status, metadata, audio_format, audio_sample_rate)
       VALUES ($1, $2, $3, 'sdk', $4, $5, $6, 'opening', $7, 'opus', 16000)`,
      [
        sessionId,
        orgId,
        apiKeyId,
        body.external_id || null,
        body.agent_id || null,
        scorecardId || null,
        JSON.stringify(body.metadata || {}),
      ],
    );

    const payload: StreamTokenPayload = {
      session_id: sessionId,
      organization_id: orgId,
      api_key_id: apiKeyId,
      source: 'sdk',
    };
    const token = jwt.sign(payload, config.jwt.secret, { expiresIn: SESSION_TOKEN_TTL_SEC });

    const wsBase = (config.appUrl || '').replace(/^http/, 'ws');
    const response: MintTokenResponse = {
      session_id: sessionId,
      token,
      ws_url: `${wsBase || 'ws://localhost:3001'}/v1/stream/sdk?token=${encodeURIComponent(token)}`,
      expires_at: new Date(Date.now() + SESSION_TOKEN_TTL_SEC * 1000).toISOString(),
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * Configure or update the webhook URL + secret on an API key.
 */
streamRouter.put('/api-keys/:id/webhook', authenticateApiKey, async (req, res, next) => {
  try {
    const apiKeyId = req.user!.userId;
    if (req.params.id !== apiKeyId) {
      throw new AppError(403, 'Can only modify your own API key');
    }

    const { webhook_url, regenerate_secret } = req.body || {};
    if (typeof webhook_url !== 'string' || !/^https:\/\//.test(webhook_url)) {
      throw new AppError(400, 'webhook_url must be an https:// URL');
    }

    let plaintextSecret: string | null = null;
    let updateSecret = false;

    if (regenerate_secret) {
      plaintextSecret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
      updateSecret = true;
    }

    if (updateSecret && plaintextSecret) {
      await query(
        `UPDATE api_keys
            SET webhook_url = $2, webhook_secret_encrypted = $3, allow_streaming = true
          WHERE id = $1`,
        [apiKeyId, webhook_url, encrypt(plaintextSecret)],
      );
    } else {
      await query(
        `UPDATE api_keys SET webhook_url = $2, allow_streaming = true WHERE id = $1`,
        [apiKeyId, webhook_url],
      );
    }

    res.json({
      webhook_url,
      ...(plaintextSecret ? { webhook_secret: plaintextSecret } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Validate a streaming JWT from the WebSocket upgrade phase.
 * Throws AppError on any auth failure.
 */
export function verifyStreamToken(token: string): StreamTokenPayload {
  try {
    return jwt.verify(token, config.jwt.secret) as StreamTokenPayload;
  } catch {
    throw new AppError(401, 'Invalid or expired streaming token');
  }
}

/**
 * Validate an API key passed via WebSocket query param (used by dialer endpoints).
 */
export async function verifyApiKeyForStreaming(apiKey: string): Promise<{
  api_key_id: string;
  organization_id: string;
}> {
  const { hashApiKey } = await import('../services/api-keys.js');
  const keyHash = hashApiKey(apiKey);
  const record = await queryOne<{ id: string; organization_id: string; allow_streaming: boolean }>(
    `SELECT id, organization_id, allow_streaming FROM api_keys
      WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash],
  );
  if (!record) throw new AppError(401, 'Invalid or revoked API key');
  if (!record.allow_streaming) throw new AppError(403, 'API key not authorised for streaming');
  return { api_key_id: record.id, organization_id: record.organization_id };
}
