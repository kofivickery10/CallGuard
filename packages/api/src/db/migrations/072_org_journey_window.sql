-- Per-organisation journey lookback window.
--
-- assembleJourney (services/journey.ts) gathers the calls that make up a "sale"
-- by looking back a fixed number of days from the sale trigger. Until now that
-- window came only from the tenant's CloudTalk connection
-- (dialer_connections.history_window_days), falling back to a hardcoded 30 days.
--
-- Two problems that fix creates:
--
-- 1. A tenant with no CloudTalk connection — one uploading recordings by hand,
--    ingesting Teams appointment recordings, dropping files on SFTP, or using a
--    different dialler — has no way to set the window at all. They silently get
--    30 days.
--
-- 2. 30 days is wrong for some sectors. A mortgage case runs fact find ->
--    recommendation -> offer -> completion over weeks or months; a new-build
--    purchase can run six months. When the sale trigger finally fires, a 30-day
--    window drops the fact find and the recommendation call — the two calls
--    carrying almost every suitability and disclosure checkpoint — and the case
--    is then scored on completion chatter alone. That does not fail loudly; it
--    produces a confident score against the wrong evidence.
--
-- Nullable on purpose: NULL means "no organisation-level opinion", so existing
-- tenants keep exactly the behaviour they have today (dialler setting, else the
-- 30-day default). Only a tenant that sets it changes behaviour.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS journey_window_days INTEGER
    CHECK (journey_window_days IS NULL OR (journey_window_days >= 1 AND journey_window_days <= 730));

COMMENT ON COLUMN organizations.journey_window_days IS
  'How many days back assembleJourney gathers calls for a sale. NULL = fall back to the dialler connection''s history_window_days, then the 30-day default. Capped at 730 days (2 years) so a mis-set value cannot pull a customer''s entire history into one journey.';
