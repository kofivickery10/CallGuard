-- Scorecard items can be referenced by historical call_item_scores/breaches
-- (no ON DELETE from those tables, deliberately — a compliance record should
-- not silently disappear because a scorecard was later edited). Editing a
-- scorecard's items after any call has been scored against it therefore can't
-- hard-delete a removed item; it must be archived instead so history stays
-- intact while it drops out of future scoring runs.
ALTER TABLE scorecard_items ADD COLUMN archived_at TIMESTAMPTZ;
