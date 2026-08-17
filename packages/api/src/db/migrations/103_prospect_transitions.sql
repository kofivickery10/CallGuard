-- AR-to-directly-authorised transition detection (see enrich-prospects-fca.ts,
-- "--discover" transition detection section, for the full mechanics).
--
-- WHY THIS MATTERS: Trust Point, CallGuard's existing client, is the pattern
-- this exists to find. On the live Register it appears as two FRN records
-- under one Companies House number: FRN 1021037 ("TRUST POINT MORTGAGE &
-- PROTECTION SERVICES LIMITED"), Business Type "Appointed Representative",
-- status "No longer registered as an Appointed Representative" as of
-- 29/11/2024; and FRN 1044052, same firm, now "Authorised" as of 18/12/2025.
-- The firm was an Appointed Representative and went directly authorised.
-- That transition is commercially decisive: as an AR, the principal firm
-- supplies the compliance scaffolding — file checks, call monitoring, QA —
-- for free. On authorisation the firm inherits all of that overnight with no
-- compliance function of its own. That moment, not "any protection/mortgage
-- firm", is when this product is worth buying, so it's worth flagging on the
-- prospect record rather than leaving it to be spotted by chance.
--
-- Purely additive: production already holds ~100 prospects rows, so every
-- column here is nullable or defaulted, nothing rewrites existing data, and
-- nothing goes NOT NULL without a default.
--
-- Same firm-level-only rule as migration 102: a Companies House number and a
-- pair of dates describe the company, never a person, so none of this needs
-- the LIA that a named-contact column would.
ALTER TABLE prospects
    -- The reliable link between a firm's AR-era FRN and its newly-authorised
    -- FRN. Register firm names vary in punctuation, case and legal suffix
    -- between the two records (and sometimes between Search and Firm
    -- responses for the very same FRN) — the Companies House number does
    -- not, so it's the primary match key for transition detection, with
    -- normalised-name matching as a fallback only when it's unavailable.
    ADD COLUMN IF NOT EXISTS companies_house_number TEXT,
    -- The Register's "Status Effective Date" for the current ("Authorised")
    -- record — when this firm's direct authorisation took effect.
    ADD COLUMN IF NOT EXISTS authorised_since DATE,
    -- Set only when discovery has actual evidence (Companies House number
    -- match, or a conservative normalised-name match with no known
    -- conflicting CH number) that this firm previously held Appointed
    -- Representative status under a different, now-lapsed FRN. Defaults to
    -- false rather than NULL so existing rows and every ordinary insert read
    -- as "no evidence of a transition" without a three-state NULL to handle.
    ADD COLUMN IF NOT EXISTS former_ar BOOLEAN NOT NULL DEFAULT false,
    -- The Register's "Status Effective Date" on the lapsed AR record that
    -- former_ar's evidence was found against — when that prior AR
    -- registration ended. NULL whenever former_ar is false.
    ADD COLUMN IF NOT EXISTS ar_ceased_on DATE;

-- The transitions-only ranking query (most-promising first) orders by
-- former_ar true-before-false, then most recent authorised_since first, then
-- name — index the two columns actually driving that sort. authorised_since
-- DESC matches "most recent first"; NULLS LAST keeps firms discovery hasn't
-- dated yet off the front of that ordering rather than sorting ahead of
-- everything on account of a NULL.
CREATE INDEX IF NOT EXISTS idx_prospects_former_ar_authorised_since
    ON prospects (former_ar DESC, authorised_since DESC NULLS LAST);
