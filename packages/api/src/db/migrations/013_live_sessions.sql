-- Live streaming sessions: mobile SDKs and dialers stream audio in real time

-- Webhook config on api_keys (one per integration)
ALTER TABLE api_keys ADD COLUMN webhook_url TEXT;
ALTER TABLE api_keys ADD COLUMN webhook_secret_encrypted TEXT;
ALTER TABLE api_keys ADD COLUMN allow_streaming BOOLEAN NOT NULL DEFAULT false;

-- Allow live streaming as a recognised ingestion source on calls
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_ingestion_source_check;
ALTER TABLE calls ADD CONSTRAINT calls_ingestion_source_check
    CHECK (ingestion_source IN ('upload','api','sftp','live_stream'));

-- A live streaming session
CREATE TABLE live_sessions (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id      UUID NOT NULL REFERENCES organizations(id),
    api_key_id           UUID NOT NULL REFERENCES api_keys(id),
    source               TEXT NOT NULL DEFAULT 'sdk'
        CHECK (source IN ('sdk','twilio','aws_connect','generic_dialer')),
    external_id          TEXT,
    agent_id             UUID REFERENCES users(id),
    scorecard_id         UUID REFERENCES scorecards(id),
    status               TEXT NOT NULL DEFAULT 'opening'
        CHECK (status IN ('opening','active','ended','failed')),
    metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
    consent_required     BOOLEAN NOT NULL DEFAULT true,
    consent_captured_at  TIMESTAMPTZ,
    consent_excerpt      TEXT,
    started_at           TIMESTAMPTZ,
    ended_at             TIMESTAMPTZ,
    duration_seconds     INTEGER,
    transcript_text      TEXT,
    final_call_id        UUID REFERENCES calls(id) ON DELETE SET NULL,
    error_message        TEXT,
    audio_format         TEXT,
    audio_sample_rate    INTEGER,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_live_sessions_org_status ON live_sessions(organization_id, status, created_at DESC);
CREATE INDEX idx_live_sessions_api_key ON live_sessions(api_key_id);
CREATE UNIQUE INDEX idx_live_sessions_org_external
    ON live_sessions(organization_id, external_id)
    WHERE external_id IS NOT NULL;

-- Track which breaches we've already emitted to client + webhook,
-- so the live scoring loop only fires once per criterion per session
CREATE TABLE live_session_emitted_breaches (
    session_id        UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
    scorecard_item_id UUID NOT NULL REFERENCES scorecard_items(id) ON DELETE CASCADE,
    severity          TEXT NOT NULL,
    evidence          TEXT,
    emitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, scorecard_item_id)
);

-- Audit log for outbound webhook deliveries (best-effort visibility)
CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    api_key_id      UUID NOT NULL REFERENCES api_keys(id),
    session_id      UUID REFERENCES live_sessions(id) ON DELETE SET NULL,
    event_type      TEXT NOT NULL,
    target_url      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','delivered','failed','dropped')),
    response_code   INTEGER,
    response_body   TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_deliveries_org_status ON webhook_deliveries(organization_id, status, created_at DESC);
CREATE INDEX idx_webhook_deliveries_session ON webhook_deliveries(session_id) WHERE session_id IS NOT NULL;
