// Clear a review queue of formats that cannot be confirmed, with the reason on
// each one.
//
// DRY RUN BY DEFAULT. Nothing is written without --commit.
//
// WHY A SCRIPT AND NOT TEN CLICKS
//
// A dismissal is a decision another admin will see the consequences of, so the
// UI asks for a reason. Ten of them, each needing the evidence behind it — which
// document it was really learned from, how many of the document's own fields it
// reads, what the sale is being read by instead — is not a form-filling job. The
// reasons are the point of this script; the UPDATE is incidental.
//
// Every row is matched on insurer, product AND question fingerprint before it is
// touched, so a stale id, a re-proposed format or the wrong tenant cannot be
// dismissed by accident: a mismatch is reported and skipped.
//
// Dismissal is REVERSIBLE — activateProfile accepts a dismissed row, which is
// the undo. What it is not is silent: the row keeps its reason and shows as
// dismissed on Data Forms.
//
// Usage:
//   tsx src/scripts/retire-unconfirmable-formats.ts
//   tsx src/scripts/retire-unconfirmable-formats.ts --commit
import { pool, query, queryOne } from '../db/client.js';

interface Decision {
  insurer: string;
  product: string;
  /** First 16 characters of question_fingerprint — enough to be specific. */
  fingerprint: string;
  reason: string;
}

// Trust Point Mortgage and Protection Services, reviewed 25 August 2026 against
// the document each format was actually learned from. See
// docs/trustpoint/question-sets-review-2026-08-25.md for the workings.
const ORG = 'Trust Point';

