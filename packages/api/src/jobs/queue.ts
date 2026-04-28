import { Queue } from 'bullmq';
import { config } from '../config.js';

const connection = {
  url: config.redis.url,
};

let _transcriptionQueue: Queue | null = null;
let _scoringQueue: Queue | null = null;
let _ingestionQueue: Queue | null = null;
let _alertsQueue: Queue | null = null;

export function getTranscriptionQueue(): Queue {
  if (!_transcriptionQueue) {
    _transcriptionQueue = new Queue('transcription', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return _transcriptionQueue;
}

export function getScoringQueue(): Queue {
  if (!_scoringQueue) {
    _scoringQueue = new Queue('scoring', {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return _scoringQueue;
}

export function getIngestionQueue(): Queue {
  if (!_ingestionQueue) {
    _ingestionQueue = new Queue('ingestion', {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    });
  }
  return _ingestionQueue;
}

export function getAlertsQueue(): Queue {
  if (!_alertsQueue) {
    _alertsQueue = new Queue('alerts', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
  }
  return _alertsQueue;
}

// Keep named exports for backward compat in worker.ts
export const transcriptionQueue = { add: (...args: Parameters<Queue['add']>) => getTranscriptionQueue().add(...args) };
export const scoringQueue = { add: (...args: Parameters<Queue['add']>) => getScoringQueue().add(...args) };
export const ingestionQueue = {
  add: (...args: Parameters<Queue['add']>) => getIngestionQueue().add(...args),
  removeRepeatableByKey: (key: string) => getIngestionQueue().removeRepeatableByKey(key),
  getRepeatableJobs: () => getIngestionQueue().getRepeatableJobs(),
};
export const alertsQueue = { add: (...args: Parameters<Queue['add']>) => getAlertsQueue().add(...args) };
