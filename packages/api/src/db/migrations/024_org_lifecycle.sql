-- Organisation lifecycle: status tracking and superadmin role.

-- Org status (active / suspended / cancelled)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'cancelled')),
  ADD COLUMN IF NOT EXISTS subscription_notes TEXT,
  ADD COLUMN IF NOT EXISTS created_by_staff UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

-- Superadmin users have no org (platform operators).
-- Allow organization_id to be NULL for them; existing NOT NULL constraint is dropped.
ALTER TABLE users ALTER COLUMN organization_id DROP NOT NULL;

-- Expand role enum to include superadmin.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('superadmin', 'admin', 'supervisor', 'viewer', 'adviser'));
