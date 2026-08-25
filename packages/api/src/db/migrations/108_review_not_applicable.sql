-- A reviewer must be able to say "this checkpoint did not apply".
--
-- The review queue offered pass or fail and nothing else, so a reviewer looking
-- at a checkpoint that could not apply to the sale in front of them had one way
-- to clear it: record a pass. Nine of Trust Point's corrections are exactly
-- that, and the reviewer said so in the free-text reason each time —
--
--   "No trust so n/a"
--   "Trust not applicable so no need to contact trustee"
--   "Metlife product not eligible to be put into trust so didn't"
--   "DD's not needed"
--
-- The consequence is a compliance register asserting an adviser arranged
-- trustee contact on a hospital-cash plan that cannot be placed in trust. The
-- checkpoint's pass rate is corrupted with it, and the free passes inflate the
-- sale's score — the item stays in the denominator as a pass rather than
-- dropping out.
--
-- WHY NULL RATHER THAN A NEW COLUMN
--
-- original_pass is already nullable in this table with exactly this shape of
-- meaning: NULL = "there was no verdict" (a manual_review row had none for the
-- AI). So NULL on the corrected side reads the same way — the reviewer reached
-- a resolution, and that resolution was that no verdict applies. Adding a
-- separate flag would leave two columns to keep in step and a corrected_pass
-- value that has to be a lie either way.
--
-- corrected_score goes with it: an item that does not apply has no score, and
-- storing 0 would make it indistinguishable from a fail in every aggregate that
-- reads this table (calibration among them).
ALTER TABLE score_corrections
  ALTER COLUMN corrected_pass DROP NOT NULL,
  ALTER COLUMN corrected_score DROP NOT NULL;

COMMENT ON COLUMN score_corrections.corrected_pass IS
  'The reviewer''s verdict. TRUE = met, FALSE = not met, NULL = the checkpoint did not apply to this sale (resolved as ''na''). NULL is a resolution, not an absence of one.';

COMMENT ON COLUMN score_corrections.corrected_score IS
  'The score the reviewer''s verdict implies. NULL where the checkpoint did not apply — deliberately not 0, which would be indistinguishable from a fail in any aggregate over this table.';

-- The nine already recorded as false passes are deliberately NOT rewritten
-- here. Which of them meant 'na' is only recoverable from free text a person
-- typed, and re-deciding a human's verdict from a regex is not something a
-- migration should do. They are corrected by re-scoring the affected sales once
-- scorecard_items.applies_to_products is set, which makes the checkpoint 'na'
-- at source and drops the correction rows with it.
