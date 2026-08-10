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
import { pool, query } from '../db/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // ── 7. The last few runs, with whatever they are complaining about ─────────
  console.log('\n— Most recent runs —');
  table(
    await query(
      `SELECT r.status,
              r.extraction_method AS read_by,
              r.attempts,
              COALESCE(r.attachment_name, '—') AS document,
              r.created_at::date AS created,
              left(COALESCE(r.error_message, ''), 80) AS message
         FROM capture_reconciliation_runs r
        WHERE r.organization_id = $1
        ORDER BY r.created_at DESC
        LIMIT 15`,
      O
    )
  );

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
