-- A stable, provider-native call id, so the same CloudTalk call ingested by two
-- different routes is recognised as one call.
--
-- Calls arrive two ways and each recorded a different identifier as
-- `external_id`:
--
--   live webhook  -> CloudTalk's `call_uuid`  e.g. 1c2787a8-5dc3-4c16-...
--   API backfill  -> CloudTalk's CDR `id`     e.g. 1247400354
--
-- Deduplication keys on (organization_id, external_id), so those two never
-- match. Backfilling a customer whose recent calls arrived live would re-ingest
-- every one of them as a new row: the sale is then scored twice over the same
-- conversations, double-charged for transcription, and its breach register
-- duplicated. That is the blocker to recovering the calls that predate a
-- tenant's webhook going live (Trust Point's CloudTalk connection was created
-- 2026-07-16, so nothing before that was ever delivered).
--
-- external_id is deliberately left alone. It is the webhook's idempotency key
-- and rewriting historical values would break replay handling; this is a second,
-- narrower key that both routes can agree on.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dialer_call_id TEXT;

COMMENT ON COLUMN calls.dialer_call_id IS
  'The dialler''s own numeric call id (CloudTalk CDR id). Shared key between live webhook capture and API backfill, which record different values in external_id. NULL for non-dialler sources (SFTP, manual upload).';

-- Backfill from the recording URL, which embeds the numeric id as base64 in its
-- path: https://my.cloudtalk.io/pub/r/<base64(cdr_id)>/<hash>.wav
--
-- Verified against production before writing this: 1055 of 1059 CloudTalk calls
-- carry a parseable pointer, all 1055 decode to digits, and all 1055 are
-- distinct within their organisation. The 4 without are rows that never got a
-- recording pointer at all. Two were cross-checked against CloudTalk's API and
-- matched the CDR ids it returns.
--
-- Guarded on the URL shape and on the decode producing digits, so a pointer in
-- any other format is left NULL rather than storing a junk key.
UPDATE calls
   SET dialer_call_id = convert_from(
         decode(replace(split_part(recording_pointer, '/', 6), '%3D', '='), 'base64'),
         'UTF8'
       )
 WHERE dialer_call_id IS NULL
   AND recording_pointer LIKE 'https://my.cloudtalk.io/pub/r/%'
   AND convert_from(
         decode(replace(split_part(recording_pointer, '/', 6), '%3D', '='), 'base64'),
         'UTF8'
       ) ~ '^[0-9]+$';

-- Mirrors idx_calls_org_external_id. Unique so a double-ingest is refused by the
-- database rather than relying on the application's check-then-insert, which
-- races under concurrent webhook deliveries; captureCallMetadata and ingestCall
-- already catch 23505 and return the winning row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_org_dialer_call_id
    ON calls(organization_id, dialer_call_id)
    WHERE dialer_call_id IS NOT NULL;