const DECISIONS: Decision[] = [
  {
    insurer: 'Aviva',
    product: 'Life Insurance+',
    fingerprint: '6dafcff1f62b4c58',
    reason:
      "Five of this format's eight questions are the document's page footer (\"Page 2 of 6\"), and the " +
      'real health and lifestyle questions were folded into the guidance underneath them. It is a failed ' +
      'parse of the right document rather than an Aviva format, and a proposal like it would be refused ' +
      'outright today. The application is being read directly by AI instead, which found 72 answers on ' +
      'the sale this was learned from.',
  },
  {
    insurer: 'Experian',
    product: 'Due Diligence Verification',
    fingerprint: '2d49ad04b8eeb573',
    reason:
      'This is the Experian identity and sanctions search, not an application form — its fields are ' +
      'SSID, Authentication Index, Royal Mail PAF confirmation and CRA, none of which the customer ' +
      'disclosed. It is filed on every sale and is deliberately ranked last for that reason. The sale it ' +
      'was learned from has no application attached at all, which is what needs chasing.',
  },
  {
    insurer: 'Legal & General',
    product: 'Life Insurance - Personal Quote',
    fingerprint: 'acb8c77bf1431e99',
    reason:
      'Learned from the pre-sale quote rather than from the application, which is attached to the same ' +
      'sale. Three fields, two of which run on into the paragraph after their value. That application was ' +
      'read directly by AI and produced 66 answers, so confirming this would replace 66 checks with 3.',
  },
  {
    insurer: 'Legal & General Assurance Society Limited',
    product: 'Life Insurance',
    fingerprint: '664a2ce2404ce24f',
    reason:
      'The right document — the full Protection Application Details — but the parse reads 4 of the 41 ' +
      'fields the document prints, because this form puts the value on the line AFTER the label and the ' +
      'label/value strategy needs a colon. The only four it reads are height and weight; every health ' +
      'question on the form would go unchecked on every future sale. The document is being read directly ' +
      'by AI instead, which found 40 answers on this sale.',
  },
  {
    insurer: 'MetLife',
    product: 'EverydayProtect',
    fingerprint: '01053bc784feb854',
    reason:
      'Its question set is identical to the MetLife EverydayProtect format already live, so there is ' +
      'nothing here to approve. Confirming it would retire the working format and re-check the whole ' +
      "tenant's history for no gain.",
  },
  {
    insurer: 'National Friendly',
    product: 'Simple cover',
    fingerprint: '55b2a680633fb948',
    reason:
      'Learned from the pre-sale quote, not from the Friendly Shield application form attached to the ' +
      'same sale. The same document was also proposed twice three seconds apart, as "Simple cover" and ' +
      '"Simple cover options", with an identical question set — this is one of that pair.',
  },
  {
    insurer: 'National Friendly',
    product: 'Simple cover options',
    fingerprint: '55b2a680633fb948',
    reason:
      'A duplicate of the "Simple cover" proposal — same sale, same document, same six questions, three ' +
      'seconds apart — and both were learned from the pre-sale quote rather than from the Friendly ' +
      'Shield application form attached to the same sale.',
  },
  {
    insurer: 'Royal London',
    product: 'Menu Plan Life Cover',
    fingerprint: 'b48f23a4dfac7fa4',
    reason:
      'An UnderwriteMe quote summary, not an application: the document itself says the prices are ' +
      'estimated and that the remaining underwriting questions have yet to be answered. All three ' +
      'candidate documents on that sale are copies of the same quote, so the submitted application has ' +
      'never been uploaded — that is what needs chasing, not a format.',
  },
  {
    insurer: 'Scottish Widows',
    product: 'Scottish Widows Protect',
    fingerprint: '0b84036ca8b8119f',
    reason:
      'The right document, but it reads only the 22 policy and contact fields. All 21 underwriting ' +
      'disclosures — job, height, weight, smoking, alcohol and the "Have you ever had:" blocks — are ' +
      'configured and none of them parse, because that section of the document prints no colons. A clean ' +
      'result on this format would be evidence about marketing preferences, not about health. The ' +
      'document is being read directly by AI instead, which found 45 answers.',
  },
  {
    insurer: 'Vitality',
    product: 'Life Cover',
    fingerprint: '22b7caee39e2aa09',
    reason:
      'An UnderwriteMe quote summary, proposed when it was the only document on the sale. The real ' +
      'application — the UnderwriteMe Protection Platform export — was uploaded afterwards, and there is ' +
      'already a live format for it, so the sale will be checked properly on its next sweep without any ' +
      'new format being confirmed.',
  },
];

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');

  const org = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE name ILIKE $1 LIMIT 1`,
    [`%${ORG}%`]
  );
  if (!org) {
    console.log(`No organization matching "${ORG}"`);
    return;
  }
  console.log(`\n${org.name}${commit ? '' : '   (dry run — pass --commit to write)'}\n`);

  let done = 0;
  let skipped = 0;

  for (const d of DECISIONS) {
    // All versions, then the pending one — insurer+product is NOT unique across
    // statuses. MetLife has a live v1 and a proposed v2 under the same name, and
    // taking whichever came back first would have reported the live format's
    // status and skipped the proposal it was meant to retire.
    const rows = await query<{ id: string; status: string; version: number; question_fingerprint: string }>(
      `SELECT id, status, version, question_fingerprint
         FROM capture_document_profiles
        WHERE organization_id = $1 AND insurer = $2 AND COALESCE(product, '') = $3
        ORDER BY version DESC`,
      [org.id, d.insurer, d.product]
    );

    const label = `${d.insurer} / ${d.product}`;
    if (rows.length === 0) {
      console.log(`SKIP  ${label} — no such profile on this tenant`);
      skipped++;
      continue;
    }
    const row = rows.find((r) => r.status === 'needs_confirmation');
    if (!row) {
      console.log(
        `SKIP  ${label} — nothing awaiting confirmation (found ` +
          `${rows.map((r) => `v${r.version} ${r.status}`).join(', ')})`
      );
      skipped++;
      continue;
    }
    if (!row.question_fingerprint.startsWith(d.fingerprint)) {
      console.log(
        `SKIP  ${label} — fingerprint is ${row.question_fingerprint.slice(0, 16)}, expected ` +
          `${d.fingerprint}. The format has changed since it was reviewed; review it again.`
      );
      skipped++;
      continue;
    }
    console.log(`${commit ? 'DISMISS' : 'WOULD DISMISS'}  ${label} (v${row.version})\n    ${d.reason}\n`);
    if (commit) {
      // dismissed_by stays null: this is a reviewed decision applied in bulk,
      // not one person clicking, and inventing an author for it would be a lie
      // in the audit trail.
      await query(
        `UPDATE capture_document_profiles
            SET status = 'dismissed', dismissed_at = now(), dismissed_reason = $2, updated_at = now()
          WHERE id = $1 AND status = 'needs_confirmation'`,
        [row.id, d.reason]
      );
    }
    done++;
  }

  const remaining = await queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM capture_document_profiles
      WHERE organization_id = $1 AND status = 'needs_confirmation'`,
    [org.id]
  );

  console.log(
    `${commit ? 'Dismissed' : 'Would dismiss'} ${done}, skipped ${skipped}. ` +
      `${commit ? 'Now' : 'Currently'} ${remaining?.n ?? '?'} awaiting confirmation.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
