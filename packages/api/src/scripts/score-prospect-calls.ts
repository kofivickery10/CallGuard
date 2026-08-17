/**
 * Score a prospect's own calls before a demo, in one command.
 *
 * The manual version of this — spin up a throwaway tenant, attach a suitable
 * scorecard, ingest the prospect's recordings, wait for them to score — takes
 * a salesperson roughly half an hour and is easy to get slightly wrong. This
 * script does the same steps through the *real* pipeline (creates an org,
 * attaches a scorecard, uploads each local audio file through the ordinary
 * ingest -> transcribe -> score path used by every other tenant) so the demo
 * is an honest preview of the product, not a mock-up.
 *
 * DATA PROTECTION: the files this script ingests are a third party's real
 * call recordings, almost always containing real customers' personal data
 * (and, for financial/protection/health sales calls, special-category data).
 * CallGuard has no ongoing lawful basis to hold a prospect's data beyond the
 * demo, so this script is deliberately unable to create anything long-lived:
 *   - the throwaway org's name is always prefixed "PROSPECT – " so it can
 *     never be mistaken for a paying tenant in any list or export;
 *   - its retention horizon is set short (14 days by default) so the daily
 *     retention sweep purges it even if a human forgets to; and
 *   - `--teardown <orgId>` is the ONLY supported way to delete a prospect org,
 *     reusing the org-cascade deletion already used for real tenant deletion
 *     (services/tenant-deletion.ts) plus the same "delete the audio file
 *     before the database row" ordering used by scripts/delete-customer-data.ts
 *     and the retention-purge job, so a failed file delete can never orphan
 *     encrypted audio with nothing left to locate it by.
 * Every run prints the exact teardown command with the org id filled in —
 * run it as soon as the demo is over.
 *
 * This connects to whatever DATABASE_URL points at, which is usually
 * production, and writes real rows there. Nothing is written until --yes is
 * passed; without it, both modes just print what they would do.
 *
 * Usage:
 *   # Preview only (no writes):
 *   npx tsx src/scripts/score-prospect-calls.ts --dir /path/to/prospect/calls --org-name "Acme Advice"
 *
 *   # For real:
 *   npx tsx src/scripts/score-prospect-calls.ts --dir /path/to/prospect/calls --org-name "Acme Advice" --yes
 *
 *   # Optional:
 *   npx tsx src/scripts/score-prospect-calls.ts --dir <dir> --org-name "<name>" \
 *     [--industry "<free text, frames the scoring prompt>"] \
 *     [--admin-email you@callguardai.co.uk] [--retention-days 7] \
 *     [--scorecard <path-to-csv>] --yes
 *
 *   --scorecard defaults to sample_scorecards/mortgage/mcob-mortgage-advice.csv
 *   (CallGuard's actual market). Point it at a different card under
 *   sample_scorecards/ for other verticals (e.g. a protection card once one
 *   exists there). It must NOT point at sample_scorecards/trustpoint/ — those
 *   are one real client's bespoke scorecards, named to that firm in the
 *   criteria text, and showing them to another prospect would be a
 *   client-confidentiality breach; the script refuses any path under that
 *   directory.
 *
 *   # Teardown once the demo is done (preview, then for real):
 *   npx tsx src/scripts/score-prospect-calls.ts --teardown <orgId>
 *   npx tsx src/scripts/score-prospect-calls.ts --teardown <orgId> --yes
 */

import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_FILE_SIZE_BYTES } from '@callguard/shared';
import { pool, query, queryOne } from '../db/client.js';
import { config } from '../config.js';
import { ingestCall } from '../services/ingestion.js';
import { deleteFile } from '../services/storage.js';
import { deleteOrganizationCascade } from '../services/tenant-deletion.js';
import { parseScorecardCsv, branchToAppliesWhen, type CsvItem } from './onboard-tenant.js';

// Every org this script creates is named with this prefix, and teardown
// refuses to touch an org that doesn't have it — a second guard, on top of
// requiring the exact org id, against ever pointing the deletion path at a
// real tenant.
const PROSPECT_PREFIX = 'PROSPECT – ';

// Safety ceiling on the retention horizon a caller can request. 14 days is the
// default; --retention-days can shorten it further but not lengthen it past
// this, since the whole point is that this data does not linger.
const DEFAULT_RETENTION_DAYS = 14;
const MAX_RETENTION_DAYS = 30;

