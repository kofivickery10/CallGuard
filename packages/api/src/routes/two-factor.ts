import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { authenticate, AuthPayload } from '../middleware/auth.js';
import { issueSession } from './auth.js';
import { recordAuditEvent, AuditActionType } from '../services/audit.js';
import {
  generateTotpSetup,
  verifyTotp,
  encryptSecret,
  decryptSecret,
  generateBackupCodes,
  consumeBackupCode,
  countUnusedBackupCodes,
  sendEmailCode,
  verifyEmailCode,
} from '../services/two-factor.js';
import type { Request } from 'express';

export const twoFactorRouter = Router();

// Audit a 2FA event — only when the user belongs to an org (audit_log.organization_id
// is NOT NULL, so superadmins, who have no org, are skipped here).
async function audit(
  req: Request,
  userId: string,
  organizationId: string | null,
  actionType: AuditActionType,
  summary: string
): Promise<void> {
  if (!organizationId) return;
  await recordAuditEvent({
    organizationId,
    userId,
    actionType,
    entityType: 'user',
    entityId: userId,
    summary,
    req,
  });
}

// Resolve the user id carried by a 2FA login-challenge token, or throw 401.
function userIdFromChallenge(challengeToken: unknown): string {
  if (!challengeToken || typeof challengeToken !== 'string') {
    throw new AppError(400, 'challenge_token is required');
  }
  let payload: AuthPayload;
  try {
    payload = jwt.verify(challengeToken, config.jwt.secret) as AuthPayload;
  } catch {
    throw new AppError(401, 'Your sign-in session expired. Please log in again.');
  }
  if (payload.typ !== 'mfa' || !payload.userId) {
    throw new AppError(401, 'Invalid challenge token');
  }
  return payload.userId;
}

// ── Login second factor (challenge-token authenticated) ─────────────────────────

