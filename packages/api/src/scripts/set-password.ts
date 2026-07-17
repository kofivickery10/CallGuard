/**
 * Set (reset) a user's password by email — for any user, tenant or superadmin.
 *
 * Usage:
 *   USER_EMAIL=admin@trustpoint.co.uk \
 *   USER_PASSWORD='a-new-strong-password' \
 *   npx tsx src/scripts/set-password.ts
 *
 * Looks the user up by email (case-insensitive), bcrypt-hashes the new password
 * and updates the row. Prints the user's id, role and org so you can confirm you
 * reset the account you meant to. Does not create users — use onboard-tenant.ts
 * (tenant admin) or seed-superadmin.ts (superadmin) for that.
 */

import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/client.js';

const email = process.env.USER_EMAIL;
const rawPassword = process.env.USER_PASSWORD;

if (!email || !rawPassword) {
  console.error('USER_EMAIL and USER_PASSWORD env vars are both required');
  process.exit(1);
}

async function run() {
  const user = await queryOne<{ id: string; role: string; organization_id: string | null }>(
    `SELECT id, role, organization_id FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(rawPassword as string, 12);
  await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, user.id]);

  console.log(
    `Password updated for ${email} (id: ${user.id}, role: ${user.role}, org: ${user.organization_id ?? 'none'})`
  );
  process.exit(0);
}

run().catch((err) => {
  console.error('Set password failed:', err);
  process.exit(1);
});
