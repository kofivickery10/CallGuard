-- Retire the two-pass scoring architecture.
--
-- Scoring ran on Haiku and re-checked flagged items on Sonnet. The second pass
-- never earned its place: it broke twice on output budgeting (a fixed 2048-token
-- cap truncating the tool call), both times silently, because a failure was
-- swallowed by a best-effort catch and left no usage row behind. On the sale
-- that exposed it, the cheap first pass had also produced a false breach at 0.95
-- confidence, missed two explicit consent responses, and passed a compound
-- criterion on half its content.
--
-- Scoring now runs once on Sonnet, which costs roughly half the two-pass design
-- and applies the strictness and compound-criteria rules that used to live in
-- the verify prompt to every item rather than only to the ones that reached a
-- second opinion.
--
-- Migration 071 added verify_status/verify_error a few hours before this
-- decision; nothing ever wrote to them. Dropping rather than leaving them
-- behind: an unused column named verify_status is a trap for whoever next reads
-- this schema and concludes there is a verification stage.
DROP INDEX IF EXISTS idx_journeys_verify_failed;

ALTER TABLE journeys DROP COLUMN IF EXISTS verify_status;
ALTER TABLE journeys DROP COLUMN IF EXISTS verify_error;
ALTER TABLE calls    DROP COLUMN IF EXISTS verify_status;
ALTER TABLE calls    DROP COLUMN IF EXISTS verify_error;
