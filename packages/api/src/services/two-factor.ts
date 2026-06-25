import crypto from 'crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { query, queryOne } from '../db/client.js';
import { encrypt, decrypt } from './crypto.js';
import { sendEmail } from './email.js';

// Allow ±30s (one time-step) of clock drift either side of the current window.
const EPOCH_TOLERANCE_SECONDS = 30;

const ISSUER = 'CallGuard';
const BACKUP_CODE_COUNT = 10;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const EMAIL_CODE_MAX_ATTEMPTS = 5;

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── TOTP enrolment ────────────────────────────────────────────────────────────

export interface TotpSetup {
  secret: string; // plaintext base32 — returned to the client once, never stored raw
  otpauthUrl: string;
  qrDataUrl: string; // data: PNG for the enrolment screen
}

// Generate a fresh secret and the matching otpauth URL + QR image. The secret is
// returned to the caller (to persist encrypted as "pending") and rendered as a QR.
export async function generateTotpSetup(email: string): Promise<TotpSetup> {
  const secret = generateSecret();
  const otpauthUrl = generateURI({ issuer: ISSUER, label: email, secret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { secret, otpauthUrl, qrDataUrl };
}

export async function verifyTotp(token: string, secret: string): Promise<boolean> {
  try {
    const result = await verify({
      secret,
      token: token.replace(/\s/g, ''),
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
    });
    return result.valid;
  } catch {
    return false;
  }
}

export function encryptSecret(secret: string): string {
  return encrypt(secret);
}

export function decryptSecret(encrypted: string): string {
  return decrypt(encrypted);
}

// ── Backup codes ──────────────────────────────────────────────────────────────

// Generate, persist (hashed), and return a fresh set of single-use backup codes.
// Any existing codes for the user are deleted first (regeneration invalidates old).
export async function generateBackupCodes(userId: string): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    // 10 hex chars, grouped for readability: "a1b2c-3d4e5"
    const raw = crypto.randomBytes(5).toString('hex');
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }

  await query('DELETE FROM two_factor_backup_codes WHERE user_id = $1', [userId]);
  for (const code of codes) {
    await query(
      'INSERT INTO two_factor_backup_codes (user_id, code_hash) VALUES ($1, $2)',
      [userId, sha256(code.replace(/\s/g, '').toLowerCase())]
    );
  }
  return codes;
}

// Consume a backup code if it matches an unused one. Returns true on success.
export async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const hash = sha256(code.replace(/\s/g, '').toLowerCase());
  const rows = await query<{ id: string }>(
    `UPDATE two_factor_backup_codes
        SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, hash]
  );
  return rows.length > 0;
}

export async function countUnusedBackupCodes(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM two_factor_backup_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );
  return row ? parseInt(row.count, 10) : 0;
}

// ── Email one-time codes (fallback factor) ──────────────────────────────────────

// Generate a 6-digit code, store it hashed with a short TTL, and email it. Replaces
// any existing pending code for the user.
export async function sendEmailCode(userId: string, email: string): Promise<void> {
  const code = (crypto.randomInt(0, 1_000_000)).toString().padStart(6, '0');
  const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS);

  await query(
    `INSERT INTO two_factor_email_codes (user_id, code_hash, expires_at, attempts, created_at)
     VALUES ($1, $2, $3, 0, now())
     ON CONFLICT (user_id) DO UPDATE
       SET code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           attempts = 0,
           created_at = now()`,
    [userId, sha256(code), expiresAt.toISOString()]
  );

  await sendEmail({
    to: email,
    subject: 'Your CallGuard verification code',
    html: `<p>Your CallGuard verification code is:</p>
           <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0;">${code}</p>
           <p>This code expires in 10 minutes. If you didn't try to sign in, change your password.</p>`,
    text: `Your CallGuard verification code is ${code}. It expires in 10 minutes.`,
  });
}

// Verify an email code. Increments the attempt counter; locks the code after too
// many wrong guesses. Consumes (deletes) the code on success.
export async function verifyEmailCode(userId: string, code: string): Promise<boolean> {
  const row = await queryOne<{ code_hash: string; expires_at: string; attempts: number }>(
    'SELECT code_hash, expires_at, attempts FROM two_factor_email_codes WHERE user_id = $1',
    [userId]
  );
  if (!row) return false;
  if (new Date(row.expires_at) < new Date()) return false;
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return false;

  if (sha256(code.replace(/\s/g, '')) !== row.code_hash) {
    await query('UPDATE two_factor_email_codes SET attempts = attempts + 1 WHERE user_id = $1', [userId]);
    return false;
  }

  await query('DELETE FROM two_factor_email_codes WHERE user_id = $1', [userId]);
  return true;
}

// Hide most of an email for display on the challenge screen: "jo***@acme.com".
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || !local) return email;
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}${'*'.repeat(Math.max(1, local.length - shown.length))}@${domain}`;
}

export { BACKUP_CODE_COUNT };
