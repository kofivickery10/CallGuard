// What is the Data Forms (application reconciliation) module actually doing for
// a tenant right now?
//
// STRICTLY READ-ONLY. Every statement is a SELECT: this reports, it never
// changes anything, so it is safe to run against production at any time.
//
// It exists because the module's failure mode is silence. A sale that was never
// checked, one parked waiting for a format, and one checked cleanly all look the
// same from the outside — nothing on screen distinguishes "no problems found"
// from "nothing was ever compared". This prints the distinction, in the order
// you need it to diagnose a tenant:
//
//   1. Is the module switched on, and is the migration applied? (the two
//      answers that make every later number meaningless if wrong)
//   2. Where are the runs, and are any stuck in a state nothing rescues?
//   3. Have any ITEMS been produced — the only proof the comparison ran?
//   4. What are the outcomes, and are they undetermined for a redaction reason?
//   5. Which formats exist, and did any go live on their own?
//   6. What has it cost?
//
// Usage:
//   tsx src/scripts/dataforms-status.ts                 # every enabled tenant
//   tsx src/scripts/dataforms-status.ts "Trust Point"   # one, by name or id
import { pool, query, queryOne } from '../db/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Piping this into `head` closes stdout early, and an unguarded write to a
// closed pipe crashes with an unhandled EPIPE — a wall of stack trace in place
// of the report someone was reading. Reading the first twenty lines of a long
// report is the obvious thing to do with it, so it must not look like a fault.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log('   (none)');
    return;
  }
  console.table(rows);
}

