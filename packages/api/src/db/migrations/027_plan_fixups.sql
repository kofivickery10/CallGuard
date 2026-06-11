-- Fix column default left as 'growth' by migration 010 (plan_rename updated values but
-- not the DEFAULT, so new tenant inserts hit a CHECK constraint violation).
ALTER TABLE organizations ALTER COLUMN plan SET DEFAULT 'core';

-- Per-user plan override: superadmin can bump a specific user to a higher tier
-- (e.g. a power user at a Core tenant who needs Professional features).
-- NULL = no override; the user inherits the org plan.
-- Constraint prevents accidental downgrade below 'core'.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan_override TEXT
  CHECK (plan_override IN ('core', 'professional', 'enterprise'));
