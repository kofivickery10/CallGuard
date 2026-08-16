'use strict';

/**
 * Environment configuration for the bridge Lambda. All values are supplied
 * by the CloudFormation template (../template.yaml) as function environment
 * variables — nothing here is hardcoded, and no credential ever appears in
 * plaintext: CALLGUARD_API_KEY_SECRET_ARN points at a Secrets Manager secret
 * the Lambda reads at runtime, not the key itself.
 */

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getConfig() {
  return {
    // CallGuard WebSocket host, e.g. "stream.callguardai.co.uk" — no scheme,
    // the client builds wss://<host>/v1/stream/dialer/aws-connect.
    callguardWsHost: requireEnv('CALLGUARD_WS_HOST'),

    // ARN of the Secrets Manager secret holding the raw CallGuard API key
    // (SecretString is the key itself, or JSON { "apiKey": "..." } — both
    // are handled in secrets.js).
    apiKeySecretArn: requireEnv('CALLGUARD_API_KEY_SECRET_ARN'),

    // Amazon Connect instance this bridge is allowed to serve. Defence in
    // depth against a misconfigured/forged Lambda invocation: any invocation
    // event whose InstanceARN doesn't match this is rejected before we ever
    // touch Kinesis Video or open a WebSocket. Optional — if unset, the
    // check is skipped (not recommended).
    connectInstanceArn: process.env.CONNECT_INSTANCE_ARN || null,

    // How many milliseconds before Lambda's hard timeout we stop reading
    // new Kinesis Video fragments, flush the mixer, end the CallGuard
    // session cleanly and (if the call is still live) self-invoke a
    // continuation. Needs enough headroom to flush + close + invoke.
    stopBeforeTimeoutMs: parseInt(process.env.STOP_BEFORE_TIMEOUT_MS || '60000', 10),

    // Bounded reconnect policy for a dropped CallGuard WebSocket mid-call —
    // see README "Reconnect behaviour" for exactly what this does and does
    // not achieve.
    wsReconnectMaxAttempts: parseInt(process.env.WS_RECONNECT_MAX_ATTEMPTS || '5', 10),
    wsReconnectBaseDelayMs: parseInt(process.env.WS_RECONNECT_BASE_DELAY_MS || '500', 10),
    wsReconnectMaxDelayMs: parseInt(process.env.WS_RECONNECT_MAX_DELAY_MS || '8000', 10),
    // How much mixed audio (ms) we'll buffer in memory while reconnecting
    // before we start dropping the oldest audio to bound memory use.
    wsReconnectBufferMs: parseInt(process.env.WS_RECONNECT_BUFFER_MS || '15000', 10),

    // PCM mixer skew tolerance — see pcm-mixer.js.
    mixerMaxSkewMs: parseInt(process.env.MIXER_MAX_SKEW_MS || '500', 10),
    mixerFlushIntervalMs: parseInt(process.env.MIXER_FLUSH_INTERVAL_MS || '200', 10),

    // Fixed by the CallGuard aws_connect adapter contract
    // (packages/api/src/services/dialer-adapters.ts) — not configurable.
    sampleRate: 8000,
    bytesPerSample: 2, // 16-bit signed PCM, little-endian
  };
}

module.exports = { getConfig, requireEnv };
