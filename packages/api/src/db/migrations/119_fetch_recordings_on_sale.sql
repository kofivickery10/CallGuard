-- Download a firm's call recordings only when a sale comes in, as its own
-- setting rather than something inferred from the Zoho connection.
--
-- Ruled by the product owner on 17 September 2026: organizations.scoring_scope
-- alone decides whether a firm scores sales or calls. Until now three places
-- (the transcription job, the CloudTalk webhook and the stuck-work check) also
-- asked whether the firm had a working Zoho sale trigger, and quietly scored
-- every call on its own when it did not. Zoho is a CRM integration built for
-- one client. It is not the signal for how a firm is scored, and a sales_only
-- firm whose sales arrive another way (the in-app "Score sale", the upload
-- "this call is a sale" flag, another CRM) was being scored call by call
-- without anyone choosing that.
--
-- WHY THIS IS A SEPARATE SETTING AND NOT PART OF scoring_scope: the two
-- behaviours the Zoho test used to switch together carry different risks.
--   * Holding a call's score until a sale arrives keeps the transcript. If the
--     sale never comes, the call can still be scored later.
--   * Not downloading the recording until a sale arrives keeps only the
--     dialler's pointer to it. If the sale comes after the dialler's own
--     retention has expired, the recording is gone for good.
-- The second is a data-handling decision a firm makes on purpose (nothing but
-- metadata reaches CallGuard until a customer buys), so it gets its own
-- switch, set by CallGuard staff beside scoring_scope.
--
-- It only makes sense for a firm that scores sales: a firm scoring every call
-- needs every recording. The CHECK below holds that in the database as well as
-- in the superadmin route that sets it.
--
-- WHY THE BACKFILL: it preserves what every live tenant does today. The rows
-- set to true are exactly those that currently get metadata-only capture —
-- sales_only with an active Zoho connection carrying a signing secret or a
-- ticked sale trigger (the rule services/tenant-settings.ts hasUsableSaleTrigger
-- applied before this change). Everyone else keeps downloading recordings as
-- they arrive.
--
-- Cheap on a live table: since Postgres 11, adding a column with a constant
-- default is a catalogue change, not a table rewrite. The UPDATE touches only
-- the handful of organisations that qualify, and the CHECK scans a table of a
-- few rows.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS fetch_recordings_on_sale BOOLEAN NOT NULL DEFAULT false;

UPDATE organizations o
   SET fetch_recordings_on_sale = true
 WHERE o.scoring_scope = 'sales_only'
   AND EXISTS (
     SELECT 1 FROM zoho_connections z
      WHERE z.organization_id = o.id
        AND z.status = 'active'
        AND (z.inbound_secret_encrypted IS NOT NULL OR z.sale_trigger_enabled = true)
   );

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_fetch_recordings_on_sale_scope_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_fetch_recordings_on_sale_scope_check
  CHECK (NOT fetch_recordings_on_sale OR scoring_scope = 'sales_only');

COMMENT ON COLUMN organizations.fetch_recordings_on_sale IS
  'Only for scoring_scope = sales_only. true: a dialler webhook records the call''s metadata and the recording is downloaded only when a sale for that customer arrives (a recording the dialler has already deleted by then cannot be recovered). false (default): every recording is downloaded and transcribed as it arrives.';
