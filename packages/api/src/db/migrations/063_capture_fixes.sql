-- Data Capture review fixes (pre-launch hardening).
--
-- 1. needs_form runs no longer pin a placeholder form. A needs_form run means
--    "no form could be resolved" — pinning the oldest active form's id/version
--    (the previous NOT NULL workaround) showed a real form name in the
--    attention queue for a run that has no form, and silently inserted nothing
--    when the org had zero forms. form_id/form_version become nullable, with a
--    CHECK that only needs_form rows may omit them.
ALTER TABLE capture_runs
  ALTER COLUMN form_id DROP NOT NULL,
  ALTER COLUMN form_version DROP NOT NULL;

ALTER TABLE capture_runs
  ADD CONSTRAINT capture_runs_form_presence CHECK (
    status = 'needs_form' OR (form_id IS NOT NULL AND form_version IS NOT NULL)
  );

-- 2. Dedupe needs_form rows. Migration 060's partial unique indexes only cover
--    pending/running/completed, so the needs_form INSERT's ON CONFLICT DO
--    NOTHING had no arbiter and re-scoring stacked duplicate rows in the
--    attention queue. One needs_form row per journey (or call).
--
--    Collapse any pre-existing duplicates first, keeping the most recent row per
--    journey / per call — the committed 059/060 backend could have produced
--    duplicate needs_form rows before this migration lands, and CREATE UNIQUE
--    INDEX would abort on them.
DELETE FROM capture_runs a
  USING capture_runs b
  WHERE a.status = 'needs_form' AND b.status = 'needs_form'
    AND a.journey_id IS NOT NULL AND a.journey_id = b.journey_id
    AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));

DELETE FROM capture_runs a
  USING capture_runs b
  WHERE a.status = 'needs_form' AND b.status = 'needs_form'
    AND a.call_id IS NOT NULL AND a.call_id = b.call_id
    AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));

CREATE UNIQUE INDEX uq_capture_runs_journey_needs_form
    ON capture_runs(journey_id)
    WHERE journey_id IS NOT NULL AND status = 'needs_form';
CREATE UNIQUE INDEX uq_capture_runs_call_needs_form
    ON capture_runs(call_id)
    WHERE call_id IS NOT NULL AND status = 'needs_form';

-- 3. CRM sale-trigger context for capture-form resolution. The scalar fields
--    of the inbound sale-trigger payload (e.g. an Insurer/Provider field) are
--    snapshotted onto the journey so capture_form_rules with source='crm_field'
--    can be evaluated when capture starts (which happens later, at scoring
--    time, when the webhook payload is long gone). Keys-and-scalar-values
--    only, size-capped at write time in routes/integrations.ts.
ALTER TABLE journeys
  ADD COLUMN IF NOT EXISTS trigger_context JSONB;
