// Manually replay one or more Zoho sale-trigger deliveries through
// assemble-journey — for sales that already fired the webhook (so CallGuard
// has the phone + Zoho record id from the API log) but never produced a
// journey, e.g. because of a since-fixed zoho_connections config error
// (a bad sale_module/policies_related_list/policy_product_field value makes
// fetchSaleProducts fail every poll until the 75-minute product-wait deadline
// elapses).
//
// This does NOT call Zoho's sale-trigger webhook again — it enqueues the same
// 'assemble-journey' job the route would have, using the phone/recordId you
// already have from the log line (grep the API log for
// '[Zoho] sale-trigger accepted'). assembleJourney is idempotent
// (services/journey.ts), so replaying a sale that already produced a journey
// is a safe no-op, not a duplicate.
//
// Needs the worker running on the same Redis this script connects to (it
// enqueues; the worker processes the job).
//
// Usage:
//   tsx src/scripts/reprocess-zoho-sales.ts <orgId|nameSubstring> --sales="phone:recordId,phone:recordId"
//   tsx src/scripts/reprocess-zoho-sales.ts <orgId|nameSubstring> --sales-file=./sales.txt
//     # sales.txt: one per line, "phone,recordId[,clientName]"
//   Add --commit to actually enqueue (default is a dry run that just prints
//   what would happen).
//
// Example:
//   tsx src/scripts/reprocess-zoho-sales.ts "Trust Point" \
//     --sales="+447514404992:893027000011004115" --commit
import fs from 'fs';
import { pool, queryOne } from '../db/client.js';
import { ingestionQueue } from '../jobs/queue.js';
import { normalizePhone } from '../services/ingestion.js';
import { getConnectionRow } from '../services/zoho.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors routes/integrations.ts MAX_PRODUCT_WAIT_MS — kept in sync manually
// since this is a one-off ops script, not shared code.
const MAX_PRODUCT_WAIT_MS = 75 * 60 * 1000;

interface SaleEntry {
  phone: string;
  recordId: string | null;
  clientName: string | null;
}

async function resolveOrg(idOrName: string): Promise<{ id: string; name: string }> {
  if (UUID_RE.test(idOrName)) {
    const row = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [idOrName]
    );
    if (!row) throw new Error(`No organization with id ${idOrName}`);
    return row;
  }
  const rows = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE name ILIKE $1 ORDER BY name',
    [`%${idOrName}%`]
  );
  if (rows.rows.length === 0) throw new Error(`No organization matching "${idOrName}"`);
  if (rows.rows.length > 1) {
    throw new Error(
      `Ambiguous tenant "${idOrName}" — matches:\n` +
        rows.rows.map((r) => `  ${r.id}  ${r.name}`).join('\n')
    );
  }
  return rows.rows[0]!;
}

function parseEntry(raw: string): SaleEntry {
  const [rawPhone, recordId, clientName] = raw.split(/[:,]/).map((s) => s?.trim());
  if (!rawPhone) throw new Error(`Could not parse sale entry "${raw}"`);
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new Error(`Could not normalise phone "${rawPhone}" in entry "${raw}"`);
  return { phone, recordId: recordId || null, clientName: clientName || null };
}

function readEntries(): SaleEntry[] {
  const salesArg = process.argv.find((a) => a.startsWith('--sales='))?.slice('--sales='.length);
  const salesFileArg = process.argv
    .find((a) => a.startsWith('--sales-file='))
    ?.slice('--sales-file='.length);

  const raw: string[] = [];
  if (salesArg) raw.push(...salesArg.split(','));
  if (salesFileArg) raw.push(...fs.readFileSync(salesFileArg, 'utf8').split(/\r?\n/));
  const cleaned = raw.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    console.error('No sales provided — use --sales="phone:recordId,..." or --sales-file=./sales.txt');
    process.exit(1);
  }
  return cleaned.map(parseEntry);
}

async function run() {
  const orgArg = process.argv[2];
  const commit = process.argv.includes('--commit');
  if (!orgArg) {
    console.error('Usage: tsx src/scripts/reprocess-zoho-sales.ts <orgId|nameSubstring> --sales="..." [--commit]');
    process.exit(1);
  }

  const org = await resolveOrg(orgArg);
  const entries = readEntries();

  const conn = await getConnectionRow(org.id);
  const productResolutionConfigured = !!(
    conn?.sale_module && conn?.policies_related_list && conn?.policy_product_field
  );

  console.log(
    `[Reprocess] org="${org.name}" (${org.id}) sales=${entries.length} ` +
      `productResolution=${productResolutionConfigured ? 'configured' : 'not configured'}` +
      (commit ? '' : ' (DRY RUN — pass --commit to enqueue)')
  );

  for (const entry of entries) {
    const productDeadlineAt =
      productResolutionConfigured && entry.recordId ? Date.now() + MAX_PRODUCT_WAIT_MS : undefined;

    console.log(
      `  phone=${entry.phone} recordId=${entry.recordId ?? 'none'} client=${entry.clientName ?? 'none'} ` +
        `productDeadline=${productDeadlineAt ? 'set' : 'none'}`
    );

    if (!commit) continue;

    await ingestionQueue.add('assemble-journey', {
      organizationId: org.id,
      phone: entry.phone,
      recordId: entry.recordId,
      clientName: entry.clientName,
      productDeadlineAt,
      triggerContext: null,
    });
  }

  if (!commit) {
    console.log('\nDry run only — re-run with --commit to actually enqueue these.');
  } else {
    console.log(`\nEnqueued ${entries.length} assemble-journey job(s). Check the worker log for [AssembleJourney] lines.`);
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
