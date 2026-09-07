-- What the adviser was actually told, not merely which sale it was about.
--
-- 087 snapshots the findings because a record saying only "this sale was fed
-- back" becomes a lie the moment the sale is re-scored and its breach set
-- changes. The email now asserts considerably more than a list of labels: a
-- score, a pass/fail verdict, a named client, and the model's reason under each
-- finding. Every one of those is recomputed by a re-score exactly as the breach
-- set is, so the same argument applies to all of them. The acknowledgement is
-- evidence of what was in front of the adviser when they clicked, and the record
-- has to hold that rather than a live join to values that have since moved.
--
-- A live re-join is not merely unreliable, it is impossible. breaches.
-- journey_item_score_id is ON DELETE CASCADE (042), and score-journey deletes
-- both breaches and journey_item_scores for the journey on every run — so the
-- reasoning row and the breach row are both gone, and journey_feedback_items.
-- breach_id has already gone NULL through its own ON DELETE SET NULL.

ALTER TABLE journey_feedback
  -- The sale as it was NAMED IN THE EMAIL. journeys.client_name is null on every
  -- sale pushed before the CRM backfill (Trust Point's Zoho workflow sends only
  -- id and Phone), so the value may have come from customers.name instead.
  -- Recording what was resolved keeps the record honest about what was read.
  ADD COLUMN IF NOT EXISTS client_name        TEXT,
  -- The score and verdict AS STATED. NULL where the email stated none: a sale
  -- held at nothingAutoScored has findings but no number, and a tenant on
  -- score_only is never shown a verdict. NULL here means "not asserted" — never
  -- zero, and never "failed".
  ADD COLUMN IF NOT EXISTS score              NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS pass               BOOLEAN,
  -- True where findings carried reasoning that policy deliberately kept out of
  -- the email: the tenant keeps health (phi) unredacted, so the model's sentence
  -- may quote a health disclosure in the clear and email is not an appropriate
  -- channel for it (DPIA R5). NOT NULL DEFAULT false backfills every existing
  -- row to "nothing was withheld", which is the truthful reading of every record
  -- written before this change.
  ADD COLUMN IF NOT EXISTS reasoning_withheld BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN journey_feedback.reasoning_withheld IS
  'The findings carried reasoning deliberately kept out of the email because the tenant keeps health unredacted (DPIA R5). Distinguishes a withheld reason from an absent one.';

ALTER TABLE journey_feedback_items
  -- The reason AS IT WAS SENT, copied for the same purpose item_label is copied
  -- in 087: the record of what someone was told must not change afterwards.
  --
  -- Populated ONLY when it actually travelled. This is not a mirror of
  -- journey_item_scores.reasoning for its own sake — storing a reason that was
  -- never disclosed would make this table assert something that did not happen,
  -- and would duplicate special-category text no adviser ever received.
  --
  -- Read alongside journey_feedback.reasoning_withheld, the three states are
  -- unambiguous:
  --   reasoning NOT NULL                      -> that exact text was sent
  --   reasoning NULL, withheld = false        -> the finding had no reason
  --   reasoning NULL, withheld = true         -> there was one, policy suppressed it
  ADD COLUMN IF NOT EXISTS reasoning TEXT;

COMMENT ON COLUMN journey_feedback_items.reasoning IS
  'The model reason as it appeared in the feedback email, frozen at send time. NULL where the finding had no reason, or where journey_feedback.reasoning_withheld is true.';
