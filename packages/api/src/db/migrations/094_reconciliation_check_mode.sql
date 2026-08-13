-- Not every field on an application is a question the customer was asked.
--
-- Reconciliation's premise is that a submitted answer can be checked against
-- what the customer said. That premise holds for a health disclosure, an
-- occupation, a premium, a term — things spoken aloud on the call. It does not
-- hold for a bank account number or a sort code, and treating those the same way
-- has been producing accusations rather than findings.
--
-- Two things go wrong with them at once. The insurer masks the value it stores
-- ("XX-XX-38", "XXXXX-388"), so searching the call for it either finds nothing
-- or — worse — matches a stray "38" somewhere unrelated, and the model then
-- reads that irrelevant passage and correctly reports no account number in it.
-- That lands as 'asked_no_answer': a claim about how the adviser conducted the
-- call, built on a coincidence. And even with a clean value, a customer reads
-- digits back in fragments ("oh seven nine... oh seven..."), so the comparison
-- could never have been reliable. One sale was ranked the worst in its tenant on
-- eight findings of this kind, none of them real.
--
-- The check that IS worth making on such a field is a different one: was it
-- filled in at all? A direct debit set up without an account number is a real
-- problem, and it is visible from the document alone.
--
-- So a question now carries a check_mode, stored per question inside the
-- profile's `questions` JSONB (no DDL there — it is already schemaless):
--
--   'reconcile' : compare against the call. The default, and what everything
--                 was before this.
--   'presence'  : never compared against the call. Populated is 'recorded';
--                 blank is 'missing_from_application', which IS a finding.
--   'none'      : on the record, never compared, never a finding. What the
--                 hardcoded isInsurerGenerated branch did for a policy number
--                 or a date of issue — a value that did not exist during the
--                 call and so cannot be checked against it.
--
-- WHY TWO NEW OUTCOMES RATHER THAN REUSING match / no_application_answer
--
-- 'recorded' is not 'match'. Match asserts the call and the application agree,
-- and every match rate in the product is computed from it; letting a field
-- nobody verified count towards that would inflate the one number a firm is
-- most likely to quote back at us.
--
-- 'missing_from_application' is not 'no_application_answer'. The latter is
-- benign and deliberately not actionable — a conditional follow-up that did not
-- apply is blank for a good reason, and 61 of one tenant's items are exactly
-- that. A blank where the mode says the field must be present is the opposite:
-- it is the finding. Same empty value, opposite meaning, so it needs its own
-- outcome rather than an actionability rule bolted onto the old one — the
-- dashboard predicates are SQL over `outcome` and cannot see a profile's modes.
ALTER TABLE capture_reconciliation_items
  DROP CONSTRAINT IF EXISTS capture_reconciliation_items_outcome_check;

ALTER TABLE capture_reconciliation_items
  ADD CONSTRAINT capture_reconciliation_items_outcome_check
  CHECK (outcome IN ('match', 'mismatch', 'not_asked',
                     'asked_no_answer',
                     'no_application_answer',
                     -- Present on the application; not compared against the
                     -- call, because this kind of field cannot be. Never a
                     -- finding, and deliberately outside the match rate.
                     'recorded',
                     -- Left blank where it had to be filled in. A finding.
                     'missing_from_application',
                     'undetermined'));

COMMENT ON COLUMN capture_reconciliation_items.outcome IS
  'The comparison result. ''recorded'' and ''missing_from_application'' belong to questions whose profile check_mode is ''presence'': they are checked for completion on the document rather than against the call. ''recorded'' is excluded from the match rate — nothing was verified — and ''missing_from_application'' is actionable, unlike the benign ''no_application_answer''.';

-- Existing rows are left alone deliberately. Backfilling would mean re-deciding
-- outcomes from data this migration cannot see (the document, the transcript),
-- and the runs re-derive themselves anyway: a completed run re-scored under the
-- new modes replaces its items wholesale. Re-run the affected sales instead —
--   tsx src/scripts/rerun-reconciliation.ts "<tenant>"
-- which is also the only way to confirm the accusation count actually fell.
