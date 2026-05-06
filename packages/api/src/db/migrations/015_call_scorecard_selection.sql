-- Per-call scorecard selection.
-- Lets the caller specify which scorecard a call should be scored against
-- at upload / ingest time. Falls back to the org's active scorecard when null.
-- Critical for BPO-style customers who run multiple campaigns each with
-- their own scorecard.

ALTER TABLE calls
  ADD COLUMN scorecard_id UUID REFERENCES scorecards(id);

CREATE INDEX idx_calls_org_scorecard
  ON calls(organization_id, scorecard_id)
  WHERE scorecard_id IS NOT NULL;
