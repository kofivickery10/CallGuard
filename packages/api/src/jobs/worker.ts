import { Job, Worker } from 'bullmq';
import { config } from '../config.js';
import { processTranscription } from './processors/transcribe.js';
import { processScoring } from './processors/score.js';
import { processSFTPPoll } from './processors/sftp-poll.js';
import { processIngestCall } from './processors/ingest-call.js';
import { processHydrateCall } from './processors/hydrate-call.js';
import { processAssembleJourney } from './processors/assemble-journey.js';
import { processAlertDelivery } from './processors/alert-deliver.js';
import { processNotifyEmail } from './processors/notify-email.js';
import { processFeedbackEmail } from './processors/feedback-email.js';
import { processZohoRetry } from './processors/zoho-retry.js';
import { processScoreJourney } from './processors/score-journey.js';
import { processCapture } from './processors/capture.js';
import { processReconcile } from './processors/reconcile.js';
import { processRetentionPurge } from './processors/retention-purge.js';
import { processStuckRepair } from './processors/stuck-repair.js';
import { processReconciliationSweep } from './processors/reconciliation-sweep.js';
import { processSyncProducts } from './processors/sync-products.js';
import { processBillingSnapshot } from './processors/billing-snapshot.js';
import { refreshSFTPSchedules } from './scheduler.js';
import { refreshRetentionSchedule } from './retention-scheduler.js';
import { writeWorkerHeartbeat, closeRedis } from '../services/redis.js';
import { sendJobFailureAlert } from '../services/ops-alert.js';
import { assertDatabaseIsSafe } from '../db/remote-guard.js';

// Before any worker registers: a dev worker pointed at the production database
// fails real calls against a local uploads directory. See db/remote-guard.ts.
assertDatabaseIsSafe('worker');

const connection = {
  url: config.redis.url,
};

// Every dispatcher below is written as an exhaustive switch over a literal
// union of the job names its queue actually carries (found by grepping every
// `xQueue.add(...)` call site for that queue name). A stray/typo'd job name
// silently falling through to the wrong processor is worse than a thrown
// error for these queues: score-journey run through processScoring, or a
// retention purge run through processStuckRepair, would corrupt compliance
// data or waste a scoring pass rather than just failing visibly and retrying.
// `assertUnreachableJobName`'s `never` parameter also makes this a *compile*
// error, not just a runtime one, if a new job name is added to a queue but a
// case for it is not: the cast to the union type stops narrowing to `never`
// in the `default` branch and `tsc` refuses to build.
function assertUnreachableJobName(name: never, queue: string): never {
  throw new Error(`[${queue}] Unrecognised job name: ${String(name)}`);
}

const transcriptionWorker = new Worker('transcription', processTranscription, {
  connection,
  concurrency: 2,
});

// The scoring queue carries four job types: 'score' (per-call, unchanged),
// 'score-journey' (multi-call, spec §9), 'capture' (data-capture extraction, run
// after scoring) and 'reconcile' (compare the submitted application against the
// call) — dispatch by name rather than splitting into more queue/worker pairs.
//
// 'reconcile' rides here despite doing no Claude work of its own: it runs after
// scoring on the same journey, and sharing the queue keeps that ordering and the
// same concurrency ceiling without a fifth worker.
//
// 'score-streamed-call' (services/stream-worker.ts) is deliberately routed to
// the same processor as 'score' — it is the same per-call scoring work, just
// enqueued under a distinct name so it's identifiable in logs/queue metrics as
// having come from the live-stream path rather than the post-call one.
type ScoringJobName = 'score' | 'score-journey' | 'capture' | 'reconcile' | 'score-streamed-call';
async function dispatchScoring(job: Job) {
  const name = job.name as ScoringJobName;
  switch (name) {
    case 'score-journey': return processScoreJourney(job);
    case 'capture': return processCapture(job);
    case 'reconcile': return processReconcile(job);
    case 'score':
    case 'score-streamed-call':
      return processScoring(job);
    default:
      return assertUnreachableJobName(name, 'scoring');
  }
}

const scoringWorker = new Worker('scoring', dispatchScoring, {
  connection,
  concurrency: 2,
});

