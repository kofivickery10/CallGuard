-- QA write-back to the tenant's QA module, linked to the sold-customer record
-- (Trust Point: the Customers Sold custom module). The Zoho sale trigger sends
-- the Customers Sold record id + client name; carry them on the journey so
-- score-journey can, once scoring finishes, upsert a QA record linked back to
-- that sold-customer record (services/zoho.ts pushQARecord).
ALTER TABLE journeys
  ADD COLUMN IF NOT EXISTS zoho_record_id TEXT,
  ADD COLUMN IF NOT EXISTS client_name TEXT;

-- New QA field-map shape. CallGuard writes only ONE component of the tenant's
-- QA module — the AI compliance score — plus links the record to the sold
-- customer and (optionally) a free-text summary. The tenant's own formula
-- averages the AI score with their human QA marks. Replaces the previous
-- adviser/month/result/link shape (that pre-dated seeing the real module).
--   score           : the numeric AI score field (Trust Point: AI_Call_Score)
--   client_name     : required name field on the QA record (Trust Point: Name)
--   customer_lookup : lookup to the sold-customer record (Trust Point: Client)
--   notes           : free-text summary field; '' = not configured, skip it
ALTER TABLE zoho_connections
  ALTER COLUMN qa_field_map SET DEFAULT '{
      "score": "AI_Call_Score",
      "client_name": "Name",
      "customer_lookup": "Client",
      "notes": ""
    }'::jsonb;

-- Migrate any existing rows off the old key shape (the old keys reference
-- fields that don't exist on a real QA module, so they were never usable).
UPDATE zoho_connections
   SET qa_field_map = '{
      "score": "AI_Call_Score",
      "client_name": "Name",
      "customer_lookup": "Client",
      "notes": ""
    }'::jsonb
 WHERE qa_field_map ? 'adviser';
