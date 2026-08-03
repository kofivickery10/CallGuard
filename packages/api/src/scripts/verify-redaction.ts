/**
 * Non-destructive check that the narrowed `redact` list (services/transcription.ts)
 * still redacts every genuine identifier while letting organisation names, prices
 * and durations through. Re-transcribes ONE existing call from its stored audio
 * with the CURRENT code settings and diffs the redaction tag set against what is
 * already stored. Writes nothing back to the DB.
 *
 * Run where the audio and DEEPGRAM_API_KEY live (i.e. the server), since the
 * recording is read from the local uploads dir.
 *
 * Usage: npx tsx src/scripts/verify-redaction.ts <callId>
 */
import { pool, queryOne, query } from '../db/client.js';
import { transcribeCall } from '../services/transcription.js';
import { getScoringSettings } from '../services/tenant-settings.js';
import type { Call } from '@callguard/shared';

const TAG_RE = /\[[A-Z][A-Z_]*_[0-9]+\]/g;
const tagTypes = (t: string) =>
  new Set((t.match(TAG_RE) ?? []).map((x) => x.replace(/_[0-9]+\]$/, ']')));

async function main() {
  const callId = process.argv[2];
  if (!callId) { console.error('Usage: tsx src/scripts/verify-redaction.ts <callId>'); process.exit(1); }

  const call = await queryOne<Call & { encrypted_at_rest?: boolean; direction?: string | null; transcript_text: string }>(
    'SELECT * FROM calls WHERE id = $1', [callId]);
  if (!call) { console.error('Call not found'); process.exit(1); }
  if (!call.file_key) { console.error('Call has no file_key (not hydrated)'); process.exit(1); }

  // organizations.keyterms/pii_unredacted_categories only exist once their
  // migrations (058/079) are applied; this DB may predate either. Select each
  // only when present.
  const hasKeyterms = !!(await queryOne(
    "SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='keyterms'"));
  const hasUnredactedCategories = !!(await queryOne(
    "SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='pii_unredacted_categories'"));
  const orgRow = await queryOne<{
    name: string | null;
    adviser_channel: number | null;
    keyterms: string[] | null;
    pii_unredacted_categories: string[] | null;
  }>(
    `SELECT name, adviser_channel${hasKeyterms ? ', keyterms' : ''}${hasUnredactedCategories ? ', pii_unredacted_categories' : ''}
       FROM organizations WHERE id = $1`,
    [call.organization_id]);
  const agents = await query<{ name: string }>(
    "SELECT name FROM users WHERE organization_id = $1 AND role = 'adviser'", [call.organization_id]);
  const keyterms = [
    ...(orgRow?.name ? [orgRow.name] : []),
    ...(orgRow?.keyterms ?? []),
    ...agents.map((a) => a.name).filter(Boolean),
  ];
  const s = await getScoringSettings(call.organization_id);
  const dir = (call as { direction?: string | null }).direction ?? null;
  const monoFirst = dir === 'outbound' ? 'customer' : dir === 'inbound' ? 'agent' : s.monoFirstSpeaker;

  // The stored file is normally encrypted at rest. If you've dropped in a
  // PLAINTEXT copy of the audio (e.g. the original .wav, not the server's
  // encrypted blob), run with FORCE_PLAINTEXT=1 so readFile doesn't try to
  // decrypt it.
  const encrypted = process.env.FORCE_PLAINTEXT === '1'
    ? false
    : ((call as { encrypted_at_rest?: boolean }).encrypted_at_rest ?? false);

  // Migration 079: per-category exemption. An explicit OVERRIDE_UNREDACTED lets
  // you probe what a proposed category list would actually produce BEFORE
  // committing it for a tenant — the point of this script.
  const override = process.env.OVERRIDE_UNREDACTED;
  const unredactedCategories = override !== undefined
    ? override.split(',').map((c) => c.trim()).filter(Boolean)
    : (orgRow?.pii_unredacted_categories ?? []);
  const identityExempt = unredactedCategories.some((c) => c !== 'phi' && c !== 'numbers');
  console.log(
    `Re-transcribing ${callId} with ${override !== undefined ? 'OVERRIDE' : 'the org\'s'} redaction settings ` +
      `(no DB write, encrypted=${encrypted}, unredacted=[${unredactedCategories.join(', ') || 'none'}])...`
  );
  if (unredactedCategories.length) {
    console.log(
      `WARNING: categories [${unredactedCategories.join(', ')}] are NOT redacted in this run, so the ` +
        'corresponding leak checks below are EXPECTED to fire. pci is always redacted.'
    );
  }
  const result = await transcribeCall(
    call.file_key,
    keyterms,
    encrypted,
    orgRow?.adviser_channel ?? null,
    s.transcriptionMode,
    s.deepgramRegion,
    monoFirst as 'agent' | 'customer',
    unredactedCategories
  );

  const oldTags = tagTypes(call.transcript_text ?? '');
  const newTags = tagTypes(result.text);

  console.log('\n=== redaction tag types (informational; ASR reclassifies run-to-run) ===');
  console.log('present before, absent now:', [...oldTags].filter((t) => !newTags.has(t)).sort());
  console.log('present now:', [...newTags].sort());

  // The real test: strip every redaction tag, then look for raw identifiers
  // still sitting in the transcript. Tag-type churn between runs is noise;
  // an actual unredacted phone/account/card number or email is a leak.
  const stripped = result.text.replace(TAG_RE, ' ');
  const mask = (s: string) => {
    const d = s.replace(/\D/g, '');
    return d.length <= 4 ? '••••' : `${d.slice(0, 2)}${'•'.repeat(d.length - 4)}${d.slice(-2)} (${d.length} digits)`;
  };
  // 5+ digit runs (phones, account/sort/card numbers), allowing spaces between.
  const runMatches = [...stripped.matchAll(/\d(?:[\d\s]{3,}\d)/g)]
    .filter((m) => m[0].replace(/\D/g, '').length >= 5);
  const digitRuns = runMatches.map((m) => m[0].trim());
  const emails = [...stripped.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);
  // UK postcodes and dates of birth are personal data too — a digit-run/email
  // check alone would wave them through. These heuristics widen the net; they
  // still can't catch names (see the caveat on the verdict below).
  const postcodes = [...stripped.matchAll(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi)].map((m) => m[0].trim());
  const dates = [
    ...stripped.matchAll(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g),
    ...stripped.matchAll(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/gi),
  ].map((m) => m[0].trim());

  // Print surrounding words (digits masked) so we can tell WHAT each number is
  // — a bank sort code/account (must redact) vs a date/policy/ref (harmless).
  const contextOf = (m: RegExpMatchArray) => {
    const i = m.index ?? 0;
    const ctx = stripped.slice(Math.max(0, i - 45), i + m[0].length + 25)
      .replace(/\s+/g, ' ')
      .replace(m[0], `«${mask(m[0])}»`);
    return ctx.trim();
  };

  console.log('\n=== RAW IDENTIFIER LEAK CHECK (the one that matters) ===');
  console.log(`  unredacted digit runs (>=5 digits): ${digitRuns.length}`);
  for (const m of runMatches.slice(0, 20)) console.log(`     …${contextOf(m)}…`);
  console.log(`  unredacted emails: ${emails.length}`);
  for (const e of emails.slice(0, 10)) console.log(`     ${e.replace(/(.).*(@.*)/, '$1•••$2')}`);
  console.log(`  possible postcodes: ${postcodes.length}`);
  for (const p of postcodes.slice(0, 10)) console.log(`     ${p}`);
  console.log(`  possible dates of birth: ${dates.length}`);
  for (const d of dates.slice(0, 10)) console.log(`     ${d}`);
  // Per-category verdict (migration 079). A finding only fails the run if the
  // category that would have caught it is still supposed to be redacted.
  //
  // The 'numbers' case is the interesting one and the reason to run this script
  // before permitting it: with 'numbers' permitted, short runs are EXPECTED and
  // wanted (they are the reconcilable answers — cigarettes per day, blood
  // pressure readings, weight), but bank-length runs must still be gone. If any
  // 6+ digit run survives here, the in-house digit-run redaction that
  // 'numbers' was covering for is not doing its job, and permitting 'numbers'
  // for this tenant is unsafe.
  const numbersPermitted = unredactedCategories.includes('numbers');
  const bankLengthRuns = runMatches.filter((m) => m[0].replace(/\D/g, '').length >= 6);
  const offendingRuns = numbersPermitted ? bankLengthRuns : runMatches;
  if (numbersPermitted) {
    console.log(
      `  ('numbers' permitted: ${digitRuns.length} run(s) total, of which ${bankLengthRuns.length} are ` +
        'bank-length (>=6 digits) and must be zero)'
    );
  }
  const leaked =
    offendingRuns.length > 0 ||
    (!unredactedCategories.includes('email_address') && emails.length > 0) ||
    (!unredactedCategories.includes('location_zip') && postcodes.length > 0) ||
    (!unredactedCategories.includes('dob') && dates.length > 0);

  console.log('\n=== compliance content now visible? ===');
  const lc = result.text.toLowerCase();
  for (const p of ['fca', 'authorised and regulated', 'regulated by', orgRow?.name?.toLowerCase() ?? 'trust point']) {
    console.log(`  "${p}": ${lc.includes(p)}`);
  }
  console.log(`\n[ORGANIZATION] gone: ${!newTags.has('[ORGANIZATION]')}   [MONEY] gone: ${!newTags.has('[MONEY]')}   [DURATION] gone: ${!newTags.has('[DURATION]')}`);
  console.log(leaked
    ? '\nRESULT: *** RAW IDENTIFIER FOUND in a category that should be redacted —'
      + '\n  inspect the masked samples above; do not ship until resolved ***'
    : unredactedCategories.length
      ? `\nRESULT: everything outside [${unredactedCategories.join(', ')}] is still redacted, and no`
        + '\n  bank-length digit run survived. Content from the permitted categories IS visible above —'
        + '\n  confirm that matches the signed-off DPIA scope, nothing more.'
        + (identityExempt
            ? '\n  CAVEAT: identity categories are permitted, so personal names are expected in the clear.'
            : '')
      : '\nRESULT: no digit/email/postcode/date identifiers leaked by the automated check.'
        + '\n  CAVEAT: this cannot detect leaked NAMES (no reliable pattern) — eyeball the'
        + '\n  transcript printed above for un-tagged personal names before treating this as safe.');

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
