-- One alert per rule, per checkpoint, per call or sale — permanently.
--
-- Until now the only thing stopping an alert being delivered twice was the
-- BullMQ job id (services/alert-evaluator.ts fans out with
-- `alert-<rule>-<pass>-<channel>`). That is not a record of what a firm has
-- been told:
--
--   * the alerts queue keeps only its last 500 finished jobs, so the id a
--     repeat would collide with is routinely gone;
--   * the "pass" it is keyed on changes by design — a re-score mints a new
--     call_scores row — so the same failed checkpoint re-alerts on every
--     re-score;
--   * and now that a reviewer's ruling and a corrected verdict raise alerts
--     too (routes/review.ts, routes/calls.ts, routes/journeys.ts), the same
--     failure can be reached from several directions at different times.
--
-- Alerts reach a firm's compliance team by email and Slack. Telling them the
-- same checkpoint failed three times, once per re-score, is how an alert
-- channel stops being read. So the fact of having alerted is stored, and the
-- unique index below is what makes "at most once" true rather than likely.
--
-- One row is claimed (INSERT ... ON CONFLICT DO NOTHING RETURNING) before any
-- delivery job is enqueued; losing the race means somebody has already been
-- told. This is deliberately at-most-once rather than at-least-once: a claim
-- that commits and then fails to enqueue loses that alert, which is the safer
-- failure for a channel whose value is that everything in it is new.
CREATE TABLE IF NOT EXISTS alert_events (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    rule_id           UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    -- Which kind of thing was alerted on. A sale (journey) is scored as one
    -- compliance unit and its calls are never scored on their own, so its
    -- alerts key on the sale, not on the wrap-up call they are delivered
    -- against.
    entity_type       TEXT NOT NULL CHECK (entity_type IN ('call', 'journey')),
    -- The call id or journey id. Deliberately no foreign key: it points at one
    -- of two tables. Retention may delete the call or sale underneath it; the
    -- row left behind is 6 columns of bookkeeping saying "this was alerted",
    -- which stays true, and ids are UUIDs so it can never attach to anything
    -- else.
    entity_id         UUID NOT NULL,
    -- The checkpoint an 'item_below_threshold' alert was about. NULL for
    -- whole-entity rules ('low_overall_score', 'processing_failed'), which are
    -- about the call or sale itself.
    scorecard_item_id UUID REFERENCES scorecard_items(id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The constraint that makes an alert at-most-once. Expression index rather than
-- a plain UNIQUE because NULL scorecard_item_id (a whole-entity rule) must
-- collide with itself, and in SQL two NULLs never do — without the COALESCE a
-- "Low score" alert would re-send on every re-score.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_once
  ON alert_events (
    organization_id,
    rule_id,
    entity_type,
    entity_id,
    COALESCE(scorecard_item_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- For "what has this sale/call already raised?" lookups and support questions.
CREATE INDEX IF NOT EXISTS idx_alert_events_entity
  ON alert_events (entity_type, entity_id, created_at DESC);
