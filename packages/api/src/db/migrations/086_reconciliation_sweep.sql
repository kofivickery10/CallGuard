-- Reconciliation runs wait for a document that arrives by hand.
--
-- The insurer's application pack is downloaded from the portal and attached to
-- the CRM record by a team member after the call: usually the same day, and for
-- a sale made late in the day, the next morning. Scoring finishes minutes after
-- the last call, so a run started at score time will nearly always find no
-- document at all.
--
-- 081 already recognised that ('needs_document' is documented there as a waiting
-- state, not a failure), but nothing ever came back to look again. These columns
-- let a sweep do that on a decaying cadence, and — the part that matters for the
-- CRM API budget — let it eventually stop.
--
-- Every attempt lists the sale's attachments and downloads each candidate to see
-- whether it parses against a known profile, so a sale whose pack is never
-- uploaded (cancelled, or handled off-system) would otherwise retry for ever.

ALTER TABLE capture_reconciliation_runs
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE capture_reconciliation_runs
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

COMMENT ON COLUMN capture_reconciliation_runs.attempts IS
  'How many times this run has been processed. Also disambiguates the BullMQ job id per attempt: the scoring queue keeps completed jobs, so reusing reconcile-<run id> would have the retry silently deduped against the previous attempt.';

COMMENT ON COLUMN capture_reconciliation_runs.last_attempt_at IS
  'When the run was last processed. Drives the retry cadence in services/reconciliation-sweep.ts.';

-- 'abandoned': we stopped waiting for a document. Distinct from 'failed' (which
-- means the run errored and is retried by BullMQ) and from 'needs_document'
-- (which invites the reader to keep waiting). The UI must be able to say "we are
-- no longer looking at this" rather than showing a waiting state for ever.
--
-- The CHECK from 081 was declared inline on the column, so its name is whatever
-- Postgres generated. Found by what it constrains rather than by an assumed name:
-- a DROP ... IF EXISTS on a guessed name would pass silently and leave the old
-- constraint in place, and the first 'abandoned' write would then fail in
-- production rather than here.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  FOR con_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'capture_reconciliation_runs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%needs_document%'
  LOOP
    EXECUTE format('ALTER TABLE capture_reconciliation_runs DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

ALTER TABLE capture_reconciliation_runs
  ADD CONSTRAINT capture_reconciliation_runs_status_check
  CHECK (status IN ('pending', 'running', 'needs_document', 'needs_profile',
                    'summary_only', 'completed', 'failed', 'abandoned'));

-- The sweep's own lookup: waiting runs, oldest attempt first.
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_waiting
  ON capture_reconciliation_runs (status, last_attempt_at NULLS FIRST)
  WHERE status = 'needs_document';
