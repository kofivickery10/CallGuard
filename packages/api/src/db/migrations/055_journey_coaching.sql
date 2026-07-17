-- Journey-level coaching brief (strengths / improvements / next actions across
-- the whole sale). Per-call coaching was intentionally skipped for journeys
-- because a journey can span advisers; a single brief for the sale as a whole
-- is the useful unit. Populated by jobs/processors/score-journey.ts.
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS coaching JSONB;
