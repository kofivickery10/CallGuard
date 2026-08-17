-- sftp_processed_files could not tell "processed successfully" apart from
-- "errored" — both were just a row with a NULL or non-NULL `error`. The
-- existence check in jobs/processors/sftp-poll.ts skipped either one on
-- every future poll, so a single transient network blip during download
-- permanently blacklisted a regulated call recording, recoverable only by
-- editing the database by hand.
--
-- `status` makes the two cases distinguishable, and `attempt_count` bounds
-- how many times an errored file is retried before the poller gives up on
-- it for good ('abandoned') rather than retrying it silently for ever.
-- 'abandoned' is a separate state from 'errored' precisely so giving up is
-- visible and queryable, not indistinguishable from "about to be retried".
ALTER TABLE sftp_processed_files
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processed'
    CHECK (status IN ('processed', 'errored', 'abandoned')),
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill. A row with `error` set never has a call_id (see the two INSERTs
-- in sftp-poll.ts, which are mutually exclusive on that column) so `error`
-- alone identifies the errored rows; everything else predates this column
-- and was, by definition, a completed ingest.
--
-- Existing errored rows are reset to attempt_count = 1 rather than backdated
-- to some assumed historical count we don't actually have. That is a
-- deliberate one-time amnesty tied to shipping this fix: before today these
-- files had *no* retry path at all, so giving them a full attempt budget on
-- upgrade recovers them instead of leaving files that errored under the old,
-- permanently-blacklisting code worse off than a file that errors for the
-- first time tomorrow. The cap's job is to stop *future* runaway retries,
-- not to punish rows for a bug that predates the cap.
UPDATE sftp_processed_files
   SET status = 'errored',
       attempt_count = 1,
       last_attempt_at = processed_at
 WHERE error IS NOT NULL;

UPDATE sftp_processed_files
   SET last_attempt_at = processed_at
 WHERE error IS NULL;

COMMENT ON COLUMN sftp_processed_files.status IS
  'processed = ingested and must never be re-ingested. errored = failed, eligible for automatic retry on the next poll. abandoned = failed MAX_FILE_ATTEMPTS times in a row and will not be retried automatically again; use the sftp-sources retry endpoints to reset it.';
COMMENT ON COLUMN sftp_processed_files.attempt_count IS
  'Total attempts made at this file. Only meaningful while status is errored/abandoned; caps automatic retrying in jobs/processors/sftp-poll.ts.';

-- Poll-level visibility for the moment a file is abandoned, alongside the
-- existing files_found/files_ingested/files_skipped counters.
ALTER TABLE sftp_poll_logs
  ADD COLUMN IF NOT EXISTS files_abandoned INTEGER DEFAULT 0;
