// Report, per tenant, how much scored evidence cannot be shown to a reviewer.
//
// Journey evidence is attributed by parsing the "[Call N]" prefix the scorer is
// asked to put on each quote. It omits that prefix on roughly one quote in six,
// and every one of those was stored with source_call_id NULL.
//
// That is not cosmetic. The review panel loads through source_call_id, so an
// unattributed checkpoint offers no transcript excerpt, no audio player, and no
// notice that the call's speaker labels were found unreliable — the warning
// renders from the same payload. The reviewer is told to open the sale and find
// it themselves, then asked to rule on a compliance checkpoint.
//
// THIS SCRIPT WRITES NOTHING. The repair lives in two migrations, which run in
// order at deploy and are idempotent:
//
//   083  attributes the unambiguous case — a sale that was scored on exactly
//        one call has exactly one call the quote came from.
//   084  gives everything still unattributed an honest caveat, so the register
//        stops reading those breaches as "no known weakness".
//
// Deliberately not a --commit tool. Doing 083's half without 084's would leave
// a checkpoint pointed at a call with unreliable speakers and no caveat saying
// so — re-introducing, by hand, the exact dishonesty 084 exists to remove. One
// place repairs; this one reports.
//
// Usage:
//   tsx src/scripts/report-unattributed-evidence.ts [<orgId|nameSubstring>]
//
// Omit the tenant to sweep every organization. Read-only, so it is safe to run
// against production at any time — before a deploy to size the problem, after
// one to confirm the migrations did what they said.
import { pool, query, queryOne } from '../db/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOrg(idOrName: string): Promise<{ id: string; name: string }> {
  if (UUID_RE.test(idOrName)) {
    const row = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [idOrName]
    );
    if (!row) throw new Error(`No organization with id ${idOrName}`);
    return row;
  }
  const rows = await query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE name ILIKE $1 ORDER BY name',
    [`%${idOrName}%`]
  );
  if (rows.length === 0) throw new Error(`No organization matching "${idOrName}"`);
  if (rows.length > 1) {
    throw new Error(
      `Ambiguous tenant "${idOrName}" — matches:\n` + rows.map((r) => `  ${r.id}  ${r.name}`).join('\n')
    );
  }
  return rows[0]!;
}

// Every unattributed checkpoint, split by whether migration 083 can resolve it.
// The rule here is character-for-character the migration's, including the
// journey_score_runs guard — a report that disagrees with the repair is worse
// than no report.
const SELECT_UNATTRIBUTED = `
  WITH single_call AS (
    SELECT jc.journey_id
      FROM journey_calls jc
      JOIN calls c ON c.id = jc.call_id
     WHERE c.transcript_text IS NOT NULL
     GROUP BY jc.journey_id
    HAVING COUNT(*) = 1
  ),
  scored_single AS (
    SELECT DISTINCT ON (journey_id) journey_id, calls_scored
      FROM journey_score_runs
     ORDER BY journey_id, run_number DESC
  )
  SELECT j.id AS journey_id,
         COALESCE(j.client_name, '(unnamed)') AS client,
         jis.result,
         (sc.journey_id IS NOT NULL AND ss.calls_scored = 1) AS resolvable
    FROM journey_item_scores jis
    JOIN journeys j ON j.id = jis.journey_id
    LEFT JOIN single_call sc ON sc.journey_id = j.id
    LEFT JOIN scored_single ss ON ss.journey_id = j.id
   WHERE jis.source_call_id IS NULL
`;

async function main() {
  const orgArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const org = orgArg ? await resolveOrg(orgArg) : null;

  console.log(`Unattributed journey evidence — ${org ? `${org.name} (${org.id})` : 'ALL organizations'}`);
  console.log('Read-only. The repair is migrations 083 and 084.\n');

  const rows = await query<{
    journey_id: string;
    client: string;
    result: string;
    resolvable: boolean;
  }>(
    org ? `${SELECT_UNATTRIBUTED} AND j.organization_id = $1` : SELECT_UNATTRIBUTED,
    org ? [org.id] : []
  );

  if (rows.length === 0) {
    console.log('Nothing unattributed — every scored checkpoint can show its evidence.');
    return;
  }

  const resolvable = rows.filter((r) => r.resolvable);
  const ambiguous = rows.filter((r) => !r.resolvable);
  const pending = (rs: typeof rows) => rs.filter((r) => r.result === 'manual_review').length;
  const sales = (rs: typeof rows) => new Set(rs.map((r) => r.journey_id)).size;

  console.log(`${rows.length} unattributed checkpoint(s) across ${sales(rows)} sale(s).`);
  console.log(`${pending(rows)} are awaiting review — a reviewer opens those to an empty panel.\n`);

  console.log(`Migration 083 resolves ${resolvable.length} of them (${sales(resolvable)} sale(s), ` +
    `${pending(resolvable)} awaiting review):`);
  const bySale = new Map<string, { client: string; items: number; pending: number }>();
  for (const r of resolvable) {
    const s = bySale.get(r.journey_id) ?? { client: r.client, items: 0, pending: 0 };
    s.items += 1;
    if (r.result === 'manual_review') s.pending += 1;
    bySale.set(r.journey_id, s);
  }
  const listed = [...bySale.entries()].sort((a, b) => b[1].items - a[1].items);
  for (const [journeyId, s] of listed.slice(0, 20)) {
    const awaiting = s.pending > 0 ? `, ${s.pending} awaiting review` : '';
    console.log(`  ${String(s.items).padStart(3)} × ${s.client} (${journeyId.slice(0, 8)}${awaiting})`);
  }
  if (listed.length > 20) console.log(`  … and ${listed.length - 20} more sale(s)`);

  console.log(
    `\n${ambiguous.length} stay(s) unattributed (${sales(ambiguous)} sale(s), ` +
      `${pending(ambiguous)} awaiting review).`
  );
  console.log('Either the sale genuinely has several calls the quote could have come from, or a');
  console.log('call has since been deleted and the sale can no longer be trusted to be');
  console.log('single-call. Migration 084 caveats these rather than guessing at them.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
