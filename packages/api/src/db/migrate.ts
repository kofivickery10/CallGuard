import fs from 'fs';
import path from 'path';
import { pool } from './client.js';

// Arbitrary but fixed lock id for the migration advisory lock. Two deploys
// running migrate at once would otherwise interleave DDL; the lock serialises
// them (the second waits, then finds every file already applied).
const MIGRATION_LOCK_ID = 947_213_006;

// A migration file can opt out of the default transaction wrapper by making
// this the very first line. Postgres refuses to run CREATE INDEX CONCURRENTLY
// (or REINDEX CONCURRENTLY) inside a transaction block at all, so a migration
// that needs one has no other way to get it.
//
// The cost: a no-transaction migration that fails part-way is NOT rolled back
// — whatever DDL ran before the failure stays applied, and the file is not
// recorded in _migrations, so the next `npm run migrate` will run it again
// from the top. Anyone using this marker must write the migration to be safe
// to re-run from scratch (e.g. `CREATE INDEX CONCURRENTLY IF NOT EXISTS`),
// same as any other non-idempotent-by-default DDL we'd otherwise rely on the
// transaction to protect us from.
const NO_TRANSACTION_MARKER = '-- callguard:no-transaction';

function requiresNoTransaction(sql: string): boolean {
  return sql.split('\n', 1)[0]?.trim() === NO_TRANSACTION_MARKER;
}

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

      if (requiresNoTransaction(sql)) {
        // No BEGIN/COMMIT around this one — see NO_TRANSACTION_MARKER above.
        // A failure here leaves the DDL that already ran in place and does
        // NOT write the _migrations row, so a re-run tries the whole file
        // again; the file's own SQL is responsible for tolerating that.
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
          console.log(`  [applied, no-transaction] ${file}`);
        } catch (err) {
          throw new Error(
            `Migration ${file} failed outside a transaction and was NOT rolled back — the ` +
            `database may be left in a partial state. Fix the underlying issue and re-run ` +
            `migrate; this file must be written to be safe to run again: ${(err as Error).message}`
          );
        }
        continue;
      }

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
