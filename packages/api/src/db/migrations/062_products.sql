-- Product-aware scoring.
--
-- A tenant sells one or more products (e.g. protection-insurance policy types).
-- Some scorecard items are only relevant to certain products and must not count
-- against a sale that didn't include that product. This adds:
--
--   1. A per-org PRODUCTS catalogue. `external_key` is the value the tenant's CRM
--      carries for the product (e.g. a Zoho "Policies Sold" product field), used
--      to map an inbound sale onto a catalogue product.
--   2. `scorecard_items.applies_to_products` — the set of products an item is
--      required for. NULL/empty means "applies to every product" (the default,
--      so existing scorecards are unchanged). Otherwise the item is only scored
--      when the sale's products intersect this set; otherwise it resolves to
--      'na' and is excluded from the weighted denominator (same mechanism as the
--      branch `applies_when` gate — see services/checkpoint-classification.ts).
--   3. JOURNEY_PRODUCTS — the set of products a journey (sale) covered. A sale is
--      one-to-many with products (a customer can buy several policies in one
--      appointment), so this is a set, not a single column. `source` records how
--      each was determined ('crm' from the CRM, 'ai' inferred from the transcript
--      fallback, 'manual' set by a reviewer). `product_name` is snapshotted so
--      history survives a product later being renamed or removed.
--   4. Config on `zoho_connections` for reading the products off a related module
--      (e.g. Zoho "Policies Sold" linked to the "Customers Sold" sale record).
--
-- The feature is opt-in per tenant: it only affects scoring for an org that has a
-- products catalogue AND items with a non-empty applies_to_products. An org with
-- neither scores exactly as before.

CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- The CRM value that identifies this product on an inbound sale (e.g. the
  -- product field on Zoho "Policies Sold"). NULL for products that only ever
  -- come from the AI transcript fallback or manual tagging.
  external_key    TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- One CRM value maps to at most one product per org, so mapping a sale is
-- unambiguous. Case-insensitive because CRM values aren't reliably cased.
CREATE UNIQUE INDEX IF NOT EXISTS products_org_external_key_uk
  ON products (organization_id, lower(external_key))
  WHERE external_key IS NOT NULL;

-- Products an item is required for. NULL/empty = applies to every product.
ALTER TABLE scorecard_items
  ADD COLUMN IF NOT EXISTS applies_to_products UUID[];

CREATE TABLE IF NOT EXISTS journey_products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id   UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  -- SET NULL rather than RESTRICT: a product can be retired from the catalogue
  -- without blocking, and the snapshotted product_name keeps the sale's history
  -- readable regardless.
  product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'crm' CHECK (source IN ('crm', 'ai', 'manual')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A product appears at most once per journey.
CREATE UNIQUE INDEX IF NOT EXISTS journey_products_journey_product_uk
  ON journey_products (journey_id, product_id)
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS journey_products_journey_idx
  ON journey_products (journey_id);

-- How a journey's products were resolved, for display and the assemble-time
-- poll: 'crm' (read from the CRM related list), 'ai' (transcript fallback),
-- 'none' (org not configured, or cap hit with nothing found). NULL until
-- resolution runs.
ALTER TABLE journeys
  ADD COLUMN IF NOT EXISTS product_source TEXT
    CHECK (product_source IN ('crm', 'ai', 'none'));

-- Zoho "Policies Sold" (or equivalent) related-module config. All nullable —
-- unset means the tenant isn't using product resolution and scoring is
-- unaffected.
ALTER TABLE zoho_connections
  -- API name of the module the sale trigger fires from, whose record id the
  -- inbound payload carries (e.g. 'Customers_Sold'). The related products list
  -- is read off this record.
  ADD COLUMN IF NOT EXISTS sale_module TEXT,
  -- API name of the related list holding the products (e.g. 'Policies_Sold').
  ADD COLUMN IF NOT EXISTS policies_related_list TEXT,
  -- API name of the field on a policy record carrying the product value that
  -- maps to products.external_key (e.g. 'Product' or 'Policy_Type').
  ADD COLUMN IF NOT EXISTS policy_product_field TEXT;
