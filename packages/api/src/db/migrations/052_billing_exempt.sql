-- Per-user billing exemption. A billable "seat" is a distinct agent on scored
-- calls in a month; this flag drops a user from that count entirely, so an
-- internal CallGuard login seeded into a tenant (setup/support admin) never
-- bills that tenant a seat even if test calls get attributed to it. Default
-- false; only settable by superadmin flows, never tenant-facing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN NOT NULL DEFAULT false;
