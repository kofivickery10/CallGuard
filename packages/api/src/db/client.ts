import { Pool, type PoolConfig, type PoolClient } from 'pg';
import { config } from '../config.js';

// Managed Postgres providers (AWS Lightsail, RDS, Heroku, etc.) require SSL
// but use internal CAs that aren't in the system trust store. We strip
// sslmode from the URL and apply our own SSL config explicitly, otherwise
// pg v8.16+ treats sslmode=require as verify-full and rejects the cert.
const rawUrl = config.database.url;
const wantsSsl = /sslmode=(require|prefer|verify-|no-verify|true)/i.test(rawUrl)
  || /^postgresql:\/\/.+@(?!localhost|127\.|::1)/.test(rawUrl);

const cleanUrl = rawUrl
  .replace(/[?&]sslmode=[^&]*/gi, '')
  .replace(/\?&/, '?')
  .replace(/[?&]$/, '');

const poolConfig: PoolConfig = {
  connectionString: cleanUrl,
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
