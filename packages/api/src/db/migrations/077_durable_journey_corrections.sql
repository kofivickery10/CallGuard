-- Stop a re-score destroying the human rulings on a sale.
--
-- score_corrections.journey_item_score_id is ON DELETE CASCADE, and
-- processScoreJourney opens its write transaction with
--
--   DELETE FROM journey_item_scores WHERE journey_id = $1
--
-- so every supervisor ruling on that sale is cascade-deleted: the verdict, the
-- reason they typed, and the calibration record that feeds getLearningContext.
-- Not overwritten by a fresh model verdict — erased. Verified against
-- production in a rolled-back transaction: one ruling before the delete, zero
-- after.
--
-- Two consequences, both bad. A firm that corrects a wrong breach watches it
-- reappear the next time the sale is scored, which is indefensible on a
-- compliance register. And the learning loop can never accumulate anything,
-- because its training examples are deleted by the very process meant to
-- benefit from them.
--
-- The root cause is that the correction was keyed to the wrong thing. A
-- journey_item_scores row is TRANSIENT — it is dropped and recreated on every
-- scoring run. The durable identity of "a human ruled on this checkpoint of
-- this sale" is (journey_id, scorecard_item_id), which survives any number of
-- re-scores.

-- 1. Keep the row when its item score is recreated. journey_item_score_id stays
--    as a convenience pointer to the CURRENT row (re-linked by score-journey
--    after each run), but is no longer what identifies the correction.
ALTER TABLE score_corrections
  DROP CONSTRAINT IF EXISTS score_corrections_journey_item_score_id_fkey;
ALTER TABLE score_corrections
  ADD CONSTRAINT score_corrections_journey_item_score_id_fkey
  FOREIGN KEY (journey_item_score_id) REFERENCES journey_item_scores(id) ON DELETE SET NULL;

-- 2. A correction belongs to a call or a sale. Previously this was expressed
--    through journey_item_score_id, which cannot hold once that column is
--    nullable — journey_id is the stable parent and always was.
ALTER TABLE score_corrections DROP CONSTRAINT IF EXISTS score_corrections_one_parent;
ALTER TABLE score_corrections ADD CONSTRAINT score_corrections_one_parent CHECK (
  (call_item_score_id IS NOT NULL AND journey_id IS NULL) OR
  (call_item_score_id IS NULL AND journey_id IS NOT NULL)
);

-- 3. One ruling per checkpoint per sale, keyed to what actually persists. The
--    old index was on journey_item_score_id, which now goes NULL on re-score —
--    and Postgres treats NULLs as distinct, so it would have allowed duplicate
--    rulings to pile up on the same checkpoint.
DROP INDEX IF EXISTS idx_corrections_journey_item;
CREATE UNIQUE INDEX IF NOT EXISTS idx_corrections_journey_checkpoint
  ON score_corrections(journey_id, scorecard_item_id)
  WHERE journey_id IS NOT NULL;

-- Lookup path for re-applying rulings at the start of a scoring run.
CREATE INDEX IF NOT EXISTS idx_corrections_journey
  ON score_corrections(journey_id)
  WHERE journey_id IS NOT NULL;

COMMENT ON COLUMN score_corrections.journey_item_score_id IS
  'Pointer to the CURRENT journey_item_scores row, re-linked after each scoring run. Nullable and not the identity: journey_item_scores is recreated on every re-score, so (journey_id, scorecard_item_id) is what identifies a ruling.';