// The ingestion queue carries 'sftp-poll' (recurring SFTP polling),
// 'ingest-call' (delayed dialer-webhook recording fetch, spec §4),
// 'hydrate-call' (fetch + transcribe a captured call on sale) and
// 'assemble-journey' (grace-delayed journey assembly on a Zoho sale trigger).
type IngestionJobName = 'sftp-poll' | 'ingest-call' | 'hydrate-call' | 'assemble-journey';
async function dispatchIngestion(job: Job) {
  const name = job.name as IngestionJobName;
  switch (name) {
    case 'ingest-call': return processIngestCall(job);
    case 'hydrate-call': return processHydrateCall(job);
    case 'assemble-journey': return processAssembleJourney(job);
    case 'sftp-poll': return processSFTPPoll(job);
    default: return assertUnreachableJobName(name, 'ingestion');
  }
}

const ingestionWorker = new Worker('ingestion', dispatchIngestion, {
  connection,
  concurrency: 2,
});

// The alerts queue carries 'deliver' (alert-rule deliveries — email/slack/in-app
// fan-out from services/alert-evaluator.ts and routes/alerts.ts), 'notify-email'
// (the email side of a directed system notification raised via
// services/notify.ts), 'feedback-email' (services/journey-feedback.ts) and
// 'zoho-retry' (a backed-off re-attempt of a failed Zoho write-back — see
// scheduleZohoRetry in services/zoho.ts) — dispatch by name.
type AlertsJobName = 'deliver' | 'notify-email' | 'feedback-email' | 'zoho-retry';
async function dispatchAlerts(job: Job) {
  const name = job.name as AlertsJobName;
  switch (name) {
    case 'notify-email': return processNotifyEmail(job);
    case 'feedback-email': return processFeedbackEmail(job);
    case 'deliver': return processAlertDelivery(job);
    case 'zoho-retry': return processZohoRetry(job);
    default: return assertUnreachableJobName(name, 'alerts');
  }
}

const alertsWorker = new Worker('alerts', dispatchAlerts, {
  connection,
  concurrency: 4,
});

// The maintenance queue carries 'retention-purge' (daily lifecycle sweep),
// 'billing-snapshot' (daily month-end billing freeze), 'sync-products' and
// 'reconciliation-sweep' (re-check sales whose application pack has not been
// attached to the CRM yet) — dispatch by name.
//
// 'stuck-repair' does NOT ride this queue (see the dedicated worker below):
// it is the safety net that catches calls/journeys whose job was committed to
// the DB but never actually queued, and needs to run on a fixed cadence
// regardless of how long the other maintenance jobs take.
type MaintenanceJobName = 'retention-purge' | 'billing-snapshot' | 'sync-products' | 'reconciliation-sweep';
async function dispatchMaintenance(job: Job) {
  const name = job.name as MaintenanceJobName;
  switch (name) {
    case 'billing-snapshot': return processBillingSnapshot(job);
    case 'sync-products': return processSyncProducts(job);
    case 'reconciliation-sweep': return processReconciliationSweep(job);
    case 'retention-purge': return processRetentionPurge(job);
    default: return assertUnreachableJobName(name, 'maintenance');
  }
}

const maintenanceWorker = new Worker('maintenance', dispatchMaintenance, {
  connection,
  concurrency: 1,
});

// Isolated from 'maintenance' on purpose: a slow retention purge or
// reconciliation sweep must never delay the repair sweep that catches
// dropped compliance jobs. Its own queue means its own concurrency slot that
// nothing else can occupy.
const stuckRepairWorker = new Worker('stuck-repair', processStuckRepair, {
  connection,
  concurrency: 1,
});

// Fire an ops alert (throttled, final-attempt-only) from a worker 'failed'
// event. `job` can be undefined if BullMQ couldn't load it.
function alertOnFailure(queue: string, job: Job | undefined, err: Error): void {
  if (!job) return;
  void sendJobFailureAlert({
    queue,
    jobName: job.name,
    jobId: job.id,
    error: err.message,
    attemptsMade: job.attemptsMade,
    attempts: job.opts.attempts ?? 1,
  });
}

transcriptionWorker.on('completed', (job) => {
  console.log(`[Transcription] Job ${job.id} completed`);
});
transcriptionWorker.on('failed', (job, err) => {
  console.error(`[Transcription] Job ${job?.id} failed:`, err.message);
  alertOnFailure('transcription', job, err);
});
transcriptionWorker.on('error', (err) => {
  console.error('[Transcription] Worker error:', err);
});

scoringWorker.on('completed', (job) => {
  console.log(`[Scoring] Job ${job.id} completed`);
});
scoringWorker.on('failed', (job, err) => {
  console.error(`[Scoring] Job ${job?.id} failed:`, err.message);
  alertOnFailure('scoring', job, err);
});
scoringWorker.on('error', (err) => {
  console.error('[Scoring] Worker error:', err);
});

