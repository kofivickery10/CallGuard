-- B2B email outreach: role-based contact address, its provenance, and PECR
-- opt-out (see enrich-prospects-fca.ts's --export-outreach and, if built,
-- --harvest-emails, for the full mechanics).
--
-- WHY EMAIL AND NOT PHONE FOR FIRST CONTACT: cold-calling a UK business
-- number requires a Corporate Telephone Preference Service screen under
-- PECR first (see ctps_screened_at, migration 102) — no such screen exists
-- for these prospects yet. PECR treats email to a corporate subscriber far
-- more permissively: no prior consent is required to email a company (as
-- opposed to an individual), only that any opt-out be honoured going
-- forward. That is what makes email a safe channel to open with while
-- ctps_screened_at stays NULL, and what opted_out_at (below) exists to
-- guarantee.
--
-- Purely additive: production already holds real prospects rows, so every
-- column here is nullable, nothing rewrites existing data, and nothing goes
-- NOT NULL without a default.
--
-- Same firm-level-only rule as migrations 102/103/104/105: general_email
-- must describe the company, never a person — the exact same reasoning as
-- main_phone being a switchboard number and never a personal direct-dial. A
-- sole trader or partnership is an INDIVIDUAL subscriber under PECR, not a
-- corporate one, so a personal address here isn't just a data-protection
-- problem the way a personal main_phone would be, it is also the wrong legal
-- basis for the email itself. The CHECK constraint below enforces this in
-- the schema rather than trusting every future code path to remember it:
-- role-based local parts only (info@, enquiries@, hello@, etc.), so a named
-- individual's address (john.smith@firm.co.uk) is physically impossible to
-- insert, from this script, the admin UI, or a future bulk-import path none
-- of us have written yet. Extending the allowlist means editing this CHECK
-- in a new migration — a conscious, reviewed decision, not a quiet code
-- change.
ALTER TABLE prospects
    -- A role-based inbox only, found on the firm's own public website (the
    -- FCA Register publishes no email addresses at all). See the CHECK
    -- constraint's comment above for why the allowlist is enforced here, in
    -- the schema, rather than only in application code.
    ADD COLUMN IF NOT EXISTS general_email TEXT,
    ADD COLUMN IF NOT EXISTS general_email_source_url TEXT,
    -- A PECR opt-out. Once set, this firm must never appear in an outreach
    -- export again — permanently, even if a later enrichment or harvest
    -- sweep rediscovers the same address on the same page. There is no
    -- "un-opt-out": this column is only ever set once, by a human recording
    -- that a real request happened, and nothing in this codebase clears it.
    ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ,
    ADD CONSTRAINT prospects_general_email_role_based CHECK (
        general_email IS NULL OR general_email ~* '^(info|enquiries|enquiry|hello|contact|admin|office|mail|team|support|sales|reception)@'
    );
