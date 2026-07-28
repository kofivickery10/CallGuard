/**
 * Score one sale N times and report which checkpoints disagree between runs.
 *
 * Read-only: nothing is written to the database, and no CRM push happens. Safe
 * to run against a live sale.
 *
 * Exists because "why did the score change when nothing changed?" is a fair
 * question from a regulated firm and deserves a measured answer rather than a
 * shrug about AI being non-deterministic. LLM scoring samples from a
 * probability distribution, so a checkpoint whose evidence clearly meets or
 * clearly misses its criterion lands the same way every time, while one sitting
 * near the model's decision boundary can go either way.
 *
 * The useful output is therefore not the spread in the headline percentage. It
 * is WHICH checkpoints are unstable, because that names the criteria whose
 * wording does not define a clear enough bar — and those can be fixed, whereas
 * the sampling cannot (Sonnet 5 rejects `temperature` outright).
 *
 * Usage:
 *   JOURNEY=<uuid> npx tsx src/scripts/measure-score-stability.ts
 *   JOURNEY=<uuid> RUNS=5 npx tsx src/scripts/measure-score-stability.ts
 *   JOURNEY=<uuid> MODEL=claude-sonnet-4-6 npx tsx src/scripts/measure-score-stability.ts
 */

import { pool, query, queryOne } from '../db/client.js';
import { scoreTranscript, normalizeScore } from '../services/scoring.js';
import { getKBContext } from '../services/kb.js';
import { classifyItems } from '../services/checkpoint-classification.js';
import { buildCombinedTranscript } from '../services/journey-transcript.js';
import { isItemPass, resolveBranchWithSource } from '@callguard/shared';
import type { ScorecardItem, Scorecard } from '@callguard/shared';

