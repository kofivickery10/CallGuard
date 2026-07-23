-- Auto-sync the product catalogue from the Zoho picklist.
--
-- Instead of maintaining products by hand in CallGuard, a tenant can point us at
-- the Zoho module + picklist field that defines their products, and we mirror it
-- (add new values, deactivate removed ones) on demand and on a daily schedule.
--
--   * zoho_connections.policies_module — API name of the module the `Product`
--     picklist field lives on (e.g. the "Policies Sold" module). Distinct from
--     sale_module (the trigger module) and policies_related_list (the related
--     list on the sale record): the picklist definition is read off the module
--     that owns the field, via /settings/fields.
--   * products.zoho_synced_at — stamped on every product touched by a sync run.
--     Products with a non-null value are Zoho-managed: a sync deactivates any
--     whose value has disappeared from the picklist. Products added by hand
--     (null zoho_synced_at) are never touched by a sync, so the two can coexist.

ALTER TABLE zoho_connections
  ADD COLUMN IF NOT EXISTS policies_module TEXT;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS zoho_synced_at TIMESTAMPTZ;
