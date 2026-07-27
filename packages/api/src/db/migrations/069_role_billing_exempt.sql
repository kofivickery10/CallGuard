-- Billing is headcount-based (services/billing.ts): every non-exempt user is a
-- billed seat regardless of call activity. The marketing pricing page promises
-- only the 'adviser' role is a billable seat - admin/supervisor/viewer ("compliance
-- officers, supervisors and viewers who review results") are not charged. Until
-- now billing_exempt (migration 052) was only ever set by hand via the superadmin
-- flow, so real tenant admin/supervisor/viewer accounts were being billed a seat
-- despite that promise.
--
-- Backfill existing rows, then a trigger keeps every future insert/role-change
-- consistent so no user-creation or role-edit code path (agents.ts POST/PUT,
-- onboard-tenant.ts, seed scripts, superadmin tenant creation) has to remember
-- to set this by hand. A superadmin can still override afterwards via the
-- existing PATCH .../billing-exempt endpoint - the trigger only sets the
-- default, it doesn't lock the flag.

UPDATE users
   SET billing_exempt = true
 WHERE role IN ('admin', 'supervisor', 'viewer')
   AND NOT billing_exempt;

CREATE OR REPLACE FUNCTION set_role_billing_exempt() RETURNS trigger AS $$
BEGIN
  IF NEW.role IN ('admin', 'supervisor', 'viewer') THEN
    NEW.billing_exempt := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_role_billing_exempt ON users;
CREATE TRIGGER trg_role_billing_exempt
  BEFORE INSERT OR UPDATE OF role ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_role_billing_exempt();
