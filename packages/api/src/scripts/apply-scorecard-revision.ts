// Apply a reviewed set of scorecard edits to a LIVE tenant's active scorecard:
// retire checkpoints, and reword the ones that were failing calls the firm is
// happy with.
//
// Why a script and not the editor: a revision like this is agreed in writing
// with the client, touches a dozen checkpoints at once, and has to be replayable
// and reviewable afterwards. The revision below is data in this file, so what
// was changed and why is in version control next to the CSV it mirrors, and the
// dry run proves the live card matches what the revision was written against
// before anything is touched.
//
// Behaviour that matters:
//   - Retiring ARCHIVES (archived_at = now()), never deletes: past
//     call/journey item scores keep their referent, the change is reversible
//     with UPDATE scorecard_items SET archived_at = NULL, and the FK from
//     journey_item_scores (no ON DELETE) cannot be violated. Archived items
//     drop out of scoring, the editor, the review queue and the denominator.
//   - Matching is on the EXACT current label. Anything the revision names that
//     is not on the live card (or is on it twice) aborts the commit rather than
//     guessing — a live card that has drifted from the CSV is a thing to look
//     at, not to overwrite.
//   - One version bump per scorecard, mirroring the editor, so scores already
//     taken stay pinned to the version they were judged against.
//   - Sales already scored keep their existing scores and breaches until they
//     are re-scored: tsx src/scripts/rescore-tenant-journeys.ts <org> --all --commit
//
// Usage:
//   tsx src/scripts/apply-scorecard-revision.ts <orgId|nameSubstring> [--revision=<key>] [--commit]
//
// Connects to whatever DATABASE_URL points at (usually production) — treat as a
// production tool. Dry run is the default.
import { pool, query, queryOne, withTransaction } from '../db/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Retire {
  label: string;
  why: string;
}

interface Reword {
  // The label as it stands on the live card today.
  label: string;
  new_label?: string;
  new_description?: string;
  // Extra scoring guidance, sent to the model separately from the description
  // (scorecard_items.expectation). Usually "this also counts".
  new_expectation?: string;
  // The grouping heading the client reads in the app. Display only —
  // services/scoring.ts never sends `section` to the model — so renaming one
  // changes what the firm reads, not how anything is judged.
  new_section?: string;
  why: string;
}

interface Revision {
  key: string;
  tenant_hint: string;
  agreed: string;
  // Mirrors this file, so a re-import cannot undo the revision.
  csv: string;
  retire: Retire[];
  reword: Reword[];
}

/**
 * What "clear affirmative consent" means, written once and shared by every
 * consent gate that carries it.
 *
 * One constant rather than six copies on purpose: these six checkpoints are the
 * same control applied at six moments in the sale, and the half that matters
 * most is the second half — what must STILL fail. Six copies of that sentence
 * would drift, and the drift would be invisible until a gate quietly stopped
 * catching something the others still caught.
 */
const AFFIRMATIVE_CONSENT_EXPECTATION =
  'Any unambiguous agreement counts: "yes", "yeah", "yep", "sure", "correct", ' +
  '"that\'s fine", "that\'s right", "go ahead", "absolutely", "no problem" and ' +
  'equivalents are all passes. The test is whether the customer clearly agreed, not ' +
  'which word they used. Still fail where there is no agreement to read: silence, an ' +
  'ambiguous or hedged reply, the adviser answering on the customer\'s behalf, a ' +
  'question met with another question, or consent taken from the call simply ' +
  'carrying on.';

/**
 * How documents may be delivered, for the one gate that names a channel.
 *
 * Trust Point offer email, and send by post when the customer would rather have
 * that. Both are the adviser doing the job right, so the checkpoint has to score
 * the OUTCOME — was a method put to the customer and did they agree to it —
 * rather than the channel. Mirrors the wording already used on "Told customer
 * the key facts document will be sent to them" (revision trustpoint-2026-08).
 */
