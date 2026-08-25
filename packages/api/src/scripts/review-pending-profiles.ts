// Review every question set awaiting confirmation against the document it was
// learned from.
//
// WHY THIS EXISTS
//
// The Data Forms screen shows a proposed question set and asks a person to
// approve it. What it cannot show is whether the set is actually FAITHFUL to the
// PDF the insurer sent — whether a question was dropped by the parse, arrived
// mangled, or belongs to a document that is not an application at all. Confirming
// a bad set is silent and costly: a missing question stops being checked on every
// future sale, and a mangled one can never be matched by a per-question ruling
// again (services/question-quality.ts).
//
// So this re-fetches the source document, re-parses it with the profile's own
// stored config, and reports every way the stored snapshot and the document
// disagree. It READS ONLY — nothing here writes to the database or to Zoho.
//
// Usage:
//   tsx src/scripts/review-pending-profiles.ts "Trust Point"
//   tsx src/scripts/review-pending-profiles.ts "Trust Point" --only=Aviva
//   tsx src/scripts/review-pending-profiles.ts "Trust Point" --dump=/tmp/docs
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pool, query, queryOne } from '../db/client.js';
import { listSaleAttachments, downloadSaleAttachment, type ZohoAttachment } from '../services/zoho.js';
import {
  extractPdfText,
  parseApplication,
  normaliseForDetection,
  detectDrift,
  parseLooksHealthy,
  rankAttachmentCandidates,
  formatSignature,
  type ParseConfig,
  type ParseStrategy,
  type ParsedApplication,
} from '../services/application-pdf.js';
import { corruptionFlags } from '../services/question-quality.js';
import { maskApplicationAnswer } from '../services/application-redaction.js';

interface ProfileRow {
  id: string;
  insurer: string;
  product: string | null;
  strategy: ParseStrategy;
  status: string;
  questions_vary: boolean;
  detect_patterns: string[];
  parse_config: ParseConfig;
  question_fingerprint: string;
  format_signature: string | null;
  corroborating_journeys: string[];
  questions: Array<{
    order: number;
    question: string;
    guidance: string | null;
    choices: string[];
    absence_meaningful: boolean;
    check_mode: string;
  }>;
  journey_id: string | null;
  zoho_record_id: string | null;
  attachment_id: string | null;
  attachment_name: string | null;
  run_status: string | null;
  extraction_method: string | null;
  created_at: string;
}

