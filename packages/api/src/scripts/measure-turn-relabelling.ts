/**
 * Measure whether per-TURN speaker relabelling works, and what it costs.
 *
 * Read-only: nothing is written to the database.
 *
 * Today the speaker check produces one verdict for the whole transcript, and
 * the only correction available is swapSpeakerLabels, which flips every turn.
 * That cannot fix a PARTIAL inversion — a real Trust Point call has the
 * adviser's own compliance script attributed to the customer while turns either
 * side of it are labelled correctly, and flipping the lot would fix one half
 * and break the other. Such a call is currently detected, kept out of the
 * confidence lift, and routed to a human.
 *
 * The proposed alternative is to ask which SPECIFIC turns are misattributed and
 * flip only those. Before building it, two questions need answers:
 *
 *   1. Does it work? Measured against deterministic role markers
 *      (services/speaker-integrity.ts), not another model's opinion. Adviser
 *      markers are scripted, role-exclusive phrases; if relabelling is working,
 *      the share of them sitting under "Customer" should fall towards zero.
 *
 *   2. Does it damage a transcript that was already right? This is the real
 *      risk. A correction that fires on correct labels is worse than no
 *      correction, so known-good calls are included as controls and any flip on
 *      those is a false positive.
 *
 * Output is asked for as a list of turn numbers rather than a rewritten
 * transcript: a few tokens instead of thousands, and it cannot silently drop or
 * reword content the way a full regeneration can.
 *
 * Usage:
 *   CALLS=<uuid,uuid> npx tsx src/scripts/measure-turn-relabelling.ts
 *   CALLS=<uuid> MODEL=claude-sonnet-5 npx tsx src/scripts/measure-turn-relabelling.ts
 */

import { pool, query } from '../db/client.js';
import { config } from '../config.js';
import { countSpeakerMarkers } from '../services/speaker-integrity.js';
import { CLAUDE_MODELS } from '@callguard/shared';

const callIds = (process.env.CALLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const model = process.env.MODEL ?? CLAUDE_MODELS.SONNET_5;

if (callIds.length === 0) {
  console.error('CALLS (comma-separated call uuids) is required');
  process.exit(1);
}

// Sonnet 5 list pricing per million tokens. Intro pricing ($2/$10) runs to
// 2026-08-31; list is used so the figure quoted is the one that persists.
const PRICE = { input: 3 / 1_000_000, output: 15 / 1_000_000 };

interface Turn { speaker: 'Agent' | 'Customer'; text: string; raw: string }

/** Split the stored transcript into labelled turns, preserving anything else. */
function parseTurns(transcript: string): { turns: Turn[]; preamble: string } {
  const lines = transcript.split('\n');
  const turns: Turn[] = [];
  const preamble: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(Agent|Customer):\s?(.*)$/);
    if (m) turns.push({ speaker: m[1] as 'Agent' | 'Customer', text: m[2] ?? '', raw: line });
    else if (turns.length === 0) preamble.push(line);
    else if (line.trim()) {
      // Continuation of the previous turn (wrapped line).
      const last = turns[turns.length - 1]!;
      last.text += ' ' + line.trim();
      last.raw += '\n' + line;
    }
  }
  return { turns, preamble: preamble.join('\n') };
}

function render(turns: Turn[]): string {
  return turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
}

async function relabel(turns: Turn[]): Promise<{ flip: Set<number>; inTok: number; outTok: number; truncated: boolean; unparseable: boolean }> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const numbered = turns.map((t, i) => `${i + 1}. ${t.speaker}: ${t.text}`).join('\n');

  const prompt = `Below is a call transcript between a UK protection insurance ADVISER and a CUSTOMER. Each turn is numbered and carries a speaker label that came from an automated guess, which may be wrong for some turns.

Identify the turns whose speaker label is WRONG.

- The ADVISER introduces themselves and their firm, asks fact-find questions, quotes prices, reads compliance and regulatory wording, explains products, and drives the call.
- The CUSTOMER answers questions about their own health, money, family and circumstances, and reacts to what is proposed.

Some transcripts are entirely correct. Some have a run of turns inverted while the rest are fine. Report only turns you are confident are mislabelled — a turn that is short, ambiguous, or could plausibly belong to either speaker should NOT be reported.

Reply with only a JSON array of the wrong turn numbers, e.g. [12,13,14]. Reply [] if every label looks right.

## Transcript

${numbered}`;

  // Sonnet 5 runs adaptive thinking by default and max_tokens covers reasoning
  // AND output together. A budget sized for the answer alone (the answer is a
  // handful of numbers) is consumed entirely by thinking, and the run returns
  // nothing — which the parser below would read as "no turns are wrong". The
  // first attempt at this measurement did exactly that on all five calls and
  // looked like a clean negative result.
  // THINKING=off disables adaptive reasoning. Deciding who said a scripted
  // compliance line is pattern-matching against role markers, not a problem
  // that needs working through, and with thinking ON four of five calls burned
  // a 16k budget without ever emitting an answer.
  const res = await client.messages.create({
    model,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
    ...(process.env.THINKING === 'off' ? { thinking: { type: 'disabled' as const } } : {}),
  });
  const truncated = res.stop_reason === 'max_tokens';

  const text = res.content.find((b) => b.type === 'text');
  const body = text && text.type === 'text' ? text.text : '';
  const match = body.match(/\[[\d,\s]*\]/);
  let flip = new Set<number>();
  let unparseable = !match;
  if (match) {
    try {
      flip = new Set((JSON.parse(match[0]) as number[]).filter((n) => Number.isInteger(n) && n >= 1 && n <= turns.length));
    } catch {
      unparseable = true;
    }
  }
  // "No answer" and "the answer is none" must never look the same. Conflating
  // them is what made the first run of this script report a false negative.
  return { flip, inTok: res.usage.input_tokens, outTok: res.usage.output_tokens, truncated, unparseable };
}

