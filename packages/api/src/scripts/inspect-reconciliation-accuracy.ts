// Where is the Data Forms comparison losing accuracy?
//
// STRICTLY READ-ONLY. Every statement is a SELECT.
//
// dataforms-status.ts answers "is it running". This answers the next question:
// of the comparisons that DID run, which ones failed to reach a conclusion, and
// why. The module's dominant outcome is 'undetermined', and that single label
// covers several unrelated causes:
//
//   - the question text itself is corrupt, so the terms derived from it could
//     never match anything in the call
//   - the question is fine, the call genuinely did not cover it
//   - the value was redacted out before comparison
//   - the two passes disagreed and it was downgraded
//
// Only the first is a bug we can fix in the parser, so the report separates it.
import { pool, query } from '../db/client.js';
// The shape tests moved to a service so the profile-proposal path can use them
// too — catching a mangled question when it is created beats reporting it here
// after the fact.
import { corruptionFlags } from '../services/question-quality.js';

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


const corruptionFlagNames = (q: string): string[] => corruptionFlags(q).map((f) => f.name);

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

async function main(): Promise<void> {
  const orgArg = firstPositional() ?? 'Trust Point';
  const org = await query<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE name ILIKE $1 LIMIT 1`,
    [`%${orgArg}%`],
  );
  if (org.length === 0) {
    console.log(`No organization matching "${orgArg}"`);
    return;
  }
  const { id: orgId, name } = org[0];
  console.log(`\n${'='.repeat(72)}\n${name}\n${'='.repeat(72)}`);

  // ── 1. Outcome distribution ───────────────────────────────────────────────
  console.log('\n1. OUTCOMES ACROSS ALL COMPLETED RUNS\n');
  const outcomes = await query<{ outcome: string; n: string; pct: string }>(
    `SELECT i.outcome,
            COUNT(*)::text AS n,
            ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)::text AS pct
       FROM capture_reconciliation_items i
       JOIN capture_reconciliation_runs r ON r.id = i.run_id
      WHERE r.organization_id = $1
      GROUP BY i.outcome
      ORDER BY COUNT(*) DESC`,
    [orgId],
  );
  console.table(outcomes);

  // ── 2. Undetermined, split by whether we even had something to look for ────
  // An undetermined item where the application recorded no answer either is a
  // different problem from one where the application HAS an answer and the call
  // side came back empty. The second is the one that should have concluded.
  console.log('\n2. UNDETERMINED — DID THE APPLICATION EVEN HAVE AN ANSWER?\n');
  const split = await query<{ bucket: string; n: string }>(
    `SELECT CASE
              WHEN i.application_answer IS NULL OR btrim(i.application_answer) = ''
                THEN 'application blank too'
              WHEN i.call_answer_redacted THEN 'call value redacted'
              WHEN i.call_answer IS NOT NULL AND btrim(i.call_answer) <> ''
                THEN 'both sides present (downgraded or uncomparable)'
              ELSE 'application answered, call side empty'
            END AS bucket,
            COUNT(*)::text AS n
       FROM capture_reconciliation_items i
       JOIN capture_reconciliation_runs r ON r.id = i.run_id
      WHERE r.organization_id = $1 AND i.outcome = 'undetermined'
      GROUP BY 1 ORDER BY COUNT(*) DESC`,
    [orgId],
  );
  console.table(split);

  // ── 3. Which questions never resolve ──────────────────────────────────────
  console.log('\n3. QUESTIONS THAT MOST OFTEN GO UNDETERMINED (top 25)\n');
  const worst = await query<{
    question: string;
    total: string;
    undet: string;
    resolved: string;
  }>(
    `SELECT i.question,
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE i.outcome = 'undetermined')::text AS undet,
            COUNT(*) FILTER (WHERE i.outcome <> 'undetermined')::text AS resolved
       FROM capture_reconciliation_items i
       JOIN capture_reconciliation_runs r ON r.id = i.run_id
      WHERE r.organization_id = $1
      GROUP BY i.question
     HAVING COUNT(*) FILTER (WHERE i.outcome = 'undetermined') > 0
      ORDER BY COUNT(*) FILTER (WHERE i.outcome = 'undetermined') DESC
      LIMIT 25`,
    [orgId],
  );
  console.table(
    worst.map((w) => ({
      question: w.question.length > 78 ? `${w.question.slice(0, 75)}...` : w.question,
      total: w.total,
      undet: w.undet,
      ok: w.resolved,
      corrupt: corruptionFlagNames(w.question).join(', ') || '',
    })),
  );

  // ── 4. Corruption in the stored profiles ──────────────────────────────────
  // The items above are per-sale copies. The profile is the source: if the
  // question is mangled there, every future sale inherits it.
  console.log('\n4. CORRUPT QUESTIONS IN THE STORED PROFILES\n');
  const profiles = await query<{
    id: string;
    insurer: string;
    product: string | null;
    status: string;
    questions: Array<{ question: string; order?: number }>;
  }>(
    `SELECT id, insurer, product, status, questions
       FROM capture_document_profiles
      WHERE organization_id = $1 AND status <> 'superseded'
      ORDER BY insurer, product`,
    [orgId],
  );
  for (const p of profiles) {
    const qs = p.questions ?? [];
    const bad = qs
      .map((q, idx) => ({ idx, question: q.question ?? '', flags: corruptionFlagNames(q.question ?? '') }))
      .filter((r) => r.flags.length > 0);
    const label = `${p.insurer}${p.product ? ` / ${p.product}` : ''} [${p.status}]`;
    console.log(`\n   ${label} — ${bad.length} of ${qs.length} questions look corrupt`);
    for (const b of bad) {
      console.log(`      #${b.idx}  (${b.flags.join(', ')})`);
      console.log(`          ${JSON.stringify(b.question)}`);
    }
  }

  // ── 4b. Old build vs new ──────────────────────────────────────────────────
  // Only some sales have been re-run since the check_mode / polarity /
  // corroboration work. Pooling them hides which build produced which number,
  // so every accuracy figure above is an average of two different products.
  console.log('\n4b. RUNS BY DAY, WITH THEIR OUTCOME MIX\n');
  const byDay = await query<Record<string, string>>(
    `SELECT to_char(date_trunc('hour', r.completed_at), 'YYYY-MM-DD HH24:00') AS day,
            COUNT(DISTINCT r.id)::text AS runs,
            COUNT(*)::text AS items,
            COUNT(*) FILTER (WHERE i.outcome = 'undetermined')::text AS undet,
            COUNT(*) FILTER (WHERE i.outcome = 'match')::text AS match,
            COUNT(*) FILTER (WHERE i.outcome IN ('mismatch','not_asked','asked_no_answer'))::text AS findings,
            COUNT(*) FILTER (WHERE i.outcome IN ('recorded','missing_from_application'))::text AS modes
       FROM capture_reconciliation_runs r
       JOIN capture_reconciliation_items i ON i.run_id = r.id
      WHERE r.organization_id = $1 AND r.completed_at IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [orgId],
  );
  console.table(byDay);

  // ── 5. Format signature spread ────────────────────────────────────────────
  // One document format should have one signature. More than one signature for
  // the same insurer+product means detection is unstable, which is what leaves
  // proposals stuck.
  console.log('\n5. FORMAT SIGNATURES PER INSURER/PRODUCT\n');
  const sigs = await query<{
    insurer: string;
    product: string | null;
    signatures: string;
    rows: string;
    statuses: string;
  }>(
    `SELECT insurer, product,
            COUNT(DISTINCT format_signature)::text AS signatures,
            COUNT(*)::text AS rows,
            string_agg(DISTINCT status, ', ') AS statuses
       FROM capture_document_profiles
      WHERE organization_id = $1
      GROUP BY insurer, product
      ORDER BY COUNT(DISTINCT format_signature) DESC, insurer`,
    [orgId],
  );
  console.table(sigs);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
