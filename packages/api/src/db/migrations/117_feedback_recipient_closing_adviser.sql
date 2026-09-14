-- Name the default feedback recipient for what it now is.
--
-- 111 recorded a default send as 'default_last_caller', because resolveAdviser
-- picked the wrap-up call's adviser and the wrap-up WAS the last call in the
-- sale. It no longer is: the wrap-up is now the latest call long enough to have
-- closed the sale (services/wrap-up.ts), so a voicemail or a 40-second call-back
-- made afterwards no longer decides who is fed back. A new default send records
-- 'default_closing_adviser'.
--
-- WHY EXISTING ROWS ARE NOT RENAMED
--
-- Every row already carrying 'default_last_caller' was sent under the old rule,
-- to the last caller. That is a true statement about how its recipient was
-- chosen, and rewriting it would make the audit trail claim a rule that did not
-- exist when the feedback went out. The old value stays valid for those rows.

ALTER TABLE journey_feedback DROP CONSTRAINT IF EXISTS journey_feedback_recipient_source_check;
ALTER TABLE journey_feedback
  ADD CONSTRAINT journey_feedback_recipient_source_check
  CHECK (recipient_source IN ('default_closing_adviser', 'default_last_caller', 'manual'));

ALTER TABLE journey_feedback ALTER COLUMN recipient_source SET DEFAULT 'default_closing_adviser';
