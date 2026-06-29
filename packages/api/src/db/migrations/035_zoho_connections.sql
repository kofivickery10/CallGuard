-- Zoho CRM connections: one row per organization. Holds the OAuth credentials
-- (encrypted at rest, same AES-256-GCM scheme as sftp_sources) plus which module
-- and custom fields CallGuard writes compliance results to. One-way push only —
-- CallGuard writes the score/result + breach tasks, never reads contact details.
CREATE TABLE zoho_connections (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- Zoho data centre region: 'eu' (UK/EU), 'com' (US), 'in', 'com.au', 'jp', 'ca'.
    -- Drives the accounts.zoho.<region> OAuth host; the CRM api_domain comes back
    -- from the token exchange and is stored separately.
    dc_region                TEXT NOT NULL DEFAULT 'eu',
    -- OAuth client (self-client / server-based app) created in the Zoho API console.
    client_id                TEXT NOT NULL,
    client_secret_encrypted  TEXT NOT NULL,
    -- Long-lived refresh token + cached short-lived access token, both encrypted.
    refresh_token_encrypted  TEXT,
    access_token_encrypted   TEXT,
    token_expires_at         TIMESTAMPTZ,
    -- CRM API base returned by the token exchange, e.g. https://www.zohoapis.eu
    api_domain               TEXT,
    -- Which module scored calls are matched/written to.
    module                   TEXT NOT NULL DEFAULT 'Leads'
                                 CHECK (module IN ('Leads','Contacts')),
    -- API names of the custom fields CallGuard writes. Defaults match the labels
    -- in docs/zoho-integration.md; overridable per tenant if Zoho generated
    -- different API names.
    field_map                JSONB NOT NULL DEFAULT '{
                                 "score": "Compliance_Score",
                                 "result": "Compliance_Result",
                                 "last_scored": "Last_Scored",
                                 "link": "CallGuard_Link"
                               }'::jsonb,
    -- Connection is only usable once the OAuth dance has produced a refresh token.
    status                   TEXT NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','active','disabled')),
    last_synced_at           TIMESTAMPTZ,
    last_error               TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One Zoho connection per org.
    UNIQUE (organization_id)
);

CREATE INDEX idx_zoho_connections_active
    ON zoho_connections(organization_id)
    WHERE status = 'active';
