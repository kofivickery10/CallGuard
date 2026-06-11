/**
 * Model evaluation script: compare Claude Haiku vs Sonnet on real scored calls.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... \
 *   DATABASE_URL=postgres://... \
 *   npx tsx src/scripts/evaluate-models.ts --count=20
 *
 * Prints a summary table and a JSON report file: evaluation-report.json
 * Decision criterion: if Haiku pass/fail agreement >= 90%, it is recommended.
 */

import fs from 'fs/promises';
import { query, queryOne } from '../db/client.js';
import { scoreTranscript, normalizeScore } from '../services/scoring.js';
import { callPasses, isItemPass, CLAUDE_MODELS, CLAUDE_PRICING } from '@callguard/shared';
import type { ScorecardItem } from '@callguard/shared';

// Baseline must be the model production actually scores with, otherwise the
// agreement metric compares Haiku against a model we don't run.
const HAIKU_MODEL  = CLAUDE_MODELS.HAIKU;
const SONNET_MODEL = CLAUDE_MODELS.SONNET;
const AGREEMENT_THRESHOLD = 0.90;

const countArg = process.argv.find((a) => a.startsWith('--count='));
const COUNT = countArg ? parseInt(countArg.split('=')[1]!, 10) : 20;

interface CallRow {
  id: string;
  organization_id: string;
  transcript_text: string;
  overall_score: number;
  pass: boolean;
  model_id: string;
  // Human-readable identifiers so you can see which calls were tested.
  call_date: string | null;
  created_at: string;
  agent_name: string | null;
  customer_phone: string | null;
  external_id: string | null;
}

interface ScorecardRow {
  id: string;
  items: ScorecardItem[];
}

interface EvalResult {
  call_id: string;
  call_date: string | null;
  agent_name: string | null;
  customer_phone: string | null;
  external_id: string | null;
  production_pass: boolean;
  production_score: number;
  haiku_pass: boolean | null;
  haiku_score: number | null;
  sonnet_pass: boolean | null;
  sonnet_score: number | null;
  agreement: boolean | null;
  haiku_tokens: number;
  sonnet_tokens: number;
  haiku_cost_usd: number;
  sonnet_cost_usd: number;
}

function tokenCost(tokens: number, per1m: number): number {
  return (tokens / 1_000_000) * per1m;
}

async function runModelOnCall(
  model: string,
  call: CallRow,
  scorecard: ScorecardRow
): Promise<{ pass: boolean; score: number; inputTokens: number; outputTokens: number } | null> {
  try {
    const { output, usage } = await scoreTranscript(
      call.transcript_text,
      scorecard.items,
      model,
      null,  // no KB context
      null   // no learning context
    );

    const normalised = scorecard.items.map((item) => {
      const result = output.items.find((r) => r.scorecard_item_id === item.id);
      return result
        ? normalizeScore(result.score, item.score_type)
        : 0;
    });

    const passes = normalised.filter((s) => isItemPass(s)).length;
    const total  = scorecard.items.length;
    const score  = total > 0 ? (passes / total) * 100 : 0;
    const pass   = callPasses(score, []);

    return {
      pass,
      score,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    };
  } catch (err) {
    console.error(`  Model ${model} failed on call ${call.id}:`, (err as Error).message);
    return null;
  }
}