const DOCUMENT_DELIVERY_EXPECTATION =
  'Any delivery route counts — email, post, or a portal. Email offered and agreed ' +
  'passes; email offered, declined, and post agreed instead passes just as well. ' +
  'The channel is not the test. Fail only where no delivery method was put to the ' +
  'customer at all, or where none was agreed. ' +
  AFFIRMATIVE_CONSENT_EXPECTATION;

// ── Revisions ────────────────────────────────────────────────────────────────
// Numbers in the rationale are POSITIONS ON THE LIVE CARD at the time the change
// was agreed — what the client reads off the app and quotes back ("take out point
// 3"). They are NOT the source spreadsheet's numbering, and they stop matching
// positions as soon as an item is retired: the dry run prints the live card
// numbered so the mapping can be checked against the client's own email before
// anything is committed.
const REVISIONS: Revision[] = [
  {
    key: 'trustpoint-2026-08',
    tenant_hint: 'Trust Point',
    agreed: 'Trust Point QA review, 2026-08-03 — stop failing sales on checkpoints that did not apply',
    csv: 'sample_scorecards/trustpoint/trustpoint-protection.csv',
    retire: [
      {
        label: 'Explained the reason for the call',
        why: 'Live 3 — overlaps 4, which asks the same question in more detail.',
      },
      {
        label: 'Allowed the customer to answer every H&L question',
        why: 'Live 25 — Health & Lifestyle coverage deferred; also worded so one interruption is a literal fail.',
      },
      {
        label: 'Did NOT lead the customer in their H&L answers',
        why: 'Live 26 — Health & Lifestyle coverage deferred. No H&L checkpoint remains on the card.',
      },
      {
        label: 'Explained add-ons and key policy features',
        why: 'Live 32 — not every policy has add-ons and no rule says which do, so it failed sales with nothing to explain.',
      },
      {
        label: "Checked 'is that all clear?' on add-ons / key features",
        why: 'Live 33 — as 32; a consent gate on something the policy may not have.',
      },
    ],
    reword: [
      {
        label: 'Explained the call is to understand the situation and suitable cover',
        new_expectation:
          'Counts wherever in the call this is covered. There is no requirement for it to come early: ' +
          'the opening stage can run for several minutes, and covering it at the end of that is a ' +
          'pass. Judge only whether it was covered.',
        why: 'Live 4 — the "Intro" section name is a grouping label, not a timing rule; their intro can run ten minutes.',
      },
      {
        label: 'Told customer key facts and services sent by email',
        new_label: 'Told customer the key facts document will be sent to them',
        new_description:
          'Did the adviser say that if a policy is arranged, the key facts document and details of the ' +
          'service will be sent to the customer?',
        new_expectation:
          'Any delivery route counts — email, post, or a portal — and so does telling the customer the ' +
          'documents will be sent to them without naming a route. Do not fail this because email was ' +
          'not specified.',
        why: 'Live 10 — telling the client the key facts are coming is sufficient; naming email is not.',
      },
      {
        label: 'Recapped the recommendation after the H&L application',
        new_label: 'Recapped the recommendation as the sale was closed',
        new_description:
          'Did the adviser recap the recommendation (product, insurer, what it covers) at the point the ' +
          'sale was being closed?',
        new_expectation:
          'The recap must appear as the sale is being closed — after the application details were taken ' +
          'and before the adviser moves on to payment, documents and final confirmation. It does not ' +
          'have to follow the Health & Lifestyle questions, and a sale with no Health & Lifestyle ' +
          'section is not failed on that basis.',
        why: 'Live 28 — was failing sales that needed no Health & Lifestyle section.',
      },
      {
        label: 'Clearly stated the application outcome',
        new_label: 'Stated the outcome of the application',
        new_description:
          'Did the adviser tell the customer the outcome of the application — accepted on standard ' +
          'terms, accepted on amended or rated terms, or referred for underwriting?',
        new_expectation:
          'Standard terms includes any immediate acceptance, such as a product with no medical ' +
          'underwriting where cover simply starts. Where the application had no underwriting outcome ' +
          'to give, the adviser confirming the cover is in place and when it starts is the outcome. ' +
          'Fail only where the customer was left not knowing where the application stands.',
        why: 'Live 30 — a product with no medical underwriting has no separate "outcome" to state. Also drops "clearly", a threshold word with no threshold.',
      },
      {
        label: 'Explained the outcome correctly for the path taken',
        new_expectation:
          'Where the product carried no underwriting decision, confirming acceptance and the start ' +
          'date satisfies the on-risk path — there are no amended or rated terms to explain.',
        why: 'Live 31 — the twin of 30, and it needs the same immediate-acceptance allowance.',
      },
    ],
  },
  {
    key: 'trustpoint-2026-08-affirmative-consent',
    tenant_hint: 'Trust Point',
    agreed:
      'Trust Point feedback, Joey Crone, 2026-08-26 — "Can we change all of the wording on the ' +
      'sections that look for a firm yes to clear affirmative consent - I\'m happy with Yes, or yep ' +
      'or sure or whatever. Doesn\'t specifically have to be YES."',
    csv: 'sample_scorecards/trustpoint/trustpoint-protection.csv',
    retire: [],
    // Every consent_gate on the live card is here, and that set is exactly the set
    // whose wording invoked a literal "yes" — three in the label ("a clear 'yes'",
    // "a firm yes") and the rest through the section heading "(hard yes)". Rewording
    // only the one that happened to say "firm" would leave the same fault in five
    // other places, which is what "all of the wording" was asking about.
    //
    // The widening lives in each item's expectation rather than in the shared
    // consent-gate line in services/scoring.ts, which is sent for EVERY consent gate
    // on every tenant. That line already asks for "an explicit, affirmative response"
    // and never required the literal word — the literalness came from these labels
    // being passed through verbatim as `Label:`. Fixing it here keeps the blast
    // radius to the firm that asked, and keeps the guidance readable next to the
    // checkpoint it governs.
    reword: [
      {
        label: "Obtained a clear 'yes' to information sharing",
        new_label: 'Obtained clear affirmative consent to information sharing',
        new_section: 'Consent (clear affirmative)',
        new_expectation: AFFIRMATIVE_CONSENT_EXPECTATION,
        why: 'Label quoted \'yes\' directly — the most literal of the six.',
      },
      {
        label: "Obtained a clear 'yes' to the recommendation",
        new_label: 'Obtained clear affirmative consent to the recommendation',
        new_section: 'Consent (clear affirmative)',
        new_expectation: AFFIRMATIVE_CONSENT_EXPECTATION,
        why: 'As above. This is the consent gate on the recommendation itself, so a false fail here is the costliest of the set.',
      },
      {
        label: 'Confirmed the recap still matches what the client wanted',
        new_section: 'Consent (clear affirmative)',
        new_expectation: AFFIRMATIVE_CONSENT_EXPECTATION,
        why: 'Label is already neutral; the "(hard yes)" section heading and the missing guidance were doing the narrowing.',
      },
      {
        label: 'Confirmed happy with cover, premium and everything applied for',
        new_section: 'Consent (clear affirmative)',
        new_expectation: AFFIRMATIVE_CONSENT_EXPECTATION,
        why: 'As above.',
      },
      {
        label: 'Confirmed documents by email and got a firm yes',
        new_label: 'Confirmed documents by email and got clear affirmative consent',
        new_expectation: AFFIRMATIVE_CONSENT_EXPECTATION,
        why: 'The item quoted verbatim in the feedback. Its section ("Documents") needs no change.',
      },
      {
        label: 'Confirmed the client is happy with the service',
        new_section: 'Final close (clear affirmative)',
        new_expectation: AFFIRMATIVE_CONSENT_EXPECTATION,
        why: 'Label already neutral; renamed the section for the same reason as the others.',
      },
    ],
  },
  {
    key: 'trustpoint-2026-08-documents-and-rubrics',
    tenant_hint: 'Trust Point',
    agreed:
      'Trust Point feedback, Joey Crone, 2026-08-26 — "In practice, we tell people that their docs ' +
      'will come via email, and ask if this is ok. If they say no, we send them via post, and this ' +
      'is fine. But at the moment, the AI is failing people for this route because it\'s looking for ' +
      'consent to email only." Carries the same conversation\'s "clear affirmative consent" point ' +
      'into the rubrics, which the previous revision left untouched.',
    csv: 'sample_scorecards/trustpoint/trustpoint-protection.csv',
    retire: [],
    // TWO CHANGES, one conversation.
    //
    // 1. THE RUBRICS. Revision trustpoint-2026-08-affirmative-consent reworded the
    //    labels, sections and expectations of all six consent gates and left the
    //    descriptions alone — but services/scoring.ts sends `description` to the
    //    model as `Rubric:`, so every gate was still being told to look for "an
    //    explicit 'yes'" while its expectation said any clear agreement counts.
    //    Contradictory instructions in the same prompt. All six are corrected here.
    //
    // 2. THE POSTAL ROUTE. "Confirmed documents by email" named a channel, so an
    //    adviser who offered email, was turned down, and posted the documents —
    //    the correct behaviour — failed a consent gate for it.
    reword: [
      {
        label: 'Obtained clear affirmative consent to information sharing',
        new_description:
          'Did the customer clearly agree to the information-sharing statement before the ' +
          'adviser proceeded?',
        why: 'Rubric still said "an explicit \'yes\'", contradicting the expectation set in the previous revision.',
      },
      {
        label: 'Obtained clear affirmative consent to the recommendation',
        new_description:
          'Did the customer clearly agree to the recommendation before the adviser continued?',
        why: 'As above.',
      },
      {
        label: 'Confirmed the recap still matches what the client wanted',
        new_description:
          'Did the adviser check the recap still matches what the client wanted to achieve, and ' +
          'did the client clearly agree?',
        why: 'Rubric still ended "with a firm \'yes\'?".',
      },
      {
        label: 'Confirmed happy with cover, premium and everything applied for',
        new_description:
          'Did the adviser check the client is happy with the cover, the premium and everything ' +
          'applied for, and did the client clearly agree?',
        why: 'As above.',
      },
      {
        label: 'Confirmed the client is happy with the service',
        new_description:
          'Did the adviser check the client is happy with the service and the policy arranged ' +
          'today, and did the client clearly agree?',
        why: 'As above.',
      },
      {
        label: 'Confirmed documents by email and got clear affirmative consent',
        new_label: 'Confirmed how documents will be sent and got clear affirmative consent',
        new_description:
          'Did the adviser tell the customer how their policy documents will be sent, and did ' +
          'the customer clearly agree to that method?',
        new_expectation: DOCUMENT_DELIVERY_EXPECTATION,
        why:
          'The reported bug: the checkpoint named email, so offering email, being declined, and ' +
          'posting instead — the firm\'s own documented process — failed a consent gate. Now ' +
          'scores the outcome (a method was offered and agreed) rather than the channel. Its ' +
          'rubric also still said "obtain a firm \'yes\'? Proceed only on a clear yes."',
      },
    ],
  },
];

