import { maintenanceQueue } from './queue.js';

const RETENTION_JOB_ID = 'retention-purge-daily';
const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;
const REPAIR_JOB_ID = 'stuck-repair';
const REPAIR_EVERY_MS = 10 * 60 * 1000;

/**
 * Registers the maintenance repeatable jobs (daily retention purge + frequent
 * stuck-job repair) if they aren't already scheduled. Idempotent — safe to
 * call on every worker boot.
 */
export async function refreshRetentionSchedule(): Promise<void> {
  const existing = await maintenanceQueue.getRepeatableJobs();

  if (!existing.some((rep) => rep.id === RETENTION_JOB_ID)) {
    await maintenanceQueue.add(
      'retention-purge',
      {},
      { jobId: RETENTION_JOB_ID, repeat: { every: RETENTION_EVERY_MS } }
    );
    console.log('[Scheduler] Registered daily retention-purge job');
  }

  if (!existing.some((rep) => rep.id === REPAIR_JOB_ID)) {
    await maintenanceQueue.add(
      'stuck-repair',
      {},
      { jobId: REPAIR_JOB_ID, repeat: { every: REPAIR_EVERY_MS } }
    );
    console.log('[Scheduler] Registered stuck-job repair sweep');
  }
}
