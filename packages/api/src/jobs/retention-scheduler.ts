import { maintenanceQueue, stuckRepairQueue } from './queue.js';

const RETENTION_JOB_ID = 'retention-purge-daily';
const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;
const REPAIR_JOB_ID = 'stuck-repair';
const REPAIR_EVERY_MS = 10 * 60 * 1000;
const BILLING_JOB_ID = 'billing-snapshot-daily';
const BILLING_EVERY_MS = 24 * 60 * 60 * 1000;
const PRODUCT_SYNC_JOB_ID = 'sync-products-daily';
const PRODUCT_SYNC_EVERY_MS = 24 * 60 * 60 * 1000;
const RECONCILIATION_SWEEP_JOB_ID = 'reconciliation-sweep';
// The tick rate, not the per-run retry rate: the sweep decides for itself which
// waiting runs are due (services/reconciliation-sweep.ts). 30 minutes is the
// finest cadence that policy asks for, so anything slower would blunt it.
const RECONCILIATION_SWEEP_EVERY_MS = 30 * 60 * 1000;

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

  // stuck-repair has its own queue (see jobs/queue.ts) so a slow retention
  // purge or reconciliation sweep on 'maintenance' can never delay it —
  // check and register its repeatable job against that queue, not this one.
  const existingRepair = await stuckRepairQueue.getRepeatableJobs();
  if (!existingRepair.some((rep) => rep.id === REPAIR_JOB_ID)) {
    await stuckRepairQueue.add(
      'stuck-repair',
      {},
      { jobId: REPAIR_JOB_ID, repeat: { every: REPAIR_EVERY_MS } }
    );
    console.log('[Scheduler] Registered stuck-job repair sweep');
  }

  if (!existing.some((rep) => rep.id === BILLING_JOB_ID)) {
    await maintenanceQueue.add(
      'billing-snapshot',
      {},
      { jobId: BILLING_JOB_ID, repeat: { every: BILLING_EVERY_MS } }
    );
    console.log('[Scheduler] Registered daily billing-snapshot job');
  }

  if (!existing.some((rep) => rep.id === PRODUCT_SYNC_JOB_ID)) {
    await maintenanceQueue.add(
      'sync-products',
      {},
      { jobId: PRODUCT_SYNC_JOB_ID, repeat: { every: PRODUCT_SYNC_EVERY_MS } }
    );
    console.log('[Scheduler] Registered daily product-sync job');
  }

  if (!existing.some((rep) => rep.id === RECONCILIATION_SWEEP_JOB_ID)) {
    await maintenanceQueue.add(
      'reconciliation-sweep',
      {},
      {
        jobId: RECONCILIATION_SWEEP_JOB_ID,
        repeat: { every: RECONCILIATION_SWEEP_EVERY_MS },
      }
    );
    console.log('[Scheduler] Registered reconciliation sweep');
  }
}
