-- Say what a breach rests on, so a compliance register never asserts more than
-- the evidence supports.
--
-- Trust Point's register currently holds 185 breaches, 154 of which no human
-- has looked at. Of the 20 critical ones, 18 were raised under a branch that
-- was guessed rather than read from their CRM, 17 came from a scoring model
-- since retired, and 14 sit on checkpoints measured to flip between runs on
-- identical evidence. Every one is presented identically to a finding we can
-- fully stand behind.
--
-- The fix is NOT to suppress the shaky ones. Missing a genuine compliance
-- failure is worse than raising an uncertain one, and the data says most of
-- these are probably real — the worst offender ("Obtained a clear 'yes' to the
-- recommendation") fails 9 runs out of 12, which is a likely breach with noise
-- around it, not a coin toss. Suppressing it would hide a real finding three
-- times in four.
--
-- So the finding stays and the certainty is stated. "The adviser failed to
-- obtain consent" becomes "the adviser appears to have failed to obtain
-- consent, on evidence with these specific weaknesses, please confirm".
--
-- Deliberately a separate axis from `status`. Status is the workflow (new ->
-- resolved); this is how much weight the finding can bear. A breach can be
-- unconfirmed and resolved, or caveat-free and untouched.
ALTER TABLE breaches
  ADD COLUMN IF NOT EXISTS evidence_caveats TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN breaches.evidence_caveats IS
  'Why this finding is not settled. Empty = no known weakness. Values: low_agreement (independent scoring runs disagreed), low_confidence (the scorer was unsure), unreliable_speakers (who said what could not be established on the source call), guessed_branch (the sale''s branch was inferred, so the checkpoint may not even apply), retired_model (scored by a model no longer in use).';

-- Human confirmation is the strongest possible standing, and is what a
-- regulated firm should be able to point at. Distinct from resolving a breach:
-- resolving records that it was dealt with, this records that a person agreed
-- it was real.
ALTER TABLE breaches ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE breaches ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- The register view that matters: unconfirmed findings, worst first.
CREATE INDEX IF NOT EXISTS idx_breaches_unconfirmed
  ON breaches(organization_id, severity, detected_at DESC)
  WHERE confirmed_at IS NULL AND array_length(evidence_caveats, 1) > 0;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Everything below is derivable from data already stored, so the existing
-- register gains honest labelling without re-scoring anything. This is the
-- point: a firm can see tonight which of their 185 findings are solid.

-- The sale's branch was inferred rather than read from the CRM, so the
-- checkpoint may not have applied to this sale at all. NULL branch_source means
-- the sale predates provenance tracking (migration 071) — unknown, which for
-- this purpose is not better than guessed.
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'guessed_branch')
  FROM journeys j
 WHERE j.id = b.journey_id
   AND j.branch IS NOT NULL
   AND j.branch_source IS DISTINCT FROM 'crm'
   AND NOT ('guessed_branch' = ANY(b.evidence_caveats));

-- Scored by a model that has since been retired, under the two-pass design
-- whose verify stage truncated silently (migration 073).
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'retired_model')
  FROM journeys j
 WHERE j.id = b.journey_id
   AND j.model_id IS NOT NULL
   AND j.model_id NOT LIKE '%sonnet-5%'
   AND NOT ('retired_model' = ANY(b.evidence_caveats));

-- Who said what could not be established on the call the evidence came from,
-- so any checkpoint turning on speaker identity is unsafe here.
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'unreliable_speakers')
  FROM journey_item_scores jis
  JOIN calls c ON c.id = jis.source_call_id
 WHERE jis.id = b.journey_item_score_id
   AND (c.speaker_integrity_flag IS NOT NULL OR c.speaker_attribution_confidence < 0.5)
   AND NOT ('unreliable_speakers' = ANY(b.evidence_caveats));

-- The scorer itself was unsure. 0.7 is the boundary measured between stable and
-- unstable checkpoints (mean confidence 0.66 on ones that flipped between runs,
-- 0.72 on ones that never did).
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'low_confidence')
  FROM journey_item_scores jis
 WHERE jis.id = b.journey_item_score_id
   AND jis.confidence IS NOT NULL
   AND jis.confidence < 0.7
   AND NOT ('low_confidence' = ANY(b.evidence_caveats));

-- Independent scoring runs disagreed on this verdict (consensus scoring,
-- migration 076). Only present where consensus was actually on.
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'low_agreement')
  FROM journey_item_scores jis
 WHERE jis.id = b.journey_item_score_id
   AND jis.agreement IS NOT NULL
   AND jis.agreement < 1.0
   AND NOT ('low_agreement' = ANY(b.evidence_caveats));

-- The per-call path, same rules where the equivalent data exists.
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'unreliable_speakers')
  FROM call_item_scores cis
  JOIN call_scores cs ON cs.id = cis.call_score_id
  JOIN calls c ON c.id = cs.call_id
 WHERE cis.id = b.call_item_score_id
   AND (c.speaker_integrity_flag IS NOT NULL OR c.speaker_attribution_confidence < 0.5)
   AND NOT ('unreliable_speakers' = ANY(b.evidence_caveats));

UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'low_confidence')
  FROM call_item_scores cis
 WHERE cis.id = b.call_item_score_id
   AND cis.confidence IS NOT NULL
   AND cis.confidence < 0.7
   AND NOT ('low_confidence' = ANY(b.evidence_caveats));
