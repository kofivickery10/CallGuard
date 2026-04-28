import { Worker } from 'bullmq';
import { config } from '../config.js';
import { processTranscription } from './processors/transcribe.js';
import { processScoring } from './processors/score.js';
import { processSFTPPoll } from './processors/sftp-poll.js';
import { processAlertDelivery } from './processors/alert-deliver.js';
import { refreshSFTPSchedules } from './scheduler.js';

const connection = {
  url: config.redis.url,
};

const transcriptionWorker = new Worker('transcription', processTranscription, {
  connection,
  concurrency: 2,
});

const scoringWorker = new Worker('scoring', processScoring, {
  connection,
  concurrency: 2,
});

const ingestionWorker = new Worker('ingestion', processSFTPPoll, {
  connection,
  concurrency: 1,
});

const alertsWorker = new Worker('alerts', processAlertDelivery, {
  connection,
  concurrency: 4,
});

transcriptionWorker.on('completed', (job) => {
  console.log(`[Transcription] Job ${job.id} completed`);
});
transcriptionWorker.on('failed', (job, err) => {
  console.error(`[Transcription] Job ${job?.id} failed:`, err.message);
});

scoringWorker.on('completed', (job) => {
  console.log(`[Scoring] Job ${job.id} completed`);
});
scoringWorker.on('failed', (job, err) => {
  console.error(`[Scoring] Job ${job?.id} failed:`, err.message);
});

ingestionWorker.on('completed', (job) => {
  console.log(`[Ingestion] Job ${job.id} completed`);
});
ingestionWorker.on('failed', (job, err) => {
  console.error(`[Ingestion] Job ${job?.id} failed:`, err.message);
});

alertsWorker.on('completed', (job) => {
  console.log(`[Alerts] Delivery ${job.id} completed`);
});
alertsWorker.on('failed', (job, err) => {
  console.error(`[Alerts] Delivery ${job?.id} failed:`, err.message);
});

console.log('CallGuard worker started - listening for transcription, scoring, ingestion, and alerts jobs');

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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Worker shutting down...');
  await transcriptionWorker.close();
  await scoringWorker.close();
  await ingestionWorker.close();
  await alertsWorker.close();
  process.exit(0);
});
