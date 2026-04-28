CREATE TABLE alert_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    description     TEXT,
    trigger_type    TEXT NOT NULL CHECK (trigger_type IN
                      ('low_overall_score','item_below_threshold','processing_failed')),
    trigger_config  JSONB NOT NULL DEFAULT '{}',
    channels        JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_rules_org_active ON alert_rules(organization_id) WHERE is_active = true;

CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    title           TEXT NOT NULL,
    body            TEXT,
    severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    call_id         UUID REFERENCES calls(id) ON DELETE CASCADE,
    rule_id         UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);

CREATE TABLE alert_deliveries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_id         UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    call_id         UUID REFERENCES calls(id) ON DELETE SET NULL,
    channel         TEXT NOT NULL CHECK (channel IN ('email','slack','in_app')),
    target          TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    error_message   TEXT,
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_deliveries_rule_call ON alert_deliveries(rule_id, call_id);