ingestionWorker.on('completed', (job) => {
  console.log(`[Ingestion] Job ${job.id} completed`);
});
ingestionWorker.on('failed', (job, err) => {
  console.error(`[Ingestion] Job ${job?.id} failed:`, err.message);
  alertOnFailure('ingestion', job, err);
});
ingestionWorker.on('error', (err) => {
  console.error('[Ingestion] Worker error:', err);
});

alertsWorker.on('completed', (job) => {
  console.log(`[Alerts] Delivery ${job.id} completed`);
});
alertsWorker.on('failed', (job, err) => {
  console.error(`[Alerts] Delivery ${job?.id} failed:`, err.message);
  alertOnFailure('alerts', job, err);
});
alertsWorker.on('error', (err) => {
  console.error('[Alerts] Worker error:', err);
});

maintenanceWorker.on('completed', (job) => {
  console.log(`[Maintenance] Job ${job.id} completed`);
});
maintenanceWorker.on('failed', (job, err) => {
  console.error(`[Maintenance] Job ${job?.id} failed:`, err.message);
  alertOnFailure('maintenance', job, err);
});
maintenanceWorker.on('error', (err) => {
  console.error('[Maintenance] Worker error:', err);
});

stuckRepairWorker.on('completed', (job) => {
  console.log(`[StuckRepair] Job ${job.id} completed`);
});
stuckRepairWorker.on('failed', (job, err) => {
  console.error(`[StuckRepair] Job ${job?.id} failed:`, err.message);
  alertOnFailure('stuck-repair', job, err);
});
stuckRepairWorker.on('error', (err) => {
  console.error('[StuckRepair] Worker error:', err);
});

// Backstop: BullMQ/Redis errors or a stray rejection in a processor would
// otherwise crash the worker process and silently stop all call processing.
process.on('unhandledRejection', (reason) => {
  console.error('[worker] Unhandled rejection:', reason);
});
// An uncaught exception leaves the process in an undefined state — exit so PM2
// restarts a clean worker rather than one that may silently mis-process jobs.
process.on('uncaughtException', (err) => {
  console.error('[worker] Uncaught exception — exiting for a clean restart:', err);
  shutdown('uncaughtException', 1);
});

console.log('CallGuard AI worker started - listening for transcription, scoring, ingestion, maintenance, stuck-repair, and alerts jobs');

// Register SFTP repeatable jobs on startup, and refresh every 5 minutes
// to pick up any source changes made via the API
refreshSFTPSchedules().catch((err) => {
  console.error('[Scheduler] Initial refresh failed:', err);
});
setInterval(() => {
  refreshSFTPSchedules().catch((err) => {
    console.error('[Scheduler] Periodic refresh failed:', err);
  });
}, 5 * 60 * 1000);

// Register the daily retention-purge job (idempotent — no-op if already scheduled).
refreshRetentionSchedule().catch((err) => {
  console.error('[Scheduler] Retention schedule registration failed:', err);
});

// Liveness heartbeat: the API health check reports the worker as down if this
// stops updating, so a dead/stuck worker is visible instead of silently
// draining the queues. Write immediately, then on an interval.
writeWorkerHeartbeat().catch((err) => console.error('[worker] heartbeat write failed:', err.message));
const heartbeatTimer = setInterval(() => {
  writeWorkerHeartbeat().catch((err) => console.error('[worker] heartbeat write failed:', err.message));
}, 30_000);

// Graceful shutdown. Handle both SIGINT (PM2 reload/stop) and SIGTERM
// (orchestrators). BullMQ's close() waits for in-flight jobs to finish, so a
// scoring/transcription job mid-flight is not killed — pair with a generous
// PM2 kill_timeout (see ecosystem.config.js) so the OS doesn't SIGKILL first.
let shuttingDown = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received — finishing in-flight jobs...`);
  clearInterval(heartbeatTimer);
  const forceExit = setTimeout(() => {
    console.error('[worker] Drain timed out — forcing exit');
    process.exit(code || 1);
  }, 110_000);
  forceExit.unref();
  await Promise.all([
    transcriptionWorker.close(),
    scoringWorker.close(),
    ingestionWorker.close(),
    alertsWorker.close(),
    maintenanceWorker.close(),
    stuckRepairWorker.close(),
  ]).catch((err) => console.error('[worker] close error:', err));
  await closeRedis();
  clearTimeout(forceExit);
  console.log('[worker] Shutdown complete');
  process.exit(code);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
