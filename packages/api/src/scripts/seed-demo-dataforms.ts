/**
 * Demo data for the Data Forms module, added to the existing Brookfield
 * Protection demo tenant.
 *
 * Additive and idempotent. It does NOT reset the tenant: seed-demo.ts --reset
 * deletes the whole demo org and rebuilds it, which would take the hero call and
 * everything else with it. This only adds (and re-adds) its own rows, all of
 * which carry a DEMO- marker so they can be identified and replaced.
 *
 * Why journeys are created here: seed-demo.ts is per-call only and creates no
 * journeys at all, and both halves of Data Forms are sale-scoped — reconciliation
 * entirely so. Without a sale there is nothing for either panel to attach to.
 *
 * Everything is fabricated. The customers are the demo tenant's fictional ones,
 * and the health answers below are invented to exercise each outcome. No real
 * client data goes anywhere near this script.
 *
 * Usage:
 *   npx tsx src/scripts/seed-demo-dataforms.ts            # add/refresh
 *   npx tsx src/scripts/seed-demo-dataforms.ts --remove    # take it all out again
 */

import { pool, query, queryOne } from '../db/client.js';
import { fingerprintQuestions } from '../services/application-pdf.js';

const DEMO_ORG = 'Brookfield Protection';
const FORM_NAME = 'Protection Application Questions';
const DEMO_CRM_PREFIX = 'DEMO-APP-';
const INSURERS = ['Royal London', 'Sovereign Life'];

interface FieldSpec {
  label: string;
  answer_type: 'text' | 'yes_no' | 'number' | 'currency' | 'date' | 'choice';
  required: boolean;
  pii_class: 'none' | 'personal' | 'health';
  description?: string;
  choices?: string[];
}

/**
 * The tenant's own question set (Part A). Deliberately mixes pii_class, because
 * the whole point of the confirm-only path is that a health answer's value is
 * never stored — the demo should show that, not hide it.
 */
const FIELDS: FieldSpec[] = [
  { label: 'Sum assured requested', answer_type: 'currency', required: true, pii_class: 'none' },
  { label: 'Cover term in years', answer_type: 'number', required: true, pii_class: 'none' },
  { label: 'Product type', answer_type: 'choice', required: true, pii_class: 'none', choices: ['Life only', 'Life + CIC', 'Income protection'] },
  { label: 'Smoker status established', answer_type: 'yes_no', required: true, pii_class: 'none' },
  { label: 'Existing cover discussed', answer_type: 'yes_no', required: true, pii_class: 'none' },
  { label: 'Budget confirmed with client', answer_type: 'currency', required: true, pii_class: 'none' },
  { label: 'Height and weight taken', answer_type: 'yes_no', required: true, pii_class: 'health', description: 'Confirm-only: the values themselves are never stored.' },
  { label: 'Pre-existing conditions disclosed', answer_type: 'text', required: true, pii_class: 'health', description: 'Confirm-only: the values themselves are never stored.' },
  { label: 'Beneficiary details taken', answer_type: 'text', required: false, pii_class: 'personal' },
];

/** One demo sale: its customer, and how each half of the module turned out. */
interface SaleSpec {
  customerName: string;
  insurer: string;
  product: string;
  /** Part A: field label → how it came out. */
  capture: Record<string, 'captured' | 'confirmed_only' | 'missed' | 'manual_review' | 'na'>;
  captureValues: Record<string, string>;
  /** Part B: the reconciliation run's status, and its per-question items. */
  reconciliation:
    | { status: 'needs_document' }
    | { status: 'summary_only' }
    | { status: 'completed'; items: ItemSpec[] };
}

interface ItemSpec {
  question: string;
  applicationAnswer: string | null;
  callAnswer: string | null;
  callAnswerRedacted?: boolean;
  outcome:
    | 'match'
    | 'mismatch'
    | 'not_asked'
    | 'asked_no_answer'
    | 'no_application_answer'
    | 'undetermined';
  evidence?: string;
  reasoning?: string;
  confidence?: number;
  revisions?: Array<{ value: string; timestamp: string | null; recordedBy: string | null }>;
  amendmentType?: 'disclosure_withdrawn' | 'disclosure_added' | 'value_changed';
}

