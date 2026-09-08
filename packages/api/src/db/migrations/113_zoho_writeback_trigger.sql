-- When the Zoho write-back fires: automatically on scoring, or when a human
-- presses Feedback (CG-4).
--
-- Raised by Trust Point (Joey Crone, 26 August 2026): "Rather than the call
-- being scored and sent straight to zoho automatically. Could the trigger for
-- the zoho record creation be the point where I hit the feedback button?"
--
-- WHY THIS IS A SETTING AND NOT A CHANGE: the ask is a good one — it puts a
-- person between an AI output and a record that feeds an adviser commission
-- process, which is the strongest answer to any automated-decision question a
-- compliance officer can ask. But it is a preference, not a truth. A firm with
-- higher volume and a downstream process that expects the record to exist the
-- moment a sale is scored is not wrong, and moving them would silently stop
-- records arriving until someone noticed. So it is per-tenant.
--
-- WHY THE DEFAULT IS 'on_scoring': it is what every existing tenant does today.
-- A default of 'on_feedback' would change live behaviour for every firm on the
-- platform on deploy, and the failure mode is silent — no error, records simply
-- stop appearing in their CRM until a human happens to press a button nobody
-- told them was now required.
--
-- Scoring itself is UNAFFECTED either way. This gates only the CRM write-back;
-- sales are still scored automatically off the sale trigger.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS zoho_writeback_trigger TEXT NOT NULL DEFAULT 'on_scoring';

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_zoho_writeback_trigger_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_zoho_writeback_trigger_check
  CHECK (zoho_writeback_trigger IN ('on_scoring', 'on_feedback'));

COMMENT ON COLUMN organizations.zoho_writeback_trigger IS
  'on_scoring: push to Zoho as soon as a sale is scored (default, and the historic behaviour). on_feedback: hold the push until a supervisor sends feedback, so nothing reaches the CRM unreviewed.';

-- The QA record this round of feedback wrote, so a re-send appends rather than
-- overwrites — and so a RETRY of the same round does neither.
--
-- The existing write-back upserts: it looks up a QA record by the sold-customer
-- lookup and PUTs it, so a sale has exactly one QA record however many times it
-- is re-scored. That is right for a score being corrected — there is one sale
-- and one current verdict — but wrong for feedback, where each round is a
-- separate event: this is what the adviser was told, on this date, about this
-- version of the score. Flattening two rounds into one record loses the first
-- conversation entirely.
--
-- So each feedback round gets its own QA record, and this column is what makes
-- that safe. Without it "append on feedback" would mean "append on every push",
-- and the delivery layer retries: a transient Zoho failure would leave two
-- records for one round, silently double-counting in a tenant's QA average.
-- With it the rule is exact — no id yet, create one and record it; id already
-- present, update that record.
ALTER TABLE journey_feedback
  ADD COLUMN IF NOT EXISTS zoho_qa_record_id TEXT;

COMMENT ON COLUMN journey_feedback.zoho_qa_record_id IS
  'The Zoho QA record this feedback round created. NULL when nothing has been pushed for it yet (or the tenant has no QA module). Makes a re-push of the same round an update rather than a duplicate.';

-- Which feedback round a queued write-back belongs to.
--
-- zoho_deliveries is replayed on retry: retryZohoDelivery rebuilds the push
-- from the stored row, not from the call site's local state. So the round has
-- to be ON the row. Without it a retried delivery would silently fall back to
-- the sale-wide upsert and overwrite whichever QA record it found — turning a
-- transient network failure into a lost feedback round, which is the exact
-- outcome the column above exists to prevent.
--
-- NULL on every existing row and on every push that is not releasing feedback,
-- which is the truthful reading: those deliveries are sale-scoped.
ALTER TABLE zoho_deliveries
  ADD COLUMN IF NOT EXISTS feedback_id UUID REFERENCES journey_feedback(id) ON DELETE SET NULL;

COMMENT ON COLUMN zoho_deliveries.feedback_id IS
  'The journey_feedback round this delivery is releasing, so a retry stays scoped to that round. NULL for sale-scoped pushes (the default trigger).';
