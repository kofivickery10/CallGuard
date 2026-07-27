// One-off correction for journey 91f078db (Trust Point, call 97701e4c).
//
// The Haiku cleanup pass returned SPEAKER_LABELS: swapped and inverted an
// already-correct labelling. Deepgram mis-assigned the adviser's opening turns
// ("Hi there. Can I speak to ...") to cluster 0 and merged a few boundary
// turns, and that intro-introduction cue is exactly what the speaker-label
// verification keys on (services/transcript-cleanup.ts). The org heuristic
// (mono_first_speaker = 'customer' -> cluster 0 = Customer, cluster 1 = Agent)
// was right: cluster 1 carries 26 adviser markers to 1 customer marker.
//
// This flips every Agent:/Customer: label back, backs the old transcript up to
// disk first, and enqueues a re-score. The re-score deletes prior breaches and
// item scores in a transaction (jobs/processors/score-journey.ts), and pushes
// the corrected score to Zoho (suppressCrm is NOT set) so the 26% already on
// the tenant's QA record is replaced.
//
// Usage:
//   tsx src/scripts/fix-journey-speaker-swap.ts <backupDir>            # dry run
//   tsx src/scripts/fix-journey-speaker-swap.ts <backupDir> --commit   # apply
import { writeFileSync } from 'node:fs';
import { pool, queryOne, query } from '../db/client.js';
import { scoringQueue } from '../jobs/queue.js';

const JOURNEY_ID = '91f078db-97c6-4767-85bd-8b15adffdbe6';
const CALL_ID = '97701e4c-d4f0-42aa-b713-3332091fe731';

// One full, mechanical flip of every turn label — mirrors swapSpeakerLabels in
// services/transcript-cleanup.ts. Turn order and text are untouched.
function swapSpeakerLabels(transcript: string): string {
  return transcript.replace(/^(Agent|Customer):/gm, (_m, who: string) =>
    who === 'Agent' ? 'Customer:' : 'Agent:'
  );
}

async function main() {
  const backupDir = process.argv[2];
  const commit = process.argv.includes('--commit');
  if (!backupDir) {
    console.error('Usage: tsx src/scripts/fix-journey-speaker-swap.ts <backupDir> [--commit]');
    process.exit(1);
  }

  const call = await queryOne<{
    transcript_text: string | null;
    speaker_attribution_confidence: string | null;
  }>(
    'SELECT transcript_text, speaker_attribution_confidence FROM calls WHERE id = $1',
    [CALL_ID]
  );
  if (!call?.transcript_text) throw new Error(`Call ${CALL_ID} has no transcript_text`);

  const before = call.transcript_text;
  const after = swapSpeakerLabels(before);

  const countLabels = (t: string, who: string) =>
    (t.match(new RegExp(`^${who}:`, 'gm')) ?? []).length;

  const beforeAgent = countLabels(before, 'Agent');
  const beforeCust = countLabels(before, 'Customer');
  const afterAgent = countLabels(after, 'Agent');
  const afterCust = countLabels(after, 'Customer');

  console.log(`confidence: ${call.speaker_attribution_confidence} -> 0.6`);
  console.log(`chars: ${before.length} -> ${after.length}`);
  console.log(
    `Agent turns: ${beforeAgent} -> ${afterAgent}, Customer turns: ${beforeCust} -> ${afterCust}`
  );

  if (before === after) throw new Error('No labels changed — refusing to write');
  // The counts must simply exchange — no turn gained, lost or relabelled twice.
  if (afterAgent !== beforeCust || afterCust !== beforeAgent) {
    throw new Error('Label counts did not exchange cleanly — refusing to write');
  }
  // Every turn's spoken text must be byte-identical; only labels may differ.
  const strip = (t: string) => t.replace(/^(Agent|Customer):/gm, '');
  if (strip(before) !== strip(after)) {
    throw new Error('Transcript text changed beyond the labels — refusing to write');
  }

  // Sanity check the direction: after the swap, the Trust Point introduction
  // must sit on an Agent: turn, not a Customer: turn.
  const introTurn = after
    .split('\n\n')
    .find((t) => /calling from Trust Point/i.test(t));
  console.log(`\nintro turn after swap: ${introTurn?.slice(0, 90)}`);
  if (!introTurn?.startsWith('Agent:')) {
    throw new Error('After swap the Trust Point introduction is not on an Agent: turn — refusing to write');
  }

  console.log('\n--- first 3 turns after swap ---');
  console.log(after.split('\n\n').slice(0, 3).join('\n'));

  const stamp = process.env.BACKUP_STAMP ?? 'backup';
  const path = `${backupDir}/call-${CALL_ID}-transcript-${stamp}.txt`;
  writeFileSync(path, before);
  console.log(`\nBacked up previous transcript to ${path}`);

  if (!commit) {
    console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.');
    await pool.end();
    return;
  }

  await query(
    `UPDATE calls
        SET transcript_text = $2,
            speaker_attribution_confidence = 0.6,
            updated_at = now()
      WHERE id = $1`,
    [CALL_ID, after]
  );
  console.log('Transcript labels swapped back and confidence reset to 0.6.');

  // suppressCrm intentionally omitted: the corrected score should replace the
  // 26% already pushed to the tenant's Zoho QA record.
  const jobId = `rescore-journey-${JOURNEY_ID}-speakerfix`;
  await scoringQueue.add('score-journey', { journeyId: JOURNEY_ID }, { jobId });
  console.log(`Enqueued score-journey (jobId=${jobId}) — CRM write-back WILL fire.`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
