-- Emailed invitations for provisioning tenant users (first admin on tenant
-- creation, and additional users added by a superadmin). The token is stored
-- as a SHA-256 hash; the raw token only ever lives in the emailed link.
CREATE TABLE IF NOT EXISTS invites (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin',
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      UUID REFERENCES users(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(organization_id);
