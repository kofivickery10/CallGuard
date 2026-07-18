// Re-run the LLM cleanup pass (incl. the speaker-label swap check) for a call
// whose cleanup previously fell back to the raw transcript, and store the
// result. Does NOT re-transcribe (transcript_raw is untouched) and does NOT
// enqueue scoring — trigger a re-score via the UI/API afterwards.
// Usage: tsx src/scripts/reprocess-call-cleanup.ts <callId>
import { pool, queryOne, query } from '../db/client.js';
import { cleanupTranscript } from '../services/transcript-cleanup.js';
import { getKBContext } from '../services/kb.js';

async function main() {
  const callId = process.argv[2];
  if (!callId) {
    console.error('Usage: tsx src/scripts/reprocess-call-cleanup.ts <callId>');
    process.exit(1);
  }

  const call = await queryOne<{
    id: string;
    organization_id: string;
    transcript_text: string | null;
    speaker_attribution_confidence: string | null;
  }>(
    'SELECT id, organization_id, transcript_text, speaker_attribution_confidence FROM calls WHERE id = $1',
    [callId]
  );
  if (!call) throw new Error(`Call ${callId} not found`);
  if (!call.transcript_text) throw new Error(`Call ${callId} has no transcript_text`);

  const confidence = call.speaker_attribution_confidence
    ? Number(call.speaker_attribution_confidence)
    : 0.6;

  console.log(`Re-running cleanup for call ${callId} (confidence=${confidence}, chars=${call.transcript_text.length})`);
  console.log('Before:', call.transcript_text.slice(0, 160).replace(/\n/g, ' | '));

  const kbContext = await getKBContext(call.organization_id);
  const cleanup = await cleanupTranscript(
    call.transcript_text,
    call.organization_id,
    kbContext,
    callId,
    confidence
  );

  console.log(`speakerLabelsSwapped=${cleanup.speakerLabelsSwapped}, output chars=${cleanup.text.length}`);
  console.log('After: ', cleanup.text.slice(0, 160).replace(/\n/g, ' | '));

  if (cleanup.text === call.transcript_text) {
    console.log('Cleanup returned the transcript unchanged — nothing to store.');
  } else {
    const newConfidence = cleanup.speakerLabelsSwapped ? Math.max(confidence, 0.75) : confidence;
    await query(
      `UPDATE calls SET transcript_text = $1, speaker_attribution_confidence = $2, updated_at = now() WHERE id = $3`,
      [cleanup.text, newConfidence, callId]
    );
    console.log(`Stored. speaker_attribution_confidence=${newConfidence}. Now re-score the call (UI "Re-score" or POST /calls/${callId}/rescore).`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
