-- Frozen monthly billing snapshots.
--
-- Until now MRR and seat counts were computed live from the calls table, which
-- drifts as calls are re-scored, edited, or retention-purged, so there was no
-- durable record of what a tenant was actually billed. This table freezes one
-- row per active tenant per month: the billed seat count (headcount of billable
-- advisers), the plan and any negotiated override in force, and the total. The
-- month-end snapshot job (jobs/processors/billing-snapshot.ts) writes it once
-- per month; nothing recomputes it afterwards.
CREATE TABLE billing_periods (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- First day (UTC) of the billed calendar month.
    period_month        DATE NOT NULL,
    plan                TEXT NOT NULL,
    -- Number of billable seats (advisers, excluding billing_exempt) at snapshot.
    seat_count          INTEGER NOT NULL,
    -- The negotiated flat rate in force, if any (else per-tier pricing applied).
    seat_price_override NUMERIC(12, 2),
    currency            TEXT NOT NULL DEFAULT 'GBP',
    -- Frozen total for the month = sum of each seat's effective-tier price.
    total               NUMERIC(12, 2) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One frozen row per tenant per month; the snapshot job relies on this to
    -- stay idempotent (ON CONFLICT DO NOTHING).
    UNIQUE (organization_id, period_month)
);

CREATE INDEX idx_billing_periods_month ON billing_periods(period_month DESC);
CREATE INDEX idx_billing_periods_org ON billing_periods(organization_id, period_month DESC);
