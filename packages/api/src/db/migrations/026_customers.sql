-- Customer journey: track individual customers across multiple calls by phone number.
-- Customers are org-scoped and identified by normalised E.164 phone number.

CREATE TABLE customers (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone_normalized  TEXT        NOT NULL,
  name              TEXT,
  external_crm_id   TEXT,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  call_count        INTEGER     NOT NULL DEFAULT 0,
  avg_score         NUMERIC(5,2),
  UNIQUE (organization_id, phone_normalized)
);

CREATE INDEX customers_org_id_idx     ON customers (organization_id);
CREATE INDEX customers_phone_idx      ON customers (organization_id, phone_normalized);
CREATE INDEX customers_last_seen_idx  ON customers (organization_id, last_seen_at DESC);

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS customer_id   UUID REFERENCES customers(id),
  ADD COLUMN IF NOT EXISTS customer_phone TEXT;

CREATE INDEX calls_customer_id_idx ON calls (customer_id) WHERE customer_id IS NOT NULL;
