// Score one real sale on several models and grade each against hand-established
// ground truth. Read-only: nothing is written to the database.
//
// Distinct from evaluate-models.ts, which measures AGREEMENT between two models.
// Agreement is a weak proxy — two models can agree and both be wrong, which is
// exactly what happened on the sale this eval is built from. Here every model is
// graded against verdicts derived by reading the transcript by hand.
//
// The branch is pinned rather than resolved, so all models see an identical item
// set and the comparison measures scoring quality, not branch detection.
//
// Usage:
//   npx tsx src/scripts/eval-scoring-models.ts
//   npx tsx src/scripts/eval-scoring-models.ts --models claude-sonnet-5,claude-sonnet-4-6
import { pool, query, queryOne } from '../db/client.js';
import { scoreTranscript, normalizeScore } from '../services/scoring.js';
import { getKBContext } from '../services/kb.js';
import { classifyItems } from '../services/checkpoint-classification.js';
import { buildCombinedTranscript } from '../services/journey-transcript.js';
import { isItemPass, CLAUDE_MODELS } from '@callguard/shared';
import type { ScorecardItem, Scorecard } from '@callguard/shared';

const JOURNEY_ID = '27bbb305-b4b7-4612-8783-c7c5022c4d42';

// The correct branch for this sale, established from the CRM semantics in the
// wrap-up call ("we leave it to the medical underwriter now", "there's no
// immediate start", "we just wait for them to accept you"). Pinned so every
// model scores the same items.
const BRANCH = 'referred';

const PASS_THRESHOLD = 70;

/**
 * Verdicts established by reading the eight transcripts by hand, not by asking
 * a model. Each entry records WHY, so a future reader can challenge the ground
 * truth rather than treating it as an oracle.
 *
 * Deliberately excluded: items 21 and 22 (Health & Lifestyle). They depend on
 * who was speaking, and call 7's Agent/Customer labels are known to be
 * scrambled in the stored transcript — no model can be graded fairly on them
 * until that call is re-transcribed.
 */
