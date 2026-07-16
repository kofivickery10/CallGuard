-- Metadata-only call capture for 'sales_only' tenants (see routes/ingestion.ts
-- handleCloudTalkWebhook, services/journey.ts). Under this model CloudTalk's
-- "Call Ended" webhook records lightweight metadata for every call — the
-- CloudTalk call UUID (external_id), customer phone, agent, timestamp,
-- direction and a recording pointer — WITHOUT downloading the audio or
-- transcribing. Nothing but metadata touches CallGuard until the customer
-- converts; a Zoho sale trigger then pulls the recordings for that customer's
-- captured calls, transcribes and scores them as one journey.
--
-- This requires a call row that has no audio yet:
--   * file_key / mime_type nullable (audio is fetched later, at sale time)
--   * a new 'captured' status, sitting before 'uploaded' in the lifecycle
--   * recording_pointer holds the webhook's recording URL when it carried one
--     (often absent — the recording is re-fetched by external_id at sale time,
--     which avoids relying on a URL that may have expired by then)

-- file_key was NOT NULL (every prior ingest path downloaded before insert).
-- Captured calls have no audio yet, so relax it. mime_type is already nullable.
ALTER TABLE calls ALTER COLUMN file_key DROP NOT NULL;

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE calls
  ADD CONSTRAINT calls_status_check
  CHECK (status IN ('captured', 'uploaded', 'transcribing', 'transcribed', 'scoring', 'scored', 'skipped', 'failed'));

ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_pointer TEXT;
