// Repair mangled question wording in a stored document profile.
//
// DRY RUN BY DEFAULT. Nothing is written without --commit.
//
// WHAT IS ACTUALLY BROKEN
//
// Not the outcomes. Items take their question text from the fresh parse, and the
// parser produces clean text now, so nothing on screen today is wrong because of
// this. What is broken is the stored snapshot, and it matters twice:
//
//   1. It is what a human confirms on the Data Forms screen. "Have you : ever" is
//      not something anyone can sensibly approve, which is part of why profiles
//      sit unconfirmed.
//   2. Per-question rulings are keyed by question text. The moment the profile IS
//      confirmed, a mangled key can never be matched again — so a reviewer sets a
//      check mode on the tenant's suicide and self-harm questions, sees it saved,
//      and reconcile.ts silently falls back to the heuristic. On the observed
//      profile all four mangled questions are in the mental-health block.
//
// HOW THE REPAIR IS DERIVED
//
// Not typed by hand. The corruption is span re-ordering, so a mangled question
// carries the same words as the intact one — "In the have you had any of these?
// last 5 years" and "In the last 5 years have you had any of these?" are the same
// eleven words. The intact wording is recovered by matching word multisets
// against the questions this profile's own runs have already stored, and only
// where exactly one candidate matches (services/question-quality.ts).
//
// So the correction comes from the tenant's own data, is verifiable by reading
// the two strings, and refuses rather than guesses when the evidence is
// ambiguous.
//
// WHAT IT LEAVES ALONE
//
// question_fingerprint and format_signature. The signature identifies the
// document layout and is what matches a document to this profile; the fingerprint
// drives drift detection, which is skipped entirely on a profile with
// questions_vary = true (as the observed one has). Recomputing either from
// repaired text would risk un-matching documents that match today, to no benefit.
//
// Choices and guidance are untouched — they were captured correctly, and they
// carry the substance the comparison actually searches for.
//
// Usage:
//   tsx src/scripts/repair-profile-questions.ts "Trust Point"
//   tsx src/scripts/repair-profile-questions.ts "Trust Point" --commit
import { pool, query, queryOne } from '../db/client.js';
import { corruptionFlags, repairFromObserved } from '../services/question-quality.js';

interface ProfileRow {
  id: string;
  insurer: string;
  product: string | null;
  status: string;
  questions_vary: boolean;
  questions: Array<Record<string, unknown> & { question: string }>;
}

async function main(): Promise<void> {
  const orgArg = process.argv[2] ?? 'Trust Point';
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

  const profiles = await query<ProfileRow>(
    `SELECT id, insurer, product, status, questions_vary, questions
       FROM capture_document_profiles
      WHERE organization_id = $1 AND status <> 'superseded'
      ORDER BY insurer, product`,
    [org.id]
  );

  let repairedTotal = 0;
  let unrepairableTotal = 0;

  for (const profile of profiles) {
    const questions = profile.questions ?? [];
    const mangled = questions
      .map((q, index) => ({ index, question: q.question, flags: corruptionFlags(q.question) }))
      .filter((r) => r.flags.length > 0);
    if (mangled.length === 0) continue;

    const label = `${profile.insurer}${profile.product ? ` / ${profile.product}` : ''} [${profile.status}]`;
    console.log(`${label} — ${mangled.length} of ${questions.length} mangled`);

    // Questions this profile's own runs have stored, which come from fresh
    // parses and so show the wording the parser produces now.
    const observed = await query<{ question: string }>(
      `SELECT DISTINCT i.question
         FROM capture_reconciliation_items i
         JOIN capture_reconciliation_runs r ON r.id = i.run_id
        WHERE r.profile_id = $1`,
      [profile.id]
    );
    const observedText = observed.map((o) => o.question);

    const next = [...questions];
    let repaired = 0;
    for (const m of mangled) {
      const fixed = repairFromObserved(m.question, observedText);
      if (fixed === null) {
        unrepairableTotal++;
        console.log(
          `   LEAVE  #${m.index}  ${JSON.stringify(m.question)}` +
            `\n          (${m.flags.map((f) => f.name).join(', ')}) — no single intact match among ` +
            `${observedText.length} observed question(s)`
        );
        continue;
      }
      console.log(`   FIX    #${m.index}  ${JSON.stringify(m.question)}`);
      console.log(`                 -> ${JSON.stringify(fixed)}`);
      next[m.index] = { ...questions[m.index]!, question: fixed };
      repaired++;
      repairedTotal++;
    }

    if (repaired > 0 && commit) {
      await query('UPDATE capture_document_profiles SET questions = $2::jsonb, updated_at = now() WHERE id = $1', [
        profile.id,
        JSON.stringify(next),
      ]);
    }
    console.log('');
  }

  console.log(
    `${repairedTotal} question(s) ${commit ? 'repaired' : 'would be repaired'}, ` +
      `${unrepairableTotal} left for a person.\n`
  );
  if (unrepairableTotal > 0) {
    console.log(
      'A question left alone is one the evidence cannot repair — usually because\n' +
        'nothing intact has been observed for it yet. Those need the document, not a script.\n'
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
