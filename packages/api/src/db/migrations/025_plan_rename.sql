-- Rename subscription plans to match the new tier naming:
--   starter       → core
--   growth        → professional
--   pro           → enterprise

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_plan_check;

UPDATE organizations SET plan = 'core'         WHERE plan = 'starter';
UPDATE organizations SET plan = 'professional' WHERE plan = 'growth';
UPDATE organizations SET plan = 'enterprise'   WHERE plan = 'pro';

ALTER TABLE organizations
  ADD CONSTRAINT organizations_plan_check
  CHECK (plan IN ('core', 'professional', 'enterprise'));
