-- Data Capture module (generic, cross-tenant): per-tenant capture forms.
--
-- A capture form is a named set of typed questions/fields the AI extracts from
-- every scored call/journey — separate from scorecards/QA. A tenant defines one
-- form per context (e.g. per insurer, per supplier, per product line); a
-- resolution rule decides which form applies to a given sale. Nothing in this
-- schema is industry-specific: "insurer question sets" are just how an
-- insurance tenant configures it.

CREATE TABLE capture_forms (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    -- What this form is FOR, in the tenant's own terms (an insurer name, a
    -- supplier, a product line). Matched by capture_form_rules and shown in UI.
    context_label   TEXT,
    -- Versioned like scorecards (041): editing a form that already has capture
    -- runs bumps the version; answers pin the version they were captured with.
    version         INTEGER NOT NULL DEFAULT 1,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    archived_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_capture_forms_org ON capture_forms(organization_id) WHERE archived_at IS NULL;

CREATE TABLE capture_form_fields (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    form_id         UUID NOT NULL REFERENCES capture_forms(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    -- The question as the agent is expected to ask it / the field name.
    label           TEXT NOT NULL,
    -- Guidance for the AI: what counts as this question being asked, common
    -- phrasings, what a valid answer looks like.
    description     TEXT,
    answer_type     TEXT NOT NULL DEFAULT 'text'
                    CHECK (answer_type IN ('text', 'yes_no', 'number', 'currency', 'date', 'choice')),
    -- For answer_type='choice': allowed values, e.g. ["never","current","former"].
    choices         JSONB,
    required        BOOLEAN NOT NULL DEFAULT true,
    -- Drives capture vs confirm-only. Answers classed personal/health are
    -- NEVER stored as literal values (the transcript the AI sees is already
    -- redacted upstream; this is enforcement in depth, in code):
    --   none     -> captured_value stored
    --   personal -> confirm-only (asked/answered recorded, value suppressed)
    --   health   -> confirm-only (special-category data)
    pii_class       TEXT NOT NULL DEFAULT 'none'
                    CHECK (pii_class IN ('none', 'personal', 'health')),
    -- Optional branch gate, same semantics as scorecard_items.applies_when.
    applies_when    TEXT,
    archived_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_capture_form_fields_form ON capture_form_fields(form_id) WHERE archived_at IS NULL;

-- Which form applies to a call/journey. Evaluated in priority order; first
-- match wins. Generic sources so new tenants configure rather than fork:
--   crm_field       -> match_value compared (case-insensitive) against the
--                      named field on the inbound CRM sale-trigger payload
--   source_document -> resolved later from the fetched comparison document
--                      (phase 2), e.g. the provider named on an application PDF
--   manual          -> no auto-resolution; a human picks in the UI
CREATE TABLE capture_form_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    form_id         UUID NOT NULL REFERENCES capture_forms(id) ON DELETE CASCADE,
    source          TEXT NOT NULL CHECK (source IN ('crm_field', 'source_document', 'manual')),
    -- For crm_field: the payload key to read (e.g. "Insurer", "Supplier").
    source_key      TEXT,
    -- Value that selects this form, matched case-insensitively; supports
    -- substring match so "Legal & General Assurance" matches "Legal & General".
    match_value     TEXT,
    priority        INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_capture_form_rules_org ON capture_form_rules(organization_id) WHERE is_active;

-- Per-tenant module switch: tenants without the feature see no capture UI,
-- run no capture jobs, and pay no capture LLM cost.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS capture_enabled BOOLEAN NOT NULL DEFAULT false;

-- Which form a journey resolved to (null until resolved; journeys with a
-- completed capture run keep this for display/re-run).
ALTER TABLE journeys
  ADD COLUMN IF NOT EXISTS capture_form_id UUID REFERENCES capture_forms(id);
