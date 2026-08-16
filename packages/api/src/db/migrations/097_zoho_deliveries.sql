-- Per-call/journey Zoho CRM write-back delivery tracking, mirroring
-- webhook_deliveries (migration 013).
--
-- Until now a failed Zoho write-back left no trace anywhere: zoho_connections
-- only carries `last_error`, which holds the LATEST problem across the whole
-- connection — a transient failure on one call is silently overwritten by the
-- next call's success a minute later. For a regulated firm "we scored it but
-- the CRM never got it, and nobody knows" is a real evidence gap, not just an
-- inconvenience.
--
-- pushScoredPayload (services/zoho.ts) makes two INDEPENDENT writes per scored
-- call/journey — the customer-record (Leads/Contacts) score + breach task, and
-- the QA-module record — so `kind` distinguishes which one a row is tracking;
-- a single call/journey can have one row of each, and a tenant using only one
-- of the two only ever gets rows for that one (no row is written for a target
-- that was never configured/attempted, same as webhook_deliveries skipping
-- silently when no webhook_url is set).
CREATE TABLE zoho_deliveries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    call_id         UUID REFERENCES calls(id) ON DELETE SET NULL,
    journey_id      UUID REFERENCES journeys(id) ON DELETE SET NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('record', 'qa')),
    -- Human-readable description of what was written to: the matched CRM
    -- record once resolved ("Leads:5904xxxx"), or a description of the
    -- attempt before/without a resolved record ("Leads (phone +4477...)").
    target          TEXT NOT NULL,
    -- The scored payload this delivery is (re)trying to write, carried here so
    -- a queued retry can run without recomputing the score — same shape as
    -- webhook_deliveries.payload.
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
    -- Whether the last failure is one a delayed retry can plausibly fix
    -- (transport error, 429, 5xx) versus one that needs a person (token
    -- revoked, a rejected field, a deleted record) — see classifyZohoFailure
    -- in services/zoho.ts. Always false once status = 'skipped': an ambiguous
    -- phone match is a deliberate no-op, not a failure, and must never be
    -- retried blindly into guessing which customer it is.
    retryable       BOOLEAN NOT NULL DEFAULT false,
    last_error      TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (call_id IS NOT NULL OR journey_id IS NOT NULL)
);

CREATE INDEX idx_zoho_deliveries_org_status ON zoho_deliveries(organization_id, status, created_at DESC);
CREATE INDEX idx_zoho_deliveries_call ON zoho_deliveries(call_id) WHERE call_id IS NOT NULL;
CREATE INDEX idx_zoho_deliveries_journey ON zoho_deliveries(journey_id) WHERE journey_id IS NOT NULL;
