import { Pool, type PoolConfig } from 'pg';
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
  poolConfig.ssl = { rejectUnauthorized: false };
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
