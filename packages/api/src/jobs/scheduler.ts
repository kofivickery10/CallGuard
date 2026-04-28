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

  const existing = await queue.getRepeatableJobs();
  const desiredKeys = new Set<string>();

  for (const source of sources) {
    const every = source.poll_interval_minutes * 60 * 1000;
    const jobId = `sftp-poll-${source.id}`;

    await queue.add(
      'sftp-poll',
      { sourceId: source.id },
      {
        jobId,
        repeat: { every },
      }
    );

    // BullMQ generates a composite key for repeatables; we can't predict it
    // exactly but we can match by name + jobId
    desiredKeys.add(`${jobId}:${every}`);
  }

  // Remove repeatables that belong to deleted/inactive sources
  for (const rep of existing) {
    const match = rep.name === 'sftp-poll' && rep.id && rep.id.startsWith('sftp-poll-');
    if (!match) continue;

    const sourceId = rep.id!.replace('sftp-poll-', '');
    const stillActive = sources.some((s) => s.id === sourceId);
    if (!stillActive) {
      await queue.removeRepeatableByKey(rep.key);
      console.log(`[Scheduler] Removed repeatable for deleted source ${sourceId}`);
    }
  }

  console.log(`[Scheduler] Refreshed SFTP schedules: ${sources.length} active sources`);
}
