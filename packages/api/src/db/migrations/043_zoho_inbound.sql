-- Inbound Zoho sale trigger + a QA custom-module write-back, alongside the
-- existing outbound Leads/Contacts push (spec §9/§11).
ALTER TABLE zoho_connections
  -- Verifies the inbound "deal marked as sale" webhook. NULL = trigger not
  -- configured; the inbound route rejects until this is set.
  ADD COLUMN IF NOT EXISTS inbound_secret_encrypted TEXT,
  -- Which field on the sale payload carries the customer's phone number —
  -- the journey-assembly key (spec §9.2).
  ADD COLUMN IF NOT EXISTS sale_phone_field TEXT NOT NULL DEFAULT 'Phone',
  -- Custom QA module API name (e.g. "CallGuard_QA"). NULL = not configured;
  -- QA write-back is skipped (best-effort, like the rest of the Zoho path).
  ADD COLUMN IF NOT EXISTS qa_module TEXT,
  -- API names of the fields on the QA module CallGuard writes to: adviser,
  -- month, score, result, journey link — lets Trust Point filter QA records
  -- by adviser + month for commission-tied averages.
  ADD COLUMN IF NOT EXISTS qa_field_map JSONB NOT NULL DEFAULT '{
      "adviser": "Adviser_Name",
      "month": "Period",
      "score": "Compliance_Score",
      "result": "Compliance_Result",
      "link": "CallGuard_Link"
    }'::jsonb;

-- `module` (the customer-record target) keeps its existing Leads/Contacts
-- CHECK — the QA module above is a separate, unconstrained free-text field
-- validated in application code, since custom module API names vary per org.
