-- What the adviser actually DID about each finding (CG-25, Phase 2 of the CG-6
-- scope — docs/remediation-guidance-scope.md §4.3).
--
-- 115 gave a firm a place to say what should be done about a failed checkpoint.
-- Nothing in the product has ever asked whether it was. The loop stopped at
-- "the adviser confirmed they read it", which is an acknowledgement of a
-- message, not an outcome for a customer.
--
-- WHY COLUMNS HERE AND NOT A NEW TABLE
--
-- journey_feedback_items is already the durable per-finding identity: keyed on
-- (feedback_id, scorecard_item_id), snapshotted at send time by 087, and
-- deliberately built to survive a re-score that destroys the breach row
-- underneath it. An outcome is a property of the thing the adviser was told,
-- so it belongs on the row that records the telling. A second table would have
-- to re-derive that identity and would gain nothing by it.
--
-- History does not need a second table either. breach_events is already the
-- per-finding audit trail, and the constraint widened below is the third such
-- widening (006 defined it, 087 added the feedback pair) — the established way
-- this schema records that something happened to a finding.
--
-- WHY THE OUTCOME IS GATED ON CONFIRMATION (enforced in the service, not here)
--
-- sendFeedback DELETEs a previous *unconfirmed* feedback when a supervisor
-- re-sends, and ON DELETE CASCADE takes its items with it. An outcome recorded
-- before acknowledgement would therefore be destroyed by a re-send, silently,
-- with the adviser having no way to know their work was gone. Requiring
-- confirmed_at before any outcome can be written puts the row permanently out
-- of that DELETE's reach — the delete cannot match a confirmed feedback.
--
-- The check lives in services/journey-feedback.ts rather than in a CHECK
-- constraint here because the condition is on the PARENT row, which a row-level
-- CHECK cannot see.

ALTER TABLE journey_feedback_items
  -- Three values, and the third is the one that makes the set honest.
  --
  -- 'done' and 'not_needed' are the two an adviser would invent on their own.
  -- 'customer_unreachable' is the case that would otherwise be recorded as one
  -- of those two or left blank: the adviser tried, repeatedly, and could not
  -- reach the person. A firm that cannot distinguish "we decided no action was
  -- needed" from "we could not reach them" cannot answer the only question the
  -- Ombudsman would ask about it.
  --
  -- NULL means no outcome has been recorded yet — never "nothing was needed",
  -- which is what 'not_needed' says explicitly. Every row written before this
  -- migration is NULL and that is the truthful reading of all of them.
  ADD COLUMN IF NOT EXISTS remediation_outcome TEXT
    CHECK (remediation_outcome IN ('done', 'not_needed', 'customer_unreachable')),

  -- The adviser's own words about what they did. Optional against 'done' and
  -- 'not_needed'; it is what carries the substance of 'customer_unreachable',
  -- where the dates and the number of attempts are the whole evidential value.
  ADD COLUMN IF NOT EXISTS remediation_note TEXT,

  -- When it was recorded, not when the work was done. The adviser may be
  -- describing a call they made last week; this column does not claim
  -- otherwise, and the note is where a real date can be stated.
  ADD COLUMN IF NOT EXISTS remediated_at TIMESTAMPTZ,

  -- The adviser's user row, WHERE THEY HAVE ONE. Nullable and not the identity
  -- of the actor: the token holder is authenticated by the token, and a large
  -- share of advisers have no account at all (061) — Trust Point's have none.
  -- The durable answer to "who recorded this" is journey_feedback.adviser_name
  -- and adviser_email on the parent row, which are snapshotted and never null.
  -- This column is the join back to a live user when there is one to join to.
  ADD COLUMN IF NOT EXISTS remediated_by UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN journey_feedback_items.remediation_outcome IS
  'What the adviser did about this finding: done / not_needed / customer_unreachable (CG-25). NULL means not yet answered, never "no action needed".';
COMMENT ON COLUMN journey_feedback_items.remediation_note IS
  'The adviser''s own account of what they did. Carries the evidence for customer_unreachable — attempts and dates.';
COMMENT ON COLUMN journey_feedback_items.remediated_at IS
  'When the outcome was RECORDED, not when the work was done. The note is where a date for the work itself can be stated.';
COMMENT ON COLUMN journey_feedback_items.remediated_by IS
  'The adviser''s user row where one exists. Nullable by design — the token is the credential and many advisers have no login (061). journey_feedback.adviser_name is the durable identity.';

-- "What has been asked for on this sale and not yet closed?" — the query behind
-- the adviser's own page, and behind the open-remediations reporting in Phase 4.
-- Partial, because answered rows are not what anybody chases.
CREATE INDEX IF NOT EXISTS idx_journey_feedback_items_open_remediation
  ON journey_feedback_items (feedback_id)
  WHERE remediation_outcome IS NULL;

-- Surface the outcome on the breach's own history, so a breach opened from the
-- register shows that it was fed back, acknowledged, AND acted on, without
-- anyone needing to know the sale-level feedback record exists.
--
-- The constraint is found by what it constrains rather than by an assumed name,
-- for the reason 087 spells out: a DROP ... IF EXISTS on a guessed name passes
-- silently and leaves the old constraint in place, so the first
-- remediation_recorded write would fail in production rather than here.
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
                        'feedback_sent', 'feedback_confirmed',
                        -- Appended on every write, not replaced: an adviser who
                        -- revises an outcome leaves both entries, because "said
                        -- done, then said unreachable" is a fact a claims file
                        -- needs and a single mutable column cannot hold.
                        'remediation_recorded'));
