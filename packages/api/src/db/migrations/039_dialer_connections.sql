-- Generalises inbound dialer/PBX integration per tenant. CloudTalk is the
-- first provider; the live-streaming path already supports Twilio/AWS
-- Connect/generic dialers (see live_sessions.source) so this table follows
-- the same "provider" shape rather than being CloudTalk-specific.
--
-- Credentials are encrypted at rest with the same AES-256-GCM scheme as
-- sftp_sources/zoho_connections. One connection per (org, provider).
CREATE TABLE dialer_connections (
    id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider                  TEXT NOT NULL DEFAULT 'cloudtalk'
                                  CHECK (provider IN ('cloudtalk')),
    name                      TEXT NOT NULL DEFAULT 'CloudTalk',
    -- HMAC secret used to verify the inbound "Call Ended" webhook signature.
    -- NULL means verification is not yet configured (see routes/ingestion.ts).
    signing_secret_encrypted  TEXT,
    -- CloudTalk REST API (recording fetch, call history) — HTTP Basic auth.
    api_key_id_encrypted      TEXT,
    api_secret_encrypted      TEXT,
    api_base_url              TEXT NOT NULL DEFAULT 'https://my.cloudtalk.io/api',
    -- Recording is still processing when the "Call Ended" event fires — delay
    -- before pulling it. Tunable per tenant; CloudTalk's own guidance varies.
    recording_fetch_delay_seconds INTEGER NOT NULL DEFAULT 60,
    -- Journey window: how far back to gather a customer's prior calls when
    -- assembling a multi-call journey for scoring.
    history_window_days      INTEGER NOT NULL DEFAULT 30,
    -- Tolerant field-name mapping for the inbound payload, since CloudTalk's
    -- webhook shape varies by tenant configuration. Keys are our field names;
    -- values are arrays of candidate keys to check, in order, in the payload
    -- (top-level or one level of nesting — see pickField in ingestion.ts).
    field_map                 JSONB NOT NULL DEFAULT '{
                                  "call_id": ["call_uuid", "uuid", "call_id", "id"],
                                  "recording_url": ["recording_url", "recording", "call_recording_url", "recording_link", "audio_url", "url"],
                                  "agent_email": ["agent_email", "agent_mail", "internal_email"],
                                  "agent_external_id": ["agent_id", "agent", "internal_id"],
                                  "agent_name": ["agent_name", "internal_name"],
                                  "customer_phone": ["external_number", "public_external_number", "contact_number", "phone_number"]
                                }'::jsonb,
    is_active                 BOOLEAN NOT NULL DEFAULT true,
    last_event_at             TIMESTAMPTZ,
    last_error                TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, provider)
);

CREATE INDEX idx_dialer_connections_org ON dialer_connections(organization_id);
CREATE INDEX idx_dialer_connections_active ON dialer_connections(organization_id)
    WHERE is_active = true;

-- Recognise the new async, queued CloudTalk path as a distinct ingestion
-- source from the old synchronous 'api' path, so it is separable in reporting.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_ingestion_source_check;
ALTER TABLE calls ADD CONSTRAINT calls_ingestion_source_check
    CHECK (ingestion_source IN ('upload', 'api', 'sftp', 'live_stream', 'dialer_webhook'));

-- Track the dialer connection a call came from + the raw call id at the
-- provider, for the multi-call history fetch (score-journey needs to know
-- which connection's API to call).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dialer_connection_id UUID
  REFERENCES dialer_connections(id) ON DELETE SET NULL;
