-- Two-factor authentication.
-- TOTP (authenticator app) is the primary factor; email one-time codes are the
-- fallback; single-use backup codes are the recovery path. 2FA is mandatory for
-- all users — unenrolled users are gated out of the app until they enrol.

ALTER TABLE users
  -- AES-256-GCM encrypted at rest (services/crypto.ts). NULL until enrolment begins.
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS two_factor_enrolled_at TIMESTAMPTZ;

-- Single-use backup codes. Generated at enrolment, shown to the user once, stored
-- only as SHA-256 hashes. A NULL used_at means the code is still spendable.
CREATE TABLE IF NOT EXISTS two_factor_backup_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_2fa_backup_codes_user ON two_factor_backup_codes(user_id);

-- Email one-time login codes (fallback factor). One active row per user, replaced
-- on each request. Stored as a SHA-256 hash with a short expiry and an attempt
-- counter so a code can be locked after repeated wrong guesses.
CREATE TABLE IF NOT EXISTS two_factor_email_codes (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
