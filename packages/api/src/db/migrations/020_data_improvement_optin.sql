-- Opt-in (default OFF) for using anonymised, customer-derived data to improve
-- the Services, per DPA §4.2. Default false keeps "we don't train on your data"
-- true unless the Controller explicitly opts in. The _at / _by columns record
-- the consent event for evidencing; the audit_log carries the full trail.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS data_improvement_opt_in BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS data_improvement_opt_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS data_improvement_opt_in_by UUID REFERENCES users(id);