// JOURNEY takes one; JOURNEYS takes several and aggregates across them.
// Measuring more than one sale matters: a checkpoint can look unstable on a
// single call simply because that call's evidence happened to be marginal for
// it. A criterion whose WORDING is the problem is unstable on sale after sale,
// and only the cross-sale view separates the two.
const journeyIds = (process.env.JOURNEYS ?? process.env.JOURNEY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const runs = Number(process.env.RUNS ?? 5);
const modelOverride = process.env.MODEL ?? null;

if (journeyIds.length === 0) {
  console.error('JOURNEY (one uuid) or JOURNEYS (comma-separated) is required');
  process.exit(1);
}

interface ItemStat {
  label: string;
  sort: number;
  passes: number;
  fails: number;
  confidences: number[];
  // Sales on which this checkpoint disagreed with itself between runs.
  unstableOn: Set<string>;
  // Sales on which it was scored at all (branch/product gating varies).
  seenOn: Set<string>;
}

async function measureJourney(journeyId: string, stats: Map<string, ItemStat>): Promise<void> {
  const journey = await queryOne<{
    organization_id: string; scorecard_id: string; crm_stage: string | null;
  }>('SELECT organization_id, scorecard_id, crm_stage FROM journeys WHERE id = $1', [journeyId as string]);
  if (!journey) throw new Error(`Journey ${journeyId} not found`);

  const calls = await query<{
    call_date: string | null; created_at: string; agent_name: string | null; transcript_text: string | null;
  }>(
    `SELECT c.call_date, c.created_at, c.agent_name, c.transcript_text
       FROM journey_calls jc JOIN calls c ON c.id = jc.call_id
      WHERE jc.journey_id = $1 AND c.transcript_text IS NOT NULL
      ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
    [journeyId as string]
  );
  if (calls.length === 0) throw new Error('No transcribed calls on this journey');
  const transcript = buildCombinedTranscript(calls);

  const scorecard = await queryOne<Scorecard>('SELECT * FROM scorecards WHERE id = $1', [journey.scorecard_id]);
  const items = await query<ScorecardItem>(
    'SELECT * FROM scorecard_items WHERE scorecard_id = $1 AND archived_at IS NULL ORDER BY sort_order',
    [journey.scorecard_id]
  );

  // Resolve exactly as scoring does, so the item set matches the real run.
  const { branch, source } = resolveBranchWithSource(transcript, scorecard?.branch_config, journey.crm_stage);
  const { scoreable, na } = classifyItems(items, branch, 1.0);
  // Read pass_threshold directly rather than through getScoringSettings: this
  // is a diagnostic that must run against any database, including one that has
  // not had the latest migrations applied yet.
  const thresholdRow = await queryOne<{ pass_threshold: string }>(
    'SELECT pass_threshold FROM organizations WHERE id = $1', [journey.organization_id]
  );
  const passThreshold = Number(thresholdRow?.pass_threshold ?? 70);
  const org = await queryOne<{ industry: string | null }>(
    'SELECT industry FROM organizations WHERE id = $1', [journey.organization_id]
  );
  const kbContext = await getKBContext(journey.organization_id);
  const products = await query<{ product_name: string }>(
    'SELECT product_name FROM journey_products WHERE journey_id = $1', [journeyId as string]
  );

  console.log(`Journey ${journeyId}`);
  console.log(`  transcript: ${transcript.length.toLocaleString()} chars across ${calls.length} call(s)`);
  console.log(`  branch:     "${branch}" (via ${source}) — ${scoreable.length} scored, ${na.length} n/a`);
  console.log(`  each checkpoint is worth ${(100 / scoreable.length).toFixed(2)} points`);
  console.log(`  runs:       ${runs}\n`);

  // Per-sale pass/fail tally, so instability can be attributed to THIS sale
  // rather than smeared across the aggregate.
  const local = new Map<string, { p: number; f: number }>();
  const scores: number[] = [];

  for (let run = 1; run <= runs; run++) {
    process.stdout.write(`  run ${run}/${runs}… `);
    const { output, model } = await scoreTranscript(
      transcript,
      scoreable.map((i) => ({
        id: i.id, label: i.label, description: i.description, score_type: i.score_type,
        expectation: i.expectation, ai_check: i.ai_check, consent_gate: i.consent_gate,
      })),
      modelOverride,
      kbContext,
      undefined,
      false, // no coaching — keeps runs comparable and cheaper
      org?.industry ?? null,
      true,  // journeyMode
      products.map((p) => p.product_name),
      false
    );

    let weighted = 0;
    let weight = 0;
    for (const it of output.items) {
      const item = scoreable.find((i) => i.id === it.scorecard_item_id);
      if (!item) continue;
      const normalized = normalizeScore(it.score, item.score_type);
      const passed = isItemPass(normalized, passThreshold);
      const w = Number(item.weight);
      weighted += normalized * w;
      weight += w;

      const stat = stats.get(item.id) ?? {
        label: item.label, sort: item.sort_order, passes: 0, fails: 0,
        confidences: [], unstableOn: new Set<string>(), seenOn: new Set<string>(),
      };
      passed ? stat.passes++ : stat.fails++;
      if (typeof it.confidence === 'number') stat.confidences.push(it.confidence);
      stat.seenOn.add(journeyId);
      const perSale = local.get(item.id) ?? { p: 0, f: 0 };
      passed ? perSale.p++ : perSale.f++;
      local.set(item.id, perSale);
      stats.set(item.id, stat);
    }
    const score = weight > 0 ? weighted / weight : 0;
    scores.push(score);
    console.log(`${score.toFixed(2)}%  (${model})`);
  }

  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  console.log(`\n  spread: ${min.toFixed(2)}% – ${max.toFixed(2)}%  (range ${(max - min).toFixed(2)} points, mean ${mean.toFixed(2)}%)`);

  // Attribute instability to THIS sale before folding into the aggregate.
  let unstableHere = 0;
  for (const [id, t] of local) {
    if (t.p > 0 && t.f > 0) {
      stats.get(id)!.unstableOn.add(journeyId);
      unstableHere++;
    }
  }
  console.log(`  ${local.size - unstableHere}/${local.size} checkpoints identical across every run, ${unstableHere} disagreed\n`);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main() {
  const stats = new Map<string, ItemStat>();
  for (const id of journeyIds) {
    await measureJourney(id, stats);
  }

  const everUnstable = [...stats.values()].filter((s) => s.unstableOn.size > 0);
  const stable = [...stats.values()].filter((s) => s.unstableOn.size === 0);

  console.log('='.repeat(78));
  console.log(`AGGREGATE across ${journeyIds.length} sale(s), ${runs} runs each\n`);
  console.log(`  ${stable.length} checkpoint(s) never disagreed with themselves.`);
  console.log(`  ${everUnstable.length} disagreed on at least one sale.\n`);

  if (everUnstable.length > 0) {
    console.log('  unstable_on | pass/fail | mean conf | checkpoint');
    for (const s of everUnstable.sort(
      (a, b) => b.unstableOn.size - a.unstableOn.size || avg(a.confidences) - avg(b.confidences)
    )) {
      const on = `${s.unstableOn.size}/${s.seenOn.size}`.padStart(11);
      const split = `${s.passes}/${s.fails}`.padStart(9);
      console.log(`  ${on} | ${split} |      ${avg(s.confidences).toFixed(2)} | ${s.sort}. ${s.label}`);
    }

    // Unstable on MORE THAN ONE sale is the strong signal: the criterion's
    // wording is the problem, not one call's evidence being marginal.
    const systemic = everUnstable.filter((s) => s.unstableOn.size > 1);
    if (systemic.length > 0) {
      console.log(`\n  ${systemic.length} unstable on more than one sale — these are wording problems,`);
      console.log('  not one call being borderline. Fix these first:');
      for (const s of systemic.sort((a, b) => b.unstableOn.size - a.unstableOn.size)) {
        console.log(`    ${s.sort}. ${s.label}  (${s.unstableOn.size}/${s.seenOn.size} sales)`);
      }
    }
    console.log(
      `\n  Mean confidence: ${avg(everUnstable.flatMap((s) => s.confidences)).toFixed(2)} unstable, ` +
        `${avg(stable.flatMap((s) => s.confidences)).toFixed(2)} stable.`
    );
  }
  console.log('='.repeat(78));

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[Stability] failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
