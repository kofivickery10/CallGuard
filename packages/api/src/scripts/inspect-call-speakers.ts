// One-off diagnostic: inspect speaker attribution for a call (CG transcript
// confusion investigation). Usage: tsx src/scripts/inspect-call-speakers.ts <callId>
import { pool } from '../db/client.js';

async function main() {
const callId = process.argv[2];
if (!callId) {
  console.error('Usage: tsx src/scripts/inspect-call-speakers.ts <callId>');
  process.exit(1);
}

const { rows } = await pool.query(
  `SELECT c.id, c.direction, c.created_at, c.updated_at, c.status, c.speaker_attribution_confidence,
          c.duration_seconds, c.organization_id, o.name AS org_name,
          o.transcription_mode, o.mono_first_speaker, o.adviser_channel,
          c.transcript_raw IS NOT NULL AS has_raw,
          left(c.transcript_text, 400) AS text_head
     FROM calls c
     JOIN organizations o ON o.id = c.organization_id
    WHERE c.id = $1`,
  [callId]
);

if (!rows.length) {
  console.log('Call not found');
} else {
  const r = rows[0];
  console.log(JSON.stringify(r, null, 2));

  const raw = await pool.query(
    `SELECT transcript_raw FROM calls WHERE id = $1`,
    [callId]
  );
  const resp = raw.rows[0]?.transcript_raw;
  const utts = resp?.results?.utterances ?? [];
  console.log('\nutterance count:', utts.length);
  console.log('distinct speakers:', [...new Set(utts.map((u: any) => u.speaker))]);
  console.log('distinct channels:', [...new Set(utts.map((u: any) => u.channel))]);
  console.log('\nfirst 12 utterances:');
  for (const u of utts.slice(0, 12)) {
    console.log(
      `  [${u.start?.toFixed(1)}s] spk=${u.speaker} ch=${u.channel} conf=${u.confidence?.toFixed(2)} :: ${u.transcript.slice(0, 110)}`
    );
  }
}

await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
