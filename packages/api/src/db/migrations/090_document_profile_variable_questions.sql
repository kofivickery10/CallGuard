-- Some application forms do not have a fixed question set.
--
-- Drift detection compares the question list parsed from a sale's document
-- against the one stored on its profile, and treats any difference as the
-- insurer having changed the form. For a static document that is exactly right:
-- a question that has silently disappeared would read as "not asked" on every
-- sale, and a new one would go unchecked entirely.
--
-- It is wrong for a form that asks conditional follow-ups. Measured across one
-- tenant's real pack, the same broker-portal export produced 23, 31, 34, 38, 39,
-- 40, 58 and 95 questions on eight sales — not because anything changed, but
-- because a customer with more to disclose is asked more. Under exact matching
-- every sale after the first reads as drifted and parks itself for review that
-- has nothing to review.
--
-- WHY SKIPPING THE CHECK IS SAFE HERE
--
-- Reconciliation does not read its questions from the profile. It reads them
-- from the document attached to THAT sale (processors/reconcile.ts builds its
-- items from parsed.pairs), and the profile's question list serves only as a
-- reviewed override for the absence_meaningful judgement, with a measured
-- fallback for anything not in it. So a follow-up nobody has seen before is
-- still compared against the call; it just uses the computed default rather than
-- a human's ruling.
--
-- What a stale profile actually risks on such a form is the PARSE breaking, not
-- the question list moving. That is checked directly instead — see
-- parseLooksHealthy in services/application-pdf.ts, which is applied at match
-- time for these profiles in place of fingerprint equality.
--
-- Off by default, and deliberately not inferred: whether an insurer's form is
-- conditional is a fact about the form, and switching off a compliance check
-- must be somebody's decision rather than a heuristic's. Set when confirming
-- the profile.
ALTER TABLE capture_document_profiles
  ADD COLUMN IF NOT EXISTS questions_vary BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN capture_document_profiles.questions_vary IS
  'True when this form asks conditional follow-ups, so its question set legitimately differs between sales. Replaces exact question-set drift detection with a structural check that the document still parses. Set by a human when confirming the profile — never inferred.';
