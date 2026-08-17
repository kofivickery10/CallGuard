-- Partial-journey coverage detection (docs/partial-journey-detection.md).
--
-- Journey bf7120bc (Trust Point, "Jimara Lewis") scored 20.51% with 31
-- breaches off a single 6m30s closing call — the scorer said so itself, in
-- free text thrown away by every downstream consumer: "the visible
-- transcript begins mid-process at the wrap-up stage, likely because the
-- fact find and intro occurred in an earlier, unprovided call." What reached
-- the tenant was a bare 20.51%, presented identically to a sale scored on
-- complete evidence.
--
-- The fix is not to hide the score (a genuinely non-compliant adviser
-- produces the same checkpoint shape as a missing first call — suppressing
-- on structure alone would mask real misconduct) or to recompute it
-- (dropping unevidenced checkpoints asserts compliance nobody has evidence
-- for). Score as now, but state what the score rests on.
--
-- Phase 1 only (spec §6): detect and persist on every new scoring run.
-- Nothing downstream reacts to this column yet — no breach caveat, no UI, no
-- aggregate exclusion, no Zoho suppression. Those are gated behind measuring
-- how often 'partial' fires and whether it agrees with the structural signal.
--
-- Backfill: deliberately none. The model signal cannot be recovered without
-- re-scoring, so historical journeys are left NULL ("never assessed") rather
-- than 'unknown' ("assessed, inconclusive") — the two must stay
-- distinguishable.
ALTER TABLE journeys
  ADD COLUMN IF NOT EXISTS coverage TEXT
    CHECK (coverage IN ('complete', 'partial', 'unknown')),
  ADD COLUMN IF NOT EXISTS coverage_missing_stages TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS coverage_rationale TEXT;

COMMENT ON COLUMN journeys.coverage IS
  'Whether this journey''s captured calls look like the complete sale (docs/partial-journey-detection.md). partial = the model judged the evidence starts mid-conversation, i.e. an earlier call in this sale was likely never captured; unknown = the model judged it complete but structural signals (front-fail/back-pass shape, no prior customer history, single-call sale below the tenant median) disagree, logged for tuning; complete = model and structure agree the evidence is whole. NULL = never assessed (journey predates this feature, or the assessment failed on its scoring run).';
COMMENT ON COLUMN journeys.coverage_missing_stages IS
  'Sale stages (e.g. intro, fact_find, regulatory_disclosures) the model judged missing from the captured calls. Empty unless coverage = partial.';
COMMENT ON COLUMN journeys.coverage_rationale IS
  'The model''s stated evidence for its coverage judgement (1-2 sentences), with a note appended when the structural signal did not corroborate a partial verdict.';

-- New breach evidence caveat (extends the enum in
-- packages/shared/src/types/breaches.ts, precedent: migration 078). Added
-- here alongside the schema per spec §4; NOT yet applied to any breach —
-- wiring it into breachCaveats() in jobs/processors/score-journey.ts is
-- explicitly Phase 2 (spec §5.1, §6).
COMMENT ON COLUMN breaches.evidence_caveats IS
  'Why this finding is not settled. Empty = no known weakness. Values: low_agreement (independent scoring runs disagreed), low_confidence (the scorer was unsure), unreliable_speakers (who said what could not be established on the source call), unattributed_evidence (the scorer cited no particular call on a multi-call sale), guessed_branch (the sale''s branch was inferred, so the checkpoint may not even apply), retired_model (scored by a model no longer in use), incomplete_journey (the sale''s earlier calls are missing, so this checkpoint may have been met on a call CallGuard never saw — not yet applied, see docs/partial-journey-detection.md).';
