-- API keys (SHA-256 hashed)
CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    key_hash        TEXT NOT NULL UNIQUE,
    key_prefix      TEXT NOT NULL,
    created_by      UUID REFERENCES users(id),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_org ON api_keys(organization_id);

-- SFTP sources (credentials encrypted at rest)
CREATE TABLE sftp_sources (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id       UUID NOT NULL REFERENCES organizations(id),
    name                  TEXT NOT NULL,
    host                  TEXT NOT NULL,
    port                  INTEGER NOT NULL DEFAULT 22,
    username              TEXT NOT NULL,
    auth_method           TEXT NOT NULL CHECK (auth_method IN ('password','privatekey')),
    password_encrypted    TEXT,
    private_key_encrypted TEXT,
    remote_path           TEXT NOT NULL DEFAULT '/',
    file_pattern          TEXT,
    filename_template     TEXT,
    poll_interval_minutes INTEGER NOT NULL DEFAULT 15,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    last_polled_at        TIMESTAMPTZ,
    last_error            TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sftp_sources_org ON sftp_sources(organization_id);
CREATE INDEX idx_sftp_sources_active ON sftp_sources(is_active) WHERE is_active = true;

-- Track processed files so we never re-ingest
CREATE TABLE sftp_processed_files (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id    UUID NOT NULL REFERENCES sftp_sources(id) ON DELETE CASCADE,
    remote_path  TEXT NOT NULL,
    file_size    BIGINT,
    call_id      UUID REFERENCES calls(id) ON DELETE SET NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    error        TEXT,
    UNIQUE(source_id, remote_path)
);

CREATE INDEX idx_sftp_processed_source ON sftp_processed_files(source_id);

-- Audit log for SFTP polls
CREATE TABLE sftp_poll_logs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id      UUID NOT NULL REFERENCES sftp_sources(id) ON DELETE CASCADE,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ,
    files_found    INTEGER DEFAULT 0,
    files_ingested INTEGER DEFAULT 0,
    files_skipped  INTEGER DEFAULT 0,
    error_message  TEXT
);

CREATE INDEX idx_sftp_poll_logs_source ON sftp_poll_logs(source_id, started_at DESC);

-- Idempotency + ingestion tracking on calls
ALTER TABLE calls ADD COLUMN external_id TEXT;
ALTER TABLE calls ADD COLUMN ingestion_source TEXT NOT NULL DEFAULT 'upload'
    CHECK (ingestion_source IN ('upload','api','sftp'));

CREATE UNIQUE INDEX idx_calls_org_external_id ON calls(organization_id, external_id)
    WHERE external_id IS NOT NULL;