// Default scorecard this script attaches when --scorecard isn't given:
// CallGuard's actual market is FCA/MCOB-regulated mortgage and protection
// advice, so a mortgage prospect (the common case) gets a genuine MCOB
// scorecard rather than something off-topic. Pass --scorecard <path> for a
// different vertical.
const DEFAULT_SCORECARD_NAME = 'MCOB Mortgage Advice QA (demo)';
const DEFAULT_SCORECARD_CSV = path.resolve(__dirname, '../../../../sample_scorecards/mortgage/mcob-mortgage-advice.csv');

// Directory holding one real client's (Trust Point's) bespoke scorecards,
// which name the firm directly in their criteria text. Showing one firm's
// scorecard to a different prospect would be a client-confidentiality
// breach, so --scorecard is refused outright for any path under here —
// see assertScorecardAllowed() below.
const TRUSTPOINT_SCORECARD_DIR = path.resolve(__dirname, '../../../../sample_scorecards/trustpoint');

// Refuses any scorecard path under sample_scorecards/trustpoint/: those cards
// are one real client's bespoke content (they name the firm in the criteria
// text), and using them for a different prospect's demo would leak that
// client's confidential material to someone outside their organisation.
function assertScorecardAllowed(csvPath: string): void {
  const resolved = path.resolve(csvPath);
  const rel = path.relative(TRUSTPOINT_SCORECARD_DIR, resolved);
  const isUnderTrustpoint = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (isUnderTrustpoint) {
    throw new Error(
      `Refusing to use "${csvPath}" — it is under sample_scorecards/trustpoint/, which holds Trust Point's ` +
        `bespoke scorecards (their criteria text names the firm directly). Showing one client's scorecard to ` +
        `another prospect is a client-confidentiality breach. Use --scorecard to point at a different card, or ` +
        `omit it to use the default MCOB mortgage card.`
    );
  }
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/x-m4a',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
};

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

// Host + database name only — never the credentials embedded in the URL.
function dbTargetLabel(): string {
  try {
    const u = new URL(config.database.url);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(DATABASE_URL could not be parsed)';
  }
}

function printDbBanner(): void {
  const line = '='.repeat(70);
  console.log(line);
  console.log(`  TARGET DATABASE: ${dbTargetLabel()}`);
  console.log('  (this is almost certainly production — see .env DATABASE_URL)');
  console.log(line);
}

function teardownCommandFor(orgId: string): string {
  return `npx tsx src/scripts/score-prospect-calls.ts --teardown ${orgId} --yes`;
}

// ── Ingest mode ─────────────────────────────────────────────────────────

