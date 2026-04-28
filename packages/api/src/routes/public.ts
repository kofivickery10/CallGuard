import { Router } from 'express';
import { query } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { sendEmail } from '../services/email.js';

// Public endpoints - no authentication required.
export const publicRouter = Router();

publicRouter.post('/demo-requests', async (req, res, next) => {
  try {
    const { name, email, company, call_volume, message } = req.body;

    if (!name || !email || typeof name !== 'string' || typeof email !== 'string') {
      throw new AppError(400, 'name and email are required');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError(400, 'Invalid email address');
    }

    await query(
      `INSERT INTO demo_requests (name, email, company, call_volume, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        name.slice(0, 200),
        email.slice(0, 200),
        typeof company === 'string' ? company.slice(0, 200) : null,
        typeof call_volume === 'string' ? call_volume.slice(0, 50) : null,
        typeof message === 'string' ? message.slice(0, 2000) : null,
      ]
    );

    // Optional: email notification to the configured demo-request recipient
    const recipient = process.env.DEMO_REQUEST_EMAIL;
    if (recipient) {
      sendEmail({
        to: recipient,
        subject: `[CallGuard] New demo request: ${name} at ${company || 'unknown'}`,
        html: `
          <h2>New demo request</h2>
          <p><strong>Name:</strong> ${escapeHtml(name)}</p>
          <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
          <p><strong>Company:</strong> ${escapeHtml(company || '')}</p>
          <p><strong>Call volume:</strong> ${escapeHtml(call_volume || '')}</p>
          ${message ? `<p><strong>Message:</strong><br>${escapeHtml(message)}</p>` : ''}
        `,
      }).catch((err) => console.error('[demo-request] email notification failed:', err));
    }

    res.status(201).json({ message: "Thanks - we'll be in touch shortly" });
  } catch (err) {
    next(err);
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
