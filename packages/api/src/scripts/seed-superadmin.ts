/**
 * Seed script — creates the platform superadmin user.
 *
 * Usage:
 *   SUPERADMIN_EMAIL=admin@callguardai.co.uk \
 *   SUPERADMIN_PASSWORD=changeme123 \
 *   npx tsx src/scripts/seed-superadmin.ts
 *
 * The script is idempotent — re-running it updates the password if the user
 * already exists. The superadmin has no organization_id (NULL).
 */

import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/client.js';

const email = process.env.SUPERADMIN_EMAIL || 'superadmin@callguardai.co.uk';
const rawPassword = process.env.SUPERADMIN_PASSWORD;

if (!rawPassword) {
  console.error('SUPERADMIN_PASSWORD env var is required');
  process.exit(1);
}

async function run() {
  const passwordHash = await bcrypt.hash(rawPassword as string, 12);

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE email = $1 AND role = 'superadmin'`,
    [email]
  );

  if (existing) {
    await query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [passwordHash, existing.id]
    );
    console.log(`Superadmin password updated for ${email} (id: ${existing.id})`);
  } else {
    const rows = await query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, organization_id)
       VALUES ($1, 'CallGuard Admin', $2, 'superadmin', NULL)
       RETURNING id`,
      [email, passwordHash]
    );
    console.log(`Superadmin created: ${email} (id: ${rows[0].id})`);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
