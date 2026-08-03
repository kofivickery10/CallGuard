-- Per-tenant "send it to a human when the model isn't sure" floor.
--
-- Until now a checkpoint reached manual review by only three routes: it was a
-- back-office item (item_type='manual'), it was a consent gate on a call whose
-- speaker split could not be trusted (CONSENT_SPEAKER_CONFIDENCE_FLOOR), or the
-- independent scoring runs disagreed about it (organizations.scoring_samples >
-- 1). Everything else was auto-scored pass or fail however marginal the
-- judgement was, because the model's own confidence was recorded and then only
-- used to annotate a breach (migration 078's `low_confidence` caveat).
--
-- That is the wrong default for a tenant whose recordings are hard to hear.
-- Trust Point's calls are mono, frequently start mid-process, and often carry
-- background noise; a checkpoint the model reports at 0.6 is a coin-toss
-- dressed as a verdict, and a coin-toss written into a compliance register is
-- worse than an empty row in a review queue. The firm's QA team would rather
-- rule on it themselves.
--
-- So: any AI-scored checkpoint whose self-reported confidence is BELOW this
-- floor is stored as manual_review with the model's provisional verdict,
-- evidence and reasoning attached — the same mechanism the consent gates and
-- the disputed checkpoints already use. The reviewer confirms or overturns
-- rather than scoring from scratch, the checkpoint stays out of the weighted
-- denominator and out of the breach register until they do, and resolving it
-- folds it straight back into the score (routes/review.ts).
--
-- Calibration note, so the number is chosen with eyes open: the model's
-- confidence is a weak signal, not a probability. Measured across Trust Point
-- re-runs, checkpoints that flipped between runs averaged 0.66 and ones that
-- never flipped averaged 0.72 — a real difference, but heavily overlapping. A
-- floor therefore buys recall of ambiguous checkpoints at the cost of also
-- routing plenty of correct ones. That is the trade a tenant is choosing when
-- they raise it, and it is why the ceiling is 0.95 rather than 1.0: at 1.0
-- every checkpoint routes and the platform stops scoring altogether.
--
-- 0 = off, and off is the default — existing tenants keep exactly the
-- behaviour they have today.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS review_confidence_floor NUMERIC(3,2) NOT NULL DEFAULT 0
    CHECK (review_confidence_floor >= 0 AND review_confidence_floor <= 0.95);

COMMENT ON COLUMN organizations.review_confidence_floor IS
  'Route an AI-scored checkpoint to manual review when the model''s own confidence is below this (0-0.95). The provisional verdict is kept for the reviewer; the checkpoint is excluded from the weighted score and the breach register until a human rules on it. 0 = off (default).';
