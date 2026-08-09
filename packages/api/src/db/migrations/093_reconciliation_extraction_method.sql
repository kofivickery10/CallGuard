-- Record HOW a run's items were produced, because it changes what they are.
--
-- A run parsed with a stored profile is deterministic: re-run it and the same
-- items come back, which is what lets a flag stand as evidence. A run read
-- directly by a model — the fallback for a format no profile fits yet, e.g. an
-- insurer the firm started selling without telling anyone — is a best effort
-- that cannot be re-derived, so it must never be mistaken for the former.
--
-- The distinction is also what makes the fallback self-correcting: when a
-- format for the document later goes live, activateProfile re-queues completed
-- runs marked 'model' alongside the parked ones, and the deterministic parse
-- replaces the model's reading. 'profile' is the default because every run that
-- existed before this column was one.
ALTER TABLE capture_reconciliation_runs
  ADD COLUMN IF NOT EXISTS extraction_method TEXT NOT NULL DEFAULT 'profile'
    CHECK (extraction_method IN ('profile', 'model'));

COMMENT ON COLUMN capture_reconciliation_runs.extraction_method IS
  'How the items were produced: ''profile'' = deterministic parse with a stored document profile (re-derivable); ''model'' = direct model extraction fallback for a format with no usable profile yet (provisional — upgraded to a profile parse when one goes live).';
