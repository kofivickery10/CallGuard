// Stop scoring trust checkpoints against products that cannot be placed in
// trust, and stop failing mandatory disclosures over paraphrase.
//
// DRY RUN BY DEFAULT. Nothing is written without --commit.
//
// ── WHY (1): the trust items ───────────────────────────────────────────────
//
// scorecard_items.applies_to_products is NULL on all three trust checkpoints, so
// they score against every product a tenant sells. Trust is a life-policy
// mechanism: a hospital-cash or income-protection plan cannot be placed in one,
// and asking whether the adviser arranged a trustee for one is a question with
// no answer.
//
// Measured on Trust Point — 29 sales are on a product that cannot go in trust,
// and all three checkpoints scored on every one of them: 87 checkpoint scores,
// 10 of them recorded FAILURES. Those ten are breaches on an adviser's record
// for not placing an accident plan into trust. The other ~75 are free passes
// inflating the sale's score.
//
// The reviewer had already worked this out and said so, nine times, in the only
// field available to them:
//   "No trust so n/a" · "Metlife product - no trust"
//   "Metlife product not eligible to be put into trust so didn't"
//
// ── WHY (2): the disclosure wording ───────────────────────────────────────
//
// 'Stated Trust Point is authorised and regulated by the FCA' carries an
// ai_check demanding the wording not "materially deviate from the approved
// word-for-word script". Two things make that unfair on this tenant's audio:
// advisers paraphrase, and 8 kHz mono telephony mangles exactly this phrase —
// the transcription keyterm list boosts "authorised and regulated" precisely
// because it was coming back as "all fine and regulated". Judging deviation on a
// transcript that introduced the deviation fails the adviser for Deepgram's
// error.
//
// 'Confirmed fully advised, whole-of-market, no fee' carries the SAME check,
// verbatim — and so do seven other checkpoints. It is one pasted template across
// all nine word-for-word items, not wording authored per checkpoint. On a
// three-part disclosure it gives the model no guidance that the parts may be
// spread across calls, and the model duly reports the whole thing as never given
// when part of it is present in paraphrase. Verified on two sales where the
// reviewer was right and the model was wrong.
//
// Only these two are rewritten here, because only these two have a measured
// false-fail rate (40% and 33% of their failures overturned). The other seven
// carry the same template and have not misfired yet: worth a deliberate review,
// not a speculative rewrite from this script.
//   Gave the call-recording disclosure · Informed customer of the services the
//   company provides · Told customer the key facts document will be sent ·
//   Explained data sharing and asked 'is that alright?' · Gave the recommendation
//   and checked 'have I got that right' · Gave the honesty/accuracy and
//   non-disclosure warning · Explained exclusions and 30-day cancellation rights
//
// ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
//
// Re-score. Setting applies_to_products changes what FUTURE runs classify as na;
// the 87 existing scores stand until the affected sales are re-scored, which is
// a separate, CRM-pushing decision.
//
// THE PRODUCT SPLIT BELOW IS A JUDGEMENT AND NEEDS THE FIRM'S SIGN-OFF. It is
// written as an explicit list rather than a rule so it can be read, argued with
// and edited. The clear-cut half comes from the reviewer's own comments
// (MetLife, and where no Direct Debit was taken); the rest follows the general
// principle that trust applies to policies paying out on death.
//
// Usage:
//   tsx src/scripts/fix-trust-item-scope.ts "Trust Point"
//   tsx src/scripts/fix-trust-item-scope.ts "Trust Point" --commit
import { pool, query, queryOne } from '../db/client.js';

/**
 * The first argument that is not a flag.
 *
 * argv[2] is not that. Running this script with only --commit made "--commit"
 * the organisation name, which fails safe (nothing matches, nothing is written)
 * but reads as though the tenant is missing rather than the argument.
 */
function firstPositional(): string | undefined {
  return process.argv.slice(2).find((a) => !a.startsWith('--'));
}


// Products whose benefit is payable on death, and so can be written in trust.
const TRUSTABLE = [
  'Level Term Life Insurance',
  'Decreasing Term Life Insurance',
  'Increasing Term Life Insurance',
  'Whole of Life',
  'Life/CIC',
  'Standalone CIC',
  'Guaranteed Over 50s',
  'Relevant Life',
  'Key Person Protection',
  'Shareholders Protection',
];

// Recorded for the reader, and to make the split total: every product must be on
// one list or the other, so a new product cannot be silently absent from both.
const NOT_TRUSTABLE = [
  'Metlife - Everyday Protect', // accident/hospital cash, unit-based
  'Metlife - Childshield',
  'Metlife - Mortgage Safe',
  'Income Protection', // pays the policyholder while living
  'Private Medical Insurance',
  'Buildings & Contents Insurance',
  'Friendly Shield', // Shepherds Friendly sickness plan — CONFIRM WITH THE FIRM
];

const TRUST_ITEMS = [
  'Explained placing the policy in Trust',
  'Arranged to contact the nominated trustee',
  'Mentioned policy can be placed in Trust free of charge',
];

