import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { sendEmail } from './email.js';

const INVITE_TTL_DAYS = 7;

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface CreatedInvite {
  id: string;
  email: string;
  name: string;
  role: string;
  expires_at: string;
}

/**
 * Issues an invite for a user to join an organisation. Returns the invite row
 * plus the raw token (only returned here; stored hashed). Caller sends the email.
 */
export async function createInvite(input: {
  organizationId: string;
  email: string;
  name: string;
  role: string;
  invitedBy: string | null;
}): Promise<{ invite: CreatedInvite; rawToken: string }> {
  const existingUser = await queryOne('SELECT id FROM users WHERE lower(email) = lower($1)', [
    input.email,
  ]);
  if (existingUser) {
    throw new AppError(409, 'A user with that email already exists');
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const rows = await query<CreatedInvite>(
    `INSERT INTO invites (organization_id, email, name, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, email, name, role, expires_at`,
    [
      input.organizationId,
      input.email,
      input.name,
      input.role,
      tokenHash,
      input.invitedBy,
      expiresAt.toISOString(),
    ]
  );

  return { invite: rows[0], rawToken };
}

export async function sendInviteEmail(input: {
  to: string;
  name: string;
  organizationName: string;
  rawToken: string;
}): Promise<{ ok: boolean; error?: string }> {
  const link = `${config.appUrl}/accept-invite?token=${input.rawToken}`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a2b22">
      <h2 style="color:#1a2b22">You've been invited to CallGuard AI</h2>
      <p>Hi ${input.name},</p>
      <p>You've been given access to <strong>${input.organizationName}</strong> on CallGuard AI.
      Click below to set your password and sign in.</p>
      <p style="margin:28px 0">
        <a href="${link}" style="background:#4a9e6e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Set your password</a>
      </p>
      <p style="font-size:13px;color:#5a6b62">This link expires in ${INVITE_TTL_DAYS} days. If you weren't expecting this, you can ignore this email.</p>
    </div>`;
  const text = `You've been invited to CallGuard AI (${input.organizationName}). Set your password: ${link} (expires in ${INVITE_TTL_DAYS} days).`;

  return sendEmail({ to: input.to, subject: 'Your CallGuard AI invitation', html, text });
}

export interface AcceptedInvite {
  userId: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
}

/**
 * Accepts an invite: validates the token, creates the user with the chosen
 * password, and marks the invite used. Single-use and time-limited.
 */
export async function acceptInvite(rawToken: string, password: string): Promise<AcceptedInvite> {
  if (!rawToken || !password || password.length < 8) {
    throw new AppError(400, 'A valid token and a password of at least 8 characters are required');
  }

  const invite = await queryOne<{
    id: string;
    organization_id: string;
    email: string;
    name: string;
    role: string;
    expires_at: string;
    accepted_at: string | null;
  }>(
    `SELECT id, organization_id, email, name, role, expires_at, accepted_at
       FROM invites WHERE token_hash = $1`,
    [hashToken(rawToken)]
  );

  if (!invite) throw new AppError(404, 'Invitation not found');
  if (invite.accepted_at) throw new AppError(410, 'This invitation has already been used');
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    throw new AppError(410, 'This invitation has expired');
  }

  // Guard against a duplicate user created between issue and accept.
  const existing = await queryOne('SELECT id FROM users WHERE lower(email) = lower($1)', [
    invite.email,
  ]);
  if (existing) throw new AppError(409, 'A user with that email already exists');

  const passwordHash = await bcrypt.hash(password, 12);
  const userRows = await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [invite.organization_id, invite.email, invite.name, passwordHash, invite.role]
  );

  await query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);

  return {
    userId: userRows[0].id,
    email: invite.email,
    name: invite.name,
    role: invite.role,
    organizationId: invite.organization_id,
  };
}

/**
 * Re-issues a fresh token for a pending invite and returns it so the caller
 * can re-send the email. The old link stops working (token is replaced).
 */
export async function resendInvite(inviteId: string): Promise<{
  rawToken: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName: string;
}> {
  const row = await queryOne<{
    email: string;
    name: string;
    accepted_at: string | null;
    organization_id: string;
    org_name: string;
  }>(
    `SELECT i.email, i.name, i.accepted_at, i.organization_id, o.name AS org_name
       FROM invites i JOIN organizations o ON o.id = i.organization_id
      WHERE i.id = $1`,
    [inviteId]
  );
  if (!row) throw new AppError(404, 'Invitation not found');
  if (row.accepted_at) throw new AppError(410, 'This invitation has already been used');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query('UPDATE invites SET token_hash = $1, expires_at = $2 WHERE id = $3', [
    hashToken(rawToken),
    expiresAt.toISOString(),
    inviteId,
  ]);

  return {
    rawToken,
    email: row.email,
    name: row.name,
    organizationId: row.organization_id,
    organizationName: row.org_name,
  };
}

/** Public preview of an invite (for the accept page) — no token leakage. */
export async function getInvitePreview(
  rawToken: string
): Promise<{ email: string; name: string; organizationName: string } | null> {
  const row = await queryOne<{ email: string; name: string; organization_name: string; expires_at: string; accepted_at: string | null }>(
    `SELECT i.email, i.name, o.name AS organization_name, i.expires_at, i.accepted_at
       FROM invites i JOIN organizations o ON o.id = i.organization_id
      WHERE i.token_hash = $1`,
    [hashToken(rawToken)]
  );
  if (!row || row.accepted_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return { email: row.email, name: row.name, organizationName: row.organization_name };
}
