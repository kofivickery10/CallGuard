// One-off diagnostic: are Trust Point's unscored long calls awaiting a Zoho sale, or phone-match-broken?
import { pool } from '../db/client.js';

async function main() {
  const ids = [
    '9bf5d4f4-ddf5-42b8-ac96-4b4c42bd1c2a',
    '40b19c05-b14b-4d15-a274-8163e980b26b',
    'cb4ad5d1-86af-4687-ba9e-cdf481f0dde3',
    '14532acb-42a7-4632-9102-88e868653bf6',
  ];
  const { rows } = await pool.query(
    `SELECT c.id, ROUND(c.duration_seconds/60.0,1) AS mins, c.customer_phone,
            c.customer_id, c.journey_id,
            j.status AS journey_status
       FROM calls c
       LEFT JOIN journeys j ON j.id = c.journey_id
      WHERE c.id = ANY($1)`,
    [ids]
  );
  for (const r of rows) {
    console.log(
      `${r.id.slice(0, 8)} — ${r.mins}min — phone:${r.customer_phone ?? 'NULL'} — ` +
        `customer_id:${r.customer_id ? 'matched' : 'NULL'} — journey:${r.journey_id ? r.journey_status : 'none'}`
    );
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
