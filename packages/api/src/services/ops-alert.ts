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
 * Email the ops inbox about a degraded-but-not-fatal condition — something that
 * completed, but produced output nobody should trust silently (e.g. a scoring
 * verify pass that errored, leaving critical breaches unverified).
 *
 * No-op (with a console warning) if OPS_ALERT_EMAIL isn't configured, and
 * throttled per `throttleKey` so a systemic fault emails once, not per record.
 */
export async function sendOpsAlert(
  subject: string,
  body: string,
  throttleKey: string
): Promise<void> {
  if (!config.opsAlertEmail) {
    console.warn(`[ops-alert] ${throttleKey}: ${subject} — OPS_ALERT_EMAIL is unset, not alerting`);
    return;
  }

  const now = Date.now();
  const last = lastAlertAt.get(throttleKey) ?? 0;
  if (now - last < THROTTLE_MS) return;
  lastAlertAt.set(throttleKey, now);

  const text = `${body}\n\nFurther alerts for "${throttleKey}" are suppressed for ${THROTTLE_MS / 60000} minutes.`;
  await sendEmail({
    to: config.opsAlertEmail,
    subject: `[CallGuard] ${subject}`,
    html: `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    text,
  }).catch((err) => console.error('[ops-alert] send failed:', err));
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

  const body = [
    `A background job failed after exhausting all retries.`,
    ``,
    `Queue:    ${ctx.queue}`,
    `Job:      ${ctx.jobName} (${ctx.jobId ?? 'no id'})`,
    `Attempts: ${ctx.attemptsMade}/${ctx.attempts}`,
    `Error:    ${ctx.error}`,
  ].join('\n');

  await sendOpsAlert(
    `Job failed after ${ctx.attempts} attempts: ${ctx.queue}/${ctx.jobName}`,
    body,
    `${ctx.queue}:${ctx.jobName}`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
