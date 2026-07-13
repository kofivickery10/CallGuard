-- Per-tenant scoring/ingestion policy. Previously hardcoded globals
-- (shared/constants.ts, config.ts) — now overridable per organization, with
-- the prior global value kept as the column default so behaviour is
-- unchanged for every existing tenant until they set an override.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS scoring_scope TEXT NOT NULL DEFAULT 'sales_only'
    CHECK (scoring_scope IN ('sales_only', 'over_threshold', 'everything')),
  ADD COLUMN IF NOT EXISTS min_scoreable_seconds INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS min_scoreable_words INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS pass_threshold NUMERIC(5,2) NOT NULL DEFAULT 70,
  -- 5 years, per the agreed retention policy.
  ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 1825,
  ADD COLUMN IF NOT EXISTS transcription_mode TEXT NOT NULL DEFAULT 'mono_diarize'
    CHECK (transcription_mode IN ('mono_diarize', 'stereo_multichannel')),
  ADD COLUMN IF NOT EXISTS deepgram_region TEXT NOT NULL DEFAULT 'eu'
    CHECK (deepgram_region IN ('eu', 'us')),
  -- Floor, not a real opt-in: Deepgram's Model Improvement Program is always
  -- opted out for voice data containing financial/health disclosures. No
  -- tenant-facing control sets this false; the column exists so the
  -- resolver has one place to read it from rather than a hardcoded literal
  -- scattered across services/transcription.ts and deepgram-stream.ts.
  ADD COLUMN IF NOT EXISTS deepgram_mip_opt_out BOOLEAN NOT NULL DEFAULT true;
