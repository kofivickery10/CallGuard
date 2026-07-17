/**
 * One-off backfill: score already-sold customers whose calls predate live
 * capture, by pulling their call history from CloudTalk on demand.
 *
 * For each phone number, this fetches the customer's calls from CloudTalk
 * (by phone, within the window), records any we don't already have as
 * 'captured' metadata rows, then assembles + scores the journey — the exact
 * same pipeline the Zoho sale trigger drives, just kicked off manually.
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
 *   # preview only (fetch history, no capture/scoring):
 *   ORG=<org-uuid> PHONES="+447700900001" DRY_RUN=1 npx tsx src/scripts/backfill-journeys.ts
 *   # override the history window (default: connection's history_window_days):
 *   ORG=<org-uuid> PHONES="..." DAYS=90 npx tsx src/scripts/backfill-journeys.ts
 */

import fs from 'fs';
import { queryOne } from '../db/client.js';
import { getDialerConnection } from '../services/tenant-settings.js';
import { fetchCallsInWindow, natSig, type CloudTalkHistoryEntry } from '../services/cloudtalk.js';
import { captureCallMetadata, normalizePhone } from '../services/ingestion.js';
import { assembleJourney } from '../services/journey.js';

const orgId = process.env.ORG;
const phonesEnv = process.env.PHONES;
const phoneFile = process.env.PHONE_FILE;
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const daysOverride = process.env.DAYS ? parseInt(process.env.DAYS, 10) : null;

if (!orgId) {
  console.error('ORG (organization uuid) is required');
  process.exit(1);
}

function readPhones(): string[] {
  const raw: string[] = [];
  if (phonesEnv) raw.push(...phonesEnv.split(','));
  if (phoneFile) raw.push(...fs.readFileSync(phoneFile, 'utf8').split(/\r?\n/));
  const cleaned = raw.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    console.error('No phone numbers provided (set PHONES or PHONE_FILE)');
    process.exit(1);
  }
  return cleaned;
}

async function run() {
  const conn = await getDialerConnection(orgId as string, 'cloudtalk');
  if (!conn) {
    console.error(`No CloudTalk connection for org ${orgId}`);
    process.exit(1);
  }
  const windowDays = daysOverride ?? conn.history_window_days;

  const phones = readPhones();
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
      console.log(
        `[Backfill] ${phone} — ${history.length} matched call(s), ${usable.length} ≥15s` +
          `${contactName ? ` (contact: ${contactName})` : ''} (dry run, not ingesting)`
      );
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

    const journeyId = await assembleJourney({
      organizationId: orgId as string,
      customerId,
      triggerSource: 'manual',
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
