-- Attribute already-scored evidence on single-call sales to the one call it can
-- have come from, so the reviewer gets an evidence panel instead of a shrug.
--
-- Journey evidence is attributed by parsing the "[Call N]" prefix the scorer is
-- asked to put on each quote. It omits that prefix on roughly one quote in six,
-- and every one of those was stored with source_call_id NULL.
--
-- That is not cosmetic. The review panel loads through source_call_id, so an
-- unattributed checkpoint offers no transcript excerpt, no audio player, and no
-- notice that the call's speaker labels were found unreliable — the warning
-- renders from the same payload. The reviewer is told to open the sale and find
-- it themselves, then asked to rule on a compliance checkpoint. On Trust Point
-- that is 52 of the 112 items in their queue, which goes a long way to
-- explaining why marginal checkpoints get cleared in seconds.
--
-- services/journey-transcript.ts now resolves the unambiguous case at scoring
-- time: a sale with exactly one transcribed call has exactly one call the quote
-- came from, marker or no marker. This repairs the rows already written under
-- the old behaviour. Multi-call sales with an unmarked quote are left NULL —
-- mis-attributing to a real call is worse than having no attribution, and the
-- next migration gives those an honest caveat instead.
--
-- Idempotent (the IS NULL predicate is re-checked), and safe to run alongside
-- scoring. Nothing reads source_call_id to derive a score or a routing decision
-- — every consumer is display or per-agent attribution — so no verdict, breach
-- or pass/fail can change as a result of this.

WITH single_call AS (
  -- Membership via journey_calls and the transcript filter, mirroring how
  -- jobs/processors/score-journey.ts builds callIdsInOrder: only calls actually
  -- sent to the model can be cited, so a sale with one transcribed call and one
  -- that failed to transcribe is single-call as far as evidence is concerned.
  SELECT jc.journey_id, (array_agg(c.id))[1] AS only_call_id
    FROM journey_calls jc
    JOIN calls c ON c.id = jc.call_id
   WHERE c.transcript_text IS NOT NULL
   GROUP BY jc.journey_id
  HAVING COUNT(*) = 1
),
scored_single AS (
  -- How many calls the sale actually had WHEN IT WAS SCORED.
  --
  -- Today's count is not evidence of that. Calls get hard-deleted — the
  -- retention sweep does exactly that (jobs/processors/retention-purge.ts), and
  -- so does an admin deletion — and when one goes, journey_calls cascades the
  -- membership row away while source_call_id is SET NULL. A three-call sale
  -- that has been purged down to one therefore looks single-call, and its
  -- orphaned evidence would be confidently pinned to whichever recording
  -- survived. That is the mis-attribution this migration exists to avoid, and
  -- it would also move the breach onto that call's agent in the per-agent
  -- dashboard counts.
  --
  -- journey_score_runs.calls_scored (migration 074) is the durable record, so
  -- attribute only where it agrees the sale was single-call all along. The join
  -- below is INNER, so a sale with no run history is skipped rather than
  -- guessed at.
  SELECT DISTINCT ON (journey_id) journey_id, calls_scored
    FROM journey_score_runs
   ORDER BY journey_id, run_number DESC
)
UPDATE journey_item_scores jis
   SET source_call_id = sc.only_call_id
  FROM single_call sc
  JOIN scored_single ss ON ss.journey_id = sc.journey_id
 WHERE jis.journey_id = sc.journey_id
   AND jis.source_call_id IS NULL
   AND ss.calls_scored = 1;
