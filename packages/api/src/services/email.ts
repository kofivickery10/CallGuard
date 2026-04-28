import { config } from '../config.js';

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<{ ok: boolean; error?: string }> {
  if (!config.resend.apiKey) {
    console.warn('[email] RESEND_API_KEY not set - skipping email delivery');
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(config.resend.apiKey);
    const result = await resend.emails.send({
      from: config.resend.fromEmail,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });

    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
