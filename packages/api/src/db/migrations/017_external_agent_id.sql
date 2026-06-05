-- Map a CallGuard adviser (user) to the agent identifier their dialler sends,
-- so calls ingested from any dialler can attribute to the right adviser even
-- when the dialler only knows the agent by an opaque internal ID.
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_agent_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_external_agent
  ON users (organization_id, external_agent_id)
  WHERE external_agent_id IS NOT NULL;
