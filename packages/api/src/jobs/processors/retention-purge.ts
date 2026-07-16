import { Job } from 'bullmq';
import { query } from '../../db/client.js';
import { deleteFile } from '../../services/storage.js';

const ARCHIVE_AFTER_DAYS = 730; // 2yr live in the portal (spec §15)
const TERMINATION_PURGE_AFTER_DAYS = 30; // return/delete within 30 days of termination
// Never-converted 'captured' calls (metadata only, no audio) are personal data
// that should not sit for the full retention window. Once a capture is older
// than any journey window could reach back (default 30d + generous margin) and
// still hasn't been pulled into a journey, it will never be — purge it.
const CAPTURED_PURGE_AFTER_DAYS = 90;

interface OrgRetentionRow {
  id: string;
  retention_days: number;
}

interface PurgeableCall {
  id: string;
  file_key: string | null;
}

/**
 * Daily retention lifecycle sweep (spec §15), per tenant:
 *  1. Archive (hide from the default portal view, keep the data) calls older
 *     than 2 years.
 *  2. Purge (delete the audio file + the call row, cascading to scores/
 *     breaches) calls older than the tenant's retention_days (5yr default).
 *  3. For cancelled orgs, purge everything once 30 days past cancellation —
 *     the return/delete-on-termination obligation.
 * Best-effort per call: a single failed file delete logs and continues
 * rather than aborting the whole sweep.
 */
export async function processRetentionPurge(_job: Job): Promise<void> {
  const orgs = await query<OrgRetentionRow>(
    `SELECT id, retention_days FROM organizations WHERE status != 'cancelled'`
  );

  let archivedTotal = 0;
  let purgedTotal = 0;

  for (const org of orgs) {
    const archived = await query<{ id: string }>(
      `UPDATE calls SET archived_at = now()
         WHERE organization_id = $1
           AND archived_at IS NULL
           AND COALESCE(call_date::timestamptz, created_at) < now() - interval '1 day' * $2
         RETURNING id`,
      [org.id, ARCHIVE_AFTER_DAYS]
    );
    archivedTotal += archived.length;

    purgedTotal += await purgeCalls(
      `SELECT id, file_key FROM calls
         WHERE organization_id = $1
           AND COALESCE(call_date::timestamptz, created_at) < now() - interval '1 day' * $2`,
      [org.id, org.retention_days]
    );

    // Never-converted captured metadata: purge well before the full retention
    // window. Scoped to captures not attached to any journey (journey_id NULL)
    // so a call being hydrated into a journey is never yanked out from under it.
    purgedTotal += await purgeCalls(
      `SELECT id, file_key FROM calls
         WHERE organization_id = $1
           AND status = 'captured'
           AND journey_id IS NULL
           AND created_at < now() - interval '1 day' * $2`,
      [org.id, CAPTURED_PURGE_AFTER_DAYS]
    );

    // Customers left with no calls and no journeys are orphaned personal data
    // (name + normalised phone) — remove them. They are re-created on demand if
    // that number is dialled again, so this is safe to run every sweep.
    await query(
      `DELETE FROM customers c
        WHERE c.organization_id = $1
          AND NOT EXISTS (SELECT 1 FROM calls ca WHERE ca.customer_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM journeys j WHERE j.customer_id = c.id)`,
      [org.id]
    ).catch((err) => console.error(`[Retention] Failed to purge orphan customers for org ${org.id}:`, (err as Error).message));

    // A journey whose calls have all aged out is now empty (journey_calls
    // cascaded away with the calls) — delete it so its transcript-quote
    // evidence and journey-level breaches don't outlive the calls they came
    // from. Journeys that still reference at least one live call are kept.
    await query(
      `DELETE FROM journeys j
        WHERE j.organization_id = $1
          AND NOT EXISTS (SELECT 1 FROM journey_calls jc WHERE jc.journey_id = j.id)`,
      [org.id]
    ).catch((err) => console.error(`[Retention] Failed to purge empty journeys for org ${org.id}:`, (err as Error).message));
  }

  // Terminated tenants: purge everything (not just aged-out calls) once 30
  // days past cancellation — the return/delete-on-termination obligation.
  const terminated = await query<{ id: string }>(
    `SELECT id FROM organizations
       WHERE status = 'cancelled'
         AND cancelled_at IS NOT NULL
         AND cancelled_at < now() - interval '1 day' * $1`,
    [TERMINATION_PURGE_AFTER_DAYS]
  );
  for (const org of terminated) {
    purgedTotal += await purgeCalls(`SELECT id, file_key FROM calls WHERE organization_id = $1`, [org.id]);
    // After the calls are gone, remove the remaining personal-data records:
    // journeys (with their evidence + journey-level breaches, via CASCADE) and
    // customers (names + normalised phone numbers). Deleting customers also
    // CASCADE-removes any journeys not already cleared, but delete journeys
    // first so the log below reflects the intended two-step purge.
    await query('DELETE FROM journeys WHERE organization_id = $1', [org.id]).catch((err) =>
      console.error(`[Retention] Failed to purge journeys for terminated org ${org.id}:`, (err as Error).message)
    );
    await query('DELETE FROM customers WHERE organization_id = $1', [org.id]).catch((err) =>
      console.error(`[Retention] Failed to purge customers for terminated org ${org.id}:`, (err as Error).message)
    );
  }

  console.log(
    `[Retention] Swept ${orgs.length} org(s): archived ${archivedTotal}, purged ${purgedTotal}, ${terminated.length} terminated org(s) fully purged`
  );
}

async function purgeCalls(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<PurgeableCall>(sql, params);
  let deleted = 0;
  for (const call of rows) {
    // A 'captured' call is metadata-only — no audio was ever fetched, so there
    // is no file to delete; go straight to removing the row.
    if (call.file_key === null) {
      try {
        await query('DELETE FROM calls WHERE id = $1', [call.id]);
        deleted++;
      } catch (err) {
        console.error(`[Retention] Failed to delete metadata-only call ${call.id}:`, (err as Error).message);
      }
      continue;
    }
    try {
      await deleteFile(call.file_key);
    } catch (err) {
      // A real delete failure (permissions, I/O — ENOENT is already swallowed
      // by deleteFile) must NOT be followed by deleting the DB row: that would
      // orphan the encrypted audio on disk with nothing left to locate it by.
      // Leave both in place and retry on the next daily sweep.
      console.error(`[Retention] Skipping call ${call.id} — audio delete failed, will retry next sweep:`, (err as Error).message);
      continue;
    }
    // Cascades to call_scores -> call_item_scores -> breaches (all ON DELETE
    // CASCADE from calls, see migrations 001/006).
    try {
      await query('DELETE FROM calls WHERE id = $1', [call.id]);
      deleted++;
    } catch (err) {
      console.error(`[Retention] Failed to delete call row ${call.id}:`, (err as Error).message);
    }
  }
  return deleted;
}