/** The question set the demo Royal London profile knows about. */
const RL_QUESTIONS = [
  'Have you smoked or used any tobacco or nicotine products in the last 12 months?',
  'What is your height and weight?',
  'Have you ever been diagnosed with or treated for diabetes?',
  'Have you ever had asthma or any other respiratory condition?',
  'Have you been prescribed medication for anxiety or depression in the last 5 years?',
  'Do you take part in any hazardous sports or activities?',
  'Has any immediate family member been diagnosed with cancer before the age of 60?',
  'How many units of alcohol do you drink in a typical week?',
];

const SALES: SaleSpec[] = [
  // 1. The one that matters: a disclosure made on the call and not submitted.
  {
    customerName: 'Emma Reynolds',
    insurer: 'Royal London',
    product: 'Personal Menu Plan',
    capture: {
      'Sum assured requested': 'captured',
      'Cover term in years': 'captured',
      'Product type': 'captured',
      'Smoker status established': 'captured',
      'Existing cover discussed': 'captured',
      'Budget confirmed with client': 'captured',
      'Height and weight taken': 'confirmed_only',
      'Pre-existing conditions disclosed': 'confirmed_only',
      'Beneficiary details taken': 'confirmed_only',
    },
    captureValues: {
      'Sum assured requested': '£250,000',
      'Cover term in years': '25',
      'Product type': 'Life + CIC',
      'Smoker status established': 'yes',
      'Existing cover discussed': 'yes',
      'Budget confirmed with client': '£42 per month',
    },
    reconciliation: {
      status: 'completed',
      items: [
        {
          question: RL_QUESTIONS[0]!,
          applicationAnswer: 'No',
          callAnswer: 'No',
          outcome: 'match',
          evidence: 'Agent: And you\'ve never smoked, is that right? Customer: No, never touched them.',
          confidence: 0.96,
        },
        {
          question: RL_QUESTIONS[1]!,
          applicationAnswer: 'Recorded',
          callAnswer: null,
          callAnswerRedacted: true,
          outcome: 'match',
          evidence: 'Agent: Can I take your height and weight? Customer: [REDACTED]',
          reasoning: 'The question was demonstrably put and answered. The value is not stored.',
          confidence: 0.88,
        },
        {
          question: RL_QUESTIONS[2]!,
          applicationAnswer: 'No',
          callAnswer: null,
          outcome: 'undetermined',
          reasoning:
            'The words identifying this question are removed from stored transcripts, so their absence proves nothing.',
        },
        {
          // The headline finding: disclosed on the call, submitted as "No".
          question: RL_QUESTIONS[3]!,
          applicationAnswer: 'No',
          callAnswer: 'Yes — inhaler as a child, occasional use now',
          outcome: 'mismatch',
          evidence:
            'Customer: I had asthma as a kid, I still use the blue inhaler now and again if I get a cold. Agent: Okay, noted.',
          reasoning:
            'The customer disclosed a respiratory condition. The application records "No" against this question.',
          confidence: 0.91,
        },
        {
          // The other serious one: an answer submitted for a question never put.
          question: RL_QUESTIONS[4]!,
          applicationAnswer: 'No',
          callAnswer: null,
          outcome: 'not_asked',
          reasoning:
            'None of these terms appear anywhere in the call: anxiety, depression, antidepressant, medication for mood.',
        },
        {
          question: RL_QUESTIONS[5]!,
          applicationAnswer: 'No',
          callAnswer: 'No',
          outcome: 'match',
          evidence: 'Agent: Any dangerous hobbies — climbing, diving, motorsport? Customer: Nothing like that, no.',
          confidence: 0.94,
        },
        {
          // A disclosure entered, then taken back before submission.
          question: RL_QUESTIONS[6]!,
          applicationAnswer: 'No',
          callAnswer: 'Yes — father, bowel cancer at 58',
          outcome: 'mismatch',
          evidence:
            'Customer: My dad had bowel cancer, he was 58. Agent: Sorry to hear that. Was he treated successfully?',
          reasoning:
            'Disclosed on the call and recorded as "Yes" in the portal, then amended to "No" before submission.',
          confidence: 0.93,
          revisions: [{ value: 'Yes', timestamp: '2026-08-03T14:22:00Z', recordedBy: 'D. Brooks' }],
          amendmentType: 'disclosure_withdrawn',
        },
        {
          question: RL_QUESTIONS[7]!,
          applicationAnswer: '10',
          callAnswer: '10 to 12',
          outcome: 'match',
          evidence: 'Customer: Maybe ten, twelve units a week? A couple of glasses of wine with dinner.',
          confidence: 0.87,
        },
      ],
    },
  },

  // 2. A clean sale, so the demo shows what "nothing wrong" looks like.
  {
    customerName: 'Michael Chen',
    insurer: 'Royal London',
    product: 'Personal Menu Plan',
    capture: {
      'Sum assured requested': 'captured',
      'Cover term in years': 'captured',
      'Product type': 'captured',
      'Smoker status established': 'captured',
      'Existing cover discussed': 'captured',
      'Budget confirmed with client': 'captured',
      'Height and weight taken': 'confirmed_only',
      'Pre-existing conditions disclosed': 'confirmed_only',
      'Beneficiary details taken': 'confirmed_only',
    },
    captureValues: {
      'Sum assured requested': '£180,000',
      'Cover term in years': '20',
      'Product type': 'Life only',
      'Smoker status established': 'yes',
      'Existing cover discussed': 'yes',
      'Budget confirmed with client': '£28 per month',
    },
    reconciliation: {
      status: 'completed',
      items: RL_QUESTIONS.map((q, i) => ({
        question: q,
        applicationAnswer: i === 1 ? 'Recorded' : i === 7 ? '4' : 'No',
        callAnswer: i === 1 ? null : i === 7 ? '3 or 4' : 'No',
        callAnswerRedacted: i === 1,
        outcome: (i === 2 || i === 4 ? 'undetermined' : 'match') as ItemSpec['outcome'],
        evidence: i === 2 || i === 4 ? undefined : 'Agent: ...  Customer: No, nothing like that.',
        reasoning:
          i === 2 || i === 4
            ? 'The words identifying this question are removed from stored transcripts, so their absence proves nothing.'
            : undefined,
        confidence: i === 2 || i === 4 ? undefined : 0.92,
      })),
    },
  },

  // 3. A required question the adviser never asked (Part A's own finding).
  {
    customerName: 'Sarah Whitfield',
    insurer: 'Royal London',
    product: 'Personal Menu Plan',
    capture: {
      'Sum assured requested': 'captured',
      'Cover term in years': 'captured',
      'Product type': 'captured',
      'Smoker status established': 'missed',
      'Existing cover discussed': 'missed',
      'Budget confirmed with client': 'captured',
      'Height and weight taken': 'confirmed_only',
      'Pre-existing conditions disclosed': 'manual_review',
      'Beneficiary details taken': 'na',
    },
    captureValues: {
      'Sum assured requested': '£320,000',
      'Cover term in years': '30',
      'Product type': 'Income protection',
      'Budget confirmed with client': '£55 per month',
    },
    reconciliation: { status: 'needs_document' },
  },

  // 4. A summary-only product, so a clean panel is never read as "health matched".
  {
    customerName: 'Priya Nair',
    insurer: 'Sovereign Life',
    product: 'EveryDay Cover',
    capture: {
      'Sum assured requested': 'captured',
      'Cover term in years': 'captured',
      'Product type': 'captured',
      'Smoker status established': 'captured',
      'Existing cover discussed': 'captured',
      'Budget confirmed with client': 'captured',
      'Height and weight taken': 'na',
      'Pre-existing conditions disclosed': 'na',
      'Beneficiary details taken': 'confirmed_only',
    },
    captureValues: {
      'Sum assured requested': '£75,000',
      'Cover term in years': '15',
      'Product type': 'Life only',
      'Smoker status established': 'yes',
      'Existing cover discussed': 'yes',
      'Budget confirmed with client': '£14 per month',
    },
    reconciliation: { status: 'summary_only' },
  },
];

