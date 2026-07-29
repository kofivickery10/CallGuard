-- Consensus scoring: score a sale N times and let the runs vote.
--
-- LLM scoring samples from a probability distribution, so a checkpoint whose
-- evidence clearly meets or clearly misses its criterion lands the same way
-- every time, while one sitting near the model's decision boundary can go
-- either way. Measured on three Trust Point sales, four runs each:
--
--   ab2af20a   67.44 – 74.42     35/43 checkpoints identical every run
--   27bbb305   34.15 – 41.46     36/41 identical
--   ebcfb738   46.51 – 53.49     38/43 identical
--
-- Consistently ~85% of checkpoints completely stable, and consistently ~7
-- points of spread from the handful that are not. For an FCA-regulated firm
-- looking at a compliance register, a score that moves seven points on a
-- re-run with no new evidence is not defensible, however well explained.
--
-- The sampling cannot be turned off: Sonnet 5 rejects `temperature` outright
-- ("deprecated for this model"), and temperature 0 never guaranteed identical
-- output on models that accept it. It also would not help — it would return the
-- same side of a 55/45 judgement every time, which is stable but arbitrary, and
-- hides the ambiguity rather than surfacing it.
--
-- Voting uses the distribution instead of fighting it. Score N times; where the
-- runs agree, that verdict is solid and gets scored; where they disagree, the
-- checkpoint is genuinely ambiguous and goes to a human rather than being
-- settled by a coin toss. Since disputed items are excluded from the weighted
-- denominator (same as any manual-review item), the resulting score is
-- computed only over checkpoints every run agreed on — stable by construction,
-- not merely less wobbly.
--
-- Default 1 (single pass, existing behaviour and existing cost). Opt-in per
-- tenant, because N samples costs N times the scoring spend and that is a
-- decision for whoever pays it.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS scoring_samples INTEGER NOT NULL DEFAULT 1
    CHECK (scoring_samples >= 1 AND scoring_samples <= 5);

COMMENT ON COLUMN organizations.scoring_samples IS
  'How many independent scoring passes to run per sale and vote across. 1 = single pass (default). Above 1, checkpoints the runs disagree on are routed to manual review instead of being auto-scored, so the score covers only unanimous verdicts.';

-- How many of the runs agreed with the recorded verdict, as a fraction. NULL
-- for single-pass scoring, where the question does not arise.
--
-- Worth storing separately from `confidence`: confidence is the model's own
-- self-report, which is only loosely calibrated (mean 0.66 on checkpoints that
-- proved unstable versus 0.72 on stable ones — a real signal, but a weak one).
-- Agreement across independent runs is a direct measurement of the same thing
-- and is what should be shown to a reviewer deciding whether to trust a verdict.
ALTER TABLE journey_item_scores
  ADD COLUMN IF NOT EXISTS agreement NUMERIC(3,2)
    CHECK (agreement IS NULL OR (agreement >= 0 AND agreement <= 1));

COMMENT ON COLUMN journey_item_scores.agreement IS
  'Fraction of independent scoring runs that reached the recorded verdict (organizations.scoring_samples > 1). NULL for single-pass scoring.';
