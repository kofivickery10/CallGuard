-- Turns the flat scorecard_item model into the spec's checkpoint model:
-- sectioned, branch-aware, AI/manual split, explicit consent gates.
ALTER TABLE scorecard_items
  ADD COLUMN IF NOT EXISTS section TEXT,
  ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'ai'
    CHECK (item_type IN ('ai', 'manual')),
  -- Branch condition, e.g. {"branch": "on_risk"}. NULL/absent = applies to
  -- every branch. Evaluated against the scorecard's resolved branch (see
  -- scorecards.branch_config in 041) before scoring; a non-matching item is
  -- marked 'na' and excluded from the denominator, never sent to Claude.
  ADD COLUMN IF NOT EXISTS applies_when JSONB,
  -- Explicit expectation text fed to the model, distinct from the free-text
  -- `description` rubric — lets a checkpoint state precisely what must be
  -- present ("adviser reads the ICOBS demands-and-needs statement verbatim
  -- or in substance") separately from scoring guidance.
  ADD COLUMN IF NOT EXISTS expectation TEXT,
  -- Presence-and-meaning check instruction for regulatory statements: what
  -- the model should verify beyond a keyword match (spec §8.5).
  ADD COLUMN IF NOT EXISTS ai_check TEXT,
  -- Consent gates require an explicit customer affirmative — the scorer is
  -- barred from inferring consent from context, and (see services/scoring.ts)
  -- the evidence utterance must be attributed to the customer above the
  -- speaker-confidence floor or the item is routed to manual_review.
  ADD COLUMN IF NOT EXISTS consent_gate BOOLEAN NOT NULL DEFAULT false;

-- Per-checkpoint result state + timestamp (spec §8.7). NA and manual_review
-- are terminal states that never go through Claude scoring and are excluded
-- from the weighted denominator (see services/scoring.ts / jobs/processors/score.ts).
ALTER TABLE call_item_scores
  ADD COLUMN IF NOT EXISTS result TEXT
    CHECK (result IN ('pass', 'fail', 'na', 'manual_review')),
  ADD COLUMN IF NOT EXISTS source_timestamp NUMERIC;

-- na / manual_review checkpoints never get a numeric score — they are excluded
-- from the weighted denominator entirely. The original schema declared these
-- NOT NULL (every row was an auto-scored pass/fail), so relax them or the
-- checkpoint-model inserts (score.ts) raise 23502 and roll back the whole run.
ALTER TABLE call_item_scores
  ALTER COLUMN score DROP NOT NULL,
  ALTER COLUMN normalized_score DROP NOT NULL;

-- Backfill: existing rows were always auto-scored pass/fail, derived from
-- normalized_score against the (pre-existing) 70 pass threshold.
UPDATE call_item_scores SET result = CASE WHEN normalized_score >= 70 THEN 'pass' ELSE 'fail' END
  WHERE result IS NULL;

-- How reliable the adviser/customer speaker split is for this call (0-1, see
-- services/transcription.ts) — deterministic (1.0) when a per-tenant stereo
-- channel is pinned, a heuristic guess otherwise. consent_gate items are
-- routed to manual_review rather than auto-scored when this is low, since a
-- mislabelled speaker on a consent checkpoint is a false-pass risk (spec §6).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS speaker_attribution_confidence NUMERIC(3,2);
