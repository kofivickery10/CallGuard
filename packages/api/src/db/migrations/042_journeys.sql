-- Multi-call journey scoring (spec §9). A journey is a customer's set of
-- calls scored together — a consent/statement counts if present anywhere in
-- the set, rather than each partial call being scored (and potentially
-- failed) in isolation.
CREATE TABLE journeys (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    scorecard_id      UUID NOT NULL REFERENCES scorecards(id),
    scorecard_version INTEGER NOT NULL,
    window_start      TIMESTAMPTZ,
    window_end        TIMESTAMPTZ,
    trigger_source    TEXT NOT NULL DEFAULT 'manual'
                          CHECK (trigger_source IN ('zoho_sale', 'manual', 'fallback')),
    status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'scoring', 'scored', 'failed')),
    branch            TEXT,
    overall_score     NUMERIC(5,2),
    pass              BOOLEAN,
    model_id          TEXT,
    error_message     TEXT,
    scored_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_journeys_org_status ON journeys(organization_id, status);
CREATE INDEX idx_journeys_customer ON journeys(customer_id, created_at DESC);

-- Which calls composed the journey, and each one's role — the wrap-up/close
-- call vs earlier context calls (spec §9 interim fallback).
CREATE TABLE journey_calls (
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    call_id    UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'context' CHECK (role IN ('wrap_up', 'context')),
    PRIMARY KEY (journey_id, call_id)
);

CREATE INDEX idx_journey_calls_call ON journey_calls(call_id);

-- Per-checkpoint result across the whole call set, with provenance: which
-- call the evidence actually came from.
CREATE TABLE journey_item_scores (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    journey_id         UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    scorecard_item_id  UUID NOT NULL REFERENCES scorecard_items(id),
    result             TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'na', 'manual_review')),
    score              NUMERIC(5,2),
    normalized_score   NUMERIC(5,2),
    confidence         NUMERIC(3,2),
    evidence           TEXT,
    reasoning          TEXT,
    source_call_id     UUID REFERENCES calls(id) ON DELETE SET NULL,
    source_timestamp   NUMERIC,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (journey_id, scorecard_item_id)
);

-- A call can belong to at most one journey at a time (the one it was last
-- scored as part of) — lets the call detail view link back to its journey.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS journey_id UUID REFERENCES journeys(id) ON DELETE SET NULL;

-- Breaches can be journey-level (detected across the call set, not
-- attributable to one call in isolation) as well as call-level.
ALTER TABLE breaches ADD COLUMN IF NOT EXISTS journey_id UUID REFERENCES journeys(id) ON DELETE CASCADE;
ALTER TABLE breaches ALTER COLUMN call_id DROP NOT NULL;
ALTER TABLE breaches ALTER COLUMN call_item_score_id DROP NOT NULL;
ALTER TABLE breaches ADD COLUMN IF NOT EXISTS journey_item_score_id UUID REFERENCES journey_item_scores(id) ON DELETE CASCADE;
-- call_item_score_id's existing UNIQUE constraint already tolerates NULLs
-- (multiple journey-level breaches with call_item_score_id NULL is fine).
ALTER TABLE breaches ADD CONSTRAINT breaches_journey_item_score_id_key UNIQUE (journey_item_score_id);
ALTER TABLE breaches ADD CONSTRAINT breaches_call_or_journey_check
  CHECK (call_id IS NOT NULL OR journey_id IS NOT NULL);
