CREATE TABLE call_share_links (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id         UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id),
    token_jti       TEXT NOT NULL UNIQUE,
    created_by      UUID REFERENCES users(id),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    view_count      INTEGER NOT NULL DEFAULT 0,
    last_viewed_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_share_links_call ON call_share_links(call_id);
CREATE INDEX idx_share_links_jti ON call_share_links(token_jti);

CREATE TABLE call_feedback (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id       UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    share_link_id UUID NOT NULL REFERENCES call_share_links(id) ON DELETE CASCADE,
    stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment       TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_feedback_call ON call_feedback(call_id);
CREATE INDEX idx_call_feedback_link ON call_feedback(share_link_id);
