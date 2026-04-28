CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Organizations
CREATE TABLE organizations (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scorecards
CREATE TABLE scorecards (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scorecard items
CREATE TABLE scorecard_items (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scorecard_id  UUID NOT NULL REFERENCES scorecards(id) ON DELETE CASCADE,
    label         TEXT NOT NULL,
    description   TEXT,
    score_type    TEXT NOT NULL DEFAULT 'binary' CHECK (score_type IN ('binary', 'scale_1_5', 'scale_1_10')),
    weight        NUMERIC(3,2) NOT NULL DEFAULT 1.00,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Calls
CREATE TABLE calls (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    uploaded_by     UUID REFERENCES users(id),
    file_name       TEXT NOT NULL,
    file_key        TEXT NOT NULL,
    file_size_bytes BIGINT,
    duration_seconds NUMERIC(10,2),
    mime_type       TEXT,
    status          TEXT NOT NULL DEFAULT 'uploaded'
                    CHECK (status IN ('uploaded', 'transcribing', 'transcribed', 'scoring', 'scored', 'failed')),
    error_message   TEXT,
    transcript_raw  JSONB,
    transcript_text TEXT,
    agent_name      TEXT,
    customer_phone  TEXT,
    call_date       TIMESTAMPTZ,
    tags            TEXT[] DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_calls_org_status ON calls(organization_id, status);
CREATE INDEX idx_calls_org_created ON calls(organization_id, created_at DESC);

-- Call scores
CREATE TABLE call_scores (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id       UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    scorecard_id  UUID NOT NULL REFERENCES scorecards(id),
    overall_score NUMERIC(5,2),
    pass          BOOLEAN,
    scored_at     TIMESTAMPTZ,
    model_id      TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(call_id, scorecard_id)
);

-- Call item scores
CREATE TABLE call_item_scores (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_score_id   UUID NOT NULL REFERENCES call_scores(id) ON DELETE CASCADE,
    scorecard_item_id UUID NOT NULL REFERENCES scorecard_items(id),
    score           NUMERIC(5,2) NOT NULL,
    normalized_score NUMERIC(5,2) NOT NULL,
    confidence      NUMERIC(3,2),
    evidence        TEXT,
    reasoning       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(call_score_id, scorecard_item_id)
);
