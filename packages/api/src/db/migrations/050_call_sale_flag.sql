-- Lets an uploader flag a manually-uploaded call as having resulted in a
-- sale, for 'sales_only' tenants that otherwise only score once a CRM sale
-- trigger fires (see services/journey.ts, jobs/processors/transcribe.ts).
-- Read once, right after transcription completes, to assemble & score a
-- journey the same way the Zoho sale-trigger webhook would.
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS sale_flagged BOOLEAN NOT NULL DEFAULT false;
