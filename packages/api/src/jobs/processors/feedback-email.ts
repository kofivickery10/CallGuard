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
  // Which sale this is about. Without it an adviser with several sales in a day
  // cannot tell which call the findings belong to, and the acknowledgement is
  // evidence of nothing in particular.
  clientName?: string | null;
  // The sale's score, or null where it has none yet. Never defaulted to 0.
  score?: number | null;
  // `reasoning` is the model's sentence about what the adviser did; the verbatim
  // transcript (`evidence`) is deliberately NOT sent — see FeedbackBreach in
  // services/journey-feedback.ts for why the line is drawn there.
  items: Array<{ label: string; severity: string; reasoning?: string | null }>;
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

/** "77.8%", or null where the sale has no score to state. */
function formatScore(score: number | null | undefined): string | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  return `${Math.round(score * 10) / 10}%`;
}

/**
 * Build the email, without sending it.
 *
 * Separate from the job so the template can be rendered in a test and eyeballed
 * in a browser. This one now carries a client's name next to compliance
 * findings, which is exactly the kind of thing that should be checkable without
 * putting a real message in front of a real adviser to see what it looks like.
 */
export function renderFeedbackEmail(data: Omit<FeedbackEmailJob, 'to'>): {
  subject: string;
  html: string;
  text: string;
} {
  const { adviserName, confirmUrl, message, items, clientName, score } = data;

  const scoreText = formatScore(score);

  // The subject carries the client name so the adviser can tell two sales apart
  // in a list, and nothing else: a subject line is the one part of an email that
  // shows on a lock screen.
  const subject = clientName
    ? `[CallGuard] Feedback on your sale for ${clientName}`
    : '[CallGuard] Feedback on a reviewed sale';

  const saleLine =
    clientName || scoreText
      ? `<p style="color: #3a4e3a; font-size: 14px; margin: 0 0 4px;">
           ${clientName ? `Sale for <strong>${escapeHtml(clientName)}</strong>` : 'Reviewed sale'}${
             scoreText
               ? ` &middot; scored <strong>${escapeHtml(scoreText)}</strong>`
               : ''
           }
         </p>`
      : '';

  const itemRows = items
    .map((i) => {
      // The reason sits under its checkpoint rather than in its own column:
      // it is a sentence, and a sentence in a table cell next to a severity
      // badge wraps into an unreadable column on a phone.
      const reasonRow = i.reasoning
        ? `
      <tr>
        <td colspan="2" style="padding: 0 0 10px; border-bottom: 1px solid #e2e8e2; color: #5a6e5a; font-size: 13px; line-height: 1.5;">
          ${escapeHtml(i.reasoning)}
        </td>
      </tr>`
        : '';
      return `
      <tr>
        <td style="padding: 8px 0 ${i.reasoning ? '2px' : '8px'}; ${i.reasoning ? '' : 'border-bottom: 1px solid #e2e8e2;'} color: #3a4e3a; font-size: 14px; font-weight: 600;">
          ${escapeHtml(i.label)}
        </td>
        <td style="padding: 8px 0 ${i.reasoning ? '2px' : '8px'}; ${i.reasoning ? '' : 'border-bottom: 1px solid #e2e8e2;'} text-align: right; vertical-align: top;">
          <span style="color: ${SEVERITY_COLOR[i.severity] ?? '#8a9e8a'}; font-size: 12px; font-weight: 600; text-transform: uppercase;">
            ${escapeHtml(i.severity)}
          </span>
        </td>
      </tr>${reasonRow}`;
    })
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
        ${saleLine}
        ${body}
        ${note}
        <p style="color: #3a4e3a; font-size: 14px; line-height: 1.6;">
          Please open the link below and confirm you have seen this. You do not need to sign in.
        </p>
        <div style="margin-top: 20px;">
          <a href="${confirmUrl}" style="background: #4a9e6e; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; display: inline-block; font-size: 15px;">
            Open and confirm
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
    ...(clientName || scoreText
      ? [
          `${clientName ? `Sale for ${clientName}` : 'Reviewed sale'}${scoreText ? ` - scored ${scoreText}` : ''}`,
          '',
        ]
      : []),
    items.length
      ? 'Your supervisor has reviewed a sale and gone through the points below with you.'
      : 'Your supervisor has reviewed a sale. Nothing was flagged against you on it.',
    ...items.flatMap((i) =>
      i.reasoning ? [`  - ${i.label} (${i.severity})`, `      ${i.reasoning}`] : [`  - ${i.label} (${i.severity})`]
    ),
    ...(message ? ['', message] : []),
    '',
    'Please open the link below and confirm you have seen this. You do not need to sign in:',
    confirmUrl,
    '',
    'This link is personal to you and expires in 30 days.',
  ].join('\n');

  return { subject, html, text };
}

export async function processFeedbackEmail(job: Job<FeedbackEmailJob>) {
  const { to } = job.data;
  const { subject, html, text } = renderFeedbackEmail(job.data);

  const result = await sendEmail({
    to,
    subject,
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
