import { Pool, type PoolConfig } from 'pg';
import { config } from '../config.js';

const poolConfig: PoolConfig = {
  connectionString: config.database.url,
};

// Managed Postgres providers (AWS Lightsail, RDS, Heroku, etc.) require SSL
// but use internal CAs that aren't in the system trust store. When the URL
// asks for SSL, allow it without strict cert verification - the connection
// is still encrypted, we just don't pin the CA.
if (/sslmode=(require|prefer|verify-)/i.test(config.database.url)) {
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
