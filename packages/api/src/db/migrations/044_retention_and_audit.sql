-- Retention lifecycle (spec §15): 2yr live in the portal, archived (kept,
-- hidden from the default view) yr 3-5, deleted at the tenant's
-- retention_days (5yr default, see 038). Plus a cancellation timestamp so
-- the 30-day return/delete-on-termination job has something to key off —
-- `suspended_at` (024) tracks suspension, not cancellation.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

ALTER TABLE calls ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX idx_calls_org_archived ON calls(organization_id, archived_at);

-- Audit log immutability. The application only ever INSERTs (services/audit.ts);
-- this trigger makes that a hard guarantee rather than a convention, so a bug
-- or a direct psql session can't quietly rewrite/erase the compliance trail.
-- (Not paired with a role-level REVOKE: the app's DB role name is
-- deployment-specific and guessing it wrong here would risk locking audit
-- writes out entirely — enforce that separately, deployment-side, if needed.)
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
