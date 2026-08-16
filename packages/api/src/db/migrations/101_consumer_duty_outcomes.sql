-- Consumer Duty outcome tagging for scorecard items.
--
-- The FCA's Consumer Duty has four outcomes (products and services; price and
-- value; consumer understanding; consumer support). Vulnerability is NOT a
-- fifth outcome — it is a cross-cutting consideration that runs through all
-- four — so it is modelled as a separate boolean, not folded into the outcome
-- enum. An item can be both "consumer understanding" and vulnerability-related.
--
-- Both columns are nullable/false by default so every existing scorecard is
-- unaffected: unmapped is the honest default for a checkpoint nobody has
-- tagged yet, not an assumption that it belongs to some outcome.
ALTER TABLE scorecard_items
  ADD COLUMN IF NOT EXISTS consumer_duty_outcome TEXT
    CHECK (consumer_duty_outcome IN (
      'products_and_services', 'price_and_value', 'consumer_understanding', 'consumer_support'
    )),
  ADD COLUMN IF NOT EXISTS vulnerability_related BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN scorecard_items.consumer_duty_outcome IS
  'Which of the FCA Consumer Duty''s four outcomes this checkpoint evidences. NULL = unmapped (the default for every scorecard until a person tags it) — must be surfaced as explicitly unmapped wherever findings are grouped by outcome, never silently dropped or bucketed into an outcome it was not assigned.';
COMMENT ON COLUMN scorecard_items.vulnerability_related IS
  'Whether this checkpoint is about identifying or adapting to customer vulnerability. Orthogonal to consumer_duty_outcome (vulnerability is a cross-cutting consideration, not a fifth outcome) — an item can be both vulnerability-related and mapped to an outcome, or neither.';
