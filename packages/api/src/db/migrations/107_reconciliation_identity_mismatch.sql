-- The application and the recording are about different people.
--
-- Journeys are matched to a customer by normalised phone number, and a shared
-- household mobile is ordinary in protection sales. When it happens, one
-- person's submitted application gets compared against another person's call,
-- and every outcome on the run is meaningless — including the ones that accuse
-- an adviser of never asking a question.
--
-- Observed on a real sale: the application's date of birth was ten and a half
-- years from the one given on the call and the first names differed, and both
-- of those facts were filed as 'undetermined' — the quietest outcome there is.
-- The run went on to produce six findings against the adviser, five of them
-- "you never asked this", with the disproof sitting two rows above them.
--
-- WHY ITS OWN STATUS
--
-- 'failed' is written only by the processor's catch block and means "something
-- went wrong this time, try again" — the sweep retries it, and retrying re-reads
-- the same document against the same call to reach the same conclusion for ever.
-- 'needs_document' and 'needs_profile' both read as "still waiting", which
-- invites someone to keep waiting for a document that has already arrived.
--
-- This is neither. The document is fine, the call is fine, and the pairing
-- between them is wrong — which only a person can resolve, by finding the right
-- call or accepting the sale has none. So it is deliberately in neither
-- RETRYABLE_STATUSES nor ABANDONABLE_STATUSES (services/reconciliation-sweep.ts).
--
-- It IS covered by idx_reconciliation_runs_journey (the partial unique index
-- excludes only 'failed'), so a sale still holds one live run.
ALTER TABLE capture_reconciliation_runs
  DROP CONSTRAINT IF EXISTS capture_reconciliation_runs_status_check;

ALTER TABLE capture_reconciliation_runs
  ADD CONSTRAINT capture_reconciliation_runs_status_check
  CHECK (status IN ('pending', 'running', 'needs_document', 'needs_profile',
                    'summary_only', 'completed', 'failed', 'abandoned',
                    -- The identity fields on the document contradict the ones
                    -- given on the call by more than a mishearing can explain.
                    -- No items are stored: a run that cannot say who it is
                    -- about must not assert anything about anyone.
                    'identity_mismatch'));

COMMENT ON COLUMN capture_reconciliation_runs.status IS
  'Run state. ''identity_mismatch'' means the application and the call appear to be about different people (see services/reconciliation-identity.ts); the run stores no items and is neither retried nor abandoned, because only a person can repair the pairing.';

-- Ops view: sales whose evidence is attached to the wrong customer. Small by
-- nature and read whenever someone asks how often phone matching gets it wrong.
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_identity_mismatch
  ON capture_reconciliation_runs (organization_id, created_at DESC)
  WHERE status = 'identity_mismatch';
