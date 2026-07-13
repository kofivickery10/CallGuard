-- Scorecard versioning + branch configuration + scoring mode (spec §8/§10).
ALTER TABLE scorecards
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  -- Defines the branches this scorecard supports and how to detect which one
  -- applies to a given call/journey, e.g.
  --   {"branches": ["on_risk", "referred"], "detect": "keyword", "keywords": {"referred": ["refer to a specialist", "referred adviser"]}}
  -- NULL = single implicit branch (every item applies, current behaviour).
  ADD COLUMN IF NOT EXISTS branch_config JSONB,
  ADD COLUMN IF NOT EXISTS scoring_mode TEXT NOT NULL DEFAULT 'journey'
    CHECK (scoring_mode IN ('per_call', 'journey'));

-- Pin every score to the scorecard version it was actually scored against,
-- so editing a live scorecard later never retroactively changes what a past
-- call/journey appears to have been judged on.
ALTER TABLE call_scores ADD COLUMN IF NOT EXISTS scorecard_version INTEGER;
UPDATE call_scores SET scorecard_version = 1 WHERE scorecard_version IS NULL;
