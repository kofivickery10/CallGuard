-- Stop the register asserting clean provenance on evidence it cannot show.
--
-- Migration 078 gave every breach the specific weaknesses behind it, so a
-- compliance register never claims more than its evidence supports. It has a
-- hole: the unreliable_speakers rule joins journey_item_scores to the call the
-- evidence came from, and that join is an INNER one. A checkpoint whose
-- source_call_id is NULL matched no row, gained no caveat, and therefore reads
-- as '{}' — "no known weakness".
--
-- The live scorer had the same gap for the same reason (the caveat test was
-- guarded on `sourceCallId &&`), so this was not only historical.
--
-- Unknown provenance was scoring better than known-bad provenance. On Trust
-- Point, 117 open breaches assert caveat-free certainty about evidence nobody
-- can open.
--
-- Two caveats now apply where the source call was never established:
--
--   unattributed_evidence — which recording this rests on is unknown.
--   unreliable_speakers   — added only when SOME call on the sale has
--                           unreliable speakers. The quote may have come from
--                           it and we cannot rule that out, so we do not.
--
-- Ordering matters and is why this is 084, not part of 083: 083 attributes the
-- single-call sales, so by the time this runs, a NULL source_call_id means
-- genuine ambiguity rather than a missing marker on a sale with one call. Run
-- the other way round, 132 Trust Point checkpoints would be labelled
-- unattributed and then quietly given a source call, leaving a stale caveat.
--
-- evidence_caveats has no CHECK constraint (it is TEXT[]), so no schema change
-- is needed for the new value; the column comment is the contract and is
-- restated below. Every statement re-checks membership, so this is idempotent.

COMMENT ON COLUMN breaches.evidence_caveats IS
  'Why this finding is not settled. Empty = no known weakness. Values: low_agreement (independent scoring runs disagreed), low_confidence (the scorer was unsure), unreliable_speakers (who said what could not be established on the source call), unattributed_evidence (the scorer cited no particular call and the sale has more than one, so which recording this rests on is unknown), guessed_branch (the sale''s branch was inferred, so the checkpoint may not even apply), retired_model (scored by a model no longer in use).';

-- ── Backfill ────────────────────────────────────────────────────────────────

-- Journey breaches whose evidence was never attributed to a call.
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'unattributed_evidence')
  FROM journey_item_scores jis
 WHERE jis.id = b.journey_item_score_id
   AND jis.source_call_id IS NULL
   AND NOT ('unattributed_evidence' = ANY(b.evidence_caveats));

-- ...and where any call on that sale has speakers we could not establish, the
-- quote may have come from it. Mirrors the runtime rule in
-- jobs/processors/score-journey.ts.
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'unreliable_speakers')
  FROM journey_item_scores jis
 WHERE jis.id = b.journey_item_score_id
   AND jis.source_call_id IS NULL
   AND NOT ('unreliable_speakers' = ANY(b.evidence_caveats))
   AND EXISTS (
     SELECT 1
       FROM journey_calls jc
       JOIN calls c ON c.id = jc.call_id
      WHERE jc.journey_id = jis.journey_id
        AND c.transcript_text IS NOT NULL
        AND (c.speaker_integrity_flag IS NOT NULL
             OR c.speaker_attribution_confidence < 0.5)
   );

-- Re-run 078's speaker rule for rows that 083 has just attributed: they had no
-- source call when 078 ran, so its INNER JOIN skipped them, and now they do.
UPDATE breaches b
   SET evidence_caveats = array_append(b.evidence_caveats, 'unreliable_speakers')
  FROM journey_item_scores jis
  JOIN calls c ON c.id = jis.source_call_id
 WHERE jis.id = b.journey_item_score_id
   AND (c.speaker_integrity_flag IS NOT NULL OR c.speaker_attribution_confidence < 0.5)
   AND NOT ('unreliable_speakers' = ANY(b.evidence_caveats));
