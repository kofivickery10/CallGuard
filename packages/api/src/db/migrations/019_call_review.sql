-- Implicit calibration signal: a reviewer marking a call as reviewed means the
-- item scores they did NOT correct are agreements. Combined with corrections
-- (disagreements) this gives a true AI<->reviewer agreement rate.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_calls_org_reviewed
  ON calls (organization_id, reviewed_at)
  WHERE reviewed_at IS NOT NULL;
