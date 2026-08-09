-- Let a format confirm itself once independent sales agree about it.
--
-- Until now every format needed a person to approve it before any sale could be
-- reconciled against it. That step was doing two different jobs, and only one of
-- them needed a human:
--
--   1. Supplying what the document does not contain — the insurer's name, and
--      whether the form asks conditional follow-ups.
--   2. Vouching that the parse is right.
--
-- Job 2 is the compliance gate, and a person is a weaker check on it than it
-- appears: nobody compares forty parsed questions against the PDF line by line.
-- Independent corroboration is stronger evidence and is available for free. The
-- same format arriving from a DIFFERENT sale and parsing to the same result is
-- something a one-off model misread cannot fake, and it is exactly the failure
-- this guards against — the learner is a model pass with measurable variance
-- (across three runs over one tenant's pack, one sale's document selection
-- changed).
--
-- format_signature is the identity of a FORMAT, as distinct from a question set:
-- the strategy plus its detect patterns, normalised and ordered. Two documents
-- with the same signature are the same insurer form. Their question sets may
-- still differ, and that difference is itself the signal for questions_vary —
-- see migration 090. So one column answers both "have we seen this format
-- before" and "does this format's question set move".
--
-- corroborating_journeys holds the sales that produced it, not a count, so the
-- evidence stays inspectable: a firm challenging a finding can be shown which
-- sales agreed the format, and a journey deleted under retention drops out
-- rather than leaving a number nobody can account for.
ALTER TABLE capture_document_profiles
  ADD COLUMN IF NOT EXISTS format_signature TEXT,
  ADD COLUMN IF NOT EXISTS corroborating_journeys UUID[] NOT NULL DEFAULT '{}',
  -- Set when the profile went active without a person, so the confirmation is
  -- never misread as someone's approval. confirmed_by stays NULL in that case,
  -- and the audit trail says which sales stood in for the signature.
  ADD COLUMN IF NOT EXISTS auto_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN capture_document_profiles.format_signature IS
  'Identity of the insurer FORM (strategy + normalised, ordered detect patterns), independent of its question set. Same signature + different question fingerprint is the evidence that the form asks conditional follow-ups.';
COMMENT ON COLUMN capture_document_profiles.corroborating_journeys IS
  'Sales whose document independently produced this format. Kept as ids rather than a count so the evidence behind an auto-confirmation stays inspectable.';
COMMENT ON COLUMN capture_document_profiles.auto_confirmed_at IS
  'Set when the profile was activated by corroboration rather than by a person. confirmed_by remains NULL — nobody approved it, so nothing should claim they did.';

-- The lookup auto-propose does on every unrecognised document.
CREATE INDEX IF NOT EXISTS idx_capture_doc_profiles_signature
  ON capture_document_profiles (organization_id, format_signature)
  WHERE format_signature IS NOT NULL;
