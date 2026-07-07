import { query } from '../db/client.js';
import { getIngestionQueue } from './queue.js';

interface ActiveSource {
  id: string;
  poll_interval_minutes: number;
}

/**
 * Sync BullMQ repeatable jobs with the current set of active SFTP sources.
 * Removes stale repeatables and adds missing ones.
 */
export async function refreshSFTPSchedules(): Promise<void> {
  const queue = getIngestionQueue();

  const sources = await query<ActiveSource>(
    `SELECT id, poll_interval_minutes FROM sftp_sources WHERE is_active = true`
  );
  const desiredEveryBySource = new Map(
    sources.map((s) => [s.id, s.poll_interval_minutes * 60 * 1000])
  );

  for (const source of sources) {
    const every = desiredEveryBySource.get(source.id)!;
    const jobId = `sftp-poll-${source.id}`;

    await queue.add(
      'sftp-poll',
      { sourceId: source.id },
      {
        jobId,
        repeat: { every },
      }
    );
  }

  // Remove repeatables for deleted/inactive sources, or whose interval no
  // longer matches. Changing a source's poll interval registers a NEW
  // repeatable (BullMQ keys repeatables by name+id+every, so a different
  // `every` doesn't overwrite the old one) — without this second check the
  // stale cadence keeps firing forever alongside the new one, double-polling
  // the source.
  const existing = await queue.getRepeatableJobs();
  for (const rep of existing) {
    const match = rep.name === 'sftp-poll' && rep.id && rep.id.startsWith('sftp-poll-');
    if (!match) continue;

    const sourceId = rep.id!.replace('sftp-poll-', '');
    const desiredEvery = desiredEveryBySource.get(sourceId);
    const staleInterval = desiredEvery != null && rep.every != null && String(desiredEvery) !== rep.every;

    if (desiredEvery == null || staleInterval) {
      await queue.removeRepeatableByKey(rep.key);
      console.log(
        `[Scheduler] Removed repeatable for source ${sourceId} (${desiredEvery == null ? 'deleted/inactive' : 'interval changed'})`
      );
    }
  }

  console.log(`[Scheduler] Refreshed SFTP schedules: ${sources.length} active sources`);
}
