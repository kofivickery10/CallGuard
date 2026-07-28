/**
 * One-off backfill: score already-sold customers whose calls predate live
 * capture, by pulling their call history from CloudTalk on demand.
 *
 * For each customer, this fetches their calls from CloudTalk (by phone, within
 * the window), records any we don't already have as 'captured' metadata rows,
 * then scores them through the exact same pipeline the Zoho sale trigger
 * drives, just kicked off manually.
 *
 * Where the customer already has a scored sale, the recovered calls are
 * attached to THAT sale and it is re-scored in place — the tenant ends up with
 * one corrected sale, not a second one beside the original. A customer with no
 * scored sale yet gets a new journey as before.
 *
 * The worker MUST be running: this enqueues hydrate/transcribe/score jobs and
 * returns; the worker fetches the recordings, transcribes and scores async.
 *
 * Backfill only reaches as far back as CloudTalk still retains the recordings.
 *
 * Usage:
 *   ORG=<org-uuid> PHONES="+447700900001,+447700900002" \
 *     npx tsx src/scripts/backfill-journeys.ts
 *   # or from a file, one phone per line:
 *   ORG=<org-uuid> PHONE_FILE=./phones.txt npx tsx src/scripts/backfill-journeys.ts
 *   # or target sales directly by journey id (keeps phone numbers out of the shell):
 *   ORG=<org-uuid> JOURNEYS="<journey-uuid>,<journey-uuid>" npx tsx src/scripts/backfill-journeys.ts
 *   # preview only (fetch history, no capture/scoring):
 *   ORG=<org-uuid> PHONES="+447700900001" DRY_RUN=1 npx tsx src/scripts/backfill-journeys.ts
 *   # override the history window (default: connection's history_window_days):
 *   ORG=<org-uuid> PHONES="..." DAYS=90 npx tsx src/scripts/backfill-journeys.ts
 */

import fs from 'fs';
import { query, queryOne } from '../db/client.js';
import { getDialerConnection } from '../services/tenant-settings.js';
import { fetchCallsInWindow, natSig, type CloudTalkHistoryEntry } from '../services/cloudtalk.js';
import { captureCallMetadata, normalizePhone } from '../services/ingestion.js';
import { assembleJourney } from '../services/journey.js';

const orgId = process.env.ORG;
const phonesEnv = process.env.PHONES;
const phoneFile = process.env.PHONE_FILE;
const journeyIdsEnv = process.env.JOURNEYS;
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const daysOverride = process.env.DAYS ? parseInt(process.env.DAYS, 10) : null;

if (!orgId) {
  console.error('ORG (organization uuid) is required');
  process.exit(1);
}

/**
 * Resolve JOURNEYS=<uuid,uuid> to the customers' phone numbers.
 *
 * Targeting a sale by its id is the natural way to drive this: the sales whose
 * calls need recovering are identified from the sale list, and it keeps
 * customer phone numbers out of shell history and process arguments.
 */
async function phonesForJourneys(ids: string[]): Promise<string[]> {
  const rows = await query<{ journey_id: string; phone: string | null }>(
    `SELECT j.id AS journey_id, cu.phone_normalized AS phone
       FROM journeys j JOIN customers cu ON cu.id = j.customer_id
      WHERE j.organization_id = $1 AND j.id = ANY($2::uuid[])`,
    [orgId as string, ids]
  );
  const found = new Map(rows.map((r) => [r.journey_id, r.phone]));
  const phones: string[] = [];
  for (const id of ids) {
    const phone = found.get(id);
    if (!phone) {
      console.warn(`[Backfill] journey ${id} — not found in this org, or its customer has no phone; skipping`);
      continue;
    }
    phones.push(phone);
  }
  return phones;
}

async function readPhones(): Promise<string[]> {
  const raw: string[] = [];
  if (phonesEnv) raw.push(...phonesEnv.split(','));
  if (phoneFile) raw.push(...fs.readFileSync(phoneFile, 'utf8').split(/\r?\n/));
  if (journeyIdsEnv) {
    raw.push(...(await phonesForJourneys(journeyIdsEnv.split(',').map((s) => s.trim()).filter(Boolean))));
  }
  const cleaned = raw.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    console.error('No customers to process (set PHONES, PHONE_FILE or JOURNEYS)');
    process.exit(1);
  }
  // De-duplicate: two journey ids can belong to one customer.
  return [...new Set(cleaned)];
}

