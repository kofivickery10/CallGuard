-- Let a person say "no" to a proposed document format.
--
-- Until now the review queue had one exit: confirm. A proposal that should never
-- go live — a duplicate of a format already active, the same form learned twice
-- under two names, a covering letter mistaken for an application — had nowhere
-- to go, so it sat in the queue for ever. One tenant's queue held seven formats
-- of which three were duplicates, and a queue that shows work that is not work
-- is one people stop reading.
--
-- WHY A NEW STATUS RATHER THAN 'superseded'
--
-- Because dismissal has to be REMEMBERED, and superseding is not remembered.
-- Learning looks for an existing profile by format_signature with
-- status IN ('needs_confirmation','active'); anything else is invisible to it,
-- so the next sale carrying that document would propose it again. The dismissal
-- would appear to work, the queue would clear, and it would silently refill.
--
-- 'dismissed' is therefore in that lookup (see reconciliation-runs.ts), which is
-- the whole point of it existing separately: the row survives as the record of a
-- decision, and re-encountering the format finds that decision instead of
-- creating a new proposal.
--
-- WHAT DISMISSAL DOES NOT DO
--
-- It does not stop the sale being checked. With no active profile for that
-- format the run lands at 'needs_profile' and the model fallback reads the
-- document, exactly as it does for an insurer never seen before. Dismissing a
-- format says "do not file this as a format", not "do not check these sales".
--
-- Reversible on purpose: PUT /profiles/:id/confirm accepts a dismissed profile
-- and activates it. Somebody dismissing the wrong row must not have to wait for
-- another sale of that insurer to get a second chance at it.
ALTER TABLE capture_document_profiles
  DROP CONSTRAINT IF EXISTS capture_document_profiles_status_check;

ALTER TABLE capture_document_profiles
  ADD CONSTRAINT capture_document_profiles_status_check
  CHECK (status IN ('needs_confirmation', 'active', 'superseded', 'dismissed'));

ALTER TABLE capture_document_profiles
  ADD COLUMN IF NOT EXISTS dismissed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Why it was dismissed, in the reviewer's own words. Shown against the row so
  -- the next person does not have to work out whether it was a considered
  -- decision or a mis-click, and so a format that keeps coming back can be told
  -- apart from one dismissed once by mistake.
  ADD COLUMN IF NOT EXISTS dismissed_reason TEXT;

COMMENT ON COLUMN capture_document_profiles.dismissed_reason IS
  'Why a person rejected this proposed format. Set with status = ''dismissed''.';

-- The review queue reads "everything awaiting a decision", which must not
-- include the ones already decided against.
CREATE INDEX IF NOT EXISTS idx_document_profiles_awaiting
  ON capture_document_profiles (organization_id)
  WHERE status = 'needs_confirmation';
