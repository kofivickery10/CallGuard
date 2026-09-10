import crypto from 'crypto';
import { query, queryOne } from '../db/client.js';
import { decrypt } from './crypto.js';
import { organisationKeepsUnredacted, withheldBreachEvidence } from './transcript-access.js';
import type { WebhookPayload, WebhookCallScoredPayload, WebhookJourneyScoredPayload } from '@callguard/shared';

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
  rawPayload: WebhookPayload,
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

  // DPIA R5, action 8. Here rather than in deliverCallScored below, because
  // THIS is the function that leaves: three producers reach it, and the other
  // two are the live-session events (services/stream-worker.ts) that carry the
  // same verbatim transcript quote. Gating the batch path alone would have left
  // the control complete on `core` and absent on the tiers that have live
  // streaming, which is not a property a compliance control may have.
  //
  // Gated on ANY permitted category, not health alone: a webhook_url is
  // whatever endpoint the tenant typed, so the "the CRM already holds their
  // name" argument that narrows the Zoho gate does not apply. See the
  // two-gates note in services/transcript-access.ts.
  //
  // Applied before the row is written, so a retry replays the withheld copy.
  const payload = withheldBreachEvidence(
    rawPayload,
    await organisationKeepsUnredacted(key.organization_id),
  );

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

/**
 * Deliver a `call.scored` (single call) or `journey.scored` (multi-call,
 * spec §9) event. There is no live session/api-key tied to either, so fire
 * to every webhook-configured, non-revoked API key in the org (typically
 * one - e.g. the CRM integration key). Best-effort: errors are swallowed per
 * delivery.
 */
export async function deliverCallScored(
  organizationId: string,
  payload: WebhookCallScoredPayload | WebhookJourneyScoredPayload,
): Promise<void> {
  // No R5 filter here on purpose — deliverWebhook applies it for every
  // producer, including the two live-session events that never pass through
  // this function.
  const keys = await query<{ id: string }>(
    `SELECT id FROM api_keys
       WHERE organization_id = $1 AND revoked_at IS NULL AND webhook_url IS NOT NULL`,
    [organizationId],
  );
  for (const k of keys) {
    await deliverWebhook(k.id, null, payload).catch((err) => {
      console.warn(`[Webhook] call.scored delivery failed for key ${k.id}:`, (err as Error).message);
    });
  }
}