const GROUND_TRUTH: Record<string, { expectPass: boolean; sort: number; why: string }> = {
  // CORRECTED after the first eval run. Both items below were initially graded
  // as expected-PASS on a plain reading of the transcript, and all three models
  // disagreed. They were right and the first reading was wrong — the scorecard
  // applies a stricter standard than "was the topic covered":
  //
  //   item 15 is a hard-yes CONSENT GATE. The customer says "Yeah" and then
  //     immediately qualifies it — "I'm not going to commit right now, though."
  //     A consent gate needs a clean affirmative, not one the customer walks
  //     back in the same breath.
  //   item 18 is in the "Regulatory (word-for-word)" section and its ai_check
  //     demands the approved script. GP contact was discussed conversationally
  //     four times, but conversational coverage does not satisfy a word-for-word
  //     requirement, and the 1-in-10 checks were never mentioned at all.
  //
  // Left documented rather than quietly edited: a ground-truth set that three
  // independent models reject is itself evidence, and the next person to run
  // this should see why these two moved.
  '59089f50-57c7-4e1d-9a44-05186e78e2ac': {
    sort: 15, expectPass: false,
    why: 'CONSENT GATE. Customer says "Yeah" to the price but immediately adds "I\'m not going to commit right now, though." A hard-yes gate is not met by an affirmative the customer qualifies away.',
  },
  '97b4b631-f85f-4c77-8ed3-346fb331c53c': {
    sort: 18, expectPass: false,
    why: 'WORD-FOR-WORD. GP contact discussed conversationally 4x, but the ai_check requires the approved script, and the 1-in-10 checks were never mentioned. Note: a model answering "no relevant evidence found" here has the right verdict for the wrong reason — the topic WAS discussed.',
  },

  // ── Expected PASS ─────────────────────────────────────────────────────────
  'e21ccc4c-144a-40ad-883a-4d57d257b3f8': {
    sort: 32, expectPass: true,
    why: 'Sort code + account number taken, and non-activation made explicit: "once the decision is made... you can start it if you\'re happy", customer "No money\'s going out until I\'m happy" -> "Exactly. Nothing\'s going to start either."',
  },

  // ── Expected FAIL: the compound-criteria case, plus a genuine miss ────────
  '3d50cc7e-407d-4833-9c26-ed12ebec995c': {
    sort: 35, expectPass: false,
    why: 'COMPOUND. Suicide exclusion given ("doesn\'t pay out if suicide is committed within the first year") but 30-day cancellation rights never mentioned anywhere in 64k characters. Half a two-part criterion. The first pass marked this MET.',
  },
  'd8941c73-2735-43fa-8118-2cd9bb69f50b': {
    sort: 33, expectPass: false,
    why: 'Never asked. Adviser started to ("What date—sorry.") then switched to requesting the sort code and never returned to it.',
  },

  // ── Controls: genuine failures. A model passing these is too lenient ───────
  'db39ed87-3a37-4857-a065-226d672558a3': {
    sort: 10, expectPass: false,
    why: 'CONTROL. The data-sharing statement was never given, so no consent to it could be obtained.',
  },
  'd4032a6f-c786-4a86-8084-a6fc55767d76': {
    sort: 17, expectPass: false,
    why: 'CONTROL. The honesty/non-disclosure warning was never delivered. The CUSTOMER said "no point lying about it" — the adviser did not give the warning.',
  },
  '7329cc17-3e08-4f8f-aca6-c713a394dfb6': {
    sort: 37, expectPass: false,
    why: 'CONTROL. No Google review was ever requested.',
  },
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const models = (arg('--models') ?? `${CLAUDE_MODELS.HAIKU},claude-sonnet-4-6,claude-sonnet-5`)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const journey = await queryOne<{ organization_id: string; scorecard_id: string }>(
    'SELECT organization_id, scorecard_id FROM journeys WHERE id = $1',
    [JOURNEY_ID]
  );
  if (!journey) throw new Error(`Journey ${JOURNEY_ID} not found`);

  const calls = await query<{
    call_date: string | null; created_at: string; agent_name: string | null; transcript_text: string | null;
  }>(
    `SELECT c.call_date, c.created_at, c.agent_name, c.transcript_text
       FROM journey_calls jc JOIN calls c ON c.id = jc.call_id
      WHERE jc.journey_id = $1 AND c.transcript_text IS NOT NULL
      ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
    [JOURNEY_ID]
  );
  const transcript = buildCombinedTranscript(calls);

  const scorecard = await queryOne<Scorecard>('SELECT * FROM scorecards WHERE id = $1', [journey.scorecard_id]);
  const items = await query<ScorecardItem>(
    'SELECT * FROM scorecard_items WHERE scorecard_id = $1 AND archived_at IS NULL ORDER BY sort_order',
    [journey.scorecard_id]
  );

  // Speaker confidence passed as 1.0 so consent gates stay in the scoreable set
  // — the point is to compare scoring, not to re-test the manual-review routing.
  const { scoreable, na } = classifyItems(items, BRANCH, 1.0);
  const org = await queryOne<{ industry: string | null }>(
    'SELECT industry FROM organizations WHERE id = $1',
    [journey.organization_id]
  );
  const kbContext = await getKBContext(journey.organization_id);

  console.log(`Journey ${JOURNEY_ID}`);
  console.log(`  transcript: ${transcript.length.toLocaleString()} chars across ${calls.length} calls`);
  console.log(`  branch:     "${BRANCH}" (pinned) — ${scoreable.length} scored, ${na.length} n/a`);
  console.log(`  scorecard:  ${scorecard?.name ?? journey.scorecard_id}`);
  console.log(`  graded on:  ${Object.keys(GROUND_TRUTH).length} hand-checked items\n`);

  const results: Array<{
    model: string; correct: number; wrong: string[]; score: number;
    inTok: number; outTok: number; ms: number;
  }> = [];

  for (const model of models) {
    process.stdout.write(`Scoring on ${model}... `);
    const started = Date.now();
    let output, usage;
    try {
      ({ output, usage } = await scoreTranscript(
        transcript,
        scoreable.map((i) => ({
          id: i.id, label: i.label, description: i.description, score_type: i.score_type,
          expectation: i.expectation, ai_check: i.ai_check, consent_gate: i.consent_gate,
        })),
        model,
        kbContext,
        undefined,
        false,               // no coaching — keeps runs comparable and cheaper
        org?.industry ?? null,
        true,                // journeyMode
        ['Level Term Life Insurance'],
        false
      ));
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
      continue;
    }
    const ms = Date.now() - started;

    const byId = new Map(output.items.map((it) => [it.scorecard_item_id, it]));
    let correct = 0;
    const wrong: string[] = [];

    for (const [itemId, truth] of Object.entries(GROUND_TRUTH)) {
      const item = scoreable.find((i) => i.id === itemId);
      const scored = byId.get(itemId);
      if (!item || !scored) {
        wrong.push(`item ${truth.sort}: NOT SCORED`);
        continue;
      }
      const passed = isItemPass(normalizeScore(scored.score, item.score_type), PASS_THRESHOLD);
      if (passed === truth.expectPass) correct++;
      else {
        wrong.push(
          `item ${truth.sort} (${item.label.slice(0, 40)}): said ${passed ? 'PASS' : 'FAIL'}, ` +
          `should be ${truth.expectPass ? 'PASS' : 'FAIL'} — "${(scored.evidence ?? '').slice(0, 70)}"`
        );
      }
    }

    // Overall score across every item, for context on how the verdict moves.
    let weighted = 0, totalWeight = 0;
    for (const it of output.items) {
      const item = scoreable.find((i) => i.id === it.scorecard_item_id);
      if (!item) continue;
      const w = Number(item.weight);
      weighted += normalizeScore(it.score, item.score_type) * w;
      totalWeight += w;
    }

    console.log(`${correct}/${Object.keys(GROUND_TRUTH).length} correct  (${(ms / 1000).toFixed(0)}s)`);
    results.push({
      model, correct, wrong,
      score: totalWeight > 0 ? weighted / totalWeight : 0,
      inTok: usage.input_tokens + usage.cache_read_input_tokens,
      outTok: usage.output_tokens,
      ms,
    });
  }

  console.log(`\n${'='.repeat(78)}\nRESULTS — graded against hand-checked ground truth\n${'='.repeat(78)}`);
  const total = Object.keys(GROUND_TRUTH).length;
  for (const r of results) {
    console.log(
      `\n${r.model}\n  ground truth: ${r.correct}/${total}   overall score: ${r.score.toFixed(1)}%   ` +
      `tokens: ${r.inTok.toLocaleString()} in / ${r.outTok.toLocaleString()} out   ${(r.ms / 1000).toFixed(0)}s`
    );
    if (r.wrong.length === 0) console.log('  no disagreements with ground truth');
    for (const w of r.wrong) console.log(`  ✗ ${w}`);
  }

  console.log(`\n${'-'.repeat(78)}`);
  console.log('Ground truth (established by reading the transcripts, not by a model):');
  for (const [, t] of Object.entries(GROUND_TRUTH).sort((a, b) => a[1].sort - b[1].sort)) {
    console.log(`  item ${String(t.sort).padStart(2)} -> ${t.expectPass ? 'PASS' : 'FAIL'}: ${t.why.slice(0, 96)}`);
  }
  console.log('\nNothing was written to the database.');

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
