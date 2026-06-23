-- Per-API-call usage ledger. One row per external call to a paid provider
-- (Deepgram transcription, every Claude call: cleanup / score / verify /
-- live_score / insights). Written live by the processors so the superadmin
-- usage report shows actual, per-operation cost instead of a rough estimate.
CREATE TABLE usage_events (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id       UUID REFERENCES organizations(id) ON DELETE SET NULL,
  call_id               UUID REFERENCES calls(id) ON DELETE SET NULL,
  provider              TEXT NOT NULL,   -- 'anthropic' | 'deepgram'
  operation             TEXT NOT NULL,   -- 'transcribe'|'cleanup'|'score'|'verify'|'live_score'|'insights'
  model_id              TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  audio_seconds         NUMERIC,         -- set for provider = 'deepgram'
  est_cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_events_created      ON usage_events(created_at DESC);
CREATE INDEX idx_usage_events_org_created  ON usage_events(organization_id, created_at DESC);
CREATE INDEX idx_usage_events_call         ON usage_events(call_id);
CREATE INDEX idx_usage_events_op_created   ON usage_events(operation, created_at DESC);