// Replacement ai_check wording. Keyed on the item label.
const AI_CHECKS: Record<string, string> = {
  'Stated Trust Point is authorised and regulated by the FCA':
    'Pass when the adviser conveys that the firm is authorised and regulated by the FCA, in any wording. ' +
    'Do NOT fail for paraphrase, word order, or a partial rendering: this call audio is 8 kHz mono telephony ' +
    'and this phrase is routinely mis-transcribed (observed: "all fine and regulated"), so a garbled but ' +
    'recognisable rendering is evidence the statement was made, not evidence it was not. ' +
    'Fail only where no statement about FCA authorisation or regulation appears anywhere in the call set.',
  'Confirmed fully advised, whole-of-market, no fee':
    'Three separate elements: (1) the service is fully advised, (2) it covers the whole of market, ' +
    '(3) there is no fee to the customer. They may be given in any wording, in any order, and ' +
    'SPREAD ACROSS DIFFERENT CALLS in the set — check all of them before concluding an element is absent. ' +
    'Accept paraphrase ("we look at every insurer", "it costs you nothing, we\'re paid by the provider"). ' +
    'Where some elements are present and others are not, fail and say WHICH are missing, rather than ' +
    'reporting the whole disclosure as never given.',
};

async function main(): Promise<void> {
  const orgArg = firstPositional() ?? 'Trust Point';
  const commit = process.argv.includes('--commit');

  const org = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE name ILIKE $1 LIMIT 1`,
    [`%${orgArg}%`]
  );
  if (!org) {
    console.log(`No organization matching "${orgArg}"`);
    return;
  }
  console.log(`\n${org.name}${commit ? '' : '   (dry run — pass --commit to write)'}\n`);

  const products = await query<{ id: string; name: string }>(
    `SELECT id, name FROM products WHERE organization_id = $1 ORDER BY name`,
    [org.id]
  );

  // Every product must be classified. An unlisted one would silently inherit
  // "trustable" (an allowlist that omits it excludes it), which is the wrong
  // default for a checkpoint that raises breaches.
  const known = new Set([...TRUSTABLE, ...NOT_TRUSTABLE]);
  const unclassified = products.filter((p) => !known.has(p.name));
  if (unclassified.length > 0) {
    console.log('REFUSING: these products are on neither list — classify them first:');
    for (const p of unclassified) console.log(`  ${p.name}`);
    console.log('');
    process.exitCode = 1;
    return;
  }

  const trustableIds = products.filter((p) => TRUSTABLE.includes(p.name)).map((p) => p.id);
  console.log(`Trustable products: ${trustableIds.length} of ${products.length}`);
  console.log(`  excluded: ${products.filter((p) => !TRUSTABLE.includes(p.name)).map((p) => p.name).join(', ')}\n`);

  console.log('1. TRUST CHECKPOINT SCOPE\n');
  for (const label of TRUST_ITEMS) {
    const item = await queryOne<{ id: string; applies_to_products: string[] | null }>(
      `SELECT si.id, si.applies_to_products
         FROM scorecard_items si JOIN scorecards sc ON sc.id = si.scorecard_id
        WHERE sc.organization_id = $1 AND si.label = $2 AND si.archived_at IS NULL`,
      [org.id, label]
    );
    if (!item) {
      console.log(`  SKIP  "${label}" — not on this tenant's scorecard`);
      continue;
    }
    const before = item.applies_to_products;
    if (before && before.length > 0) {
      console.log(`  SKIP  "${label}" — already scoped to ${before.length} product(s)`);
      continue;
    }
    // How many already-scored checkpoints this would have made na.
    const affected = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM journey_item_scores s
         JOIN journeys j ON j.id = s.journey_id
        WHERE j.organization_id = $1 AND s.scorecard_item_id = $2
          AND s.result IN ('pass','fail')
          AND NOT EXISTS (
            SELECT 1 FROM journey_products jp
             WHERE jp.journey_id = j.id AND jp.product_id = ANY($3::uuid[])
          )
          AND EXISTS (SELECT 1 FROM journey_products jp WHERE jp.journey_id = j.id)`,
      [org.id, item.id, trustableIds]
    );
    console.log(`  SET   "${label}" -> ${trustableIds.length} products  (${affected?.n ?? '0'} existing score(s) would become na on re-score)`);
    if (commit) {
      await query('UPDATE scorecard_items SET applies_to_products = $2 WHERE id = $1', [
        item.id,
        trustableIds,
      ]);
    }
  }

  console.log('\n2. DISCLOSURE CHECKPOINT WORDING\n');
  for (const [label, check] of Object.entries(AI_CHECKS)) {
    const item = await queryOne<{ id: string; ai_check: string | null }>(
      `SELECT si.id, si.ai_check
         FROM scorecard_items si JOIN scorecards sc ON sc.id = si.scorecard_id
        WHERE sc.organization_id = $1 AND si.label = $2 AND si.archived_at IS NULL`,
      [org.id, label]
    );
    if (!item) {
      console.log(`  SKIP  "${label}" — not on this tenant's scorecard`);
      continue;
    }
    console.log(`  SET   "${label}"`);
    console.log(`        was: ${item.ai_check ?? '(none)'}`);
    console.log(`        now: ${check.slice(0, 110)}...`);
    if (commit) {
      await query('UPDATE scorecard_items SET ai_check = $2 WHERE id = $1', [item.id, check]);
    }
  }

  console.log(
    commit
      ? '\nWritten. Existing scores are unchanged — re-score the affected sales to apply.\n'
      : '\nDry run. Re-run with --commit to write.\n'
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
