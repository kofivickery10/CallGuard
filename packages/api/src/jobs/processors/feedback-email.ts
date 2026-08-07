import { Job } from 'bullmq';
import { sendEmail } from '../../services/email.js';

// Feedback to an adviser on a reviewed sale, with the one-click confirmation.
//
// A separate template from notify-email deliberately. That one is built for
// supervisors: it prefixes the app URL, and its button says "Open CallGuard",
// which is wrong twice here — the recipient may have no login, and the whole
// point is that they confirm without going anywhere.

interface FeedbackEmailJob {
  to: string;
  adviserName: string;
  confirmUrl: string;
  message: string | null;
  items: Array<{ label: string; severity: string }>;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#c0392b',
  high: '#c0392b',
  medium: '#b8860b',
  low: '#8a9e8a',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function processFeedbackEmail(job: Job<FeedbackEmailJob>) {
  const { to, adviserName, confirmUrl, message, items } = job.data;

  const itemRows = items
    .map(
      (i) => `
      <tr>
        <td style="padding: 8px 0; border-bottom: 1px solid #e2e8e2; color: #3a4e3a; font-size: 14px;">
          ${escapeHtml(i.label)}
        </td>
        <td style="padding: 8px 0; border-bottom: 1px solid #e2e8e2; text-align: right;">
          <span style="color: ${SEVERITY_COLOR[i.severity] ?? '#8a9e8a'}; font-size: 12px; font-weight: 600; text-transform: uppercase;">
            ${escapeHtml(i.severity)}
          </span>
        </td>
      </tr>`
    )
    .join('');

  // Said plainly when there is nothing outstanding: an adviser opening this
  // should not have to work out whether silence means "clean" or "list missing".
  const body = items.length
    ? `<p style="color: #3a4e3a; font-size: 14px; line-height: 1.6;">
         Your supervisor has reviewed a sale and gone through the points below with you.
       </p>
       <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">${itemRows}</table>`
    : `<p style="color: #3a4e3a; font-size: 14px; line-height: 1.6;">
         Your supervisor has reviewed a sale. Nothing was flagged against you on it.
       </p>`;

  const note = message
    ? `<div style="background: #f5f8f5; border-left: 3px solid #4a9e6e; padding: 12px 16px; margin: 16px 0;">
         <p style="margin: 0; color: #3a4e3a; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(message)}</p>
       </div>`
    : '';

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #4a9e6e; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0; font-size: 18px;">Feedback on a reviewed sale</h2>
      </div>
      <div style="background: #ffffff; border: 1px solid #e2e8e2; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
        <p style="color: #3a4e3a; font-size: 14px;">Hi ${escapeHtml(adviserName)},</p>
        ${body}
        ${note}
        <p style="color: #3a4e3a; font-size: 14px; line-height: 1.6;">
          Please confirm you have seen this. One click is all it takes — you do not need to sign in.
        </p>
        <div style="margin-top: 20px;">
          <a href="${confirmUrl}" style="background: #4a9e6e; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; display: inline-block; font-size: 15px;">
            Confirm I have seen this
          </a>
        </div>
        <p style="color: #8a9e8a; font-size: 12px; margin-top: 24px;">
          This link is personal to you and expires in 30 days. Sent by CallGuard.
        </p>
      </div>
    </div>
  `;

  const text = [
    `Hi ${adviserName},`,
    '',
    items.length
      ? 'Your supervisor has reviewed a sale and gone through the points below with you.'
      : 'Your supervisor has reviewed a sale. Nothing was flagged against you on it.',
    ...items.map((i) => `  - ${i.label} (${i.severity})`),
    ...(message ? ['', message] : []),
    '',
    'Please confirm you have seen this. You do not need to sign in:',
    confirmUrl,
    '',
    'This link is personal to you and expires in 30 days.',
  ].join('\n');

  const result = await sendEmail({
    to,
    subject: '[CallGuard] Feedback on a reviewed sale',
    html,
    text,
  });
  if (!result.ok) {
    // Throw so BullMQ retries. A feedback record exists already, so a failure
    // here means the record says "sent" while nothing arrived — the retry is
    // what closes that gap.
    throw new Error(result.error || 'feedback email delivery failed');
  }
}
