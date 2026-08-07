-- Record how many calls a capture run actually read.
--
-- The manual "Re-run" on a sale's Data Capture panel had no guard: it deleted
-- the previous run and went again, unconditionally, every time it was pressed.
-- The equivalent button for scoring refuses when nothing has changed, with the
-- reasoning written into routes/journeys.ts — a tenant admin pressed it three
-- times on one sale out of curiosity and watched the number move each time.
--
-- Capture is cheaper than scoring (Haiku, not Sonnet) so the money at stake is
-- small, but the second half of that reasoning is not about money: re-running an
-- extraction on identical input draws another sample from the same distribution
-- and quietly replaces a record a human may already have read.
--
-- journey_score_runs.calls_scored exists so the scoring guard can tell "a call
-- was added" from "nothing changed". capture_runs had no equivalent, so this
-- adds one. Set by the processor at the moment it reads them, not at enqueue —
-- a call linked between the two would otherwise be missed.

ALTER TABLE capture_runs
  ADD COLUMN IF NOT EXISTS calls_captured INTEGER;

COMMENT ON COLUMN capture_runs.calls_captured IS
  'How many calls the run actually read. NULL for runs that predate this column — the re-run guard treats NULL as "unknown", and lets the re-run through rather than blocking on an assumption.';

-- Backfill what can be known: for a completed journey run, the sale''s current
-- call count is the best available estimate. Deliberately not applied to runs
-- that failed or are mid-flight, where it would assert something untrue.
UPDATE capture_runs cr
   SET calls_captured = (
         SELECT count(*) FROM journey_calls jc WHERE jc.journey_id = cr.journey_id
       )
 WHERE cr.calls_captured IS NULL
   AND cr.journey_id IS NOT NULL
   AND cr.status = 'completed';

-- A per-call run reads exactly one call, by definition.
UPDATE capture_runs
   SET calls_captured = 1
 WHERE calls_captured IS NULL
   AND call_id IS NOT NULL
   AND status = 'completed';
