-- Explicit "the Zoho sale trigger is configured" flag, decoupled from the
-- inbound signing secret. Previously the presence of inbound_secret_encrypted
-- doubled as the signal that a working sale trigger exists (see
-- services/tenant-settings.ts hasUsableSaleTrigger), which gates sales_only
-- metadata capture. That coupling forced HMAC signing: to turn capture on you
-- had to set a secret, and once a secret is set the sale-trigger endpoint
-- rejects any unsigned request.
--
-- Zoho's plain workflow Webhook action can't compute an HMAC, so this flag
-- lets an org run the trigger API-key-only: capture activates when the
-- connection is active AND (a secret is set OR this flag is on). Signature
-- enforcement stays keyed on the secret's presence (verifyInboundSaleSignature),
-- so setting a secret is still the opt-in to the stronger HMAC check.
ALTER TABLE zoho_connections
  ADD COLUMN IF NOT EXISTS sale_trigger_enabled BOOLEAN NOT NULL DEFAULT false;
