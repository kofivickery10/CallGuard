-- Let score_corrections (the calibration record fed back into scoring) also
-- reference a JOURNEY item, not just a call item. In sales_only mode calls are
-- never individually scored, so the only human verdicts happen on sales — and
-- until now none of them became calibration data. This gives sales the same
-- learning loop calls had.
--
-- The table was call-only (call_id / call_item_score_id NOT NULL). Make those
-- nullable, add the journey pair, and require exactly one parent so a row is
-- unambiguously a call correction or a sale correction.
ALTER TABLE score_corrections ALTER COLUMN call_id DROP NOT NULL;
ALTER TABLE score_corrections ALTER COLUMN call_item_score_id DROP NOT NULL;

ALTER TABLE score_corrections
  ADD COLUMN IF NOT EXISTS journey_id UUID REFERENCES journeys(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS journey_item_score_id UUID REFERENCES journey_item_scores(id) ON DELETE CASCADE;

-- Exactly one parent. Existing rows (call_item_score_id set, journey_* null)
-- already satisfy this, so it validates without a backfill.
ALTER TABLE score_corrections DROP CONSTRAINT IF EXISTS score_corrections_one_parent;
ALTER TABLE score_corrections ADD CONSTRAINT score_corrections_one_parent CHECK (
  (call_item_score_id IS NOT NULL AND journey_item_score_id IS NULL) OR
  (call_item_score_id IS NULL AND journey_item_score_id IS NOT NULL)
);

-- One correction per journey item (mirrors UNIQUE(call_item_score_id)). A full
-- unique index treats the many NULLs on call-correction rows as distinct, so it
-- coexists with the call constraint and supports ON CONFLICT upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_corrections_journey_item
  ON score_corrections(journey_item_score_id);
