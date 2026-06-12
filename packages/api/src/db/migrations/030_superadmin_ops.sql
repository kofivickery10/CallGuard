-- Superadmin operations: platform announcements, per-tenant feature overrides,
-- and a cross-tenant audit index so the superadmin audit viewer can page the
-- whole platform by time (the existing audit indexes are all org-scoped).

-- Platform-wide announcements (maintenance windows, incident notices) shown as
-- a banner in every tenant app while active and within their date window.
CREATE TABLE IF NOT EXISTS announcements (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'info'
                CHECK (level IN ('info', 'warning', 'critical')),
    active      BOOLEAN NOT NULL DEFAULT true,
    starts_at   TIMESTAMPTZ,
    ends_at     TIMESTAMPTZ,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-tenant feature flag overrides beyond plan gating. JSON object keyed by
-- feature flag; true grants, false denies, absent falls back to the plan.
-- e.g. {"live_streaming": true} grants streaming to a Core tenant on trial.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS feature_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Cross-tenant, time-ordered audit paging for the superadmin viewer.
CREATE INDEX IF NOT EXISTS idx_audit_log_created
    ON audit_log(created_at DESC);
