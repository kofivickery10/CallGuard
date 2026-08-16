import { Pool, type PoolConfig, type PoolClient } from 'pg';
import { config } from '../config.js';
import { stripSslModeParam } from './connection-url.js';

// Managed Postgres providers (AWS Lightsail, RDS, Heroku, etc.) require SSL
// but use internal CAs that aren't in the system trust store. We strip
// sslmode from the URL and apply our own SSL config explicitly, otherwise
// pg v8.16+ treats sslmode=require as verify-full and rejects the cert.
const rawUrl = config.database.url;
const wantsSsl = /sslmode=(require|prefer|verify-|no-verify|true)/i.test(rawUrl)
  || /^postgresql:\/\/.+@(?!localhost|127\.|::1)/.test(rawUrl);

const cleanUrl = stripSslModeParam(rawUrl);

// Which pool ceiling applies depends on which process this is: the worker's
// entrypoint is jobs/worker.js (jobs/worker.ts in dev, via tsx) — everything
// else importing this module is the API server. This process runs one or the
// other, never both, so detecting it once at import time is enough.
//
// The worker default (config.database.poolMaxWorker) must stay above the sum
// of every BullMQ Worker's `concurrency` in jobs/worker.ts — each concurrent
// job can hold a connection — plus headroom for the scheduler refresh and the
// 30s heartbeat write that run independently of job processing. At the time
// of writing that sum is transcription(2) + scoring(2) + ingestion(2) +
// alerts(4) + maintenance(1) + stuck-repair(1) = 12, so the default of 15
// leaves 3 spare. If you raise any of those `concurrency` values, raise
// DB_POOL_MAX_WORKER (or the default here) to match, or jobs will start
// queueing for a connection instead of running.
const isWorkerProcess = /worker\.(js|ts)$/.test(process.argv[1] ?? '');
const poolMax = isWorkerProcess ? config.database.poolMaxWorker : config.database.poolMaxApi;

const poolConfig: PoolConfig = {
  connectionString: cleanUrl,
  max: poolMax,
  idleTimeoutMillis: config.database.poolIdleTimeoutMs,
  // Without this, a client that can't get a pooled connection waits
  // indefinitely — pool exhaustion then surfaces as requests/jobs silently
  // hanging rather than as a visible, retryable error.
  connectionTimeoutMillis: config.database.poolConnectionTimeoutMs,
};

if (wantsSsl) {
  if (config.database.caCert) {
    poolConfig.ssl = { ca: config.database.caCert, rejectUnauthorized: true };
  } else {
    // Compensating control: no CA cert has been supplied (DATABASE_CA_CERT), so
    // the server certificate cannot be verified and a network-level MITM could
    // impersonate the DB. Acceptable only when the DB is reachable exclusively
    // over a private network. Set DATABASE_CA_CERT in production to close this.
    console.warn(
      '[db] DATABASE_CA_CERT not set — TLS certificate verification is disabled ' +
      '(rejectUnauthorized: false). Set DATABASE_CA_CERT to the provider\'s CA ' +
      'bundle to verify the server certificate.'
    );
    poolConfig.ssl = { rejectUnauthorized: false };
  }
}

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

// A minimal client wrapper matching the query()/queryOne() shape above, bound
// to a single checked-out connection so callers can compose multi-statement
// transactions with the same call sites they already use.
export interface TransactionClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>;
}

/**
 * Run `fn` inside a single Postgres transaction. Commits on success, rolls
 * back on any thrown error (including one thrown by `fn` itself), and always
 * releases the connection back to the pool.
 */
export async function withTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>
): Promise<T> {
  const conn: PoolClient = await pool.connect();
  const wrapped: TransactionClient = {
    async query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await conn.query(text, params);
      return result.rows as R[];
    },
    async queryOne<R = Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await conn.query(text, params);
      return (result.rows[0] as R) ?? null;
    },
  };
  try {
    await conn.query('BEGIN');
    const result = await fn(wrapped);
    await conn.query('COMMIT');
    return result;
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
