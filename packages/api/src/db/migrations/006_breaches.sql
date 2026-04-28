-- Optional severity override on scorecard items (default derived from weight)
ALTER TABLE scorecard_items ADD COLUMN severity TEXT
    CHECK (severity IN ('critical','high','medium','low'));

CREATE TABLE breaches (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id       UUID NOT NULL REFERENCES organizations(id),
    call_id               UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    call_item_score_id    UUID NOT NULL REFERENCES call_item_scores(id) ON DELETE CASCADE,
    scorecard_item_id     UUID NOT NULL REFERENCES scorecard_items(id),
    severity              TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
    status                TEXT NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','acknowledged','coached','escalated','resolved','noted')),
    assigned_to           UUID REFERENCES users(id),
    notes                 TEXT,
    detected_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(call_item_score_id)
);

CREATE INDEX idx_breaches_org_status ON breaches(organization_id, status);
CREATE INDEX idx_breaches_org_severity ON breaches(organization_id, severity);
CREATE INDEX idx_breaches_call ON breaches(call_id);
CREATE INDEX idx_breaches_assigned ON breaches(assigned_to) WHERE status != 'resolved';
CREATE INDEX idx_breaches_org_detected ON breaches(organization_id, detected_at DESC);

-- Audit log for status changes
CREATE TABLE breach_events (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    breach_id    UUID NOT NULL REFERENCES breaches(id) ON DELETE CASCADE,
    user_id      UUID REFERENCES users(id),
    event_type   TEXT NOT NULL CHECK (event_type IN ('status_changed','assigned','note_added','reopened')),
    from_value   TEXT,
    to_value     TEXT,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_breach_events_breach ON breach_events(breach_id, created_at DESC);

-- Backfill: create breaches for existing failed call_item_scores
INSERT INTO breaches (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, detected_at)
SELECT
    c.organization_id,
    c.id,
    cis.id,
    cis.scorecard_item_id,
    CASE
        WHEN si.weight >= 2.0 THEN 'critical'
        WHEN si.weight >= 1.5 THEN 'high'
        ELSE 'medium'
    END AS severity,
    COALESCE(cs.scored_at, cs.created_at)
FROM call_item_scores cis
JOIN scorecard_items si ON si.id = cis.scorecard_item_id
JOIN call_scores cs ON cs.id = cis.call_score_id
JOIN calls c ON c.id = cs.call_id
WHERE cis.normalized_score < 70
ON CONFLICT (call_item_score_id) DO NOTHING;
