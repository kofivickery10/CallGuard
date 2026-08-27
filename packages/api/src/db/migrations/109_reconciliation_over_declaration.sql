-- Declaring MORE than the customer said is not a non-disclosure, and counting
-- it as one costs the module its credibility.
--
-- Two items on the August 2026 Trust Point run were the application recording
-- more risk than the customer stated: 2 alcohol units a week against a customer
-- who said none, and 1g of other tobacco against nothing. Both were reported as
-- 'mismatch', which on this screen reads as a possible non-disclosure — the
-- thing that voids a policy. Neither can void anything. An application that
-- overstates the risk produces cover that is more expensive than it needed to
-- be, which is a fair-value problem for the customer and a correction for the
-- adviser, not an allegation of a concealed disclosure.
--
-- The two are inseparable arithmetically — both are "the figures differ" — so
-- the only thing that can tell them apart is which way the difference runs on
-- that particular field. That is the question's risk direction, stored per
-- question inside the profile's `questions` JSONB alongside check_mode (no DDL
-- there; it is already schemaless), defaulted from the question's wording by
-- defaultRiskDirection and overridable by a reviewer.
--
-- WHY A NEW OUTCOME RATHER THAN AN ACTIONABILITY FLAG
--
-- Same reasoning as migration 094. The dashboard predicates are SQL over
-- `outcome` and cannot see a profile's rulings, and every "mismatches" column in
-- the product is a count of that string. An over-declaration has to be
-- actionable — somebody still has to correct the application — while never being
-- counted in the mismatch figure, and only a distinct outcome does both.
--
-- It IS conclusive: the comparison ran and reached a verdict, so it belongs in
-- the match-rate denominator and not in the numerator, exactly like a mismatch.
--
-- WHY THE DIRECTION IS DECLARED ON A FEW FIELDS AND NOT INFERRED BROADLY
--
-- A direction can only ever downgrade a finding, so a wrong one retires a real
-- accusation silently. "Have you had tests for a family history of diabetes?"
-- recorded as "Yes, results normal" against a customer saying "No, never had
-- any diabetic tests" looks like declaring more and is the reverse — an
-- untested family history is the riskier one. Fields like that stay 'neutral'
-- and stay a mismatch. Only alcohol units, tobacco consumption and time off work
-- carry a default direction today.
ALTER TABLE capture_reconciliation_items
  DROP CONSTRAINT IF EXISTS capture_reconciliation_items_outcome_check;

ALTER TABLE capture_reconciliation_items
  ADD CONSTRAINT capture_reconciliation_items_outcome_check
  CHECK (outcome IN ('match', 'mismatch',
                     -- The two sides disagree and the application declared the
                     -- riskier figure. Actionable, never a non-disclosure.
                     'over_declaration',
                     'not_asked',
                     'asked_no_answer',
                     'no_application_answer',
                     'recorded',
                     'missing_from_application',
                     'undetermined'));

COMMENT ON COLUMN capture_reconciliation_items.outcome IS
  'The comparison result. ''recorded'' and ''missing_from_application'' belong to questions whose profile check_mode is ''presence'': they are checked for completion on the document rather than against the call. ''recorded'' is excluded from the match rate — nothing was verified — and ''missing_from_application'' is actionable, unlike the benign ''no_application_answer''. ''over_declaration'' is a decided disagreement where the application recorded the riskier figure on a question with a declared risk_direction: actionable, conclusive, and deliberately never counted as a mismatch.';

-- How the comparison was reached.
--
-- The module's whole claim is that a finding can be defended in front of the
-- firm it names. "1.83 against 6 foot" cannot be defended from the record
-- alone: nobody reading it can tell whether the conversion ran, which unit each
-- side was read as, or how close the two landed — and that is precisely the
-- finding that reached a live tenant with the extraction model's own reasoning
-- saying "so this matches" in the next column.
--
-- So every item now carries the parse and conversion trail: which rule fired,
-- both raw values, every canonical reading of each side, the tolerance applied,
-- and the risk direction in force. It is what settles a disputed finding
-- without re-running the code, and it is the only way the tolerances can be
-- tuned against what they actually did rather than against a guess.
--
-- Nullable, because most rows have nothing to record: a question that was never
-- located in the call was never compared. Written by the same masking rules as
-- application_answer — it quotes both sides verbatim, so it cannot be the one
-- place a redacted value survives (services/application-redaction.ts).
ALTER TABLE capture_reconciliation_items
  ADD COLUMN IF NOT EXISTS comparison_trail JSONB;

COMMENT ON COLUMN capture_reconciliation_items.comparison_trail IS
  'How the comparison was decided: {rule, applicationRaw, callRaw, dimension, canonicalUnit, applicationCanonical[], callCanonical[], toleranceApplied, riskDirection, outcome}. NULL where no comparison ran. Application-side values carry the same masking as application_answer.';

-- Existing rows are left alone, for the reason migration 094 gives: backfilling
-- would mean re-deciding outcomes from data this migration cannot see. Re-run
-- the affected sales instead —
--   tsx src/scripts/rerun-reconciliation.ts "<tenant>"
-- which is also the only way to confirm the mismatch count actually fell.
