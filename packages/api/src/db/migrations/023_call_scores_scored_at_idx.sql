-- Superadmin analytics (pass-rate trend, overview) aggregate call_scores by
-- scored_at over recent windows. Index it so those range scans don't degrade
-- to full-table seq scans as score volume grows.
CREATE INDEX IF NOT EXISTS idx_call_scores_scored_at ON call_scores(scored_at);
