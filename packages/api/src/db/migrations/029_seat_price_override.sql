-- Per-tenant monthly seat price override (GBP). When set, this tenant's active
-- seats bill at this negotiated rate instead of the default tier price
-- (SEAT_PRICING in @callguard/shared). NULL = use the tier default.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS seat_price_override NUMERIC(10,2);
