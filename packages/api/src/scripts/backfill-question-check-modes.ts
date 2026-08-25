// Stamp the check mode onto stored profile questions that have none.
//
// DRY RUN BY DEFAULT. Nothing is written without --commit.
//
// WHAT IS WRONG
//
// A profile question carries check_mode: whether the answer is compared against
// the call, only checked for presence, or not checked at all. It has been stamped
// at proposal time since migration 094, deliberately, so that "what a human sees
// on the review page is what will actually be applied".
//
// Profiles proposed BEFORE that migration have no check_mode on any question,
// and the two halves of the system fill the gap differently:
//
//   DocumentProfileReview.tsx   q.check_mode ?? 'reconcile'
//   processors/reconcile.ts     ruling?.checkMode ?? defaultCheckMode(question)
//
// So the screen says "Check against the call" for every question, while the
// pipeline quietly asks the heuristic — which answers 'none' for an insurer-
// generated field and 'presence' for a bank detail. The reviewer approves one
// thing and a different thing happens. On the first deploying firm that was all
// five live formats, 84 questions.
//
// WHAT THIS CHANGES: nothing about behaviour. It writes exactly what
// defaultCheckMode already returns at reconcile time, so every sale is judged the
// same way before and after. What changes is that the stored snapshot, the review
// screen and the pipeline finally agree, and a mode a person sets afterwards
// replaces a value rather than filling a hole.
//
// Usage:
//   tsx src/scripts/backfill-question-check-modes.ts "Trust Point"
//   tsx src/scripts/backfill-question-check-modes.ts "Trust Point" --commit
//   tsx src/scripts/backfill-question-check-modes.ts --all --commit
import { pool, query, queryOne } from '../db/client.js';
import { defaultCheckMode } from '../services/reconciliation.js';

interface ProfileRow {
  id: string;
  insurer: string;
  product: string | null;
  status: string;
  questions: Array<Record<string, unknown> & { question: string; check_mode?: string | null }>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const allOrgs = args.includes('--all');
  const orgArg = args.find((a) => !a.startsWith('--')) ?? (allOrgs ? null : 'Trust Point');

  let organizationId: string | null = null;
  let label = 'every tenant';
  if (orgArg) {
    const org = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE name ILIKE $1 LIMIT 1`,
      [`%${orgArg}%`]
    );
    if (!org) {
      console.log(`No organization matching "${orgArg}"`);
      return;
    }
    organizationId = org.id;
    label = org.name;
  }

  console.log(`\n${label}${commit ? '' : '   (dry run — pass --commit to write)'}\n`);

  // Superseded profiles too. They are what a re-activation would restore, and a
  // restored profile with no modes would reintroduce exactly this mismatch.
  const profiles = await query<ProfileRow>(
    `SELECT id, insurer, product, status, questions
       FROM capture_document_profiles
      WHERE ($1::uuid IS NULL OR organization_id = $1)
      ORDER BY insurer, product, version`,
    [organizationId]
  );

  let touchedProfiles = 0;
  let touchedQuestions = 0;

  for (const p of profiles) {
    const missing = p.questions.filter((q) => !q.check_mode);
    if (missing.length === 0) continue;

    const stamped = p.questions.map((q) =>
      q.check_mode ? q : { ...q, check_mode: defaultCheckMode(q.question) }
    );

    // Counted per mode, because 'reconcile' is the value the screen was already
    // claiming and the others are the ones that were being applied behind it.
    const byMode = new Map<string, number>();
    for (const q of missing) {
      const mode = defaultCheckMode(q.question);
      byMode.set(mode, (byMode.get(mode) ?? 0) + 1);
    }
    console.log(
      `${p.insurer} / ${p.product ?? '—'} [${p.status}] — ${missing.length} of ${p.questions.length} ` +
        `question(s) unstamped: ` +
        [...byMode.entries()].map(([m, n]) => `${n}×${m}`).join(', ')
    );
    for (const q of missing) {
      const mode = defaultCheckMode(q.question);
      // Only the ones the screen was misreporting are worth a line each: a
      // question that defaults to 'reconcile' was already displayed correctly.
      if (mode !== 'reconcile') console.log(`    ${mode.padEnd(8)} ${q.question}`);
    }

    if (commit) {
      await query(`UPDATE capture_document_profiles SET questions = $2::jsonb, updated_at = now() WHERE id = $1`, [
        p.id,
        JSON.stringify(stamped),
      ]);
    }
    touchedProfiles++;
    touchedQuestions += missing.length;
  }

  console.log(
    `\n${commit ? 'Stamped' : 'Would stamp'} ${touchedQuestions} question(s) across ` +
      `${touchedProfiles} profile(s).`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
