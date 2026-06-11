-- Calls too short to score meaningfully (wrong numbers, voicemails, instant
-- hangups) get a dedicated 'skipped' status. This keeps them out of scored
-- stats, agent averages and breaches WITHOUT counting them as processing
-- failures (which would skew the failure metric and fire failure alerts).

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;

ALTER TABLE calls
  ADD CONSTRAINT calls_status_check
  CHECK (status IN ('uploaded', 'transcribing', 'transcribed', 'scoring', 'scored', 'skipped', 'failed'));
