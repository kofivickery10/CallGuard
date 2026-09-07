-- Manual recipient selection on adviser feedback (CG-5).
--
-- 087 derives the recipient entirely server-side: resolveAdviser picks the
-- earliest wrap_up call, else the latest call in the set. That is the right
-- default and matches how sales are attributed everywhere else (breaches, Zoho
-- write-back), but Trust Point hit the case it cannot cover — the last person to
-- call is occasionally not the person who sold.
--
-- WHY THIS IS AN AUDIT-TRAIL FIX, NOT A UX ONE
--
-- The acknowledgement is the evidence that a finding was communicated. Send it
-- to the wrong adviser, have them confirm it, and confirmed_at is set on a
-- record that proves nothing while still LOOKING complete. Silently is the worst
-- way for an evidence chain to fail.
--
-- WHY BOTH COLUMNS
--
-- adviser_user_id already says who it went to. What it cannot say is whether a
-- human chose them. suggested_adviser_user_id records who resolveAdviser would
-- have picked, on every send: equal to adviser_user_id means the default stood,
-- different means a supervisor deliberately overrode it, and that difference is
-- the thing an auditor needs to see.
--
-- Existing rows backfill to 'default_last_caller', which is exactly what they
-- were. suggested_adviser_user_id stays NULL on them rather than being
-- reconstructed: the sales have been re-scored since, so a value computed now
-- would be a guess dressed as a record.

ALTER TABLE journey_feedback
  ADD COLUMN IF NOT EXISTS recipient_source TEXT NOT NULL DEFAULT 'default_last_caller',
  ADD COLUMN IF NOT EXISTS suggested_adviser_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Added separately from the column so a later source (a Zoho record owner, once
-- Trust Point confirms the field) is one ALTER, not a column rewrite.
ALTER TABLE journey_feedback DROP CONSTRAINT IF EXISTS journey_feedback_recipient_source_check;
ALTER TABLE journey_feedback
  ADD CONSTRAINT journey_feedback_recipient_source_check
  CHECK (recipient_source IN ('default_last_caller', 'manual'));