async function runIngest(): Promise<void> {
  const dir = arg('--dir');
  const orgLabel = arg('--org-name') || 'Unnamed Prospect';
  const industry = arg('--industry');
  const adminEmailArg = arg('--admin-email');
  const confirmed = process.argv.includes('--yes');
  const retentionArg = arg('--retention-days');
  const retentionDays = Math.min(
    retentionArg ? parseInt(retentionArg, 10) || DEFAULT_RETENTION_DAYS : DEFAULT_RETENTION_DAYS,
    MAX_RETENTION_DAYS
  );
  const scorecardArg = arg('--scorecard');
  const scorecardCsv = scorecardArg ? path.resolve(process.cwd(), scorecardArg) : DEFAULT_SCORECARD_CSV;
  const scorecardName = scorecardArg ? `${path.basename(scorecardArg, '.csv')} (demo)` : DEFAULT_SCORECARD_NAME;

  if (!dir) {
    console.error(
      'Usage: score-prospect-calls.ts --dir <path-to-audio-dir> [--org-name "<name>"] ' +
        '[--industry "<text>"] [--admin-email <email>] [--retention-days 14] ' +
        '[--scorecard <path-to-csv>] [--yes]'
    );
    process.exitCode = 1;
    return;
  }

  assertScorecardAllowed(scorecardCsv);

  const dirStat = fs.existsSync(dir) ? fs.statSync(dir) : null;
  if (!dirStat?.isDirectory()) {
    console.error(`Not a directory: ${dir}`);
    process.exitCode = 1;
    return;
  }

  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  const candidates = files.filter((f) => AUDIO_EXTENSIONS[path.extname(f).toLowerCase()]);
  const skippedExt = files.filter((f) => !AUDIO_EXTENSIONS[path.extname(f).toLowerCase()]);

  const scorecardItems: CsvItem[] = parseScorecardCsv(scorecardCsv);
  const orgName = `${PROSPECT_PREFIX}${orgLabel} (${new Date().toISOString().slice(0, 10)}-${randomBytes(2).toString('hex')})`;

  printDbBanner();
  console.log(`\nDirectory:        ${dir}`);
  console.log(`Audio files found: ${candidates.length} (${skippedExt.length} non-audio file(s) skipped)`);
  console.log(`Org to create:     ${orgName}`);
  console.log(
    `Scorecard:         ${scorecardName} (${scorecardCsv}) — ${scorecardItems.length} items ` +
      `(${scorecardItems.filter((i) => i.consent_gate).length} consent gate(s))`
  );
  console.log(`Retention horizon: ${retentionDays} day(s)`);
  if (candidates.length === 0) {
    console.log('\nNo audio files found in that directory — nothing to do.');
    return;
  }

  if (!confirmed) {
    console.log('\nPREVIEW ONLY — nothing has been written. Re-run with --yes to create the org and ingest these calls.');
    return;
  }

  console.log('\nCreating throwaway org...');
  const org = await queryOne<{ id: string }>(
    `INSERT INTO organizations (name, plan) VALUES ($1, 'core') RETURNING id`,
    [orgName]
  );
  const orgId = org!.id;
  await query(
    `UPDATE organizations SET
       scoring_scope = 'everything',
       retention_days = $2,
       industry = COALESCE($3, industry),
       updated_at = now()
     WHERE id = $1`,
    [orgId, retentionDays, industry]
  );
  console.log(`  org ${orgId} created (scoring_scope=everything, retention_days=${retentionDays})`);

  console.log('Creating demo admin login...');
  const adminEmail = adminEmailArg || `prospect-demo+${randomBytes(4).toString('hex')}@callguardai.co.uk`;
  const tempPassword = randomBytes(9).toString('base64url') + 'Cg1!';
  const adminHash = await bcrypt.hash(tempPassword, 12);
  const admin = await queryOne<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, password_hash, role)
     VALUES ($1, $2, 'Demo Admin', $3, 'admin') RETURNING id`,
    [orgId, adminEmail, adminHash]
  );
  const adminId = admin!.id;
  console.log(`  admin ${adminEmail} created`);

  console.log('Attaching scorecard...');
  const scorecard = await queryOne<{ id: string }>(
    `INSERT INTO scorecards (organization_id, name, description, scoring_mode, is_active, created_by)
     VALUES ($1, $2, $3, 'per_call', true, $4) RETURNING id`,
    [orgId, scorecardName, `Reused as-is for a prospect demo from ${path.relative(path.resolve(__dirname, '../../../../'), scorecardCsv)}.`, adminId]
  );
  const scorecardId = scorecard!.id;
  for (let i = 0; i < scorecardItems.length; i++) {
    const it = scorecardItems[i]!;
    await query(
      `INSERT INTO scorecard_items
         (scorecard_id, label, description, score_type, weight, sort_order,
          severity, section, item_type, applies_when, expectation, ai_check, consent_gate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        scorecardId, it.label, it.description || null, it.score_type, it.weight, i,
        it.severity, it.section, it.item_type, branchToAppliesWhen(it.branch),
        it.expectation, it.ai_check, it.consent_gate,
      ]
    );
  }
  console.log(
    `  scorecard ${scorecardId} attached (${scorecardItems.length} items, ` +
      `${scorecardItems.filter((i) => i.consent_gate).length} consent gate(s) preserved)`
  );

  console.log(`\nIngesting ${candidates.length} call(s) through the ordinary hydrate -> transcribe -> score pipeline...`);
  let ingested = 0;
  let duplicates = 0;
  let failed = 0;
  for (const fileName of candidates) {
    const filePath = path.join(dir, fileName);
    const mimeType = AUDIO_EXTENSIONS[path.extname(fileName).toLowerCase()]!;
    if (!ALLOWED_UPLOAD_MIME_TYPES.includes(mimeType)) {
      console.log(`  [skip]   ${fileName} — mime type ${mimeType} not accepted by the ingest pipeline`);
      continue;
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.length > MAX_UPLOAD_FILE_SIZE_BYTES) {
      console.log(`  [skip]   ${fileName} — ${Math.round(buffer.length / 1024 / 1024)}MB exceeds the upload ceiling`);
      continue;
    }
    try {
      const { call, isDuplicate } = await ingestCall({
        organizationId: orgId,
        uploadedBy: adminId,
        fileName,
        buffer,
        mimeType,
        ingestionSource: 'upload',
        scorecardId,
      });
      if (isDuplicate) {
        duplicates++;
        console.log(`  [dup]    ${fileName} -> call ${call.id}`);
      } else {
        ingested++;
        console.log(`  [queued] ${fileName} -> call ${call.id}`);
      }
    } catch (err) {
      failed++;
      console.error(`  [FAILED] ${fileName}: ${(err as Error).message}`);
    }
  }

  console.log(`\nIngested ${ingested} call(s), ${duplicates} duplicate(s), ${failed} failed, ${skippedExt.length} non-audio file(s) skipped.`);
  console.log('Transcription and scoring happen asynchronously on the worker — give it a few minutes per call before the demo.');

  console.log('\n=== Done ===');
  console.log(`Org id:     ${orgId}`);
  console.log(`Admin login: ${adminEmail}`);
  console.log(`Temp password (send securely, shown once): ${tempPassword}`);
  console.log(`View results: ${config.appUrl}/login (then Calls) once scoring completes.`);
  console.log(
    `\nREMINDER: this org holds a prospect's real customer data. Tear it down as soon as the demo is over:\n` +
      `  ${teardownCommandFor(orgId)}\n`
  );
}

