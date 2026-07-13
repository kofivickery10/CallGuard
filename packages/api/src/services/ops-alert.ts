import { config } from '../config.js';
import { sendEmail } from './email.js';

// Per-key throttle so a queue failing repeatedly emails ops once, not hundreds
// of times. Keyed by queue+job name; resets after the window.
const THROTTLE_MS = 15 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

interface JobFailureContext {
  queue: string;
  jobName: string;
  jobId: string | undefined;
  error: string;
  attemptsMade: number;
  attempts: number;
}

/**
 * Email the ops inbox when a job dies after exhausting all its retries. No-op
 * (with a console warning) if OPS_ALERT_EMAIL isn't configured, and throttled
 * per queue+job so a systemic outage doesn't flood the inbox.
 */
export async function sendJobFailureAlert(ctx: JobFailureContext): Promise<void> {
  // Only alert once retries are exhausted — a transient failure that the retry
  // recovers from is not worth paging anyone.
  if (ctx.attemptsMade < ctx.attempts) return;

  if (!config.opsAlertEmail) {
    console.warn(`[ops-alert] ${ctx.queue}/${ctx.jobName} exhausted retries but OPS_ALERT_EMAIL is unset — not alerting`);
    return;
  }

  const key = `${ctx.queue}:${ctx.jobName}`;
  const now = Date.now();
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < THROTTLE_MS) return;
  lastAlertAt.set(key, now);

  const subject = `[CallGuard] Job failed after ${ctx.attempts} attempts: ${ctx.queue}/${ctx.jobName}`;
  const body = [
    `A background job failed after exhausting all retries.`,
    ``,
    `Queue:    ${ctx.queue}`,
    `Job:      ${ctx.jobName} (${ctx.jobId ?? 'no id'})`,
    `Attempts: ${ctx.attemptsMade}/${ctx.attempts}`,
    `Error:    ${ctx.error}`,
    ``,
    `Further alerts for this queue/job are suppressed for ${THROTTLE_MS / 60000} minutes.`,
  ].join('\n');

  await sendEmail({
    to: config.opsAlertEmail,
    subject,
    html: `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
    text: body,
  }).catch((err) => console.error('[ops-alert] send failed:', err));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
