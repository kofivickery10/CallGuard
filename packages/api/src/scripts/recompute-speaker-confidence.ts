/**
 * Recompute stored speaker-attribution confidence from the transcript already
 * on file, so a change to the confidence rules reaches existing calls without
 * paying Deepgram again.
 *
 * Confidence is derived at transcription time and stored, so tightening the
 * rules leaves every historical call sitting on the old number. Everything the
 * calculation needs — the diarised utterances and the labelled transcript — is
 * already in the row, so this is free and instant.
 *
 * Read-only unless --commit.
 *
 * WHAT THIS DOES NOT RESTORE
 *
 * The cleanup pass can lift a call to 0.75 on a 'swapped' verdict, which is an
 * active correction made on stated evidence and legitimately earns the lift.
 * That verdict is not stored, so it cannot be recovered here — a call that was
 * swapped and lifted will come out at its base confidence instead.
 *
 * That is deliberate rather than merely accepted: the calls affected are ones
 * where the deterministic content check could NOT identify the adviser, which
 * are exactly the calls whose consent gates should be seen by a person. The
 * error is in the safe direction, and re-transcribing any specific call
 * recovers the exact figure if it matters.
 *
 * Never raises a stored confidence. A number that is already lower came from
 * the integrity check finding something wrong, and this must not paper over it.
 *
 * Usage:
 *   ORG=<uuid> npx tsx src/scripts/recompute-speaker-confidence.ts
 *   ORG=<uuid> npx tsx src/scripts/recompute-speaker-confidence.ts --commit
 */

import { pool, query } from '../db/client.js';
import {
  assessSpeakerIntegrity,
  identifyAdviserCluster,
  UNRELIABLE_SPEAKER_CONFIDENCE,
  type ClusterSpeech,
} from '../services/speaker-integrity.js';
import { CONSENT_SPEAKER_CONFIDENCE_FLOOR } from '../services/checkpoint-classification.js';

const orgId = process.env.ORG;
const commit = process.argv.includes('--commit');

if (!orgId) {
  console.error('ORG (organization uuid) is required');
  process.exit(1);
}

interface Row {
  id: string;
  transcript_raw: { results?: { utterances?: unknown[] } } | null;
  transcript_text: string | null;
  speaker_attribution_confidence: string | null;
  speaker_integrity_flag: string | null;
}

type Utt = { transcript?: string; speaker?: number; channel?: number; words?: Array<{ word: string; punctuated_word?: string; speaker?: number }> };

/**
 * Cluster speech built from word-level speakers, mirroring transcription.ts. An
 * utterance spanning a speaker change would otherwise contribute the other
 * party's words to a cluster and corrupt the signal this depends on.
 */
function clusterSpeech(utts: Utt[]): ClusterSpeech[] {
  const byKey = new Map<number, string[]>();
  for (const u of utts) {
    const words = (u.words ?? []).filter((w) => w.speaker !== undefined);
    if (words.length === 0) {
      const k = u.speaker ?? 0;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(u.transcript ?? '');
      continue;
    }
    for (const w of words) {
      const k = w.speaker!;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(w.punctuated_word ?? w.word);
    }
  }
  return [...byKey.entries()].map(([key, parts]) => ({ key, text: parts.join(' ') }));
}

async function main() {
  const rows = await query<Row>(
    `SELECT id, transcript_raw, transcript_text, speaker_attribution_confidence, speaker_integrity_flag
       FROM calls
      WHERE organization_id = $1 AND transcript_raw IS NOT NULL AND transcript_text IS NOT NULL`,
    [orgId as string]
  );

  console.log(`${rows.length} call(s) with a transcript${commit ? '' : '  — DRY RUN'}\n`);
  console.log('call     | stored -> new  | crosses the consent floor?');

  let changed = 0;
  let droppedBelowFloor = 0;

  for (const r of rows) {
    const utts = (r.transcript_raw?.results?.utterances ?? []) as Utt[];
    if (utts.length === 0) continue;

    const isMultichannel = utts.some((u) => u.channel === 1);
    // Stereo is pinned by channel and is not affected by any of this.
    if (isMultichannel) continue;

    const speakerCount = new Set(utts.map((u) => u.speaker ?? 0)).size;
    const contentPick = identifyAdviserCluster(clusterSpeech(utts));

    // Mirrors computeSpeakerAttributionConfidence. Deliberately no cleanup lift
    // — see the header.
    let next = contentPick ? 0.8 : speakerCount === 2 ? 0.45 : 0.3;

    // The integrity check runs against the stored transcript exactly as the
    // pipeline does, so a call whose labels are contradicted by content still
    // gets dropped to the unreliable floor.
    const assessment = assessSpeakerIntegrity(r.transcript_text!);
    if (assessment.flag) next = Math.min(next, UNRELIABLE_SPEAKER_CONFIDENCE);

    const stored = Number(r.speaker_attribution_confidence ?? 0);
    // Only ever lower. A stored value below the recomputed one came from
    // something the pipeline detected that this cannot re-derive.
    if (next >= stored) continue;

    const crosses = stored >= CONSENT_SPEAKER_CONFIDENCE_FLOOR && next < CONSENT_SPEAKER_CONFIDENCE_FLOOR;
    if (crosses) droppedBelowFloor++;
    changed++;
    console.log(
      `${r.id.slice(0, 8)} | ${stored.toFixed(2)} -> ${next.toFixed(2)}  | ` +
        `${crosses ? 'YES — its consent gates now go to review' : 'no'}` +
        `${assessment.flag ? `  [${assessment.flag}]` : ''}`
    );

    if (commit) {
      await query(
        `UPDATE calls SET speaker_attribution_confidence = $2, speaker_integrity_flag = $3, updated_at = now()
          WHERE id = $1`,
        [r.id, next, assessment.flag]
      );
    }
  }

  console.log(
    `\n${changed} call(s) lowered, ${droppedBelowFloor} crossing below the consent-gate floor` +
      `${commit ? '' : ' (nothing written)'}`
  );
  if (droppedBelowFloor > 0) {
    console.log(
      'Sales containing those calls will route their consent gates to manual review\n' +
        'on the next scoring run. Re-score afterwards for it to take effect.'
    );
  }
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[Recompute] failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
