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
import { processScoreJourney } from './processors/score-journey.js';
import { processRetentionPurge } from './processors/retention-purge.js';
import { processStuckRepair } from './processors/stuck-repair.js';
import { refreshSFTPSchedules } from './scheduler.js';
import { refreshRetentionSchedule } from './retention-scheduler.js';
import { writeWorkerHeartbeat, closeRedis } from '../services/redis.js';
import { sendJobFailureAlert } from '../services/ops-alert.js';

const connection = {
  url: config.redis.url,
};

const transcriptionWorker = new Worker('transcription', processTranscription, {
  connection,
  concurrency: 2,
});

// The scoring queue carries two job types: 'score' (per-call, unchanged) and
// 'score-journey' (multi-call, spec §9) — dispatch by name rather than
// splitting into a second queue/worker pair, since both are Claude-scoring
// work with the same concurrency/backoff needs.
async function dispatchScoring(job: Job) {
  if (job.name === 'score-journey') return processScoreJourney(job);
  return processScoring(job);
}

const scoringWorker = new Worker('scoring', dispatchScoring, {
  connection,
  concurrency: 2,
});

// The ingestion queue carries 'sftp-poll' (recurring SFTP polling),
// 'ingest-call' (delayed dialer-webhook recording fetch, spec §4),
// 'hydrate-call' (fetch + transcribe a captured call on sale) and
// 'assemble-journey' (grace-delayed journey assembly on a Zoho sale trigger).
async function dispatchIngestion(job: Job) {
  if (job.name === 'ingest-call') return processIngestCall(job);
  if (job.name === 'hydrate-call') return processHydrateCall(job);
  if (job.name === 'assemble-journey') return processAssembleJourney(job);
  return processSFTPPoll(job);
}

const ingestionWorker = new Worker('ingestion', dispatchIngestion, {
  connection,
  concurrency: 2,
});

// The alerts queue carries alert-rule deliveries (email/slack/in-app fan-out
// from services/alert-evaluator.ts) and 'notify-email' (the email side of a
// directed system notification raised via services/notify.ts) — dispatch by name.
async function dispatchAlerts(job: Job) {
  if (job.name === 'notify-email') return processNotifyEmail(job);
  return processAlertDelivery(job);
}

const alertsWorker = new Worker('alerts', dispatchAlerts, {
  connection,
  concurrency: 4,
});

// The maintenance queue carries 'retention-purge' (daily lifecycle sweep) and
// 'stuck-repair' (frequent re-enqueue of calls/journeys whose job was never
// queued) — dispatch by name.
async function dispatchMaintenance(job: Job) {
  if (job.name === 'stuck-repair') return processStuckRepair(job);
  return processRetentionPurge(job);
}

const maintenanceWorker = new Worker('maintenance', dispatchMaintenance, {
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

console.log('CallGuard AI worker started - listening for transcription, scoring, ingestion, maintenance, and alerts jobs');

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
  ]).catch((err) => console.error('[worker] close error:', err));
  await closeRedis();
  clearTimeout(forceExit);
  console.log('[worker] Shutdown complete');
  process.exit(code);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
