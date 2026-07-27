-- Three related gaps that let a sale be scored against the wrong checkpoints
-- without anything saying so. All surfaced by one Trust Point sale scored at
-- 39.53% under a branch it never belonged to.
--
-- 1. Branch provenance. resolveBranch matched literal phrases against the
--    transcript and, on no match, silently returned branches[0]. An adviser who
--    said "we'll leave it to the medical underwriter now" instead of the
--    configured "referred for underwriting" scored as on_risk: the Trust and
--    Direct-Debit-on-risk items were raised as breaches on a policy that was
--    never on risk, and the referred items were marked n/a. Nothing recorded
--    that the branch had been guessed.
--
-- 2. Verify-pass status. The Sonnet second opinion on critical/high breaches is
--    wrapped in a try/catch that logs and continues. When it throws, every
--    critical breach on the sale is an unverified first-pass Haiku verdict and
--    the UI presents it identically to a verified one.
--
-- 3. Speaker-attribution integrity. Recorded as a bare confidence number, with
--    no record of WHY it was lowered, so a transcript whose Agent/Customer
--    labels were detected as unreliable looks the same as one that was never
--    checked.

-- ── 1. Branch provenance ────────────────────────────────────────────────────

-- The API name of the stage/status field on the policies related list (Zoho
-- Deals' "Stage"). Read alongside policy_product_field on the same related-list
-- GET, so this costs no extra CRM call. NULL = not configured; branch
-- resolution then falls back to transcript keywords as before.
ALTER TABLE zoho_connections ADD COLUMN IF NOT EXISTS policy_stage_field TEXT;

-- Zoho Deals always expose the standard "Stage" picklist, so any tenant already
-- reading policies off a Deals related list can use it immediately. Tenants on a
-- custom module are left NULL for an admin to set explicitly.
UPDATE zoho_connections
   SET policy_stage_field = 'Stage'
 WHERE policy_stage_field IS NULL
   AND policies_related_list = 'Deals';

-- The raw stage value the CRM reported, kept verbatim for audit and so a
-- re-score doesn't need to re-hit the CRM. NULL = never resolved.
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS crm_stage TEXT;

-- How `branch` was decided. NULL for journeys scored before this migration
-- (provenance genuinely unknown — not the same as 'default', which is a
-- positive record that nothing matched).
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS branch_source TEXT
  CHECK (branch_source IN ('crm', 'keyword', 'default'));

-- A sale the customer never took up (Zoho "Referred - NTU" and friends) is not
-- a sale: scoring it puts breaches on the register for business that never
-- existed. Assembly skips those outright, but a journey created before the
-- stage moved to NTU — or re-scored afterwards — needs a terminal state that
-- says so, rather than being scored anyway or misfiled as 'failed'.
ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_status_check;
ALTER TABLE journeys ADD CONSTRAINT journeys_status_check
  CHECK (status IN ('pending', 'scoring', 'scored', 'failed', 'skipped'));

-- ── 2. Verify-pass status ───────────────────────────────────────────────────

-- 'ok'      — the second opinion ran; flagged breaches are verified.
-- 'skipped' — nothing met the critical/high bar, so there was nothing to verify.
-- 'failed'  — the pass errored; the breaches below are unverified first-pass
--             output and must be presented as such.
-- NULL      — scored before this migration.
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS verify_status TEXT
  CHECK (verify_status IN ('ok', 'skipped', 'failed'));
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS verify_error TEXT;

ALTER TABLE calls ADD COLUMN IF NOT EXISTS verify_status TEXT
  CHECK (verify_status IN ('ok', 'skipped', 'failed'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS verify_error TEXT;

-- Superadmin ops view: find sales whose breach register was never verified.
CREATE INDEX IF NOT EXISTS idx_journeys_verify_failed
  ON journeys(organization_id, scored_at DESC)
  WHERE verify_status = 'failed';

-- ── 3. Speaker-attribution integrity ────────────────────────────────────────

-- Why the stored speaker_attribution_confidence is what it is — e.g.
-- 'inverted_labels', 'perfect_alternation', 'role_marker_conflict'. NULL means
-- no integrity problem was detected. Diagnostic only; the confidence number
-- remains the value scoring gates on.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS speaker_integrity_flag TEXT;
