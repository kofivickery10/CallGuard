import { Router } from 'express';
import { query } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { sendEmail } from '../services/email.js';

// Public endpoints - no authentication required.
export const publicRouter = Router();

// Self-serve trial signup (Phase 1: store request, notify, manual approve)
publicRouter.post('/signup', async (req, res, next) => {
  try {
    const { name, email, company, role, sector, expected_call_volume, message } = req.body;

    if (!name || !email || !company) {
      throw new AppError(400, 'name, email and company are required');
    }
    if (typeof name !== 'string' || typeof email !== 'string' || typeof company !== 'string') {
      throw new AppError(400, 'name, email and company must be strings');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError(400, 'Invalid email address');
    }

    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip || null;
    const ua = req.headers['user-agent']?.toString().slice(0, 500) || null;

    await query(
      `INSERT INTO signup_requests
         (name, email, company, role, sector, expected_call_volume, message, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        name.slice(0, 200),
        email.slice(0, 200),
        company.slice(0, 200),
        typeof role === 'string' ? role.slice(0, 100) : null,
        typeof sector === 'string' ? sector.slice(0, 100) : null,
        typeof expected_call_volume === 'string' ? expected_call_volume.slice(0, 100) : null,
        typeof message === 'string' ? message.slice(0, 2000) : null,
        ip,
        ua,
      ]
    );

    const recipient = process.env.SIGNUP_NOTIFICATION_EMAIL || process.env.DEMO_REQUEST_EMAIL;
    if (recipient) {
      sendEmail({
        to: recipient,
        subject: `[CallGuard] Trial signup: ${name} at ${company}`,
        html: `
          <h2>New trial signup</h2>
          <p><strong>Name:</strong> ${escapeHtml(name)}</p>
          <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
          <p><strong>Company:</strong> ${escapeHtml(company)}</p>
          ${role ? `<p><strong>Role:</strong> ${escapeHtml(role)}</p>` : ''}
          ${sector ? `<p><strong>Sector:</strong> ${escapeHtml(sector)}</p>` : ''}
          ${expected_call_volume ? `<p><strong>Expected call volume:</strong> ${escapeHtml(expected_call_volume)}</p>` : ''}
          ${message ? `<p><strong>Message:</strong><br>${escapeHtml(message)}</p>` : ''}
          <p style="color:#888;font-size:12px;margin-top:24px;">Review and approve in the admin dashboard at <a href="https://app.callguardai.co.uk/signup-requests">/signup-requests</a></p>
        `,
      }).catch((err) => console.error('[signup] email notification failed:', err));
    }

    res.status(201).json({ message: "Thanks, we'll set up your trial and email you within 1 working day." });
  } catch (err) {
    next(err);
  }
});

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
