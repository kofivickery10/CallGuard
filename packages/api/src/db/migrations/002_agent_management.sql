-- Add agent_id FK to calls table (nullable for backward compat)
ALTER TABLE calls ADD COLUMN agent_id UUID REFERENCES users(id);

-- Index for querying calls by agent
CREATE INDEX idx_calls_agent_id ON calls(agent_id);

-- Index for querying users by org + role (agent listing)
CREATE INDEX idx_users_org_role ON users(organization_id, role);

-- Backfill: match existing agent_name values to member users by name
UPDATE calls c
SET agent_id = u.id
FROM users u
WHERE c.agent_name IS NOT NULL
  AND c.agent_id IS NULL
  AND u.organization_id = c.organization_id
  AND u.role = 'member'
  AND lower(trim(u.name)) = lower(trim(c.agent_name));