/** Share of adviser-only phrases sitting under a "Customer" label. 0 is clean. */
function misplacement(transcript: string): { ratio: number; under: number; total: number } {
  const c = countSpeakerMarkers(transcript);
  const total = c.adviserUnderAgent + c.adviserUnderCustomer;
  return { ratio: total > 0 ? c.adviserUnderCustomer / total : 0, under: c.adviserUnderCustomer, total };
}

async function main() {
  const rows = await query<{ id: string; transcript_text: string | null; dialer_call_id: string | null; speaker_attribution_confidence: string | null; speaker_integrity_flag: string | null; duration_seconds: string | null }>(
    `SELECT id, transcript_text, dialer_call_id, speaker_attribution_confidence,
            speaker_integrity_flag, duration_seconds
       FROM calls WHERE id = ANY($1::uuid[])`,
    [callIds]
  );

  console.log(`model: ${model}\n`);
  let totalCost = 0;

  for (const row of rows) {
    if (!row.transcript_text) {
      console.log(`${row.id.slice(0, 8)}: no transcript, skipping\n`);
      continue;
    }
    const { turns } = parseTurns(row.transcript_text);
    const before = misplacement(row.transcript_text);
    const conf = row.speaker_attribution_confidence;
    const flag = row.speaker_integrity_flag ?? 'none';
    const mins = row.duration_seconds ? Math.round(Number(row.duration_seconds) / 60) : '?';

    console.log(`${'='.repeat(72)}`);
    console.log(`call ${row.id.slice(0, 8)}  (cloudtalk ${row.dialer_call_id ?? '-'}, ${mins}m, ${turns.length} turns)`);
    console.log(`  stored: confidence ${conf}, flag ${flag}`);
    console.log(`  before: ${before.under}/${before.total} adviser phrases under "Customer" (${(before.ratio * 100).toFixed(0)}%)`);

    const { flip, inTok, outTok, truncated, unparseable } = await relabel(turns);
    const cost = inTok * PRICE.input + outTok * PRICE.output;
    totalCost += cost;

    const fixed = turns.map((t, i) =>
      flip.has(i + 1) ? { ...t, speaker: (t.speaker === 'Agent' ? 'Customer' : 'Agent') as 'Agent' | 'Customer' } : t
    );
    const after = misplacement(render(fixed));

    console.log(`  flipped: ${flip.size} of ${turns.length} turn(s)`);
    console.log(`  after:  ${after.under}/${after.total} under "Customer" (${(after.ratio * 100).toFixed(0)}%)`);
    const delta = before.under - after.under;
    if (truncated || unparseable) {
      console.log(
        `  verdict: NO ANSWER — ${truncated ? 'hit the token ceiling' : 'reply had no parseable list'}. ` +
          `Not a result; the measurement failed for this call.`
      );
      console.log(`  cost:    $${cost.toFixed(4)}  (${inTok} in / ${outTok} out)\n`);
      continue;
    }

    console.log(
      `  verdict: ${
        before.under === 0 && flip.size === 0 ? 'CONTROL HELD — was clean, nothing changed'
        : before.under === 0 && flip.size > 0 ? `FALSE POSITIVE — was clean, flipped ${flip.size} turn(s)`
        : delta > 0 ? `IMPROVED — ${delta} fewer misplaced`
        : delta < 0 ? `WORSE — ${-delta} more misplaced`
        : 'NO CHANGE'
      }`
    );
    console.log(`  cost:    $${cost.toFixed(4)}  (${inTok} in / ${outTok} out)\n`);
  }

  console.log(`${'='.repeat(72)}`);
  console.log(`total for ${rows.length} call(s): $${totalCost.toFixed(4)}  (avg $${(totalCost / Math.max(1, rows.length)).toFixed(4)}/call)`);
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[Relabel] failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
