-- Firm-authored remediation guidance per checkpoint (CG-24, Phase 1 of the
-- CG-6 scope — docs/remediation-guidance-scope.md §4.1, §4.2).
--
-- Raised by Trust Point (Joey Crone, 26 August 2026): "How difficult would it be
-- to add in some manual/remediation guidance for some of the feedback lines?"
--
-- Today a finding says what went wrong. It does not say what to do about it, so
-- every adviser works that out for themselves, or asks, or does nothing. The
-- firm already knows the answer and has no way to write it down.
--
-- WRITTEN BY THE FIRM, NOT BY US, and not by the model. Exactly like
-- `expectation` and `ai_check` above it, and for the same reason: Trust Point
-- know what they want said to their customers and we do not. A checkpoint about
-- a missing disclosure needs their wording about how they put it right, not
-- ours.
--
-- NULL IS THE NORMAL CASE, AND THE GATE. A criterion with no guidance simply has
-- no remediation step. That is what lets a firm opt in one checkpoint at a time
-- rather than being handed a workflow across all eighty, and it is why nothing
-- changes for any existing tenant until somebody writes something.
ALTER TABLE scorecard_items
  ADD COLUMN IF NOT EXISTS remediation_guidance TEXT;

COMMENT ON COLUMN scorecard_items.remediation_guidance IS
  'What the firm wants an adviser to DO when this checkpoint is failed, in the firm''s own words (CG-24). NULL means this checkpoint has no remediation step, which is the normal case.';

-- What the adviser was told to do, frozen at send time.
--
-- Same reasoning as `reasoning` in migration 110, and the same failure it
-- prevents. Guidance is editable: a firm can reword it next week, and a live
-- join would then make every past acknowledgement assert that the adviser was
-- told the NEW wording. The record has to hold what was actually in front of
-- them, not what the criterion says today.
--
-- Distinct from `reasoning` beside it, and the two must not be conflated:
--   reasoning  the model's sentence about what the adviser did      (why flagged)
--   guidance   the firm's instruction about what to do about it     (what next)
--
-- Populated only when it actually travelled, so this column never asserts the
-- adviser was given an instruction they never received. Unlike `reasoning`,
-- there is no policy that withholds it — see the note in
-- services/journey-feedback.ts on why firm-authored text is safe to send on a
-- tenant whose model reasoning is not.
ALTER TABLE journey_feedback_items
  ADD COLUMN IF NOT EXISTS remediation_guidance TEXT;

COMMENT ON COLUMN journey_feedback_items.remediation_guidance IS
  'The firm''s remediation guidance as it appeared in the feedback email, frozen at send time (CG-24). NULL where the checkpoint had none.';
