-- Score history for sales, so a re-score adds to the record instead of erasing
-- it.
--
-- POST /journeys/:id/rescore replaced overall_score in place, wrote no audit
-- entry, and re-pushed the new number to the tenant's CRM. A Trust Point admin
-- clicked it twice on one sale and watched the score go 69.8% -> ~42% -> 53.5%
-- with no new evidence and no way to see that it had ever been anything else.
-- The swing itself was a bug (a verify pass truncating at a fixed 2048-token
-- cap, removed in 073), but the deeper problem survives that fix: an FCA-
-- regulated firm's compliance register must never silently change value.
--
-- Scoring is not deterministic and cannot be made so. Sonnet 5 rejects
-- `temperature` outright ("deprecated for this model"), and temperature 0 never
-- guaranteed identical output on the models that do accept it. So the guarantee
-- to offer a regulated firm is not "the number never moves" — it is "every
-- number the system ever produced is still on the record, with who caused it,
-- when, and against which model and call set".
--
-- One row per completed scoring run, including the first. The journeys row
-- keeps holding the current score (every read path stays unchanged); this table
-- is the append-only history behind it.
CREATE TABLE IF NOT EXISTS journey_score_runs (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    journey_id           UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    -- Denormalised so history survives tenant-scoped queries and retention
    -- sweeps without a join back to journeys.
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- 1 for the initial scoring, incrementing per re-score. Assigned by the
    -- writer inside the scoring transaction (see score-journey.ts), so two
    -- concurrent runs cannot claim the same number.
    run_number           INTEGER NOT NULL,

    overall_score        NUMERIC(5,2),
    pass                 BOOLEAN,
    branch               TEXT,
    branch_source        TEXT,
    model_id             TEXT,

    -- The denominator, broken out. A score can move because verdicts changed OR
    -- because the scoreable set changed (a branch flip mutes different items, a
    -- consent gate routes to manual review). Without these you cannot tell those
    -- two apart after the fact, which is exactly the question asked of a score
    -- that moved.
    items_passed         INTEGER,
    items_failed         INTEGER,
    items_na             INTEGER,
    items_manual_review  INTEGER,

    -- How many calls the sale was scored across. A re-score after a backfill
    -- legitimately moves the score; this is what shows that.
    calls_scored         INTEGER,

    -- Who caused this run. NULL for automatic scoring (the Zoho sale trigger)
    -- and for runs whose actor is gone.
    triggered_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    -- 'initial'  — first scoring off the sale trigger or assembly.
    -- 'rescore'  — a human pressed the button.
    -- 'bulk'     — an operational re-score script (suppressCrm path).
    -- 'backfill' — calls recovered from the dialler's history API were attached
    --              to an already-scored sale, so it was scored again on more
    --              evidence than the first time. The one case where a moved
    --              score has a concrete, defensible cause, which is why it is
    --              distinguishable from the others.
    trigger_source       TEXT NOT NULL
                           CHECK (trigger_source IN ('initial', 'rescore', 'bulk', 'backfill')),

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Belt and braces on the writer's run_number assignment.
    UNIQUE (journey_id, run_number)
);

-- The sale-detail read: "show me this sale's scoring history, newest first".
CREATE INDEX IF NOT EXISTS idx_journey_score_runs_journey
    ON journey_score_runs(journey_id, run_number DESC);

-- Tenant-wide ops view: which sales have been re-scored, and how much they moved.
CREATE INDEX IF NOT EXISTS idx_journey_score_runs_org
    ON journey_score_runs(organization_id, created_at DESC);

COMMENT ON TABLE journey_score_runs IS
  'Append-only history of every completed scoring run for a sale. journeys.overall_score holds the current value; this is the audit trail behind it, so a re-scored compliance score can always be explained.';

-- Backfill the runs we can still account for. Journeys scored before this
-- migration have exactly one recoverable data point — their current score — and
-- we genuinely do not know whether it was re-scored, so these are recorded as
-- run 1 with trigger_source 'initial' and a NULL actor. That is honest: it says
-- "this is where the history starts", not "this sale was scored once".
INSERT INTO journey_score_runs
    (journey_id, organization_id, run_number, overall_score, pass, branch,
     branch_source, model_id, calls_scored, trigger_source, created_at)
SELECT j.id, j.organization_id, 1, j.overall_score, j.pass, j.branch,
       j.branch_source, j.model_id,
       (SELECT count(*) FROM journey_calls jc WHERE jc.journey_id = j.id),
       'initial', COALESCE(j.scored_at, j.updated_at, j.created_at)
  FROM journeys j
 WHERE j.status = 'scored'
   AND NOT EXISTS (SELECT 1 FROM journey_score_runs r WHERE r.journey_id = j.id);
