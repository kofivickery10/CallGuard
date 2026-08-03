-- Data Forms reconciliation (Part B): per-insurer document profiles, and the
-- per-tenant module toggle.
--
-- WHY PROFILES EXIST
--
-- Reconciliation compares what a customer said on a call against the
-- application actually submitted to the insurer. The submitted application
-- arrives as a PDF on the CRM record, and for a fully-underwritten product it
-- contains the insurer's complete question set with the answers given.
--
-- That document is therefore the authoritative question list, per sale. Holding
-- a hand-authored list instead means it silently rots the moment the insurer
-- adds, reworks or drops a question — and a newly added health question is
-- exactly the one most likely to cause a non-disclosure, because nobody has the
-- habit of asking it yet.
--
-- But re-deriving the structure with a language model on all ~180 sales a month
-- is waste: for a given insurer and product the questions are identical across
-- sales, only the answers differ. So we learn the structure once, store it here,
-- and afterwards parse deterministically in code at zero cost.
--
-- THE FINGERPRINT DOES DOUBLE DUTY
--
-- question_fingerprint is a hash of the ordered, normalised question wordings,
-- computed deterministically from the parsed document with no model involved.
-- It is both the cache-validity check and the drift detector:
--
--   fingerprint matches   -> question set unchanged, parse with this profile, free
--   fingerprint differs   -> the insurer changed something. Only then does a
--                            model pass run to learn the new structure, and the
--                            change is surfaced for a human to confirm.
--
-- One mechanism, both problems. The thing that keeps the cache honest is the
-- thing that catches drift.
--
-- A changed profile is NEVER adopted silently: it lands as 'needs_confirmation'
-- and a human confirms it, mirroring how capture_runs uses needs_form rather
-- than guessing which form applies.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS reconciliation_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.reconciliation_enabled IS
  'Data Forms reconciliation (Part B) module toggle. Independent of capture_enabled (Part A): Part A reads answers from the call, Part B compares them against the submitted application. Off by default so the module can be exercised on a tenant''s real data before it is surfaced to them.';

CREATE TABLE IF NOT EXISTS capture_document_profiles (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Which document this describes. Product matters as much as insurer: Royal
    -- London's Personal Menu Plan returns a full 16-page question-and-answer
    -- record, while a unit-based product from another insurer may return a
    -- two-page summary of key facts with no health questions at all.
    insurer              TEXT NOT NULL,
    product              TEXT,

    -- How to read it. 'question_answer' = repeated question blocks terminated by
    -- an answer delimiter (Royal London's "Your answer(s):"). 'label_value' =
    -- flat label/value pairs (MetLife EverydayProtect's summary sheet).
    -- 'question_marker' = the quote-portal export, where each question line ends
    -- with a stranded column header and the answers, with their timestamps and
    -- audit trail, PRECEDE the question they belong to. That last one is the
    -- format on every fully-underwritten sale sampled so far, so it is the
    -- common case rather than an exception.
    strategy             TEXT NOT NULL
                             CHECK (strategy IN ('question_answer', 'label_value', 'question_marker')),

    -- Literal strings that identify this document inside a multi-document pack.
    -- Filenames are NOT usable for this: the same insurer's pack has been seen
    -- named both "Client review for <name>.pdf" and "Application Details (5).pdf",
    -- and a firm's own suitability report sits alongside it looking superficially
    -- similar. Detection is on content.
    detect_patterns      JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Parse rules: answer delimiter, the page-footer marker bounding the
    -- application section within the wider pack, footer/boilerplate lines to
    -- strip. Shape is owned by services/application-pdf.ts.
    parse_config         JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Hash of the ordered normalised question wordings. See the header comment.
    question_fingerprint TEXT NOT NULL,

    -- The learned question set, ordered: wording, guidance, choices, and whether
    -- the answer is health data (which decides whether its value may be stored).
    questions            JSONB NOT NULL DEFAULT '[]'::jsonb,

    version              INTEGER NOT NULL DEFAULT 1,
    status               TEXT NOT NULL DEFAULT 'needs_confirmation'
                             CHECK (status IN ('needs_confirmation', 'active', 'superseded')),

    -- Provenance: which sale's document taught us this, so a questionable
    -- profile can be traced back to the source it was learned from.
    learned_from_journey_id UUID REFERENCES journeys(id) ON DELETE SET NULL,

    confirmed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at         TIMESTAMPTZ,
    superseded_at        TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active profile per insurer+product per tenant. COALESCE on product
-- because NULL never equals NULL in a unique index, which would otherwise let
-- duplicate product-less profiles through.
-- NB: this is a PARTIAL unique index — any ON CONFLICT targeting it must repeat
-- the WHERE predicate verbatim or Postgres raises 42P10.
CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_doc_profiles_active
  ON capture_document_profiles (organization_id, insurer, COALESCE(product, ''))
  WHERE status = 'active';

-- The hot path: given a parsed document's fingerprint, is there a profile for it?
CREATE INDEX IF NOT EXISTS idx_capture_doc_profiles_fingerprint
  ON capture_document_profiles (organization_id, question_fingerprint);

-- Drift review queue.
CREATE INDEX IF NOT EXISTS idx_capture_doc_profiles_status
  ON capture_document_profiles (organization_id, status, created_at DESC);
