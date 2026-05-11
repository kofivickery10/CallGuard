-- Self-serve trial signup requests (Phase 1).
-- The public form on /signup writes here. An admin reviews + approves
-- in the dashboard, at which point we provision the org + user manually
-- (or via a Phase 2 automation). Captures richer lead data than the
-- existing demo_requests table.

CREATE TABLE signup_requests (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                 TEXT NOT NULL,
    email                TEXT NOT NULL,
    company              TEXT NOT NULL,
    role                 TEXT,
    sector               TEXT,
    expected_call_volume TEXT,
    message              TEXT,
    status               TEXT NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new', 'contacted', 'approved', 'rejected', 'churned')),
    notes                TEXT,
    approved_at          TIMESTAMPTZ,
    approved_by          UUID REFERENCES users(id),
    invited_organization_id UUID REFERENCES organizations(id),
    ip_address           TEXT,
    user_agent           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_signup_requests_status_created
    ON signup_requests(status, created_at DESC);

CREATE INDEX idx_signup_requests_email
    ON signup_requests(lower(email));
