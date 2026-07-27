-- Reverts migration 069. That migration read the public pricing FAQ ("compliance
-- officers, supervisors and viewers who review results are not charged as seats")
-- as the commercial rule and made it structural: it backfilled billing_exempt on
-- every admin/supervisor/viewer and added a trigger forcing the flag on for those
-- roles forever. That is not how tenants are actually charged - billing is
-- headcount-based and every provisioned tenant user is a billed seat - so 069
-- silently cut real seats out of the current-month bill and out of the "Billed?"
-- column on Settings -> Billing.
--
-- Back to the migration 052 model: billing_exempt is a deliberate per-user
-- override set by a superadmin, never derived from role.
--
-- The trigger fired on INSERT and on UPDATE OF role only, so it could not have
-- overwritten a later hand-set value - the superadmin endpoint updates
-- billing_exempt alone. That makes the audit trail authoritative: audit_log is
-- append-only (044/046) and 'tenant.billing_exempt' is written on every use of
-- that endpoint, so a user whose most recent such event excluded them was
-- exempted on purpose and keeps the flag. Everyone else is a 069 backfill and is
-- restored to billable.

DROP TRIGGER IF EXISTS trg_role_billing_exempt ON users;
DROP FUNCTION IF EXISTS set_role_billing_exempt();

UPDATE users u
   SET billing_exempt = false
 WHERE u.role IN ('admin', 'supervisor', 'viewer')
   AND u.billing_exempt
   AND NOT COALESCE(
     (SELECT a.summary LIKE '%excluded from billable seat count'
        FROM audit_log a
       WHERE a.action_type = 'tenant.billing_exempt'
         AND a.entity_type = 'user'
         AND a.entity_id = u.id::text
       ORDER BY a.created_at DESC
       LIMIT 1),
     false
   );
