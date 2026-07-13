import fs from 'fs';
import path from 'path';
import { pool } from './client.js';

// Arbitrary but fixed lock id for the migration advisory lock. Two deploys
// running migrate at once would otherwise interleave DDL; the lock serialises
// them (the second waits, then finds every file already applied).
const MIGRATION_LOCK_ID = 947_213_006;

async function migrate() {
  console.log('Running migrations...');

  const client = await pool.connect();
  try {
    // Session-level advisory lock — held until we explicitly unlock or the
    // connection closes. Blocks a concurrent migrate() rather than racing it.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = path.resolve(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const applied = await client.query('SELECT name FROM _migrations WHERE name = $1', [file]);
      if (applied.rows.length > 0) {
        console.log(`  [skip] ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      // Each migration + its bookkeeping row commit together. A file that fails
      // half-way rolls back entirely, so it is never left partially applied
      // with no _migrations record (which would wedge the next run on a
      // non-idempotent CREATE INDEX / ADD CONSTRAINT).
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  [applied] ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
      }
    }

    console.log('Migrations complete.');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