async function run() {
  console.log(`Evaluating ${COUNT} calls — Haiku vs Sonnet\n`);

  const calls = await query<CallRow>(
    `SELECT c.id, c.organization_id, c.transcript_text,
            cs.overall_score, cs.pass, cs.model_id,
            c.call_date, c.created_at, c.external_id, c.customer_phone,
            COALESCE(c.agent_name, u.name) AS agent_name
     FROM calls c
     JOIN call_scores cs ON cs.call_id = c.id
     LEFT JOIN users u ON u.id = c.agent_id
     WHERE c.transcript_text IS NOT NULL
       AND c.status = 'scored'
     ORDER BY c.created_at DESC
     LIMIT $1`,
    [COUNT]
  );

  if (calls.length === 0) {
    console.log('No scored calls found in the database.');
    process.exit(0);
  }

  console.log(`Found ${calls.length} calls to evaluate\n`);

  // Show exactly which calls were selected, before scoring them.
  console.log('Calls selected (most recent scored calls first):');
  calls.forEach((c, i) => {
    const when = (c.call_date ?? c.created_at)?.slice(0, 10) ?? '????-??-??';
    const who  = c.agent_name ?? 'unknown agent';
    const ref  = c.external_id ? `ext:${c.external_id}` : c.customer_phone ?? c.id.slice(0, 8);
    console.log(`  ${String(i + 1).padStart(2)}. ${when}  ${who}  (${ref})  [${c.id}]`);
  });
  console.log('');

  const results: EvalResult[] = [];

  for (const [index, call] of calls.entries()) {
    // Fetch the scorecard used for this call
    const scorecardRow = await queryOne<{ id: string; items: string }>(
      `SELECT sc.id, jsonb_agg(si ORDER BY si.sort_order) AS items
       FROM call_scores cs
       JOIN scorecards sc ON sc.id = cs.scorecard_id
       JOIN scorecard_items si ON si.scorecard_id = sc.id
       WHERE cs.call_id = $1
       GROUP BY sc.id
       LIMIT 1`,
      [call.id]
    );

    if (!scorecardRow) {
      console.log(`  Skipping ${call.id} — no scorecard found`);
      continue;
    }

    const scorecard: ScorecardRow = {
      id: scorecardRow.id,
      items: typeof scorecardRow.items === 'string'
        ? JSON.parse(scorecardRow.items)
        : scorecardRow.items as unknown as ScorecardItem[],
    };

    const label = `${call.agent_name ?? 'unknown'} ${(call.call_date ?? call.created_at)?.slice(0, 10) ?? ''}`.trim();
    process.stdout.write(`  ${String(index + 1).padStart(2)}. ${label} (${call.id.slice(0, 8)})…`);

    const [haikuResult, sonnetResult] = await Promise.all([
      runModelOnCall(HAIKU_MODEL,  call, scorecard),
      runModelOnCall(SONNET_MODEL, call, scorecard),
    ]);

    const agreement = haikuResult !== null && sonnetResult !== null
      ? haikuResult.pass === sonnetResult.pass
      : null;

    process.stdout.write(` Haiku=${haikuResult?.pass ? 'PASS' : 'FAIL'} Sonnet=${sonnetResult?.pass ? 'PASS' : 'FAIL'} ${agreement === null ? '?' : agreement ? '✓' : '✗'}\n`);

    results.push({
      call_id:          call.id,
      call_date:        call.call_date ?? call.created_at,
      agent_name:       call.agent_name,
      customer_phone:   call.customer_phone,
      external_id:      call.external_id,
      production_pass:  call.pass,
      production_score: call.overall_score,
      haiku_pass:       haikuResult?.pass ?? null,
      haiku_score:      haikuResult?.score ?? null,
      sonnet_pass:      sonnetResult?.pass ?? null,
      sonnet_score:     sonnetResult?.score ?? null,
      agreement,
      haiku_tokens:     (haikuResult?.inputTokens ?? 0) + (haikuResult?.outputTokens ?? 0),
      sonnet_tokens:    (sonnetResult?.inputTokens ?? 0) + (sonnetResult?.outputTokens ?? 0),
      haiku_cost_usd:   tokenCost(haikuResult?.inputTokens ?? 0, CLAUDE_PRICING[HAIKU_MODEL].input_per_1m) + tokenCost(haikuResult?.outputTokens ?? 0, CLAUDE_PRICING[HAIKU_MODEL].output_per_1m),
      sonnet_cost_usd:  tokenCost(sonnetResult?.inputTokens ?? 0, CLAUDE_PRICING[SONNET_MODEL].input_per_1m) + tokenCost(sonnetResult?.outputTokens ?? 0, CLAUDE_PRICING[SONNET_MODEL].output_per_1m),
    });
  }

  // Summary
  const compared    = results.filter((r) => r.agreement !== null);
  const agreed      = compared.filter((r) => r.agreement === true).length;
  const agreementPct = compared.length > 0 ? agreed / compared.length : 0;

  const totalHaikuCost  = results.reduce((a, r) => a + r.haiku_cost_usd, 0);
  const totalSonnetCost = results.reduce((a, r) => a + r.sonnet_cost_usd, 0);
  const savingPct = totalSonnetCost > 0 ? (1 - totalHaikuCost / totalSonnetCost) * 100 : 0;

  console.log('\n═══════════════════════════════════════════');
  console.log('EVALUATION SUMMARY');
  console.log('═══════════════════════════════════════════');
  console.log(`Calls evaluated:   ${results.length}`);
  console.log(`Pairs compared:    ${compared.length}`);
  console.log(`Agreement:         ${(agreementPct * 100).toFixed(1)}% (threshold: ${AGREEMENT_THRESHOLD * 100}%)`);
  console.log(`Haiku cost:        $${totalHaikuCost.toFixed(4)}`);
  console.log(`Sonnet cost:       $${totalSonnetCost.toFixed(4)}`);
  console.log(`Cost saving (est): ${savingPct.toFixed(1)}%`);
  console.log('');

  if (agreementPct >= AGREEMENT_THRESHOLD) {
    console.log(`✅ RECOMMENDATION: Switch to ${HAIKU_MODEL}`);
    console.log(`   Agreement ${(agreementPct * 100).toFixed(1)}% >= ${AGREEMENT_THRESHOLD * 100}% threshold`);
    console.log(`   Estimated saving: ${savingPct.toFixed(0)}% per call`);
  } else {
    console.log(`❌ KEEP: ${SONNET_MODEL}`);
    console.log(`   Agreement ${(agreementPct * 100).toFixed(1)}% < ${AGREEMENT_THRESHOLD * 100}% threshold`);
  }

  // Write JSON report
  const report = {
    evaluated_at: new Date().toISOString(),
    call_count: results.length,
    agreement_pct: parseFloat((agreementPct * 100).toFixed(2)),
    threshold_pct: AGREEMENT_THRESHOLD * 100,
    recommendation: agreementPct >= AGREEMENT_THRESHOLD ? `switch_to_${HAIKU_MODEL}` : `keep_${SONNET_MODEL}`,
    total_haiku_cost_usd: parseFloat(totalHaikuCost.toFixed(4)),
    total_sonnet_cost_usd: parseFloat(totalSonnetCost.toFixed(4)),
    cost_saving_pct: parseFloat(savingPct.toFixed(2)),
    results,
  };

  await fs.writeFile('evaluation-report.json', JSON.stringify(report, null, 2));
  console.log('\nFull report written to: evaluation-report.json');

  process.exit(0);
}

run().catch((err) => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
