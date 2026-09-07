import { Job } from 'bullmq';
import { sendEmail } from '../../services/email.js';

// Feedback to an adviser on a reviewed sale, with the one-click confirmation.
//
// A separate template from notify-email deliberately. That one is built for
// supervisors: it prefixes the app URL, and its button says "Open CallGuard",
// which is wrong twice here — the recipient may have no login, and the whole
// point is that they confirm without going anywhere.

export interface FeedbackEmailJob {
  to: string;
  adviserName: string;
  confirmUrl: string;
  message: string | null;
  // Which sale this is about. Without it an adviser with several sales in a day
  // cannot tell which call the findings belong to, and the acknowledgement is
  // evidence of nothing in particular. It goes in the BODY and never the
  // subject: a subject line is the one part of an email that renders on a lock
  // screen, in a notification preview and in a mail-client search index, and a
  // named protection client next to the word "compliance" should not be there.
  clientName?: string | null;
  // The sale's score, or null where it has none yet. Never defaulted to 0.
  score?: number | null;
  // The stored verdict. Absent under score_only, where the tenant is never shown
  // one anywhere — withheld from the payload, not merely from the render, since
  // there is no client here to hide it. Null where the sale has no verdict.
  //
  // Stated alongside the score because callPasses() fails a sale on any critical
  // breach regardless of percentage, so a bare "77.8%" can tell an adviser they
  // did fine on a sale that failed.
  pass?: boolean | null;
  // `reasoning` is the model's sentence about what the adviser did; the verbatim
  // transcript (`evidence`) is deliberately NOT sent — see FeedbackBreach in
  // services/journey-feedback.ts for why the line is drawn there.
  items: Array<{ label: string; severity: string; reasoning?: string | null }>;
  // Set where findings HAD reasons and policy kept them out of this email (the
  // tenant keeps health unredacted — DPIA R5). The template says so, rather than
  // dropping the reasons and leaving a shorter email that still looks complete.
  reasoningWithheld?: boolean;
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

/**
 * "77.8%", or null where the sale has no score to state.
 *
 * Number.isFinite and not Number.isNaN: journeys.overall_score is NUMERIC(5,2),
 * which pg hands back as a string, so a guard that does not coerce passes every
 * string through — including "abc", which then renders to an adviser as "NaN%".
 * The caller coerces too; this is the second lock on the same door.
 */
function formatScore(score: number | null | undefined): string | null {
  const n = Number(score);
  if (score === null || score === undefined || !Number.isFinite(n)) return null;
  return `${Math.round(n * 10) / 10}%`;
}

/** Brand pass/fail (BRAND_GUIDELINES.md). Absent verdict renders nothing. */
const VERDICT = {
  pass: { label: 'Pass', color: '#2D6E4A' },
  fail: { label: 'Fail', color: '#C0392B' },
};

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
  const { adviserName, confirmUrl, message, items, clientName, score, pass, reasoningWithheld } =
    data;

  const scoreText = formatScore(score);
  // Absent under score_only (the key is not in the payload) and null on a sale
  // that has no verdict. Both mean "state nothing" rather than "state Fail".
  const verdict = pass === true ? VERDICT.pass : pass === false ? VERDICT.fail : null;

  // CONSTANT. The client is named in the body, never here — see clientName on
  // FeedbackEmailJob. The adviser still tells two sales apart on the first line
  // of the message, which is where saleLine puts the name.
  const subject = '[CallGuard] Feedback on a reviewed sale';

  const saleLine =
    clientName || scoreText || verdict
      ? `<p style="color: #1A2E1A; font-size: 14px; margin: 0 0 4px;">
           ${clientName ? `Sale for <strong>${escapeHtml(clientName)}</strong>` : 'Reviewed sale'}${
             scoreText
               ? ` &middot; scored <strong>${escapeHtml(scoreText)}</strong>`
               : ''
           }${
             verdict
               ? ` &middot; <strong style="color: ${verdict.color};">${verdict.label}</strong>`
               : ''
           }
         </p>`
      : '';

  // Said, not silently omitted. An adviser who gets a list of checkpoints with
  // no reasons should be told the reasons exist and where they are, otherwise a
  // deliberately reduced email is indistinguishable from a complete one.
  const withheldNote =
    reasoningWithheld && items.length
      ? `<p style="color: #5a6e5a; font-size: 13px; line-height: 1.6; margin: 12px 0 0;">
           The detail behind each point is in CallGuard rather than this email,
           because your firm keeps health disclosures unredacted. Open the link
           below to read it.
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
        ${withheldNote}
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
    ...(clientName || scoreText || verdict
      ? [
          `${clientName ? `Sale for ${clientName}` : 'Reviewed sale'}${scoreText ? ` - scored ${scoreText}` : ''}${verdict ? ` - ${verdict.label}` : ''}`,
          '',
        ]
      : []),
    items.length
      ? 'Your supervisor has reviewed a sale and gone through the points below with you.'
      : 'Your supervisor has reviewed a sale. Nothing was flagged against you on it.',
    ...items.flatMap((i) =>
      i.reasoning ? [`  - ${i.label} (${i.severity})`, `      ${i.reasoning}`] : [`  - ${i.label} (${i.severity})`]
    ),
    ...(reasoningWithheld && items.length
      ? [
          '',
          'The detail behind each point is in CallGuard rather than this email, because',
          'your firm keeps health disclosures unredacted. Open the link below to read it.',
        ]
      : []),
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
