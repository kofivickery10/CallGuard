-- Adviser feedback on a reviewed CALL, on the same record as feedback on a sale.
--
-- 087 built feedback per sale, because a sale is what a firm set to sales_only
-- scores. A firm whose scoring setting is not sales_only scores calls on their
-- own as well, and until now had no way to tell the adviser
-- about it, record that they saw it, or ask what they did about it. The
-- adviser's half of the loop (the token, the confirmation, the outcomes, the
-- snapshot of what was said) never depended on the subject being a sale, so the
-- subject is widened here rather than a second set of tables grown beside it.
--
-- WHY GENERALISE RATHER THAN ADD call_feedback TABLES
--
-- Two sets of tables would mean two confirmation endpoints, two definitions of
-- an open remediation, and a backlog that has to UNION them and keep the union
-- honest forever. This is the same move 042 made on breaches: one record that
-- names either subject. (The name call_feedback is also already taken — 008
-- uses it for a client's star rating on a shared call, which is a different
-- thing entirely.) The table keeps its name; it now covers both.
--
-- WHY EXACTLY ONE, NOT AT LEAST ONE
--
-- 042 allows a breach to carry both ids. A feedback round must not: a call that
-- belongs to a sale is fed back from the sale, which covers every call in it,
-- and a row naming both would be a round that counts towards two backlogs and
-- two acknowledgement states at once. The service refuses that case before it
-- gets here; the constraint makes the refusal something the schema holds too.

-- FAIL FAST RATHER THAN QUEUE INGEST. Adding a foreign key to calls takes a
-- lock on calls that blocks writes to it until this file commits. The DDL itself
-- is quick — journey_feedback is small and the new column is empty — but the
-- lock has to WAIT for any open transaction touching calls, and while it waits
-- every ingest, transcription and scoring write to calls queues behind it. A
-- long worker transaction would turn a one-second migration into an outage.
--
-- migrate.ts runs each file in its own transaction, so SET LOCAL scopes this to
-- the file and ends with it. If it times out ("canceling statement due to lock
-- timeout"), the whole file has rolled back and nothing is applied: simply
-- re-run `npm run migrate`, ideally when the worker is quiet. Do not raise the
-- timeout to get past it; that reintroduces the queue it exists to prevent.
SET LOCAL lock_timeout = '5s';

ALTER TABLE journey_feedback
  ALTER COLUMN journey_id DROP NOT NULL;

ALTER TABLE journey_feedback
  -- CASCADE, for the deliberate policy paths that remove a call: the retention
  -- purge (jobs/processors/retention-purge.ts), and the operator-run erasure of
  -- everything held about one data subject (scripts/delete-customer-data.ts).
  -- Once policy says the call goes, the record of what was said about it goes
  -- too; keeping it would retain the personal data the policy removed.
  --
  -- NOT so that an ordinary delete can take it. A tenant admin deleting a
  -- single call would otherwise erase the adviser's confirmation and their
  -- recorded outcomes with it, so DELETE /api/calls/:id refuses a call that has
  -- been fed back (routes/calls.ts). This is not "matching sales" either:
  -- tenants cannot delete a sale at all, and retention is the only path that
  -- removes one outside an operator script.
  ADD COLUMN IF NOT EXISTS call_id UUID REFERENCES calls(id) ON DELETE CASCADE;

ALTER TABLE journey_feedback DROP CONSTRAINT IF EXISTS journey_feedback_subject_check;
ALTER TABLE journey_feedback
  ADD CONSTRAINT journey_feedback_subject_check
  CHECK (num_nonnulls(journey_id, call_id) = 1);

-- At most one OUTSTANDING round per call.
--
-- This is the index that must not be missed. 087's idx_journey_feedback_open is
-- unique on journey_id, and Postgres treats every NULL as distinct from every
-- other — so on call rows that index still exists, still passes, and enforces
-- nothing. Without this one a double-clicked send, or two supervisors sending at
-- once, could leave a call with two live links, and the re-send DELETE (which
-- relies on there being at most one) would stop describing the table.
--
-- `call_id IS NOT NULL` in the predicate is not redundant with the column: it
-- keeps sale rows out of the index entirely rather than filling it with NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_feedback_open_call
  ON journey_feedback (call_id)
  WHERE confirmed_at IS NULL AND call_id IS NOT NULL;

-- "The latest round on this call" — the supervisor's panel and the re-score
-- guard both read it, the same way idx_journey_feedback_journey serves a sale.
CREATE INDEX IF NOT EXISTS idx_journey_feedback_call
  ON journey_feedback (call_id, sent_at DESC);

COMMENT ON TABLE journey_feedback IS
  'A round of feedback to an adviser on a reviewed subject: a sale (journey_id) or a call scored on its own (call_id), exactly one of the two. A call that belongs to a sale is fed back from the sale.';
COMMENT ON COLUMN journey_feedback.call_id IS
  'The call this round is about, at a firm whose scoring setting is not sales_only. NULL on a sale round. Mutually exclusive with journey_id (journey_feedback_subject_check).';
