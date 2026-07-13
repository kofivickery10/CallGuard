import { Redis } from 'ioredis';
import { config } from '../config.js';

// A single shared Redis connection for lightweight control-plane use — the
// worker liveness heartbeat and the health check's PING. Kept separate from
// BullMQ's own per-queue connections so a health probe never contends with job
// traffic. Lazily created so importing this module never opens a socket at
// import time (matters for the test runner and one-shot scripts).
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redis.url, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      // Don't let a Redis blip crash the process via an unhandled 'error'.
      enableOfflineQueue: true,
    });
    client.on('error', (err) => console.error('[redis] connection error:', err.message));
  }
  return client;
}

const HEARTBEAT_KEY = 'callguard:worker:heartbeat';
// TTL is a few times the write interval so a single missed beat doesn't read as
// dead, but a genuinely down worker expires within ~90s.
const HEARTBEAT_TTL_SECONDS = 90;

/** Worker calls this on an interval so the API can report worker liveness. */
export async function writeWorkerHeartbeat(): Promise<void> {
  await getRedis().set(HEARTBEAT_KEY, new Date().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
}

/** Returns the last heartbeat ISO timestamp, or null if the worker is down/never started. */
export async function readWorkerHeartbeat(): Promise<string | null> {
  return getRedis().get(HEARTBEAT_KEY);
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
}