// POST /auth/2fa/login/verify — complete login by verifying the second factor.
// Accepts a TOTP code, an emailed code, or a single-use backup code.
twoFactorRouter.post('/login/verify', async (req, res, next) => {
  try {
    const { challenge_token, method, code } = req.body as {
      challenge_token?: string;
      method?: 'totp' | 'email' | 'backup';
      code?: string;
    };
    const userId = userIdFromChallenge(challenge_token);

    if (!code || typeof code !== 'string') {
      throw new AppError(400, 'code is required');
    }

    const user = await queryOne<{
      id: string;
      organization_id: string | null;
      totp_secret: string | null;
      totp_enabled: boolean;
    }>(
      'SELECT id, organization_id, totp_secret, totp_enabled FROM users WHERE id = $1',
      [userId]
    );
    if (!user || !user.totp_enabled || !user.totp_secret) {
      throw new AppError(401, 'Two-factor authentication is not set up for this account');
    }

    let ok = false;
    let usedBackup = false;
    if (method === 'totp') {
      ok = await verifyTotp(code, decryptSecret(user.totp_secret));
    } else if (method === 'email') {
      ok = await verifyEmailCode(user.id, code);
    } else if (method === 'backup') {
      ok = await consumeBackupCode(user.id, code);
      usedBackup = ok;
    } else {
      throw new AppError(400, 'method must be one of: totp, email, backup');
    }

    if (!ok) {
      await audit(req, user.id, user.organization_id, 'auth.2fa.failed', `Failed ${method} verification at login`);
      throw new AppError(401, 'Incorrect or expired code');
    }

    const session = await issueSession(user.id, true);
    await audit(req, user.id, user.organization_id, 'auth.2fa.verified', `Signed in with ${method}`);
    if (usedBackup) {
      const remaining = await countUnusedBackupCodes(user.id);
      await audit(req, user.id, user.organization_id, 'auth.2fa.backup_used', `Used a backup code (${remaining} remaining)`);
    }
    res.json(session);
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/login/email-code — send a one-time code to the user's email as a
// fallback factor during login. Challenge-token authenticated.
twoFactorRouter.post('/login/email-code', async (req, res, next) => {
  try {
    const userId = userIdFromChallenge((req.body as { challenge_token?: string }).challenge_token);
    const user = await queryOne<{ email: string; totp_enabled: boolean }>(
      'SELECT email, totp_enabled FROM users WHERE id = $1',
      [userId]
    );
    if (!user || !user.totp_enabled) {
      throw new AppError(401, 'Two-factor authentication is not set up for this account');
    }
    await sendEmailCode(userId, user.email);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Enrolment & management (access-token authenticated) ─────────────────────────
// These run under `authenticate`, which the MFA gate exempts for /api/auth/2fa,
// so an unenrolled (gated) session can still reach them to complete enrolment.

twoFactorRouter.use(authenticate);

// GET /auth/2fa/status — current 2FA state for the signed-in user.
twoFactorRouter.get('/status', async (req, res, next) => {
  try {
    const user = await queryOne<{ totp_enabled: boolean }>(
      'SELECT totp_enabled FROM users WHERE id = $1',
      [req.user!.userId]
    );
    const backup_codes_remaining = await countUnusedBackupCodes(req.user!.userId);
    res.json({ enabled: !!user?.totp_enabled, backup_codes_remaining });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/setup — begin enrolment: generate a secret + QR. The secret is
// stored encrypted but not yet enabled until /verify-setup confirms a live code.
twoFactorRouter.post('/setup', async (req, res, next) => {
  try {
    const user = await queryOne<{ email: string; totp_enabled: boolean; totp_secret: string | null }>(
      'SELECT email, totp_enabled, totp_secret FROM users WHERE id = $1',
      [req.user!.userId]
    );
    if (!user) throw new AppError(404, 'User not found');
    if (user.totp_enabled) {
      throw new AppError(400, 'Two-factor authentication is already enabled');
    }

    // Reuse a pending secret if one exists, so a repeated setup call (e.g. React
    // StrictMode double-mounting the enrolment page, or a page refresh mid-flow)
    // can't silently invalidate the QR the user is about to scan.
    let pendingSecret: string | undefined;
    if (user.totp_secret) {
      try {
        pendingSecret = decryptSecret(user.totp_secret);
      } catch {
        // Undecryptable (e.g. ENCRYPTION_KEY changed) — fall through to a fresh secret.
      }
    }

    const setup = await generateTotpSetup(user.email, pendingSecret);
    if (!pendingSecret) {
      await query('UPDATE users SET totp_secret = $1 WHERE id = $2', [
        encryptSecret(setup.secret),
        req.user!.userId,
      ]);
    }

    res.json({
      otpauth_url: setup.otpauthUrl,
      qr_data_url: setup.qrDataUrl,
      secret: setup.secret, // shown as a manual-entry fallback to the QR
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/verify-setup — confirm enrolment with a live code, enable 2FA,
// and return backup codes (once) plus a fresh session whose token satisfies the gate.
twoFactorRouter.post('/verify-setup', async (req, res, next) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code || typeof code !== 'string') throw new AppError(400, 'code is required');

    const user = await queryOne<{
      organization_id: string | null;
      totp_secret: string | null;
      totp_enabled: boolean;
    }>('SELECT organization_id, totp_secret, totp_enabled FROM users WHERE id = $1', [
      req.user!.userId,
    ]);
    if (!user) throw new AppError(404, 'User not found');
    if (user.totp_enabled) throw new AppError(400, 'Two-factor authentication is already enabled');
    if (!user.totp_secret) throw new AppError(400, 'Start enrolment first');

    if (!(await verifyTotp(code, decryptSecret(user.totp_secret)))) {
      throw new AppError(400, 'That code is incorrect. Check your authenticator app and try again.');
    }

    await query(
      'UPDATE users SET totp_enabled = true, two_factor_enrolled_at = now() WHERE id = $1',
      [req.user!.userId]
    );
    const backup_codes = await generateBackupCodes(req.user!.userId);

    // Re-issue the session so the new token carries mfa: true and the gate lifts.
    const session = await issueSession(req.user!.userId, true);
    await audit(req, req.user!.userId, user.organization_id, 'auth.2fa.enrolled', 'Enrolled in two-factor authentication');

    res.json({ ...session, backup_codes });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/backup-codes/regenerate — issue a fresh set of backup codes,
// invalidating the old ones. Requires a live TOTP code to authorise.
twoFactorRouter.post('/backup-codes/regenerate', async (req, res, next) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code || typeof code !== 'string') throw new AppError(400, 'code is required');

    const user = await queryOne<{
      organization_id: string | null;
      totp_secret: string | null;
      totp_enabled: boolean;
    }>('SELECT organization_id, totp_secret, totp_enabled FROM users WHERE id = $1', [
      req.user!.userId,
    ]);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      throw new AppError(400, 'Two-factor authentication is not enabled');
    }
    if (!(await verifyTotp(code, decryptSecret(user.totp_secret)))) {
      throw new AppError(400, 'That code is incorrect');
    }

    const backup_codes = await generateBackupCodes(req.user!.userId);
    await audit(req, req.user!.userId, user.organization_id, 'auth.2fa.backup_regenerated', 'Regenerated backup codes');
    res.json({ backup_codes });
  } catch (err) {
    next(err);
  }
});