function head(s: string): void {
  console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orgArg = args.find((a) => !a.startsWith('--')) ?? 'Trust Point';
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).toLowerCase() : null;
  const dumpArg = args.find((a) => a.startsWith('--dump='));
  const dumpDir = dumpArg ? dumpArg.slice('--dump='.length) : null;

  const org = await queryOne<{ id: string; name: string; pii_unredacted_categories: string[] | null }>(
    `SELECT id, name, pii_unredacted_categories FROM organizations WHERE name ILIKE $1 LIMIT 1`,
    [`%${orgArg}%`]
  );
  if (!org) {
    console.log(`No organization matching "${orgArg}"`);
    return;
  }
  const readable = org.pii_unredacted_categories ?? [];

  const profiles = await query<ProfileRow>(
    `SELECT p.id, p.insurer, p.product, p.strategy, p.status, p.questions_vary,
            p.detect_patterns, p.parse_config, p.question_fingerprint, p.format_signature,
            p.corroborating_journeys, p.questions, p.created_at,
            j.id AS journey_id, j.zoho_record_id,
            r.attachment_id, r.attachment_name, r.status AS run_status, r.extraction_method
       FROM capture_document_profiles p
       LEFT JOIN journeys j ON j.id = p.learned_from_journey_id
       LEFT JOIN capture_reconciliation_runs r ON r.journey_id = j.id
      WHERE p.organization_id = $1 AND p.status = 'needs_confirmation'
      ORDER BY p.insurer, p.product`,
    [org.id]
  );

  // Everything else on the tenant, so a proposal that merely repeats a format
  // already live (or already rejected) can be called out as such rather than
  // reviewed on its merits.
  const others = await query<{
    id: string; insurer: string; product: string | null; status: string;
    question_fingerprint: string; format_signature: string | null;
  }>(
    `SELECT id, insurer, product, status, question_fingerprint, format_signature
       FROM capture_document_profiles WHERE organization_id = $1`,
    [org.id]
  );

  head(`${org.name} — ${profiles.length} question set(s) awaiting confirmation`);

  for (const p of profiles) {
    const label = `${p.insurer} / ${p.product ?? '—'}`;
    if (only && !label.toLowerCase().includes(only)) continue;

    head(`${label}   [${p.id}]`);
    console.log(
      `strategy=${p.strategy}  questions_vary=${p.questions_vary}  stored questions=${p.questions.length}\n` +
        `proposed ${new Date(p.created_at).toISOString().slice(0, 16).replace('T', ' ')}  ` +
        `from journey ${p.journey_id ?? '—'} (zoho ${p.zoho_record_id ?? '—'})\n` +
        `run: ${p.run_status ?? 'none'} via ${p.extraction_method ?? '—'}  ` +
        `document ${p.attachment_name ?? '(not recorded)'}\n` +
        `fingerprint ${p.question_fingerprint.slice(0, 16)}  signature ${p.format_signature ?? '—'}\n` +
        `detect_patterns ${JSON.stringify(p.detect_patterns)}\n` +
        `parse_config ${JSON.stringify(p.parse_config)}`
    );

    // --- Overlap with other profiles -------------------------------------
    const twins = others.filter(
      (o) => o.id !== p.id &&
        (o.question_fingerprint === p.question_fingerprint ||
          (!!o.format_signature && o.format_signature === p.format_signature))
    );
    for (const t of twins) {
      const how = t.question_fingerprint === p.question_fingerprint ? 'same fingerprint' : 'same signature';
      console.log(`  ! OVERLAP (${how}) with ${t.insurer} / ${t.product ?? '—'} [${t.status}] ${t.id}`);
    }

    // --- Corruption in the stored snapshot --------------------------------
    let mangled = 0;
    for (const q of p.questions) {
      const flags = corruptionFlags(q.question);
      if (flags.length) {
        mangled++;
        console.log(`  ! MANGLED q${q.order}: ${JSON.stringify(q.question)}`);
        for (const f of flags) console.log(`      ${f.name}: ${f.detail}`);
      }
    }
    if (mangled) console.log(`  ! ${mangled}/${p.questions.length} stored questions look corrupted`);

    // --- The document itself ----------------------------------------------
    if (!p.zoho_record_id) {
      console.log('  ! no Zoho record on the source journey — cannot re-read the document');
      continue;
    }

    // WHICH document did this profile actually come from?
    //
    // The run's recorded attachment is the one RECONCILIATION read, which is not
    // necessarily the one the profile was LEARNED from — the learner ranks
    // several candidates and keeps the best, and where the run never got a
    // profile match nothing was recorded at all. Guessing the top-ranked file
    // reports "detect pattern not found" against a document the profile was
    // never about. So every candidate is read and the profile is tested against
    // all of them, the way matchProfile would.
    let text = '';
    let usedAttachment: { id: string; file_name: string } | null = null;
    try {
      const { configured, attachments } = await listSaleAttachments(org.id, p.zoho_record_id);
      if (!configured) {
        console.log('  ! Zoho is not configured — cannot re-read the document');
        continue;
      }
      const ranked = rankAttachmentCandidates(attachments);
      const wanted = p.detect_patterns.map((x) => normaliseForDetection(x));
      let best = -1;
      const scored: Array<{ a: ZohoAttachment; hits: number; chars: number }> = [];
      for (const a of ranked.slice(0, 9)) {
        let t: string;
        try {
          t = await extractPdfText(await downloadSaleAttachment(org.id, p.zoho_record_id, a.id));
        } catch (err) {
          scored.push({ a, hits: -1, chars: 0 });
          continue;
        }
        const norm = normaliseForDetection(t);
        const hits = wanted.filter((w) => norm.includes(w)).length;
        scored.push({ a, hits, chars: t.length });
        if (hits > best) {
          best = hits;
          text = t;
          usedAttachment = a;
        }
      }
      console.log(`  attachments on the sale (${attachments.length}) — detect patterns matched by each:`);
      for (const s of scored) {
        const mark = s.a.id === p.attachment_id ? '*' : ' ';
        const pick = usedAttachment && s.a.id === usedAttachment.id ? ' <= read' : '';
        console.log(
          `      ${mark} ${s.hits < 0 ? 'unreadable' : `${s.hits}/${wanted.length}`}  ${s.a.file_name}${pick}`
        );
      }
      if (!usedAttachment) {
        console.log('  ! nothing readable on the sale');
        continue;
      }
      if (best < wanted.length) {
        console.log(
          `  ! NO attachment on this sale matches all ${wanted.length} detect patterns — ` +
            `best is ${best}/${wanted.length}. This profile would not match its own source sale.`
        );
      }
    } catch (err) {
      console.log(`  ! could not read the documents: ${(err as Error).message}`);
      continue;
    }

    console.log(`  read ${usedAttachment.file_name} — ${text.length} chars of text`);

    if (dumpDir) {
      await mkdir(dumpDir, { recursive: true });
      const file = path.join(dumpDir, `${p.insurer}__${p.product ?? 'none'}`.replace(/[^\w]+/g, '_') + '.txt');
      await writeFile(file, text, 'utf8');
      console.log(`  dumped to ${file}`);
    }

    // Do the detect patterns actually appear? matchProfile requires ALL of them
    // in the normalised text, so a pattern that is absent means this profile
    // would never match its own source document.
    const norm = normaliseForDetection(text);
    for (const pattern of p.detect_patterns) {
      const hit = norm.includes(normaliseForDetection(pattern));
      console.log(`  ${hit ? 'ok  ' : '!   '}detect pattern ${JSON.stringify(pattern)}${hit ? '' : ' NOT FOUND in this document'}`);
    }

    const sig = formatSignature(p.strategy, p.detect_patterns);
    if (p.format_signature && sig !== p.format_signature) {
      console.log(`  ! stored signature ${p.format_signature} does not match recomputed ${sig}`);
    }

    // --- Re-parse and compare ---------------------------------------------
    let parsed: ParsedApplication;
    try {
      parsed = parseApplication(text, p.strategy, p.parse_config);
    } catch (err) {
      console.log(`  ! parse threw: ${(err as Error).message}`);
      continue;
    }

    const broken = parseLooksHealthy(parsed);
    console.log(
      `  parse: ${parsed.pairs.length} pair(s), empty=${parsed.empty}, ` +
        `fingerprint ${parsed.fingerprint.slice(0, 16)} ` +
        `${parsed.fingerprint === p.question_fingerprint ? '(matches stored)' : '(DIFFERS from stored)'}` +
        (broken ? `\n  ! parseLooksHealthy: ${broken}` : '')
    );

    const drift = detectDrift(p.questions.map((q) => q.question), parsed.pairs.map((x) => x.question));
    if (drift.changed) {
      for (const a of drift.added) console.log(`  ! in the document, NOT in the stored set: ${JSON.stringify(a)}`);
      for (const r of drift.removed) console.log(`  ! in the stored set, NOT in the document: ${JSON.stringify(r)}`);
      if (drift.reordered) console.log('  ! same questions, different order');
    }

    // --- The set as a reviewer would read it -------------------------------
    console.log('\n  stored question set:');
    const byQuestion = new Map(parsed.pairs.map((x) => [x.question, x]));
    for (const q of p.questions) {
      const pair = byQuestion.get(q.question);
      const answer = pair ? maskApplicationAnswer(q.question, pair.answer, readable) : null;
      console.log(
        `   ${String(q.order).padStart(2)}. ${q.question}\n` +
          `       mode=${q.check_mode}  absence_meaningful=${q.absence_meaningful}` +
          (q.choices?.length ? `  choices=${JSON.stringify(q.choices)}` : '') +
          (q.guidance ? `\n       guidance: ${q.guidance}` : '') +
          `\n       answer in document: ${pair ? JSON.stringify(answer) : '(question not found in this parse)'}`
      );
    }

    const extras = parsed.pairs.filter((x) => !p.questions.some((q) => q.question === x.question));
    if (extras.length) {
      console.log('\n  parsed from the document but not stored:');
      for (const x of extras) {
        console.log(`   ${String(x.order).padStart(2)}. ${x.question} => ${JSON.stringify(maskApplicationAnswer(x.question, x.answer, readable))}`);
      }
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
