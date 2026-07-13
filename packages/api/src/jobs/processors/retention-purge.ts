import { Job } from 'bullmq';
import { query } from '../../db/client.js';
import { deleteFile } from '../../services/storage.js';

const ARCHIVE_AFTER_DAYS = 730; // 2yr live in the portal (spec §15)
const TERMINATION_PURGE_AFTER_DAYS = 30; // return/delete within 30 days of termination

interface OrgRetentionRow {
  id: string;
  retention_days: number;
}

interface PurgeableCall {
  id: string;
  file_key: string;
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
