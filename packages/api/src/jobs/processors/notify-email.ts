import { Job } from 'bullmq';
import { sendEmail } from '../../services/email.js';
import { config } from '../../config.js';
import type { AlertSeverity } from '@callguard/shared';

// Delivers the email side of a directed notification raised via services/
// notify.ts. In-app rows are written synchronously by notify(); email is
// queued here so a slow or failing send never blocks the action that triggered
// it, and gets BullMQ's retries.

interface NotifyEmailJob {
  to: string;
  title: string;
  body: string;
  severity: AlertSeverity;
  actionUrl?: string | null;
}

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: '#2d5a9e',
  warning: '#b8860b',
  critical: '#c0392b',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function processNotifyEmail(job: Job<NotifyEmailJob>) {
  const { to, title, body, severity, actionUrl } = job.data;
  const link = actionUrl ? `${config.appUrl}${actionUrl}` : config.appUrl;
  const color = SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.info;

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${color}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0; font-size: 18px;">${escapeHtml(title)}</h2>
      </div>
      <div style="background: #ffffff; border: 1px solid #e2e8e2; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
        <p style="color: #3a4e3a; font-size: 14px; line-height: 1.6;">${escapeHtml(body)}</p>
        <div style="margin-top: 24px;">
          <a href="${link}" style="background: #4a9e6e; color: white; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; display: inline-block;">Open CallGuard</a>
        </div>
        <p style="color: #8a9e8a; font-size: 12px; margin-top: 24px;">Sent by CallGuard</p>
      </div>
    </div>
  `;

  const text = [title, '', body, '', `Open: ${link}`].join('\n');

  const result = await sendEmail({ to, subject: `[CallGuard] ${title}`, html, text });
  if (!result.ok) {
    // Throw so BullMQ retries. notify() only enqueues when Resend is configured,
    // so a failure here is a genuine send error, not a missing-key no-op.
    throw new Error(result.error || 'notify email delivery failed');
  }
}
