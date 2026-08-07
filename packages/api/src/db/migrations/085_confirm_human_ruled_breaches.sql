-- Record that a person ruled these breaches, because a person did.
--
-- Migration 078 added confirmed_by/confirmed_at to say "a human agreed this
-- finding is real", explicitly distinct from resolving it (which only records
-- that it was dealt with). The review queue never set them. A reviewer opening
-- a marginal checkpoint, reading the evidence and ruling it a failure is the
-- strongest confirmation the schema models, and it was landing in the register
-- indistinguishable from an AI finding nobody had looked at.
--
-- Two consequences, both live. The unconfirmed-findings view (the index 078
-- created for exactly this purpose) lists breaches a human already settled, so
-- the QA team is asked to confirm decisions they themselves made. And a firm
-- asked which of their findings a person stands behind cannot answer from the
-- register — the one question confirmed_by exists to answer.
--
-- routes/review.ts now stamps both columns on resolve. This backfills the
-- rulings already made, which are fully recoverable: every resolution wrote an
-- audit_log row (action_type 'review.resolve') carrying the reviewer and the
-- timestamp, keyed by the item score id.
--
-- Only breaches that still exist are touched, and a resolution to 'pass'
-- deletes the breach, so anything matched here was necessarily ruled a failure
-- — no need to parse the summary text to work out which way it went. Where a
-- checkpoint was resolved more than once, the most recent ruling wins.
--
-- Idempotent: already-confirmed rows are left alone.

WITH ruling AS (
  SELECT DISTINCT ON (al.entity_id)
         al.entity_id AS item_score_id,
         al.user_id,
         al.created_at
    FROM audit_log al
   WHERE al.action_type = 'review.resolve'
     AND al.entity_type = 'score'
     AND al.user_id IS NOT NULL
   ORDER BY al.entity_id, al.created_at DESC
)
UPDATE breaches b
   SET confirmed_by = r.user_id,
       confirmed_at = r.created_at
  FROM ruling r
 WHERE b.confirmed_at IS NULL
   AND (b.journey_item_score_id::text = r.item_score_id
        OR b.call_item_score_id::text = r.item_score_id);
