-- Per-call direction (inbound/outbound), when the dialler's webhook payload
-- carries it (see routes/ingestion.ts's DialerFieldMap.direction). Nullable:
-- manual uploads and payloads without a recognisable direction field leave
-- this null, and transcription falls back to the org's mono_first_speaker
-- default (048_mono_first_speaker.sql) for the mono-diarisation speaker
-- guess instead of a per-call override.
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS direction TEXT CHECK (direction IN ('inbound', 'outbound'));