async function resolveOrg(idOrName: string): Promise<{ id: string; name: string }> {
  if (UUID_RE.test(idOrName)) {
    const row = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [idOrName]
    );
    if (!row) throw new Error(`No organization with id ${idOrName}`);
    return row;
  }
  const rows = await query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE name ILIKE $1 ORDER BY name',
    [`%${idOrName}%`]
  );
  if (rows.length === 0) throw new Error(`No organization matching "${idOrName}"`);
  if (rows.length > 1) {
    throw new Error(
      `Ambiguous tenant "${idOrName}" — matches:\n` + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n')
    );
  }
  return rows[0]!;
}

interface ItemRow {
  id: string;
  label: string;
  description: string | null;
  expectation: string | null;
  section: string | null;
  sort_order: number;
  journey_scores: number;
  call_scores: number;
  pending_reviews: number;
  open_breaches: number;
}

async function main() {
  const args = process.argv.slice(2);
  const orgArg = args.find((a) => !a.startsWith('--'));
  const commit = args.includes('--commit');
  const revisionKey = args.find((a) => a.startsWith('--revision='))?.split('=')[1];

  if (!orgArg) {
    console.error(
      'Usage: tsx src/scripts/apply-scorecard-revision.ts <orgId|nameSubstring> [--revision=<key>] [--commit]\n' +
        `Revisions: ${REVISIONS.map((r) => r.key).join(', ')}`
    );
    process.exit(1);
  }

  const revision = revisionKey
    ? REVISIONS.find((r) => r.key === revisionKey)
    : REVISIONS.length === 1
      ? REVISIONS[0]
      : undefined;
  if (!revision) {
    throw new Error(
      `Pick a revision with --revision=<key>. Available: ${REVISIONS.map((r) => r.key).join(', ')}`
    );
  }

  const org = await resolveOrg(orgArg);
  console.log(`Tenant:   ${org.name} (${org.id})`);
  console.log(`Revision: ${revision.key} — ${revision.agreed}`);
  console.log(`Mirrors:  ${revision.csv}`);
  console.log(`Mode:     ${commit ? 'COMMIT' : 'DRY RUN'}\n`);

  const scorecard = await queryOne<{ id: string; name: string; version: number }>(
    `SELECT id, name, version FROM scorecards
      WHERE organization_id = $1 AND is_active = true
      ORDER BY updated_at DESC LIMIT 1`,
    [org.id]
  );
  if (!scorecard) throw new Error(`No active scorecard for ${org.name}`);

  const items = await query<ItemRow>(
    `SELECT si.id, si.label, si.description, si.expectation, si.section, si.sort_order,
            (SELECT COUNT(*) FROM journey_item_scores jis WHERE jis.scorecard_item_id = si.id)::int AS journey_scores,
            (SELECT COUNT(*) FROM call_item_scores cis WHERE cis.scorecard_item_id = si.id)::int AS call_scores,
            (SELECT COUNT(*) FROM journey_item_scores jis
              WHERE jis.scorecard_item_id = si.id AND jis.result = 'manual_review')::int
            + (SELECT COUNT(*) FROM call_item_scores cis
                WHERE cis.scorecard_item_id = si.id AND cis.result = 'manual_review')::int AS pending_reviews,
            (SELECT COUNT(*) FROM breaches b
              WHERE b.scorecard_item_id = si.id AND b.status <> 'resolved')::int AS open_breaches
       FROM scorecard_items si
      WHERE si.scorecard_id = $1 AND si.archived_at IS NULL
      ORDER BY si.sort_order`,
    [scorecard.id]
  );

  console.log(`Live card: ${scorecard.name} (v${scorecard.version}), ${items.length} active checkpoint(s):`);
  for (const [i, it] of items.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${it.section ? `[${it.section}] ` : ''}${it.label}`);
  }
  console.log();

  // Resolve every label the revision names, before changing anything. A label
  // that matches nothing, or matches twice, means the live card is not the card
  // this revision was written against.
  const byLabel = new Map<string, ItemRow[]>();
  for (const it of items) {
    byLabel.set(it.label, [...(byLabel.get(it.label) ?? []), it]);
  }
  const problems: string[] = [];
  const resolve = (label: string, kind: string): ItemRow | null => {
    const found = byLabel.get(label) ?? [];
    if (found.length === 1) return found[0]!;
    problems.push(
      found.length === 0
        ? `${kind}: no active checkpoint with label "${label}"`
        : `${kind}: ${found.length} active checkpoints share the label "${label}"`
    );
    return null;
  };

  const toRetire = revision.retire
    .map((r) => ({ ...r, item: resolve(r.label, 'retire') }))
    .filter((r): r is Retire & { item: ItemRow } => r.item !== null);
  const toReword = revision.reword
    .map((r) => ({ ...r, item: resolve(r.label, 'reword') }))
    .filter((r): r is Reword & { item: ItemRow } => r.item !== null);

  console.log(`Retire (archive) — ${toRetire.length} of ${revision.retire.length}:`);
  let pendingReviews = 0;
  let openBreaches = 0;
  for (const r of toRetire) {
    const history = r.item.journey_scores + r.item.call_scores;
    pendingReviews += r.item.pending_reviews;
    openBreaches += r.item.open_breaches;
    console.log(`  - ${r.item.label}`);
    console.log(`      ${r.why}`);
    console.log(
      `      ${history} historical result(s) kept, ${r.item.pending_reviews} pending review(s), ${r.item.open_breaches} open breach(es)`
    );
  }

  console.log(`\nReword — ${toReword.length} of ${revision.reword.length}:`);
  for (const r of toReword) {
    console.log(`  - ${r.item.label}`);
    console.log(`      ${r.why}`);
    if (r.new_label) console.log(`      label:       ${r.item.label}\n                -> ${r.new_label}`);
    if (r.new_description) {
      console.log(`      description: ${r.item.description ?? '(none)'}\n                -> ${r.new_description}`);
    }
    if (r.new_section) {
      console.log(`      section:     ${r.item.section ?? '(none)'}\n                -> ${r.new_section}`);
    }
    if (r.new_expectation) {
      console.log(`      expectation: ${r.item.expectation ?? '(none)'}\n                -> ${r.new_expectation}`);
    }
  }

  if (problems.length > 0) {
    console.log(`\n⚠ ${problems.length} checkpoint(s) in this revision do not match the live card:`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log(
      '\nThe live card has drifted from the revision (edited by hand, re-imported, or already applied).\n' +
        'Reconcile it before committing — this script will not guess which checkpoint was meant.'
    );
    if (commit) {
      await pool.end();
      process.exit(2);
    }
  }

  if (pendingReviews > 0) {
    console.log(
      `\nNote: ${pendingReviews} pending manual-review row(s) sit on the retired checkpoints.\n` +
        '      They drop out of the review queue once archived (routes/review.ts filters archived items).'
    );
  }
  if (openBreaches > 0) {
    console.log(
      `\nNote: ${openBreaches} open breach(es) were raised by the retired checkpoints.\n` +
        '      Archiving does not clear them — they are findings that were made. Re-scoring the\n' +
        '      affected sales does (score-journey deletes and re-raises a sale\'s breaches):\n' +
        `      tsx src/scripts/rescore-tenant-journeys.ts ${org.id} --all --commit`
    );
  }

  if (!commit) {
    console.log('\nDry run only. Re-run with --commit to apply.');
    await pool.end();
    return;
  }

  await withTransaction(async (tx) => {
    if (toRetire.length > 0) {
      await tx.query('UPDATE scorecard_items SET archived_at = now() WHERE id = ANY($1::uuid[])', [
        toRetire.map((r) => r.item.id),
      ]);
    }
    for (const r of toReword) {
      // COALESCE on the parameter, so an omitted field leaves the stored value
      // alone rather than nulling it.
      await tx.query(
        `UPDATE scorecard_items SET
           label       = COALESCE($2, label),
           description = COALESCE($3, description),
           expectation = COALESCE($4, expectation),
           section     = COALESCE($5, section)
         WHERE id = $1`,
        [
          r.item.id,
          r.new_label ?? null,
          r.new_description ?? null,
          r.new_expectation ?? null,
          r.new_section ?? null,
        ]
      );
    }
    // One bump for the whole revision — it is a single agreed change, and every
    // score taken before it stays pinned to the version it was judged against.
    await tx.query('UPDATE scorecards SET version = version + 1, updated_at = now() WHERE id = $1', [
      scorecard.id,
    ]);
  });

  console.log(
    `\nDone. ${toRetire.length} checkpoint(s) archived, ${toReword.length} reworded, ` +
      `${scorecard.name} v${scorecard.version} -> v${scorecard.version + 1}.`
  );
  console.log(
    'Already-scored sales keep their current scores until re-scored:\n' +
      `  tsx src/scripts/rescore-tenant-journeys.ts ${org.id} --all --commit`
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
