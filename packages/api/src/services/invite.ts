import { createHash, randomBytes } from 'crypto';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { sendEmail } from './email.js';

// Days an invite link stays valid. Long enough to survive an inbox delay / a
// user getting to it a few days later, short enough that a stale link expires.
const INVITE_TTL_DAYS = 7;

export function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Mint a single-use set-password token for a user. Any prior unused tokens for
 * that user are dropped first, so an earlier link can't also be used (resending
 * an invite invalidates the previous one). Returns the raw token — only its
 * hash is stored.
 */
export async function createInviteToken(userId: string): Promise<string> {
  const raw = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query('DELETE FROM invite_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await query(
    `INSERT INTO invite_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashInviteToken(raw), expiresAt.toISOString()]
  );
  return raw;
}

export function buildInviteUrl(rawToken: string): string {
  return `${config.appUrl}/set-password/${rawToken}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Email the set-password link to a newly invited user. Best-effort: returns the
 * sendEmail result so the caller can fall back to showing the admin the link if
 * delivery is unavailable (e.g. RESEND_API_KEY unset).
 */
export async function sendInviteEmail(opts: {
  to: string;
  name: string;
  organizationName: string;
  url: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { to, name, organizationName, url } = opts;
  const safeName = escapeHtml(name || 'there');
  const safeOrg = escapeHtml(organizationName || 'CallGuard');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
  <h2 style="font-size:18px;margin:0 0 12px">You've been invited to CallGuard</h2>
  <p style="font-size:14px;line-height:1.5;margin:0 0 16px">Hi ${safeName}, ${safeOrg} has set up a CallGuard account for you. Set your password to get started:</p>
  <p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">Set your password</a></p>
  <p style="font-size:12px;line-height:1.5;color:#666;margin:0 0 6px">Or paste this link into your browser:</p>
  <p style="font-size:12px;word-break:break-all;color:#2563eb;margin:0 0 16px">${url}</p>
  <p style="font-size:12px;line-height:1.5;color:#666;margin:0">This link expires in ${INVITE_TTL_DAYS} days. If you weren't expecting this, you can ignore this email.</p>
</div>`;
  const text = `Hi ${name || 'there'},\n\n${organizationName || 'CallGuard'} has set up a CallGuard account for you. Set your password here (expires in ${INVITE_TTL_DAYS} days):\n\n${url}\n\nIf you weren't expecting this, you can ignore this email.`;

  return sendEmail({ to, subject: `Set your CallGuard password`, html, text });
}
