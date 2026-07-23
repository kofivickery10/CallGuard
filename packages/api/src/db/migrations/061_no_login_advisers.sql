-- No-login advisers.
--
-- Some tenants want their front-line advisers in the system so calls attribute
-- to them and they count as billable seats, but do NOT want them to be able to
-- sign in and see the app. Such an adviser is an ordinary users row with login
-- switched off:
--   * login_disabled hard-blocks the auth flow (login / session issue / refresh),
--   * email + password_hash become optional, so an adviser can be added by name
--     alone (plus an optional dialler agent id for call attribution).
--
-- Billing is headcount-based (services/billing.ts), so a no-login adviser still
-- bills like any other seat — no billing change is needed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS login_disabled BOOLEAN NOT NULL DEFAULT false;

-- Relax the login credentials so a no-login adviser needs neither. The UNIQUE
-- constraint on email stays (Postgres allows multiple NULLs under UNIQUE), so
-- advisers who DO log in still can't share an email.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
