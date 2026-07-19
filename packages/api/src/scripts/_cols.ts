import { pool } from '../db/client.js';
async function main() {
  const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='calls' ORDER BY ordinal_position");
  console.log('calls:', rows.map((r) => r.column_name).join(', '));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
