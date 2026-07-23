-- Data Capture module: extraction runs and captured answers.
--
-- A capture run is one AI extraction pass of a capture form over a journey's
-- combined transcript (or a single call, for per-call orgs). Runs make
-- re-processing auditable and idempotent, mirroring how journeys dedupe:
-- a completed run for the same target + form version is returned, not re-run.

CREATE TABLE capture_runs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    -- Exactly one target: a journey (sales_only orgs) or a single call.
    journey_id      UUID REFERENCES journeys(id) ON DELETE CASCADE,
    call_id         UUID REFERENCES calls(id) ON DELETE CASCADE,
    form_id         UUID NOT NULL REFERENCES capture_forms(id),
    form_version    INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'needs_form', 'running', 'completed', 'failed')),
    model_id        TEXT,
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((journey_id IS NOT NULL) <> (call_id IS NOT NULL))
);
CREATE INDEX idx_capture_runs_org ON capture_runs(organization_id, created_at DESC);
CREATE INDEX idx_capture_runs_journey ON capture_runs(journey_id) WHERE journey_id IS NOT NULL;
CREATE INDEX idx_capture_runs_call ON capture_runs(call_id) WHERE call_id IS NOT NULL;
-- Idempotency: one completed run per target + form version.
CREATE UNIQUE INDEX uq_capture_runs_journey_form
    ON capture_runs(journey_id, form_id, form_version)
    WHERE journey_id IS NOT NULL AND status IN ('pending', 'running', 'completed');
CREATE UNIQUE INDEX uq_capture_runs_call_form
    ON capture_runs(call_id, form_id, form_version)
    WHERE call_id IS NOT NULL AND status IN ('pending', 'running', 'completed');

CREATE TABLE capture_answers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id          UUID NOT NULL REFERENCES capture_runs(id) ON DELETE CASCADE,
    field_id        UUID NOT NULL REFERENCES capture_form_fields(id),
    asked           BOOLEAN NOT NULL DEFAULT false,
    answered        BOOLEAN NOT NULL DEFAULT false,
    -- The literal answer, stored ONLY for pii_class='none' fields.
    -- Confirm-only fields (personal/health) always store NULL here with
    -- value_redacted=true — enforced in services/capture.ts, never left to
    -- the model. The transcript the model reads is redacted upstream anyway
    -- (Deepgram source-side redaction); this is enforcement in depth.
    captured_value  TEXT,
    value_redacted  BOOLEAN NOT NULL DEFAULT false,
    result          TEXT NOT NULL
                    CHECK (result IN ('captured', 'confirmed_only', 'missed', 'na', 'manual_review')),
    confidence      NUMERIC(3,2),
    -- Verbatim transcript quote supporting the answer, with the "[Call N]"
    -- marker resolved to the source call where attributable.
    evidence        TEXT,
    source_call_id  UUID REFERENCES calls(id) ON DELETE SET NULL,
    reasoning       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, field_id)
);
CREATE INDEX idx_capture_answers_run ON capture_answers(run_id);
