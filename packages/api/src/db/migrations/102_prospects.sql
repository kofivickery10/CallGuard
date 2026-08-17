-- Minimal prospect tracker for CallGuard's own sales pipeline (UK protection and
-- mortgage intermediaries — firms that look like Trust Point, the existing
-- client). This is not a CRM: firm, status, note, dates. No activity timelines,
-- task reminders, email sequences or multi-user assignment — that is out of
-- scope by decision, not oversight.
--
-- Platform-level, not tenant-scoped: these are prospective clients, not
-- customers, so there is deliberately no organization_id here. Access is
-- superadmin-only (requireSuperadmin), the same as every other route in
-- routes/superadmin.ts.
--
-- FIRM-LEVEL DATA ONLY — NO NAMED INDIVIDUALS.
-- Every column below describes the company, never a person: no contact name,
-- no personal email, no personal direct-dial. This table shares a database and
-- backups with tenants' regulated call recordings, which is tolerable for
-- ordinary company data but would not be for someone's personal data sitting
-- alongside it. Adding contact-level columns (a named individual's name, email
-- or mobile) requires a documented legitimate-interests assessment under UK
-- GDPR first — that work has not been done, so those columns do not exist yet.
-- This omission is deliberate; do not add them without the LIA on file.
CREATE TABLE IF NOT EXISTS prospects (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    firm_name            TEXT NOT NULL,
    -- FCA Firm Reference Number. Nullable (a lead sourced from a directory may
    -- not have one resolved yet) but unique whenever present — enforced by the
    -- partial index below rather than a plain UNIQUE, since two NULLs must not
    -- collide.
    frn                  TEXT,
    -- Free text as it reads on the FCA Register (e.g. "Authorised",
    -- "Appointed Representative", "Not on the register") — the Register's own
    -- wording, not a CallGuard-invented enum, since it is copied from there.
    fca_status           TEXT,
    -- Regulated permissions held (e.g. "advising on investments",
    -- "arranging (bringing about) deals in investments"), also as read off
    -- the FCA Register.
    permissions          TEXT[] NOT NULL DEFAULT '{}',
    -- Coarse adviser headcount band (e.g. "1-5", "6-20", "21-50", "51+"), not
    -- an exact count — this is a fit signal, not a directory.
    adviser_count_band   TEXT,

    -- Where this prospect's name came from, for pipeline provenance.
    source               TEXT NOT NULL DEFAULT 'manual'
                         CHECK (source IN ('directory', 'vendor_case_study', 'referral', 'manual')),
    -- 0-100 how well this firm matches CallGuard's ideal customer profile
    -- (protection/mortgage intermediary shaped like Trust Point).
    fit_score            SMALLINT CHECK (fit_score IS NULL OR (fit_score BETWEEN 0 AND 100)),

    -- Pipeline status. Exactly these six values, mirrored in
    -- routes/superadmin.ts (PROSPECT_STATUSES) and the admin-web Prospects
    -- page — this CHECK is the source of truth, not packages/shared.
    status               TEXT NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new', 'qualified', 'contacted', 'engaged', 'won', 'lost')),
    note                 TEXT,

    website              TEXT,
    -- The firm's switchboard number — never a personal mobile or direct-dial.
    main_phone           TEXT,
    registered_address   TEXT,

    last_contacted_at    TIMESTAMPTZ,

    -- Corporate Telephone Preference Service screening timestamp. NULL means
    -- this firm's main_phone has never been checked against CTPS. Cold-calling
    -- a UK business without that check breaches PECR — a specific embarrassment
    -- for a company selling FCA compliance tooling. This column is the control:
    -- the admin-web UI must refuse to render main_phone as a click-to-call
    -- affordance, or present any other "call this number" action, while it is
    -- NULL, and must show an explicit "not screened" state instead (see
    -- packages/admin-web/src/pages/Prospects.tsx). Setting it is a manual,
    -- deliberate action recording that the screen actually happened — nothing
    -- sets it automatically.
    ctps_screened_at     TIMESTAMPTZ,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index: FRN is unique whenever present, but many prospects
-- will have none yet, and NULL <> NULL means a plain UNIQUE constraint would
-- let those collide harmlessly anyway — the partial form just says so
-- explicitly and is what CSV import's "keyed on FRN where present, else firm
-- name" upsert relies on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_frn ON prospects (frn) WHERE frn IS NOT NULL;

-- CSV import's fallback upsert key when a row has no FRN.
CREATE INDEX IF NOT EXISTS idx_prospects_firm_name ON prospects (firm_name);

-- The list view's default filter.
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects (status, created_at DESC);
