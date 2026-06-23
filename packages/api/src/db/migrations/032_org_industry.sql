-- Per-organisation industry / advice domain.
-- Used to frame the AI scoring prompt so each call is evaluated in the correct
-- regulatory and commercial context (e.g. "FCA-regulated protection insurance
-- advice") instead of the previous hardcoded telecom/broadband assumption.
-- Nullable: organisations without a value fall back to a generic sales/service
-- framing, so this is backwards-compatible with existing orgs.
ALTER TABLE organizations ADD COLUMN industry TEXT;
