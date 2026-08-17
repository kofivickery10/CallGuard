import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

// A handful of keys are only load-bearing once the app is actually serving
// traffic. Requiring them everywhere would break `npm run dev` for anyone not
// touching that feature; requiring them in production means we fail at boot
// instead of failing every transcription/scoring/email job at runtime.
function requiredInProduction(key: string): string {
  const value = process.env[key];
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${key} (required in production)`);
  }
  return value || '';
}

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  database: {
    url: required('DATABASE_URL'),
    // PEM-encoded CA certificate for the managed Postgres provider, so TLS
    // connections can be verified instead of blindly trusted. See client.ts.
    caCert: process.env.DATABASE_CA_CERT || undefined,
    // Pool ceilings differ by process: the API absorbs bursty concurrent HTTP
    // requests, while the worker's demand is the sum of its BullMQ worker
    // concurrency figures (jobs/worker.ts) plus headroom for the scheduler and
    // heartbeat writes that run alongside them. Left at pg's default (10) with
    // no timeout, exhaustion just queues connection requests forever instead
    // of failing — see client.ts. Which default applies is decided by which
    // process is running, not by an env var each deploy has to remember to set.
    poolMaxApi: parseInt(optional('DB_POOL_MAX_API', '20'), 10),
    poolMaxWorker: parseInt(optional('DB_POOL_MAX_WORKER', '15'), 10),
    poolIdleTimeoutMs: parseInt(optional('DB_POOL_IDLE_TIMEOUT_MS', '30000'), 10),
    poolConnectionTimeoutMs: parseInt(optional('DB_POOL_CONNECTION_TIMEOUT_MS', '5000'), 10),
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: '15m',
    refreshExpiresInDays: 30,
  },

  encryptionKey: required('ENCRYPTION_KEY'),

  // Key-rotation support for services/crypto.ts. Every encrypted blob now
  // carries the id of the key that produced it, so ENCRYPTION_KEY can be
  // swapped for a new key later without losing the ability to read data
  // written under the old one. ENCRYPTION_KEY_ID names the key that new
  // writes are stamped with (defaults to "1", the id crypto.ts also assumes
  // for the original, no-prefix blob format written before key ids existed —
  // so upgrading to this code with no env changes is a no-op). encryptionLegacyKeys
  // holds keys that are no longer current but must stay available for reads —
  // "id:hexkey" pairs, comma-separated, e.g. "1:aaaa...,2:bbbb...". To rotate:
  // move the outgoing ENCRYPTION_KEY value into ENCRYPTION_LEGACY_KEYS under
  // its existing id, then set a new ENCRYPTION_KEY and bump ENCRYPTION_KEY_ID.
  // Both are empty by default — nobody has rotated yet, and there is
  // deliberately no re-encryption job here; this only adds the format
  // capability for one to use later.
  encryptionKeyId: optional('ENCRYPTION_KEY_ID', '1'),
  encryptionLegacyKeys: optional('ENCRYPTION_LEGACY_KEYS', ''),

  uploadsDir: optional('UPLOADS_DIR', path.resolve(__dirname, '../../../uploads')),

  deepgram: {
    apiKey: requiredInProduction('DEEPGRAM_API_KEY'),
    // EU-hosted endpoint by default (UK/EU data residency — voice data stays in
    // the EU, no cross-border transfer). Override with DEEPGRAM_URL if needed.
    baseUrl: process.env.DEEPGRAM_URL || 'https://api.eu.deepgram.com',
  },

  anthropic: {
    apiKey: requiredInProduction('ANTHROPIC_API_KEY'),
  },

  resend: {
    apiKey: requiredInProduction('RESEND_API_KEY'),
    fromEmail: optional('RESEND_FROM_EMAIL', 'alerts@callguardai.co.uk'),
  },

  // Internal ops inbox for infrastructure alerts (jobs failing after all
  // retries, etc.). Distinct from tenant-facing alerts. Empty = ops alerting
  // off (a console warning is logged at boot).
  opsAlertEmail: process.env.OPS_ALERT_EMAIL || '',

  appUrl: optional('APP_URL', 'http://localhost:5173'),

  zoho: {
    // Where Zoho redirects the browser after the user approves access. Must be
    // registered verbatim as the Authorized Redirect URI in the Zoho API console
    // and must resolve to this API server. Defaults to APP_URL (prod serves the
    // API and web on the same host); override in dev where they differ.
    redirectUri: optional(
      'ZOHO_REDIRECT_URI',
      `${optional('APP_URL', 'http://localhost:5173')}/api/integrations/zoho/callback`
    ),
  },
} as const;
