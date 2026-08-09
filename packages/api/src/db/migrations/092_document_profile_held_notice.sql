-- Say something about a format that has been waiting on its own.
--
-- A format goes live when a second sale independently produces it (migration
-- 091). A format only ever seen once therefore sits at 'needs_confirmation'
-- indefinitely — correctly, because one document agreeing with itself is not
-- evidence — and every sale on it stays unchecked.
--
-- Usually that resolves itself within days: the second sale arrives and the
-- format confirms. But for a rare insurer it may never arrive, and nothing in
-- the system was going to mention it. Silence and "working fine" looked
-- identical, which is the failure this module keeps having to design against.
--
-- One notification per profile, once. Recorded here rather than relying on the
-- notification's own dedupe key, which only swallows repeats while the earlier
-- one is unread — as soon as somebody read it, the sweep would raise it again on
-- the next tick, for ever.
ALTER TABLE capture_document_profiles
  ADD COLUMN IF NOT EXISTS held_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN capture_document_profiles.held_notified_at IS
  'When we told the tenant this proposed format has been waiting alone for a corroborating sale. Set once, so the reminder cannot repeat every sweep tick after somebody reads it.';
