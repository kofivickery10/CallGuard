-- Split platform staff into two levels:
--   is_staff      = platform staff (support) — support inbox + read-only analytics
--   is_superadmin = full powers — provisioning, tenant settings, staff management
-- is_superadmin implies is_staff (enforced in application code).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false;

-- Anyone who was is_staff before this split had full powers, so keep them as superadmins.
UPDATE users SET is_superadmin = true WHERE is_staff = true;

-- Invites can carry platform-staff intent, applied when the invite is accepted.
ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS is_staff BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false;
