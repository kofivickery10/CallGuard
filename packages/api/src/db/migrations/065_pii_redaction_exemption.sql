-- Per-tenant redaction exemption for personal/health data (Data Capture value
-- reconciliation — comparing what a customer actually said on a call to what
-- was submitted on their behalf, e.g. to an insurer).
--
-- Deepgram's phi/identity redaction runs over the whole call transcript before
-- any concept of "which capture-form question is this" exists — there is no
-- per-question redaction toggle. Exempting a single underwriting answer from
-- redaction is therefore only possible by exempting the WHOLE call, and the
-- earliest point that decision can be made is transcription time, before a
-- call is linked to any journey or capture form. This is an org-wide flag:
-- every call for an opted-in org keeps its raw health and identity
-- disclosures in the stored transcript, not just the ones a capture form
-- later reconciles.
--
-- pci and numbers redaction are NOT covered by this flag and can never be
-- disabled — see services/transcription.ts. Card/bank data has no legitimate
-- reason to exist unredacted in this system, DPIA or not.
--
-- Superadmin-only (routes/superadmin.ts), not tenant self-serve: switching
-- this on is a joint CallGuard/tenant compliance decision requiring a DPIA.
-- The note column is a mandatory, durable record of what authorised the
-- exposure (DPIA reference, approver) — enforced at the route, not here.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS pii_redaction_exempt BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pii_redaction_exempt_note TEXT;
