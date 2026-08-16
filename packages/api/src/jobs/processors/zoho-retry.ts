import { Job } from 'bullmq';
import { retryZohoDelivery } from '../../services/zoho.js';

// Re-attempts one previously failed Zoho write-back (services/zoho.ts,
// scheduleZohoRetry). Rides the alerts queue alongside the other best-effort
// delivery jobs (notify-email, alert-rule 'deliver').

interface ZohoRetryJob {
  deliveryId: string;
  // 1-indexed position in ZOHO_RETRY_BACKOFF_MINUTES — carried through so a
  // further retry (scheduled from inside retryZohoDelivery itself) advances
  // along the same backoff schedule rather than restarting it.
  attempt: number;
}

export async function processZohoRetry(job: Job<ZohoRetryJob>) {
  // retryZohoDelivery never throws — it records the outcome on the delivery
  // row itself and schedules its own next attempt, so there is nothing here
  // for BullMQ's job-level retry/backoff to do.
  await retryZohoDelivery(job.data.deliveryId, job.data.attempt);
}
