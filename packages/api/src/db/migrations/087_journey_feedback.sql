-- Feeding a reviewed sale back to the adviser, and recording that they saw it.
--
-- The workflow this serves: a supervisor reviews a scored sale, overturns any
-- checkpoints the model got wrong, and then tells the adviser what stands. Until
-- now that conversation left no trace in the system — the Review Queue's
-- "Coached" button sets a breach status and notifies nobody, and there was no
-- record that the adviser was ever told, let alone that they acknowledged it.
--
-- WHY THIS IS PER SALE, NOT PER BREACH
--
-- An adviser is fed back on a sale, once, covering everything found on it. Six
-- separate emails for six checkpoints on the same call is not how the
-- conversation happens, and six separate confirmations prove less than one.
--
-- WHY THE BREACHES ARE SNAPSHOTTED
--
-- 077 exists because rulings were keyed to journey_item_scores, which are
-- dropped and recreated on every scoring run, so a re-score erased them. A
-- feedback record that says only "this sale was fed back" has the same flaw from
-- the other direction: re-score the sale, the breach set changes, and the record
-- now implies the adviser was told about findings that did not exist when the
-- email was sent. So the items are captured at send time and keyed on
-- (journey_id, scorecard_item_id) — the durable identity of a checkpoint on a
-- sale, which survives any number of re-scores.

CREATE TABLE IF NOT EXISTS journey_feedback (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    journey_id           UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,

    -- Who it went to. Snapshotted rather than derived on read: the adviser is
    -- resolved from the sale's closing call, and re-attribution or a corrected
    -- speaker mapping could later point somewhere else. The record must keep
    -- saying who was actually told.
    adviser_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    adviser_name         TEXT NOT NULL,
    adviser_email        TEXT NOT NULL,

    sent_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- What the supervisor added in their own words, if anything.
    message              TEXT,

    -- One-click confirmation. Same at-rest pattern as invite_tokens and
    -- refresh_tokens: the link carries an opaque random token, only its SHA-256
    -- lands here, so a database leak cannot be used to forge a confirmation.
    --
    -- An adviser may have no login at all (061), so the confirm endpoint is
    -- unauthenticated by necessity — the token IS the authentication, which is
    -- why it is single-use and time-bound.
    token_hash           TEXT NOT NULL UNIQUE,
    token_expires_at     TIMESTAMPTZ NOT NULL,

    confirmed_at         TIMESTAMPTZ,
    -- Kept for the confirmation's evidential weight, not for tracking.
    confirmed_ip         TEXT,
    confirmed_user_agent TEXT,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one outstanding feedback per sale. A superseded one (confirmed, or
-- expired and re-sent) is kept for history, so this is partial rather than a
-- plain unique on journey_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_feedback_open
  ON journey_feedback (journey_id)
  WHERE confirmed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_journey_feedback_journey
  ON journey_feedback (journey_id, sent_at DESC);

-- "What has this adviser been told, and did they acknowledge it?"
CREATE INDEX IF NOT EXISTS idx_journey_feedback_adviser
  ON journey_feedback (organization_id, adviser_user_id, sent_at DESC);

-- What the adviser was actually told, frozen at send time. See the header.
CREATE TABLE IF NOT EXISTS journey_feedback_items (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    feedback_id          UUID NOT NULL REFERENCES journey_feedback(id) ON DELETE CASCADE,

    -- The durable identity of a checkpoint on a sale. NOT the breach row id:
    -- breaches are recreated by a re-score, and this record must still be able
    -- to say what was fed back after one.
    scorecard_item_id    UUID NOT NULL REFERENCES scorecard_items(id),

    -- Copied, not joined. The scorecard can be edited or a checkpoint retired,
    -- and the record of what someone was told must not silently change wording
    -- afterwards.
    item_label           TEXT NOT NULL,
    severity             TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
    -- The breach as it stood when sent, for the same reason.
    breach_id            UUID REFERENCES breaches(id) ON DELETE SET NULL,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (feedback_id, scorecard_item_id)
);

CREATE INDEX IF NOT EXISTS idx_journey_feedback_items_feedback
  ON journey_feedback_items (feedback_id);

-- Surface the two new events on each breach's own history as well, so a breach
-- opened from the register shows that it was fed back and acknowledged without
-- anyone having to know the sale-level record exists.
--
-- The inline CHECK from 006 is autonamed, so it is found by what it constrains
-- rather than by an assumed name: a DROP ... IF EXISTS on a guessed name would
-- pass silently and leave the old constraint in place, and the first
-- feedback_sent write would fail in production rather than here.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  FOR con_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'breach_events'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%status_changed%'
  LOOP
    EXECUTE format('ALTER TABLE breach_events DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

ALTER TABLE breach_events
  ADD CONSTRAINT breach_events_event_type_check
  CHECK (event_type IN ('status_changed', 'assigned', 'note_added', 'reopened',
                        'feedback_sent', 'feedback_confirmed'));