async function reportOrg(org: {
  id: string;
  name: string;
  reconciliation_enabled: boolean;
  pii_unredacted_categories: string[];
}): Promise<void> {
  const O = [org.id];
  console.log(`\n${'='.repeat(72)}\n${org.name}  (${org.id})\n${'='.repeat(72)}`);

  // ── 1. Is it even on? ──────────────────────────────────────────────────────
  // The sweep filters every query on reconciliation_enabled, so a tenant with it
  // off produces no runs, no errors and no clue as to why.
  console.log(`\nModule enabled: ${org.reconciliation_enabled ? 'YES' : 'NO — nothing will run'}`);

  // Health answers are special-category data and are redacted at transcription
  // time unless permitted. Without 'phi' the module can still tell you a
  // question was raised, but not what the customer said, so health items come
  // back 'undetermined' by design rather than as a fault.
  const permitted = org.pii_unredacted_categories ?? [];
  console.log(
    `Unredacted categories: ${permitted.length ? permitted.join(', ') : 'none (everything redacted)'}`
  );
  console.log(
    `  health answers comparable: ${permitted.includes('phi') ? 'yes' : "NO — health items will read 'undetermined'"}`
  );
  console.log(
    `  numeric answers comparable: ${permitted.includes('numbers') ? 'yes' : "NO — '20 a day', '14 units' redact to placeholders"}`
  );

  // ── 1a. Does the setting actually reach the stored transcripts? ────────────
  //
  // Permitting a category changes what Deepgram is asked to redact on the NEXT
  // transcription. It does nothing to text already stored. So a tenant can hold
  // a perfectly correct setting and a full set of transcripts that predate it,
  // and every health answer stays uncheckable with nothing on screen to explain
  // why — the settings page says health is permitted, and it is, just not for
  // any call anybody has.
  //
  // Both halves are printed together because only the comparison is meaningful:
  // when the setting was last changed, against when the transcripts were last
  // written and whether they still carry health placeholders.
  const settingChanges = await query<{ when: string; summary: string | null }>(
    `SELECT created_at::text AS when, summary
       FROM audit_log
      WHERE organization_id = $1 AND action_type = 'tenant.pii_redaction_exemption'
      ORDER BY created_at DESC LIMIT 3`,
    O
  );
  const transcripts = await queryOne<{
    total: number;
    health_redacted: number;
    newest: string | null;
    oldest: string | null;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (
              WHERE transcript_text LIKE '%[CONDITION\\_%'
                 OR transcript_text LIKE '%[DRUG\\_%'
                 OR transcript_text LIKE '%[MEDICAL\\_PROCESS\\_%'
            )::int AS health_redacted,
            max(updated_at)::text AS newest,
            min(updated_at)::text AS oldest
       FROM calls c
      WHERE c.organization_id = $1 AND c.transcript_text IS NOT NULL`,
    O
  );

  console.log('\n— Do the stored transcripts carry the setting? —');
  if (settingChanges.length === 0) {
    console.log('   Redaction categories have never been changed for this tenant.');
  } else {
    for (const c of settingChanges) console.log(`   setting changed ${c.when}`);
  }
  if (transcripts) {
    console.log(
      `   transcripts: ${transcripts.total}, of which ${transcripts.health_redacted} still ` +
        'contain health placeholders'
    );
    console.log(`   last written ${transcripts.newest ?? '—'}`);
    if (permitted.includes('phi') && transcripts.health_redacted > 0) {
      console.log(
        '   !! Health is permitted but those transcripts predate the change, or were written\n' +
          '      before it saved. They must be re-transcribed for it to have any effect:\n' +
          '        tsx src/scripts/bulk-reprocess-tenant.ts "<tenant>" --retranscribe --commit'
      );
    }
  }

  // ── 1b. Is the transcript underneath all of this still settling? ───────────
  // Every number below is computed from the transcripts as they stand. During a
  // re-transcription — which is the only way a redaction change reaches calls
  // already stored — they are changing, so a reading taken now is a reading of a
  // moving target. Worth knowing before drawing any conclusion from it.
  // Only the statuses that mean "on its way to a transcript". NOT everything
  // outside the settled set: 'captured' is a metadata-only row from a dialler
  // webhook — a recording pointer with no audio, which stays that way unless a
  // sale trigger claims it. A tenant with a dialler holds thousands of those
  // permanently, and counting them reported 2,545 calls in flight where 54 were
  // actually being re-transcribed.
  const transcribing = await query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n
       FROM calls
      WHERE organization_id = $1
        AND status IN ('uploaded', 'transcribing')
      GROUP BY 1 ORDER BY 2 DESC`,
    O
  );
  if (transcribing.length > 0) {
    const total = transcribing.reduce((n, r) => n + r.n, 0);
    console.log(
      `\n!! ${total} call(s) still in flight (${transcribing
        .map((r) => `${r.n} ${r.status}`)
        .join(', ')}) — transcripts are still changing, so the outcomes below are provisional.`
    );
  }

  // ── 2. Where are the runs? ─────────────────────────────────────────────────
  console.log('\n— Runs by status —');
  table(
    await query(
      `SELECT status,
              extraction_method AS read_by,
              count(*)::int AS runs,
              min(created_at)::date AS oldest,
              max(last_attempt_at) AS last_looked_at
         FROM capture_reconciliation_runs
        WHERE organization_id = $1
        GROUP BY 1, 2
        ORDER BY 3 DESC`,
      O
    )
  );

  // Abandoned runs do NOT recover on their own: abandoning means "the document
  // was never coming", and the parked-run retry schedule covers 'needs_profile'
  // only. These need the admin re-run on the sale, which recreates the run with
  // a fresh window. Called out separately because it is the commonest reason a
  // tenant looks stuck after a fix has shipped.
  const abandoned = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM capture_reconciliation_runs
      WHERE organization_id = $1 AND status = 'abandoned'`,
    O
  );
  if ((abandoned[0]?.n ?? 0) > 0) {
    console.log(
      `\n  !! ${abandoned[0]!.n} run(s) abandoned. These never self-heal — re-run them from the sale.`
    );
  }

  // ── 3. Did the comparison ever actually run? ───────────────────────────────
  // The single most useful number here. Everything upstream can look healthy
  // while zero items exist, which means nothing has ever been compared.
  console.log('\n— Items produced (proof the comparison ran) —');
  table(
    await query(
      `SELECT count(*)::int AS items,
              count(DISTINCT i.run_id)::int AS runs_with_items,
              count(*) FILTER (WHERE i.outcome IN ('mismatch','not_asked','asked_no_answer'))::int
                AS needing_attention
         FROM capture_reconciliation_items i
         JOIN capture_reconciliation_runs r ON r.id = i.run_id
        WHERE r.organization_id = $1`,
      O
    )
  );

  // ── 4. What did it conclude? ───────────────────────────────────────────────
  console.log('\n— Outcomes —');
  table(
    await query(
      `SELECT i.outcome, count(*)::int AS n,
              count(*) FILTER (WHERE i.call_answer_redacted)::int AS redacted_out
         FROM capture_reconciliation_items i
         JOIN capture_reconciliation_runs r ON r.id = i.run_id
        WHERE r.organization_id = $1
        GROUP BY 1 ORDER BY 2 DESC`,
      O
    )
  );

  // ── 5. Which formats does it hold? ─────────────────────────────────────────
  // 'needs_confirmation' with 1 sale agreeing is the normal waiting state; with
  // 2 or more it should have activated itself, and not having done so is a bug.
  console.log('\n— Document formats —');
  table(
    await query(
      `SELECT insurer,
              COALESCE(product, '—') AS product,
              status,
              strategy,
              questions_vary AS varies,
              jsonb_array_length(questions) AS questions,
              COALESCE(array_length(corroborating_journeys, 1), 0) AS sales_agreeing,
              (auto_confirmed_at IS NOT NULL) AS went_live_itself,
              (held_notified_at IS NOT NULL) AS chased,
              created_at::date AS first_seen
         FROM capture_document_profiles
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      O
    )
  );

  // ── 6. Sales that should have a run but do not ─────────────────────────────
  console.log('\n— Coverage —');
  table(
    await query(
      `SELECT count(*) FILTER (WHERE j.status = 'scored')::int AS scored_sales,
              count(*) FILTER (WHERE j.status = 'scored' AND j.zoho_record_id IS NOT NULL)::int
                AS with_crm_record,
              count(*) FILTER (WHERE j.status = 'scored' AND j.zoho_record_id IS NOT NULL
                               AND r.id IS NULL)::int AS missing_a_run
         FROM journeys j
         LEFT JOIN capture_reconciliation_runs r ON r.journey_id = j.id
        WHERE j.organization_id = $1`,
      O
    )
  );

  // ── 7. Every sale, one line each — the actual review ────────────────────────
  //
  // Everything above answers "is the module working". This answers the
  // question that actually gets asked next: which sales, which customers, what
  // happened on each one. Ordered so the sales worth looking at surface first —
  // a real finding, then a parked format, then a document problem, then a clean
  // pass — rather than by date, which buries a genuine mismatch under whatever
  // was merely re-run most recently.
  //
  // No LIMIT. A tenant with hundreds of sales needs paging, not truncation
  // silently standing in for it; add one deliberately if this ever gets there.
  console.log('\n— Every sale Data Forms has looked at —');
  const sales = await query<{
    client_name: string | null;
    journey_id: string;
    status: string;
    read_by: string | null;
    document: string | null;
    items: number;
    needing_attention: number;
    message: string | null;
  }>(
    `SELECT j.client_name, r.journey_id, r.status,
            r.extraction_method AS read_by,
            r.attachment_name AS document,
            COALESCE(i.total, 0)::int AS items,
            COALESCE(i.actionable, 0)::int AS needing_attention,
            r.error_message AS message
       FROM capture_reconciliation_runs r
       JOIN journeys j ON j.id = r.journey_id
       LEFT JOIN (
         SELECT run_id, count(*)::int AS total,
                count(*) FILTER (
                  WHERE outcome IN ('mismatch', 'not_asked', 'asked_no_answer')
                     OR amendment_type = 'disclosure_withdrawn'
                )::int AS actionable
           FROM capture_reconciliation_items
          GROUP BY run_id
       ) i ON i.run_id = r.id
      WHERE r.organization_id = $1
      ORDER BY
        -- Findings first, worst sale first.
        i.actionable DESC NULLS LAST,
        -- Then anything parked on a person, oldest first — the ones waiting
        -- longest for a format or a document are the ones worth chasing.
        (r.status IN ('needs_profile', 'needs_document'))::int DESC,
        r.created_at ASC`,
    O
  );
  if (sales.length === 0) {
    console.log('   (no runs yet)');
  } else {
    for (const s of sales) {
      const flag = s.needing_attention > 0 ? `!! ${s.needing_attention} finding(s)` : '';
      console.log(
        `   ${(s.client_name ?? '(unnamed sale)').padEnd(28).slice(0, 28)} ` +
          `${s.status.padEnd(17)} ${(s.read_by ?? '—').padEnd(8)} ` +
          `${String(s.items).padStart(3)} items  ${flag}`
      );
      if (s.status === 'needs_document' || s.status === 'needs_profile') {
        console.log(`       ${s.message ?? '(waiting)'}`);
      } else if (s.status === 'failed' && s.message) {
        console.log(`       failed: ${s.message.slice(0, 120)}`);
      }
      console.log(`       /journeys/${s.journey_id}`);
    }
  }

  // ── 7b. Which format actually read each sale? ──────────────────────────────
  // A completed run says nothing about whether the RIGHT format read it.
  // matchProfile demands every detect pattern be present, so a cross-match
  // should be impossible — but a label_value profile with loose patterns is the
  // case where it would not be, and the result would be one insurer's document
  // parsed with another insurer's field list, silently.
  console.log('\n— Which format read each completed sale —');
  table(
    await query(
      `SELECT COALESCE(p.insurer, '(none)') AS format_insurer,
              COALESCE(p.product, '—') AS format_product,
              r.extraction_method AS read_by,
              count(*)::int AS sales,
              string_agg(DISTINCT COALESCE(r.attachment_name, '—'), ', ') AS documents
         FROM capture_reconciliation_runs r
         LEFT JOIN capture_document_profiles p ON p.id = r.profile_id
        WHERE r.organization_id = $1 AND r.status IN ('completed', 'summary_only')
        GROUP BY 1, 2, 3
        ORDER BY 4 DESC`,
      O
    )
  );

  // ── 7c. Is 'asked_no_answer' a finding, or an artefact? ────────────────────
  // The comparison locates a question by its terms, takes the FIRST occurrence
  // in the transcript, and reads ~420 characters around it. If the adviser
  // mentions a topic early (running through what they are about to cover) and
  // the customer answers later, that window holds the mention and not the
  // answer — and the item is recorded as "asked, never answered", which reads on
  // screen as a serious finding.
  //
  // The tell is concentration. Genuine unanswered questions are scattered; an
  // artefact of the search window repeats on the same questions across every
  // sale. Anything appearing on nearly every run is the second thing.
  console.log('\n— Questions most often flagged "asked but not answered" —');
  table(
    await query(
      `SELECT left(i.question, 70) AS question,
              count(*)::int AS times_flagged,
              count(DISTINCT i.run_id)::int AS across_sales
         FROM capture_reconciliation_items i
         JOIN capture_reconciliation_runs r ON r.id = i.run_id
        WHERE r.organization_id = $1 AND i.outcome = 'asked_no_answer'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      O
    )
  );

  // The ones that matter most: a recorded answer that disagrees with the call.
  //
  // Printed with the reasoning and the passage rather than as a table, because a
  // mismatch is an allegation about a named adviser and the two questions a
  // human needs — what was actually said, and why we called it a disagreement —
  // cannot be read from a truncated column. The first three found on real data
  // included one where "7 years ago" and "2019" were the same year.
  const mismatches = await query<{
    question: string;
    application_answer: string | null;
    call_answer: string | null;
    confidence: number | null;
    reasoning: string | null;
    evidence: string | null;
    document: string | null;
  }>(
    `SELECT i.question, i.application_answer, i.call_answer, i.confidence,
            i.reasoning, i.evidence, r.attachment_name AS document
       FROM capture_reconciliation_items i
       JOIN capture_reconciliation_runs r ON r.id = i.run_id
      WHERE r.organization_id = $1 AND i.outcome = 'mismatch'
      ORDER BY i.confidence DESC NULLS LAST LIMIT 20`,
    O
  );
  console.log(`\n— Mismatches (${mismatches.length}) — check each before acting on it —`);
  if (mismatches.length === 0) console.log('   (none)');
  for (const m of mismatches) {
    console.log(`\n  ${m.document ?? '—'}`);
    console.log(`  Q: ${m.question}`);
    console.log(`  form: ${m.application_answer ?? '—'}   call: ${m.call_answer ?? '—'}   ` +
      `confidence: ${m.confidence ?? '—'}`);
    if (m.reasoning) console.log(`  why: ${m.reasoning}`);
    if (m.evidence) console.log(`  said: ${m.evidence.slice(0, 500)}`);
  }

  // "This question was never put to the customer" is the most serious thing the
  // module says about a named adviser, and it was visible only as a count and a
  // truncated question column — no reasoning, no sale, no way to check one.
  //
  // Printed in full because there are few of them by design: if this list is
  // ever long enough for that to hurt, the module is over-accusing and the list
  // is the evidence. `asked_no_answer` joins it — it is a softer claim, but it
  // is still a claim about how a call was conducted.
  const accusations = await query<{
    outcome: string;
    sale: string | null;
    question: string;
    application_answer: string | null;
    reasoning: string | null;
    document: string | null;
  }>(
    `SELECT i.outcome, j.client_name AS sale, i.question, i.application_answer,
            i.reasoning, r.attachment_name AS document
       FROM capture_reconciliation_items i
       JOIN capture_reconciliation_runs r ON r.id = i.run_id
       LEFT JOIN journeys j ON j.id = r.journey_id
      WHERE r.organization_id = $1 AND i.outcome IN ('not_asked', 'asked_no_answer')
      ORDER BY i.outcome, j.client_name`,
    O
  );
  console.log(
    `\n— Reported as never asked, or asked without an answer (${accusations.length}) —`
  );
  if (accusations.length === 0) console.log('   (none)');
  for (const a of accusations) {
    console.log(`\n  [${a.outcome}] ${a.sale ?? '—'}  (${a.document ?? '—'})`);
    console.log(`  Q: ${a.question}`);
    console.log(`  form recorded: ${a.application_answer ?? '—'}`);
    if (a.reasoning) console.log(`  why: ${a.reasoning}`);
  }

  // ── 8. Spend ───────────────────────────────────────────────────────────────
  console.log('\n— Model spend on reconciliation (last 7 days) —');
  table(
    await query(
      `SELECT model_id,
              count(*)::int AS calls,
              sum(input_tokens)::int AS input_tokens,
              sum(output_tokens)::int AS output_tokens
         FROM usage_events
        WHERE organization_id = $1 AND operation = 'reconcile'
          AND created_at > now() - interval '7 days'
        GROUP BY 1 ORDER BY 2 DESC`,
      O
    )
  );
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? null;

  // The migration gates everything: the reconcile job selects extraction_method
  // on every run, so without it every sale errors rather than parking.
  const migrated = await query<{ name: string }>(
    `SELECT name FROM _migrations WHERE name LIKE '093%'`
  );
  console.log(
    migrated.length > 0
      ? 'Migration 093 (extraction_method): applied'
      : '!! Migration 093 (extraction_method) NOT applied — run `npm run migrate`. ' +
          'Until then every reconcile attempt fails.'
  );

  const orgs = await query<{
    id: string;
    name: string;
    reconciliation_enabled: boolean;
    pii_unredacted_categories: string[];
  }>(
    target
      ? `SELECT id, name, reconciliation_enabled, pii_unredacted_categories
           FROM organizations
          WHERE ${UUID_RE.test(target) ? 'id = $1' : 'name ILIKE $1'}`
      : `SELECT id, name, reconciliation_enabled, pii_unredacted_categories
           FROM organizations
          WHERE reconciliation_enabled = true
          ORDER BY name`,
    target ? [UUID_RE.test(target) ? target : `%${target}%`] : []
  );

  if (orgs.length === 0) {
    console.log(
      target
        ? `No organisation matching "${target}".`
        : 'No organisation has the reconciliation module enabled.'
    );
    return;
  }

  for (const org of orgs) await reportOrg(org);
}

main()
  .catch((err) => {
    console.error('Failed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
