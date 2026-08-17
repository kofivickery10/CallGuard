-- Per-org horizon for purging never-converted 'captured' calls (see
-- jobs/processors/retention-purge.ts). Previously a single hardcoded global
-- (CAPTURED_PURGE_AFTER_DAYS = 90) applied to every tenant regardless of how
-- long their sales journey can run — a firm with a 120-day mortgage journey
-- had its earlier calls purged out from under a journey still in progress,
-- with no warning. Default kept at the prior global value (90) so behaviour
-- is unchanged for every existing tenant until they set an override.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS captured_retention_days INTEGER NOT NULL DEFAULT 90;