// ── Teardown mode ───────────────────────────────────────────────────────

async function runTeardown(orgId: string): Promise<void> {
  const confirmed = process.argv.includes('--yes');

  printDbBanner();

  const org = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE id = $1`,
    [orgId]
  );
  if (!org) {
    console.error(`\nNo organization with id ${orgId}.`);
    process.exitCode = 1;
    return;
  }
  if (!org.name.startsWith(PROSPECT_PREFIX)) {
    console.error(
      `\nRefusing to tear down "${org.name}" — its name doesn't start with "${PROSPECT_PREFIX}", ` +
        `so it wasn't created by this script and may be a real tenant. Use the superadmin console or ` +
        `services/tenant-deletion.ts directly if a real tenant genuinely needs deleting.`
    );
    process.exitCode = 1;
    return;
  }

  const calls = await query<{ id: string; file_key: string | null }>(
    `SELECT id, file_key FROM calls WHERE organization_id = $1`,
    [orgId]
  );
  const withAudio = calls.filter((c) => c.file_key);

  console.log(`\nOrg:    ${org.name} (${org.id})`);
  console.log(`Calls:  ${calls.length}, of which ${withAudio.length} have stored audio to delete`);

  if (!confirmed) {
    console.log('\nPREVIEW ONLY — nothing has been deleted. Re-run with --yes to permanently delete this org, its calls, audio and transcripts.');
    return;
  }

  console.log('\nDeleting audio files (before any database rows, so a failed delete can never orphan a file)...');
  let audioDeleted = 0;
  const stranded: string[] = [];
  for (const c of withAudio) {
    try {
      await deleteFile(c.file_key!);
      audioDeleted++;
    } catch (err) {
      console.error(`  ! audio delete failed for call ${c.id}: ${(err as Error).message}`);
      stranded.push(c.id);
    }
  }
  console.log(`  ${audioDeleted}/${withAudio.length} audio file(s) deleted.`);

  if (stranded.length > 0) {
    console.error(
      `\n${stranded.length} audio file(s) could not be deleted — leaving the org and all its rows in place so the ` +
        `files stay locatable, rather than deleting the database rows out from under them. Retry teardown once the ` +
        `underlying storage issue is fixed:\n  ${teardownCommandFor(orgId)}`
    );
    process.exitCode = 1;
    return;
  }

  console.log('Deleting the org and every remaining row (calls, transcripts, scores, breaches, scorecard)...');
  const result = await deleteOrganizationCascade(orgId, { userId: null, orgName: org.name });
  console.log(`  ${result.total} row(s) deleted across ${Object.keys(result.counts).length} table(s).`);

  console.log(`\n=== Torn down: ${org.name} (${org.id}) ===`);
}

// ── Entry point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const teardownOrgId = arg('--teardown');
  if (teardownOrgId) {
    await runTeardown(teardownOrgId);
  } else {
    await runIngest();
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  process.exit(1);
});
