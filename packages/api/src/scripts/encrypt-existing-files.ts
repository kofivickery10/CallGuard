import fs from 'fs/promises';
import path from 'path';
import { pool, query } from '../db/client.js';
import { encryptBuffer } from '../services/crypto.js';
import { config } from '../config.js';

/**
 * One-shot migration script: encrypts every file on disk that has
 * `encrypted_at_rest = false`, then flips the flag.
 *
 * Safe to re-run - only targets rows where encrypted_at_rest = false.
 */

interface Row {
  id: string;
  file_key: string;
}

async function encryptRows(
  tableName: string,
  rows: Row[]
): Promise<{ encrypted: number; missing: number; failed: number }> {
  let encrypted = 0;
  let missing = 0;
  let failed = 0;

  for (const row of rows) {
    const filePath = path.join(config.uploadsDir, row.file_key);
    try {
      const plaintext = await fs.readFile(filePath);
      const ciphertext = encryptBuffer(plaintext);
      await fs.writeFile(filePath, ciphertext);
      await query(
        `UPDATE ${tableName} SET encrypted_at_rest = true WHERE id = $1`,
        [row.id]
      );
      encrypted++;
      console.log(`  [encrypted] ${row.file_key}`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        missing++;
        console.log(`  [missing]   ${row.file_key}`);
      } else {
        failed++;
        console.error(`  [failed]    ${row.file_key}: ${(err as Error).message}`);
      }
    }
  }

  return { encrypted, missing, failed };
}

async function main() {
  console.log('Encrypting existing files at rest...\n');

  console.log('Calls:');
  const calls = await query<Row>(
    `SELECT id, file_key FROM calls WHERE encrypted_at_rest = false AND file_key IS NOT NULL`
  );
  console.log(`  Found ${calls.length} unencrypted call files`);
  const callStats = await encryptRows('calls', calls);

  console.log('\nKnowledge base files:');
  const kbFiles = await query<Row>(
    `SELECT id, file_key FROM knowledge_base_files WHERE encrypted_at_rest = false`
  );
  console.log(`  Found ${kbFiles.length} unencrypted KB files`);
  const kbStats = await encryptRows('knowledge_base_files', kbFiles);

  console.log('\nSummary:');
  console.log(`  Calls:  ${callStats.encrypted} encrypted, ${callStats.missing} missing, ${callStats.failed} failed`);
  console.log(`  KB:     ${kbStats.encrypted} encrypted, ${kbStats.missing} missing, ${kbStats.failed} failed`);

  await pool.end();
  process.exit(callStats.failed + kbStats.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
