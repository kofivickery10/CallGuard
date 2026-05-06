-- Audit log: tracks admin / compliance-officer actions for procurement reviews
-- and FCA / SOC2 evidence trails.

CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    user_id         UUID REFERENCES users(id),
    action_type     TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT,
    summary         TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address      TEXT,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_org_created
    ON audit_log(organization_id, created_at DESC);

CREATE INDEX idx_audit_log_action
    ON audit_log(organization_id, action_type, created_at DESC);

CREATE INDEX idx_audit_log_user
    ON audit_log(organization_id, user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
