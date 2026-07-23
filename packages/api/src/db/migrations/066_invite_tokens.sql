-- Secure set-password invite tokens.
--
-- When an admin adds a login-capable user, instead of typing a temporary
-- password and passing it on manually, the user is emailed a one-time link to
-- set their own password. The link carries an opaque random token; only its
-- SHA-256 hash is stored (same at-rest pattern as refresh_tokens), so a DB leak
-- can't be used to accept invites. Single-use (used_at) and time-bound
-- (expires_at); revocable by deletion.
--
-- The invited user is created with a NULL password_hash and login_disabled =
-- false: they cannot sign in (login requires a password) until they consume the
-- link and set one, at which point the same account becomes usable.

CREATE TABLE IF NOT EXISTS invite_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invite_tokens_user_idx ON invite_tokens (user_id);
