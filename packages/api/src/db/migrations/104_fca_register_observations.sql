-- Recurring FCA Register monitoring (see docs/prospect-sweep.md and
-- enrich-prospects-fca.ts's "--sweep" mode).
--
-- WHY THIS TABLE EXISTS: today a transition (AR -> directly authorised) is
-- inferred by archaeology — find two FRN records that plausibly describe one
-- firm and match their Companies House numbers (see migration
-- 103_prospect_transitions.sql). That works, but only when a Companies
-- House number happens to be on file for the lapsed record, and only after
-- the fact — there is no record of what a firm's status USED to be on any
-- given date, only what it is right now. If instead every firm a Register
-- search returns is recorded on every run, a transition becomes something
-- observed directly: this firm's status on the last run was X, and on this
-- run it's Y. Caught within days of it happening, not inferred years later.
-- Discarding a search result the moment it's decided "not a prospect" is
-- exactly why that comparison has never been possible before now.
--
-- WHAT MAKES THIS CHEAP: this table needs no enrichment — no Firm,
-- Permissions or Address lookups, nothing beyond the Search response CallGuard
-- already fetched to build the candidate list. So it records EVERY firm a
-- search returns, including the ones deliberately excluded from
-- `prospects` — dead firms, introducer-only ARs, CBTL/"Registered" firms,
-- run-off — because those are exactly the records a future comparison needs.
-- A firm that's dead today but was an Appointed Representative last quarter
-- is not interesting as a prospect, but the fact its status changed is
-- itself the signal this table exists to catch.
--
-- CRITICAL — NO NAMED INDIVIDUALS, same rule and same reasoning as
-- migration 102_prospects.sql: a `type=firm` Register search also returns
-- sole traders trading under their own personal name (real examples: "Anna
-- Woodvine", "Craig Taylor"), still labelled business type "Firm" by the
-- Register. Migration 102 bars named individuals from `prospects` until a
-- documented UK GDPR legitimate-interests assessment exists for holding
-- that data — none does. This table shares the exact same database and
-- backups as tenants' regulated call recordings, so the same bar applies
-- here, identically: --sweep runs every candidate through the existing
-- isLikelyCompanyName heuristic (see enrich-prospects-fca.ts) BEFORE any
-- observation is written, and skips a name that looks like an individual
-- entirely — no FRN, no name, no status for that row, ever. The
-- consequence is real and accepted: CallGuard cannot track a named
-- individual's own status transition this way, because it is never
-- targeting them regardless of what their status does. Do not "fix" this by
-- recording individuals anyway and filtering them out only at read time —
-- that would put personal data at rest in this table with no LIA covering
-- it, which is the exact incident migration 102 exists to prevent.
CREATE TABLE IF NOT EXISTS fca_register_observations (
    -- FCA Firm Reference Number. Always present (unlike prospects.frn) —
    -- every row here comes straight off a Register Search result, which
    -- always carries one; the blank-FRN "clone of an authorised firm"
    -- scam-warning entries the Register sometimes mixes in are filtered out
    -- before this table is ever touched (same filter --discover already
    -- applies — see toDiscoveryCandidates).
    frn                 TEXT PRIMARY KEY,
    -- The Register's name for this firm as of the most recent sighting —
    -- refreshed on every run, same "latest wins" treatment prospects.firm_name
    -- gets from enrichment.
    firm_name           TEXT NOT NULL,
    -- The Register's own status wording (e.g. "Authorised", "Appointed
    -- representative", "No longer authorised") as of the most recent
    -- sighting — not a CallGuard-invented enum, for the same reason
    -- prospects.fca_status isn't one.
    fca_status          TEXT NOT NULL,
    -- What fca_status held immediately before the run that last changed it.
    -- NULL until this firm has been seen to change status at least once.
    previous_status     TEXT,
    -- When fca_status last changed (i.e. when THIS run's search result first
    -- disagreed with what was already stored). NULL until the first change.
    status_changed_at   TIMESTAMPTZ,
    -- The first sweep run that ever saw this FRN.
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The most recent sweep run that saw this FRN, whether or not its status
    -- changed — bumped on every sighting. This is what lets a sweep tell "we
    -- haven't seen this firm in a search result for months" from "we saw it
    -- again this run and nothing changed".
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "What changed recently" is the whole point of this table — a sweep's
-- digest (and any future ad-hoc "show me last month's transitions" query)
-- reads it in status_changed_at DESC order. NULLS LAST keeps the (majority
-- of) rows that have never changed status off the front of that ordering —
-- otherwise every never-changed row's NULL would sort ahead of every real,
-- dated change under Postgres's default NULLS-sort-highest behaviour for a
-- descending index.
CREATE INDEX IF NOT EXISTS idx_fca_register_observations_status_changed_at
    ON fca_register_observations (status_changed_at DESC NULLS LAST);
