-- In-app tenant support chat (native, no third-party processor).
-- is_staff marks the CallGuard platform operator(s) who can see every org's thread.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS support_messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  sender_user_id  UUID REFERENCES users(id),
  from_staff      BOOLEAN NOT NULL DEFAULT false,
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_org ON support_messages(organization_id, created_at);
