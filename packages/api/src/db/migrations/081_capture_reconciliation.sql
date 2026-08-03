-- Data Forms reconciliation results: per-sale, what the submitted application
-- said versus what the customer actually said on the call.
--
-- RELATIONSHIP TO PART A (capture_runs / capture_answers)
--
-- Part A answers "did the adviser ask the questions on OUR form, and what was
-- said". Reconciliation answers "does the application the insurer received match
-- the call", and it takes its question list from the insurer's own document
-- rather than from a capture form. The two are deliberately separate tables: a
-- tenant can run either alone, the question sets need not agree, and Part A must
-- keep working for insurers whose documents carry no question set at all.
--
-- WHY 'undetermined' IS A FIRST-CLASS OUTCOME
--
-- The call side is read from the stored transcript, and health redaction removes
-- the subject of the question, not just the answer: across 63 transcripts from
-- the first deploying firm, the words diabetes, cancer, stroke, asthma,
-- depression and anxiety appeared zero times, replaced by untyped placeholders.
-- For those questions the absence of a match is NOT evidence the question was
-- skipped.
--
-- Reporting that as 'not_asked' would put a false allegation against an adviser
-- on the record, on the most serious questions in the application, on every
-- sale. So the schema forces the distinction: 'undetermined' means we could not
-- tell, and it must never be presented as either a pass or a miss.
CREATE TABLE IF NOT EXISTS capture_reconciliation_runs (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    journey_id           UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,

    -- pending            : queued
    -- needs_document     : no attachment on the record matched a known profile.
    --                      Includes the ordinary case of the pack not having been
    --                      uploaded yet, so this is a waiting state, not a failure.
    -- needs_profile      : a document was found but its question set does not
    --                      match the stored profile — the insurer changed
    --                      something and a human must confirm the new structure
    --                      before any answer is judged against it.
    -- summary_only       : the document parsed, but carries no question set (a
    --                      unit-based product's summary of key facts). Recorded
    --                      explicitly so a clean result is never mistaken for
    --                      "the health answers matched" when there were none.
    status               TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'running', 'needs_document',
                                               'needs_profile', 'summary_only',
                                               'completed', 'failed')),

    profile_id           UUID REFERENCES capture_document_profiles(id) ON DELETE SET NULL,

    -- Which attachment was read, kept for evidence: a supervisor challenging a
    -- flag needs to know exactly which document it came from, and the pack is
    -- deliberately not retained (see the DPIA), so this is the only pointer back.
    attachment_id        TEXT,
    attachment_name      TEXT,
    document_fingerprint TEXT,

    error_message        TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at         TIMESTAMPTZ
);

-- One live run per sale. Partial so a superseded run can be kept for history.
-- NB: PARTIAL unique index — any ON CONFLICT targeting it must repeat this WHERE
-- predicate verbatim or Postgres raises 42P10.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_runs_journey
  ON capture_reconciliation_runs (journey_id)
  WHERE status <> 'failed';

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_attention
  ON capture_reconciliation_runs (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS capture_reconciliation_items (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id                UUID NOT NULL REFERENCES capture_reconciliation_runs(id) ON DELETE CASCADE,
    sort_order            INTEGER NOT NULL,

    -- The insurer's own wording, kept verbatim: it is what a supervisor or the
    -- insurer will recognise, and it is the evidence that this question existed
    -- on the application at the time of this sale.
    question              TEXT NOT NULL,
    guidance              TEXT,

    -- What the application recorded. NULL where the insurer marked it unanswered.
    application_answer    TEXT,

    -- What the customer said. NULL when not found, or when redaction meant the
    -- value never reached storage — the two are distinguished by outcome, and by
    -- call_answer_redacted below.
    call_answer           TEXT,
    -- True when the question was demonstrably covered on the call but the value
    -- itself was redacted. Distinguishes "we know they answered, we cannot see
    -- what they said" from "we found nothing".
    call_answer_redacted  BOOLEAN NOT NULL DEFAULT false,

    -- match                : the call and the application agree
    -- mismatch             : they disagree — the flag Part B exists for
    -- not_asked            : the application carries an answer, and the call shows
    --                        no sign the question was ever put to the customer.
    --                        The most serious outcome: the form was completed
    --                        without asking.
    -- asked_no_answer      : asked, but the customer never answered, yet the
    --                        application records one
    -- no_application_answer: the insurer recorded no answer for this question
    -- undetermined         : could not be established. See the header comment.
    outcome               TEXT NOT NULL
                              CHECK (outcome IN ('match', 'mismatch', 'not_asked',
                                                 'asked_no_answer',
                                                 'no_application_answer',
                                                 'undetermined')),

    -- Why. For a deterministic outcome this is the matched text and its location,
    -- which is reproducible and inspectable; for a model-assisted one it is the
    -- model's stated reasoning. A flag against an adviser must always be
    -- explainable.
    evidence              TEXT,
    reasoning             TEXT,
    confidence            NUMERIC(3,2),

    -- Where in the recording. Promised to the first client as "evidenced in the
    -- call recording, exact timestamp", and the precedent already exists on
    -- journey_item_scores.source_timestamp.
    source_call_id        UUID REFERENCES calls(id) ON DELETE SET NULL,
    source_timestamp      NUMERIC,

    -- ── The insurer's own audit trail ────────────────────────────────────────
    -- Some portals record every edit to an answer, with a time and the adviser
    -- who made it. The submitted document shows only the end state, so an answer
    -- that was changed is invisible in the final form — yet it is exactly the
    -- signal this feature exists to find.
    --
    -- Observed in real sales: a mental-health answer entered as "Stress" and
    -- changed back to "None of these" within the same minute; "have you ever
    -- stopped taking prescribed treatment without medical advice" changed from
    -- No to Yes; weekly spirits changed from 0 to 2.
    --
    -- An amendment is NOT evidence of anything improper — most are the answer
    -- being corrected as the conversation goes on, which is what should happen.
    -- It is a signal for a supervisor to check against the recording, and it
    -- costs nothing: it comes from the document alone, with no call comparison,
    -- no model, and no exposure to the redaction problem.
    application_answered_at   TEXT,
    application_recorded_by   TEXT,
    answer_amended            BOOLEAN NOT NULL DEFAULT false,
    -- disclosure_withdrawn : something was disclosed and then taken back. The
    --                        one worth surfacing on its own.
    -- disclosure_added     : more was disclosed than at first. Benign.
    -- value_changed        : changed without changing what was disclosed.
    amendment_type            TEXT
                                  CHECK (amendment_type IN ('disclosure_withdrawn',
                                                            'disclosure_added',
                                                            'value_changed')),
    -- The superseded answers, oldest first: [{value, timestamp, recordedBy}].
    revisions                 JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_items_outcome
  ON capture_reconciliation_items (run_id, outcome);

-- The withdrawn-disclosure queue. Partial because it is a small minority of rows
-- and the only amendment type warranting attention on its own.
CREATE INDEX IF NOT EXISTS idx_reconciliation_items_withdrawn
  ON capture_reconciliation_items (run_id)
  WHERE amendment_type = 'disclosure_withdrawn';
