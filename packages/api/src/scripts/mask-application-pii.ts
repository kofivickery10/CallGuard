// Mask customer PII already stored on the application side of reconciliation.
//
// DRY RUN BY DEFAULT. Nothing is written without --commit.
//
// reconcile.ts now masks these on the way in. This is for the rows written before
// it did: a customer's home address, full name, email or phone sitting in
// capture_reconciliation_items.application_answer in the clear, in categories the
// tenant's own DPIA does not permit.
//
// The asymmetry is the point. The SAME ROW holds '[LOCATION_ADDRESS_1]' on the
// call side, because Deepgram was told to strip it, and the full postal address
// on the application side, because nothing told the document reader to. Measured
// on the first deploying firm: 78 items across 24 sales.
//
// WHY THIS IS NOT A RE-RUN
//
// Re-running the reconciliation would mask them, and it would also re-read the
// documents, re-spend on the model where extraction_method='model', and rebuild
// every outcome on the sale. This changes one column, in place, and nothing else.
// The outcomes are untouched: masking cannot change a comparison whose call side
// was already redacted away, which is every one of these.
//
// It is also idempotent — a value already masked matches no PII pattern and is
// left alone — so it is safe to run again after the next batch of sales.
//
// Usage:
//   tsx src/scripts/mask-application-pii.ts "Trust Point"
//   tsx src/scripts/mask-application-pii.ts "Trust Point" --commit
import { pool, query, queryOne } from '../db/client.js';
import { maskApplicationAnswer } from '../services/application-redaction.js';

interface Row {
  id: string;
  question: string;
  application_answer: string | null;
  revisions: Array<{ value: string | null; timestamp: string | null; recordedBy: string | null }>;
}

async function main(): Promise<void> {
  const orgArg = process.argv[2] ?? 'Trust Point';
  const commit = process.argv.includes('--commit');

  const org = await queryOne<{
    id: string;
    name: string;
    pii_unredacted_categories: string[] | null;
  }>(
    `SELECT id, name, pii_unredacted_categories FROM organizations WHERE name ILIKE $1 LIMIT 1`,
    [`%${orgArg}%`]
  );
  if (!org) {
    console.log(`No organization matching "${orgArg}"`);
    return;
  }
  const readable = org.pii_unredacted_categories ?? [];
  console.log(`\n${org.name}${commit ? '' : '   (dry run — pass --commit to write)'}`);
  console.log(`Kept in the clear by DPIA: ${readable.length ? readable.join(', ') : '(nothing)'}\n`);

  const rows = await query<Row>(
    `SELECT i.id, i.question, i.application_answer, i.revisions
       FROM capture_reconciliation_items i
       JOIN capture_reconciliation_runs r ON r.id = i.run_id
      WHERE r.organization_id = $1
      ORDER BY i.question`,
    [org.id]
  );

  const byQuestion = new Map<string, number>();
  let revisionValues = 0;
  let changed = 0;

  for (const row of rows) {
    const maskedAnswer = maskApplicationAnswer(row.question, row.application_answer, readable);
    const revisions = (row.revisions ?? []).map((r) => ({
      ...r,
      value: maskApplicationAnswer(row.question, r.value, readable),
    }));
    const answerChanged = maskedAnswer !== row.application_answer;
    const revsChanged = revisions.some((r, i) => r.value !== (row.revisions ?? [])[i]?.value);
    if (!answerChanged && !revsChanged) continue;

    changed++;
    if (answerChanged) byQuestion.set(row.question, (byQuestion.get(row.question) ?? 0) + 1);
    if (revsChanged) revisionValues += revisions.filter((r, i) => r.value !== (row.revisions ?? [])[i]?.value).length;

    if (commit) {
      await query(
        'UPDATE capture_reconciliation_items SET application_answer = $2, revisions = $3 WHERE id = $1',
        [row.id, maskedAnswer, JSON.stringify(revisions)]
      );
    }
  }

  console.log(`${rows.length} item(s) examined, ${changed} carrying a value to mask:\n`);
  for (const [question, n] of [...byQuestion.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${question.length > 66 ? `${question.slice(0, 63)}...` : question}`);
  }
  if (revisionValues > 0) console.log(`\n  plus ${revisionValues} superseded value(s) in revision trails`);

  console.log(
    commit
      ? `\nMasked. Outcomes untouched — every one of these had its call side redacted already.\n`
      : `\nDry run. Re-run with --commit to write.\n`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
