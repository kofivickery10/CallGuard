-- Per-user 2FA exemption. 2FA is mandatory for everyone by default; this flag
-- lets a superadmin seed an internal/setup admin login that skips both the login
-- challenge and the mandatory enrolment gate (e.g. a temporary account used to
-- configure a tenant, removed before go-live). Only settable by superadmin flows;
-- tenant-facing user creation never sets it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_exempt BOOLEAN NOT NULL DEFAULT false;