async function findOrg(): Promise<string> {
  const org = await queryOne<{ id: string }>('SELECT id FROM organizations WHERE name = $1', [
    DEMO_ORG,
  ]);
  if (!org) {
    throw new Error(
      `No organisation named "${DEMO_ORG}". Run the main demo seed first (npm run seed-demo).`
    );
  }
  return org.id;
}

/** Remove only what this script creates. Journeys cascade to their runs. */
async function removeDemoData(orgId: string): Promise<void> {
  const journeys = await query<{ id: string }>(
    'SELECT id FROM journeys WHERE organization_id = $1 AND zoho_record_id LIKE $2',
    [orgId, `${DEMO_CRM_PREFIX}%`]
  );
  for (const j of journeys) {
    await query('DELETE FROM journeys WHERE id = $1', [j.id]);
  }
  await query(
    'DELETE FROM capture_document_profiles WHERE organization_id = $1 AND insurer = ANY($2::text[])',
    [orgId, INSURERS]
  );
  await query('DELETE FROM capture_forms WHERE organization_id = $1 AND name = $2', [
    orgId,
    FORM_NAME,
  ]);
  console.log(`  removed ${journeys.length} demo sale(s), their runs, profiles and the form`);
}

async function main() {
  const remove = process.argv.includes('--remove');
  const orgId = await findOrg();
  console.log(`${DEMO_ORG} → ${orgId.slice(0, 8)}\n`);

  console.log('[clean] removing any previous Data Forms demo rows');
  await removeDemoData(orgId);

  if (remove) {
    await query(
      'UPDATE organizations SET capture_enabled = false, reconciliation_enabled = false WHERE id = $1',
      [orgId]
    );
    console.log('\nData Forms demo removed, both module flags off.');
    return;
  }

  // ── The module flags. Note this does NOT touch pii_unredacted_categories:
  // nothing here needs unredacted transcription, and that flag is DPIA-gated.
  await query(
    'UPDATE organizations SET capture_enabled = true, reconciliation_enabled = true WHERE id = $1',
    [orgId]
  );
  console.log('[flags] capture_enabled + reconciliation_enabled ON');

  const admin = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE organization_id = $1 AND role = 'admin' ORDER BY created_at LIMIT 1",
    [orgId]
  );
  const scorecard = await queryOne<{ id: string; version: number }>(
    'SELECT id, version FROM scorecards WHERE organization_id = $1 ORDER BY created_at LIMIT 1',
    [orgId]
  );
  if (!scorecard) throw new Error('The demo org has no scorecard — run the main demo seed first.');

  // ── Part A: the tenant's own question set ──────────────────────────────────
  const form = await queryOne<{ id: string; version: number }>(
    // No description column on capture_forms — context_label is what carries
    // "what this form is for" (059). Only the FIELDS have descriptions.
    `INSERT INTO capture_forms (organization_id, name, context_label, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, version`,
    [orgId, FORM_NAME, 'Protection application', admin?.id ?? null]
  );
  const fieldIds = new Map<string, string>();
  for (const [i, f] of FIELDS.entries()) {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO capture_form_fields
         (form_id, sort_order, label, description, answer_type, choices, required, pii_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        form!.id,
        i,
        f.label,
        f.description ?? null,
        f.answer_type,
        f.choices ? JSON.stringify(f.choices) : null,
        f.required,
        f.pii_class,
      ]
    );
    fieldIds.set(f.label, row!.id);
  }
  console.log(`[form]  "${FORM_NAME}" with ${FIELDS.length} questions`);

  // ── Part B: the document profiles ──────────────────────────────────────────
  const rlProfile = await queryOne<{ id: string }>(
    `INSERT INTO capture_document_profiles
       (organization_id, insurer, product, strategy, detect_patterns, parse_config,
        question_fingerprint, questions, status, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,'question_answer',$4,$5,$6,$7,'active',$8, now()) RETURNING id`,
    [
      orgId,
      'Royal London',
      'Personal Menu Plan',
      JSON.stringify(['PERSONAL MENU PLAN', 'CLIENT REVIEW']),
      JSON.stringify({ answerDelimiter: 'Your answer(s):', sectionStart: 'APPLICATION FORM' }),
      fingerprintQuestions(RL_QUESTIONS),
      JSON.stringify(
        RL_QUESTIONS.map((q, i) => ({ question: q, absence_meaningful: i !== 2 && i !== 4 }))
      ),
      admin?.id ?? null,
    ]
  );

  // One awaiting confirmation, so the review queue on Data Forms is not
  // empty in the demo — this is the state a new insurer format lands in.
  const pendingQuestions = [...RL_QUESTIONS, 'Have you travelled outside the UK for more than 3 months in the last year?'];
  await query(
    `INSERT INTO capture_document_profiles
       (organization_id, insurer, product, strategy, detect_patterns, parse_config,
        question_fingerprint, questions, status)
     VALUES ($1,$2,$3,'label_value',$4,$5,$6,$7,'needs_confirmation')`,
    [
      orgId,
      'Sovereign Life',
      'EveryDay Cover',
      JSON.stringify(['EVERYDAY COVER', 'SUMMARY OF KEY FACTS']),
      JSON.stringify({ labels: ['Smoker', 'Height', 'Weight'], maxValueLength: 120 }),
      fingerprintQuestions(pendingQuestions),
      JSON.stringify(pendingQuestions.map((q) => ({ question: q, absence_meaningful: true }))),
    ]
  );
  console.log('[profiles] Royal London active, Sovereign Life awaiting confirmation');

  // ── The sales, and the runs hanging off them ───────────────────────────────
  for (const [i, sale] of SALES.entries()) {
    // Reuse the demo tenant's existing customer where the name matches, so the
    // sale hangs off the same person as their calls. Otherwise create one —
    // customers are keyed on phone_normalized, not name.
    const phone = `+44770090${String(1000 + i).slice(-4)}`;
    const customer = await queryOne<{ id: string }>(
      'SELECT id FROM customers WHERE organization_id = $1 AND name = $2 LIMIT 1',
      [orgId, sale.customerName]
    );
    const customerId =
      customer?.id ??
      (
        await queryOne<{ id: string }>(
          `INSERT INTO customers (organization_id, name, phone_normalized)
           VALUES ($1, $2, $3)
           ON CONFLICT (organization_id, phone_normalized)
             DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [orgId, sale.customerName, phone]
        )
      )!.id;

    const hoursAgo = 6 + i * 9;
    const journey = await queryOne<{ id: string }>(
      `INSERT INTO journeys
         (organization_id, customer_id, scorecard_id, scorecard_version, status,
          trigger_source, branch, overall_score, pass, scored_at, zoho_record_id,
          window_start, window_end)
       VALUES ($1,$2,$3,$4,'scored','zoho_sale','On Risk',$5,$6,
               now() - ($7 || ' hours')::interval, $8,
               now() - ($7 || ' hours')::interval - interval '2 hours',
               now() - ($7 || ' hours')::interval)
       RETURNING id`,
      [
        orgId,
        customerId,
        scorecard.id,
        scorecard.version,
        [92.5, 96.0, 78.5, 90.0][i] ?? 90,
        (([92.5, 96.0, 78.5, 90.0][i] ?? 90) as number) >= 80,
        String(hoursAgo),
        `${DEMO_CRM_PREFIX}${1000 + i}`,
      ]
    );

    // Attach an existing demo call so the sale has something to open into, and
    // so reconciliation evidence can link to a real recording in the demo.
    const call = await queryOne<{ id: string }>(
      `SELECT id FROM calls WHERE organization_id = $1 AND transcript_text IS NOT NULL
        ORDER BY created_at DESC OFFSET $2 LIMIT 1`,
      [orgId, i]
    );
    if (call) {
      await query(
        `INSERT INTO journey_calls (journey_id, call_id, role) VALUES ($1, $2, 'wrap_up')
         ON CONFLICT DO NOTHING`,
        [journey!.id, call.id]
      );
    }

    // Part A run
    const captureRun = await queryOne<{ id: string }>(
      `INSERT INTO capture_runs
         (organization_id, journey_id, form_id, form_version, status, model_id,
          started_at, completed_at)
       VALUES ($1,$2,$3,$4,'completed','claude-haiku-4-5-20251001', now(), now())
       RETURNING id`,
      [orgId, journey!.id, form!.id, form!.version]
    );
    for (const f of FIELDS) {
      const result = sale.capture[f.label] ?? 'na';
      const value = sale.captureValues[f.label] ?? null;
      const redacted = result === 'confirmed_only';
      await query(
        `INSERT INTO capture_answers
           (run_id, field_id, asked, answered, captured_value, value_redacted, result,
            confidence, evidence, source_call_id, reasoning)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          captureRun!.id,
          fieldIds.get(f.label),
          result !== 'missed' && result !== 'na',
          result === 'captured' || result === 'confirmed_only',
          redacted ? null : value,
          redacted,
          result,
          result === 'manual_review' ? 0.42 : result === 'missed' ? null : 0.93,
          result === 'missed'
            ? null
            : result === 'confirmed_only'
              ? 'Asked and answered — value not stored (personal data).'
              : `Agent: ... Customer: ${value ?? 'confirmed'}.`,
          call?.id ?? null,
          result === 'missed'
            ? 'No part of the call covers this question.'
            : result === 'manual_review'
              ? 'The passage is ambiguous — sent for a human to decide rather than scored.'
              : null,
        ]
      );
    }

    // Part B run
    const rec = sale.reconciliation;
    if (rec.status === 'needs_document') {
      await query(
        `INSERT INTO capture_reconciliation_runs
           (organization_id, journey_id, status, error_message, attempts, last_attempt_at)
         VALUES ($1,$2,'needs_document',$3,3, now() - interval '25 minutes')`,
        [
          orgId,
          journey!.id,
          'No application document has been attached to this sale in the CRM yet.',
        ]
      );
    } else if (rec.status === 'summary_only') {
      await query(
        `INSERT INTO capture_reconciliation_runs
           (organization_id, journey_id, status, profile_id, attachment_name,
            error_message, attempts, last_attempt_at, completed_at)
         VALUES ($1,$2,'summary_only',NULL,$3,$4,1, now(), now())`,
        [
          orgId,
          journey!.id,
          'EveryDay Cover - summary of key facts.pdf',
          'The application document contains no question set to compare against.',
        ]
      );
    } else {
      const run = await queryOne<{ id: string }>(
        `INSERT INTO capture_reconciliation_runs
           (organization_id, journey_id, status, profile_id, attachment_id,
            attachment_name, document_fingerprint, attempts, last_attempt_at, completed_at)
         VALUES ($1,$2,'completed',$3,'demo-attach',$4,$5,2, now(), now())
         RETURNING id`,
        [
          orgId,
          journey!.id,
          rlProfile!.id,
          `Client review for ${sale.customerName.toLowerCase()}.pdf`,
          fingerprintQuestions(RL_QUESTIONS),
        ]
      );
      for (const [order, item] of rec.items.entries()) {
        await query(
          `INSERT INTO capture_reconciliation_items
             (run_id, sort_order, question, application_answer, call_answer,
              call_answer_redacted, outcome, evidence, reasoning, confidence,
              source_call_id, source_timestamp, application_recorded_by,
              answer_amended, amendment_type, revisions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            run!.id,
            order,
            item.question,
            item.applicationAnswer,
            item.callAnswer,
            item.callAnswerRedacted ?? false,
            item.outcome,
            item.evidence ?? null,
            item.reasoning ?? null,
            item.confidence ?? null,
            item.evidence ? (call?.id ?? null) : null,
            item.evidence ? 120 + order * 45 : null,
            item.revisions?.length ? 'D. Brooks' : null,
            (item.revisions?.length ?? 0) > 0,
            item.amendmentType ?? null,
            JSON.stringify(item.revisions ?? []),
          ]
        );
      }
    }

    console.log(
      `[sale]  ${sale.customerName} — ${sale.insurer} ${sale.product} — reconciliation ${rec.status}`
    );
  }

  console.log(`
Done. Sign in as the demo admin and look at:
  Compliance → Data Capture         coverage across the question set
  Compliance → Data Forms   1 profile awaiting confirmation, 1 sale needing attention
  Sales → Emma Reynolds             both panels on one sale: a mismatch, a
                                    question never asked, and a withdrawn disclosure
  Settings → Data Capture Forms     the editable question set

Remove it again with: npx tsx src/scripts/seed-demo-dataforms.ts --remove
`);
}

main()
  .catch((err) => {
    console.error('\nSeed failed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
