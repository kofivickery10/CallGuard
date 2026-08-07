-- A reconciliation run that hits an unexpected error must not be stranded.
--
-- 'failed' is written in exactly one place: the catch block in the reconcile
-- processor. Every outcome the code actually anticipates — no document yet, an
-- unrecognised format, a drifted question set, no CRM record — has its own
-- status. So 'failed' never means "this sale cannot be checked"; it means
-- something went wrong on this attempt, and the cause is usually transient (a
-- CRM API error, a network blip, a download that timed out).
--
-- The sweep, however, only re-attempted 'needs_document', 'pending' and
-- 'running'. Nothing revisited 'failed', so a single bad attempt parked a sale
-- permanently — showing an error to the tenant, with no path back even once the
-- cause was fixed. That is precisely what happened when Zoho began requiring a
-- 'fields' parameter on attachment reads: every sale in the tenant failed at
-- once, and none of them recovered after the fix shipped.
--
-- This column bounds the retrying. A cap on TOTAL attempts would not do: a run
-- legitimately waiting three days for its pack accumulates dozens, and would
-- then have no retries left the moment it hit a real error. What has to be
-- bounded is CONSECUTIVE failures, so the counter resets the moment an attempt
-- reaches any other outcome.

ALTER TABLE capture_reconciliation_runs
  ADD COLUMN IF NOT EXISTS failure_streak INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN capture_reconciliation_runs.failure_streak IS
  'Consecutive attempts that ended in an unexpected error. Reset to 0 by any other outcome. Caps retrying in services/reconciliation-sweep.ts so a permanently broken run stops spending CRM API budget, while a hours-long outage does not exhaust it.';

-- The sweep looks up every retryable state, not just 'needs_document'. The index
-- from 086 was partial on that one status, so widening the query without
-- widening the index would push it to a sequential scan on the whole table.
DROP INDEX IF EXISTS idx_reconciliation_runs_waiting;

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_waiting
  ON capture_reconciliation_runs (status, last_attempt_at NULLS FIRST)
  WHERE status IN ('needs_document', 'pending', 'running', 'failed');

-- Existing 'failed' rows predate the counter and default to 0, which is what we
-- want: they become retryable again, which is the point of shipping this.
