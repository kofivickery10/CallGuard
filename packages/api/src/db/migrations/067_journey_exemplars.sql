-- Journey (sale) exemplars — the sales_only equivalent of call exemplars.
-- Mirrors calls.is_exemplar / exemplar_reason (011_ai_learning.sql). In
-- sales_only mode individual calls never reach 'scored', so the call-level
-- "Mark as exemplar" button never renders; this lets an admin mark a whole
-- SALE as "what good looks like", and getLearningContext feeds its combined
-- transcript into the scoring prompt as a firm exemplar.
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS is_exemplar BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS exemplar_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_journeys_exemplars
  ON journeys(organization_id, is_exemplar) WHERE is_exemplar = true;
