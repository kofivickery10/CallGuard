-- Phase 1: Score corrections (tenant-specific learning)
CREATE TABLE score_corrections (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id     UUID NOT NULL REFERENCES organizations(id),
    call_id             UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    call_item_score_id  UUID NOT NULL REFERENCES call_item_scores(id) ON DELETE CASCADE,
    scorecard_item_id   UUID NOT NULL REFERENCES scorecard_items(id) ON DELETE CASCADE,
    corrected_by        UUID NOT NULL REFERENCES users(id),
    original_score      NUMERIC(5,2) NOT NULL,
    corrected_score     NUMERIC(5,2) NOT NULL,
    original_pass       BOOLEAN,
    corrected_pass      BOOLEAN NOT NULL,
    reason              TEXT,
    transcript_excerpt  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(call_item_score_id)
);
CREATE INDEX idx_corrections_org_item ON score_corrections(organization_id, scorecard_item_id, created_at DESC);

-- Phase 2: Exemplars
ALTER TABLE calls ADD COLUMN is_exemplar BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN exemplar_reason TEXT;
CREATE INDEX idx_calls_exemplars ON calls(organization_id, is_exemplar) WHERE is_exemplar = true;

-- Phase 4: AI Insights digests
CREATE TABLE insight_digests (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    summary         TEXT NOT NULL,
    recommendations JSONB NOT NULL DEFAULT '[]',
    metrics         JSONB NOT NULL DEFAULT '{}',
    generated_by    UUID REFERENCES users(id),
    model_id        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_insight_digests_org_created ON insight_digests(organization_id, created_at DESC);