async function run() {
  // Preflight: calls.dialer_call_id (migration 075) is what stops this script
  // re-ingesting calls already captured live. Running without it would either
  // blow up mid-sweep on the dry-run check, or — worse, on a real run — dedupe
  // on external_id alone and silently duplicate every live-captured call.
  //
  // Checked before the CloudTalk sweep rather than after: that sweep pages tens
  // of thousands of CDRs and takes a minute, and there is no reason to spend it
  // only to fail on a missing column.
  const hasColumn = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'calls' AND column_name = 'dialer_call_id'`
  );
  if (!hasColumn?.n) {
    console.error(
      'Migration 075 has not been applied to this database — calls.dialer_call_id is missing.\n' +
        'Without it a backfill cannot tell which calls are already on file and would duplicate them.\n' +
        'Run `npm run migrate` against this DATABASE_URL first, then re-run this script.'
    );
    process.exit(1);
  }

  const conn = await getDialerConnection(orgId as string, 'cloudtalk');
  if (!conn) {
    console.error(`No CloudTalk connection for org ${orgId}`);
    process.exit(1);
  }
  const windowDays = daysOverride ?? conn.history_window_days;

  const phones = await readPhones();
  console.log(
    `[Backfill] org=${orgId} phones=${phones.length} window=${windowDays}d${dryRun ? ' (DRY RUN)' : ''}`
  );

  // CloudTalk's server-side filters don't work, so page the whole window ONCE
  // and index every call by its (national-significant) external number. All the
  // requested phones are then matched against this single in-memory index —
  // rather than paging the window per phone.
  console.log(`[Backfill] fetching CloudTalk calls for the last ${windowDays}d (this can take a minute)…`);
  const allCalls = await fetchCallsInWindow(conn, windowDays);
  const byNumber = new Map<string, CloudTalkHistoryEntry[]>();
  for (const e of allCalls) {
    const k = natSig(e.externalNumber);
    if (!k) continue;
    (byNumber.get(k) ?? byNumber.set(k, []).get(k)!).push(e);
  }
  console.log(`[Backfill] indexed ${allCalls.length} call(s) across ${byNumber.size} distinct number(s)`);

  let assembled = 0;
  let noCalls = 0;
  for (const rawPhone of phones) {
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      console.warn(`[Backfill] "${rawPhone}" — could not normalise, skipping`);
      continue;
    }

    const history = byNumber.get(natSig(phone)) ?? [];
    if (history.length === 0) {
      console.log(`[Backfill] ${phone} — no matching CloudTalk calls in window (retention? number not in CloudTalk?)`);
      noCalls++;
      continue;
    }

    // Skip sub-15s calls (no-answers / voicemails) — same threshold as the live
    // capture webhook.
    const usable = history.filter((e) => e.durationSeconds == null || e.durationSeconds >= 15);
    const contactName = history.find((e) => e.contactName)?.contactName ?? null;

    if (dryRun) {
      // Split into "already on file" vs "would be created" using the same key
      // captureCallMetadata dedupes on (migration 075). This is the check worth
      // running before a real backfill: if the dedupe key were wrong, every
      // call already captured live would show up here as new, and the sale
      // would end up scored twice over the same conversations.
      const held = await query<{ dialer_call_id: string | null; external_id: string | null }>(
        `SELECT dialer_call_id, external_id FROM calls
          WHERE organization_id = $1
            AND (dialer_call_id = ANY($2::text[]) OR external_id = ANY($2::text[]))`,
        [orgId as string, usable.map((e) => e.id)]
      );
      const heldIds = new Set(held.flatMap((r) => [r.dialer_call_id, r.external_id].filter(Boolean) as string[]));
      const fresh = usable.filter((e) => !heldIds.has(e.id));
      console.log(
        `[Backfill] ${phone} — ${history.length} matched call(s), ${usable.length} ≥15s` +
          `${contactName ? ` (contact: ${contactName})` : ''}: ` +
          `${fresh.length} to ingest, ${usable.length - fresh.length} already on file (dry run)`
      );
      for (const e of fresh) {
        const mins = e.durationSeconds == null ? '?' : Math.round(e.durationSeconds / 60);
        console.log(`             + ${e.startedAt ?? 'unknown date'}  ${mins}m  ${e.agentName ?? 'unknown agent'}  (${e.id})`);
      }
      continue;
    }

    if (usable.length === 0) {
      console.log(`[Backfill] ${phone} — matched calls all <15s, nothing to score`);
      noCalls++;
      continue;
    }

    // Record each CloudTalk call as a 'captured' metadata row (idempotent by
    // org+external_id). recording_pointer is left null — hydration fetches a
    // fresh URL by the call id, dodging any expired URL in the history entry.
    let customerId: string | null = null;
    for (const entry of usable) {
      const { call } = await captureCallMetadata({
        organizationId: orgId as string,
        externalId: entry.id,
        cloudtalkCallId: entry.id,
        // The shared key with live capture (migration 075). Without it this
        // dedupes on external_id alone, which the webhook fills with CloudTalk's
        // call_uuid rather than this numeric CDR id — so every call already
        // captured live would be re-ingested here as a second row, and the sale
        // scored twice over the same conversations.
        dialerCallId: entry.id,
        recordingPointer: null,
        agentEmail: entry.agentEmail,
        agentExternalId: entry.agentExternalId,
        agentName: entry.agentName,
        customerPhone: phone,
        customerName: entry.contactName,
        callDate: entry.startedAt,
        direction: entry.direction,
        durationSeconds: entry.durationSeconds,
        dialerConnectionId: conn.id,
      });
      customerId = (call as typeof call & { customer_id?: string | null }).customer_id ?? customerId;
    }

    if (!customerId) {
      console.warn(`[Backfill] ${phone} — captured no calls, skipping`);
      noCalls++;
      continue;
    }

    // Mend the customer's existing sale rather than opening a second one. The
    // recovered calls belong to a sale that has already been scored — they were
    // missing only because they predate the dialler webhook going live — so a
    // new journey would leave the tenant with two entries for one customer, the
    // older one scored on partial evidence. Falls back to creating a journey
    // when the customer has no scored sale yet.
    const journeyId = await assembleJourney({
      organizationId: orgId as string,
      customerId,
      triggerSource: 'manual',
      extendExisting: true,
    });
    if (journeyId) {
      console.log(`[Backfill] ${phone} — ${usable.length} call(s) → journey ${journeyId} (scoring async)`);
      assembled++;
    } else {
      console.log(`[Backfill] ${phone} — nothing to assemble (no active scorecard?)`);
    }
  }

  console.log(`[Backfill] done: ${assembled} journey(s) assembled, ${noCalls} with no calls`);
  process.exit(0);
}

run().catch((err) => {
  console.error('[Backfill] failed:', err);
  process.exit(1);
});
