-- Mono recordings (see 038_org_scoring_settings.sql's transcription_mode) have no
-- channel to pin the adviser to, so the agent is guessed as whoever's
-- utterance is first in the file. That's correct for inbound calls (the
-- agent greets first) but backwards for outbound calling, where the customer
-- answers "Hello?" before the agent introduces themselves. This lets a
-- tenant flip the guess to match their call direction.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS mono_first_speaker TEXT NOT NULL DEFAULT 'agent'
    CHECK (mono_first_speaker IN ('agent', 'customer'));
