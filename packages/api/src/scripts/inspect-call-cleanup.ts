// One-off diagnostic: did the cleanup pass truncate for this call?
// Usage: tsx src/scripts/inspect-call-cleanup.ts <callId>
import { pool } from '../db/client.js';

async function main() {
  const callId = process.argv[2];
  if (!callId) {
    console.error('Usage: tsx src/scripts/inspect-call-cleanup.ts <callId>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT length(transcript_text) AS text_chars,
            (SELECT count(*) FROM regexp_matches(transcript_text, '\\n\\n', 'g')) AS turn_breaks
       FROM calls WHERE id = $1`,
    [callId]
  );
  console.log('transcript:', rows[0]);

  const usage = await pool.query(
    `SELECT operation, model_id, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, created_at
       FROM usage_events WHERE call_id = $1 ORDER BY created_at`,
    [callId]
  );
  console.log('\nusage records:');
  for (const r of usage.rows) console.log(r);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
