// Is the answer in the call, but outside the passages we sent?
//
// STRICTLY READ-ONLY. Rebuilds each undetermined item's search exactly as the
// processor does, then asks a question the processor never asks: how many
// distinct places in the call does this topic come up, and how many of them did
// we actually look at?
//
// evidenceExcerpts takes the first three non-overlapping windows BY POSITION.
// The processor's own comment observes that "the adviser habitually names what
// they are about to ask before asking it, so the first mention is the one window
// an answer cannot be in" — and then takes the earliest three anyway. Where a
// topic is raised more than three times (section preamble, the run-through, then
// the actual exchange), the exchange can fall outside every window sent.
//
// Usage: tsx src/scripts/inspect-excerpt-coverage.ts ["Trust Point"] [--verbose]
import { pool, query } from '../db/client.js';
import { buildCombinedTranscriptWithOffsets } from '../services/journey-transcript.js';
import {
  deriveSearchTerms,
  deriveAnswerTerms,
  findEvidence,
  evidenceExcerpts,
} from '../services/reconciliation.js';

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

/** The excerpt settings the processor uses. Kept in step by hand — see the call. */
const MAX_EXCERPTS = 3;
const WIDTH = 700;

/** How many windows WOULD there be, if nothing capped them? */
function windowCount(hits: Array<{ index: number }>): number {
  let n = 0;
  let last = -Infinity;
  for (const h of hits) {
    if (h.index - last < WIDTH * 0.75) continue;
    n++;
    last = h.index;
  }
  return n;
}

async function main(): Promise<void> {
  const orgArg = process.argv[2] ?? 'Trust Point';
  const verbose = process.argv.includes('--verbose');

  const runs = await query<{ id: string; journey_id: string; attachment_name: string | null }>(
    `SELECT r.id, r.journey_id, r.attachment_name
       FROM capture_reconciliation_runs r
       JOIN organizations o ON o.id = r.organization_id
      WHERE o.name ILIKE $1 AND r.status = 'completed'
      ORDER BY r.completed_at DESC NULLS LAST`,
    [`%${orgArg}%`],
  );

  let considered = 0;
  let truncated = 0;
  let answerOutside = 0;
  const examples: string[] = [];

  for (const run of runs) {
    const calls = await query<{
      id: string;
      call_date: string | null;
      created_at: string;
      agent_name: string | null;
      transcript_text: string | null;
    }>(
      `SELECT c.id, c.call_date, c.created_at, c.agent_name, c.transcript_text
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
        WHERE jc.journey_id = $1
        ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
      [run.journey_id],
    );
    if (calls.length === 0) continue;
    const { text: transcript } = buildCombinedTranscriptWithOffsets(calls);
    if (transcript.trim() === '') continue;

    const items = await query<{
      sort_order: number;
      question: string;
      guidance: string | null;
      application_answer: string | null;
    }>(
      `SELECT sort_order, question, guidance, application_answer
         FROM capture_reconciliation_items
        WHERE run_id = $1 AND outcome = 'undetermined'
        ORDER BY sort_order`,
      [run.id],
    );

    for (const item of items) {
      // The item's stored wording is what the processor searched with. Choices
      // are not stored per item, so this UNDERSTATES the hit count for
      // list-selection questions — the direction that makes the finding safe.
      const questionTerms = deriveSearchTerms(item.question, item.guidance);
      const terms = [...questionTerms, ...deriveAnswerTerms(item.application_answer)];
      if (terms.length === 0) continue;

      const hits = findEvidence(terms, transcript);
      if (hits.length === 0) continue;
      considered++;

      const total = windowCount(hits);
      if (total <= MAX_EXCERPTS) continue;
      truncated++;

      // Which window is RICHEST — matches the most of the question's distinct
      // terms? That is a property of the search itself, with no guess about what
      // an answer looks like, so it does not inherit a heuristic's error. If the
      // richest window is not among the three taken by position, then position is
      // choosing worse passages than the evidence already available could.
      const sent = evidenceExcerpts(transcript, hits, MAX_EXCERPTS, WIDTH);
      const all = evidenceExcerpts(transcript, hits, 99, WIDTH);
      const richness = (window: string): number => {
        const lower = window.toLowerCase();
        return new Set(terms.filter((t) => lower.includes(t))).size;
      };
      const best = all.reduce((a, b) => (richness(b) > richness(a) ? b : a));
      const sentBest = sent.reduce((a, b) => (richness(b) > richness(a) ? b : a));
      if (richness(best) <= richness(sentBest)) continue;
      answerOutside++;
      const dropped = all.filter((e) => !sent.includes(e));

      if (verbose && examples.length < 6) {
        const window = best;
        examples.push(
          `\n   ${run.attachment_name ?? '—'} #${item.sort_order}\n` +
            `   Q    ${JSON.stringify(item.question)}\n` +
            `   app  ${JSON.stringify(item.application_answer)}\n` +
            `   ${total} windows, ${MAX_EXCERPTS} sent, ${dropped.length} dropped. ` +
              `Richest sent matches ${richness(sentBest)} terms; richest dropped matches ${richness(best)}\n` +
            `   the window position skipped: ${JSON.stringify(window.slice(0, 300))}`,
        );
      }
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Undetermined items whose topic WAS found in the call: ${considered}`);
  console.log(
    `  ...where the call raises it more than ${MAX_EXCERPTS} times, so windows were dropped: ` +
      `${truncated} (${((100 * truncated) / Math.max(1, considered)).toFixed(0)}%)`,
  );
  console.log(
    `  ...and a DROPPED window matches more of the question's terms than any sent one: ` +
      `${answerOutside} (${((100 * answerOutside) / Math.max(1, considered)).toFixed(0)}%)`,
  );
  for (const e of examples) console.log(e);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
