import crypto from 'crypto';
import { query, queryOne } from '../db/client.js';
import { decrypt } from './crypto.js';
import type { WebhookPayload } from '@callguard/shared';

interface ApiKeyWebhookConfig {
  api_key_id: string;
  organization_id: string;
  webhook_url: string | null;
  webhook_secret_encrypted: string | null;
}

/**
 * Persist a webhook delivery record and best-effort POST it to the partner.
 * Failures are logged in webhook_deliveries.status and do not throw -
 * the caller (StreamWorker) should never crash because a partner's URL is down.
 */
export async function deliverWebhook(
  apiKeyId: string,
  sessionId: string | null,
  payload: WebhookPayload,
): Promise<void> {
  const key = await queryOne<ApiKeyWebhookConfig>(
    `SELECT id as api_key_id, organization_id, webhook_url, webhook_secret_encrypted
       FROM api_keys
      WHERE id = $1 AND revoked_at IS NULL`,
    [apiKeyId],
  );

  if (!key) {
    console.warn(`[Webhook] api_key ${apiKeyId} not found, dropping delivery`);
    return;
  }
  if (!key.webhook_url) {
    // Partner hasn't configured a webhook - silently skip
    return;
  }

  const deliveryRow = await queryOne<{ id: string }>(
    `INSERT INTO webhook_deliveries
       (organization_id, api_key_id, session_id, event_type, target_url, payload, status, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0)
     RETURNING id`,
    [
      key.organization_id,
      apiKeyId,
      sessionId,
      payload.event,
      key.webhook_url,
      JSON.stringify(payload),
    ],
  );
  const deliveryId = deliveryRow!.id;

  // Sign and POST. Two retries on 5xx with backoff. 4xx is terminal.
  const secret = key.webhook_secret_encrypted
    ? decrypt(key.webhook_secret_encrypted)
    : '';
  const body = JSON.stringify(payload);
  const signature = secret
    ? crypto.createHmac('sha256', secret).update(body).digest('hex')
    : '';

  const maxAttempts = 3;
  let lastError = '';
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(key.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'CallGuardAI-Webhook/1.0',
          'X-CallGuardAI-Event': payload.event,
          ...(signature ? { 'X-CallGuardAI-Signature': `sha256=${signature}` } : {}),
        },
        body,
      });
      lastStatus = res.status;

      if (res.ok) {
        await query(
          `UPDATE webhook_deliveries
              SET status = 'delivered', response_code = $2, attempts = $3,
                  last_attempt_at = now(), delivered_at = now()
            WHERE id = $1`,
          [deliveryId, res.status, attempt],
        );
        return;
      }

      lastError = `HTTP ${res.status}`;

      // 4xx is terminal - partner's endpoint is misconfigured
      if (res.status >= 400 && res.status < 500) {
        await query(
          `UPDATE webhook_deliveries
              SET status = 'failed', response_code = $2, response_body = $3,
                  attempts = $4, last_attempt_at = now()
            WHERE id = $1`,
          [deliveryId, res.status, (await res.text()).slice(0, 2000), attempt],
        );
        return;
      }
    } catch (err) {
      lastError = (err as Error).message;
    }

    // Exponential backoff before next attempt
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }

  await query(
    `UPDATE webhook_deliveries
        SET status = 'failed', response_code = $2, response_body = $3,
            attempts = $4, last_attempt_at = now()
      WHERE id = $1`,
    [deliveryId, lastStatus || null, lastError.slice(0, 2000), maxAttempts],
  );
}
