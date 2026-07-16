-- Platform-level audit events. A superadmin action that isn't scoped to one
-- tenant — deleting a whole tenant, most importantly — is recorded in audit_log
-- with organization_id NULL, so it survives the deleted tenant's own audit rows
-- being purged and still shows in the platform-wide audit view.
ALTER TABLE audit_log ALTER COLUMN organization_id DROP NOT NULL;

-- audit_log stays append-only (migration 044), with ONE sanctioned exception:
-- deleting a tenant must be able to purge that tenant's audit trail. The teardown
-- signals this with a transaction-local flag (SET LOCAL app.allow_audit_purge),
-- which this trigger honours for DELETE only. UPDATEs remain forbidden always,
-- and any DELETE without the flag is still blocked — so the immutability
-- guarantee holds for everything except the deliberate, transactional purge.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
