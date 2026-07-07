-- Defence-in-depth: a superadmin must have no organization_id (platform-wide
-- access with no tenant context), and every other role must belong to an
-- organization. This stops a bug in a tenant-facing endpoint from ever
-- producing an org-scoped superadmin, which would otherwise pass the
-- application-layer requireSuperadmin check.
ALTER TABLE users
  ADD CONSTRAINT users_superadmin_no_org_check
  CHECK (
    (role = 'superadmin' AND organization_id IS NULL)
    OR (role != 'superadmin' AND organization_id IS NOT NULL)
  );
