# Spec: partial journey detection

## 1. The problem

Journey `bf7120bc` (Trust Point, customer "Jimara Lewis", 2026-08-01) scored
**20.51%** and raised **31 breaches**. The sale contains one call: an outbound
6m30s closing call. The fact find, intro, and every regulatory disclosure
happened in an earlier conversation that CallGuard never captured.

The scorer worked this out on its own, and said so, repeatedly, in the reasoning
it stored against the failed checkpoints:

> "This call begins as a continuation/callback of a prior conversation... No
> earlier call is provided in this journey to confirm the intro occurred."

> "the visible transcript begins mid-process at the wrap-up stage, likely
> because the fact find and intro occurred in an earlier, unprovided call."

> "it may have been given in an earlier call not provided, but based on what is
> available, it is not met."

That judgement is written into free text and then thrown away. What reaches the
tenant, the breach register, the adviser's record, and (via QA write-back) the
client's own CRM is a bare 20.51% and 31 findings, presented identically to a
sale we scored on complete evidence.

The failure shape is unmistakable once you look at it. Every front-of-sale
checkpoint scored 0 (intro, FCA authorisation, whole-of-market, call-recording
disclosure, data sharing, information-sharing consent, cancellation rights,
vulnerability statement, needs summary, recommendation). Every back-of-sale
checkpoint passed (H&L questions answered unled, Direct Debit, payment date,
documents, future support, referral, final close).

This is not rare. Of Trust Point's 30 scored journeys, 12 are single-call.

| calls in journey | journeys | avg score |
|---|---|---|
| 1 | 12 | 62.7% |
| 2 | 8 | 78.4% |
| 3 | 5 | 62.6% |
| 4 | 2 | 63.3% |
| 5 | 1 | 71.7% |
| 7 | 1 | 38.1% |
| 8 | 1 | 43.9% |

## 2. Principle

Follow the precedent set by migration 078 (`breaches.evidence_caveats`), which
settled the equivalent question for shaky breaches:

> The fix is NOT to suppress the shaky ones. Missing a genuine compliance
> failure is worse than raising an uncertain one... So the finding stays and the
> certainty is stated.

The same logic holds here, and it cuts both ways:

- **Do not hide the score or skip scoring.** An adviser who genuinely skipped
  every disclosure produces exactly the same checkpoint pattern as a missing
  first call. Suppressing on structure alone would mask real misconduct.
- **Do not recompute the score** by dropping the unevidenced checkpoints. That
  invents a number asserting the adviser was compliant on checkpoints we have no
  evidence for. A false pass is the worse error for a regulated firm, and it is
  the specific failure the consent-gate manual-review queue already exists to
  prevent.

So: score as now, state what the score rests on, and stop the qualified number
propagating into places that imply it is comparable.

## 3. Detection

### 3.1 Model-declared coverage (primary signal)

The scorer already makes this judgement. Ask for it explicitly instead of
mining prose.

`services/scoring.ts` returns a structured result per checkpoint (score,
confidence, evidence, reasoning) against a JSON schema (around line 342). Add
one journey-level object to that schema, requested once per run:

```jsonc
"coverage": {
  "starts_mid_conversation": true,
  "missing_stages": ["intro", "fact_find", "regulatory_disclosures"],
  "rationale": "Opens with identity verification and moves straight to wrap-up; the adviser refers back to a prior discussion of the recommendation."
}
```

This is a content judgement, which is the part structure cannot do. A call that
opens "as we discussed yesterday" reads differently from a cold open with no
disclosures, and that difference is exactly what separates a coverage gap from
adviser misconduct.

Cost is one small object per scoring run. Under consensus scoring (migration
076, `samples > 1`) take the majority verdict on
`starts_mid_conversation` and record disagreement, consistent with how
checkpoint votes are already resolved in `scoreTranscriptConsensus`.

### 3.2 Structural corroboration (free, computed)

Never sufficient alone (see §2), but recorded alongside so a human reviewing the
flag can check the model's claim without opening the audio:

- **Front-fails / back-passes shape.** All checkpoints in the scorecard's
  opening sections failed while later sections largely passed.
- **No prior history.** `customers.first_seen_at` equals the journey's earliest
  call, on a tenant whose capture has been live materially longer. This is the
  Jimara case exactly: customer created 09:52:16, its only call created
  09:52:16, capture live since 17 July.
- **Single-call sale** where the tenant's median sale spans more.

### 3.3 What the two together mean

| model says | structure agrees | outcome |
|---|---|---|
| mid-conversation | yes | `partial` |
| mid-conversation | no | `partial`, flagged for review (model may be wrong) |
| complete | yes | `unknown`, logged for tuning (structure may be misreading a genuinely bad call) |
| complete | no | `complete` |

Crucially, "structure agrees, model says complete" does **not** produce a
partial flag. That is the adviser-skipped-everything case, and it must keep
scoring 20% with live breaches.

## 4. Schema

```sql
-- Migration 080
ALTER TABLE journeys
  ADD COLUMN IF NOT EXISTS coverage TEXT
    CHECK (coverage IN ('complete', 'partial', 'unknown')),
  ADD COLUMN IF NOT EXISTS coverage_missing_stages TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS coverage_rationale TEXT;
```

New breach caveat, extending the existing enum in
`packages/shared/src/types/breaches.ts:94`:

```ts
incomplete_journey: "The sale's earlier calls are missing, so this checkpoint may have been met on a call CallGuard never saw",
```

Applied in `breachCaveats()` (`jobs/processors/score-journey.ts:500`) to every
breach on a journey whose `coverage = 'partial'`. This reuses migration 078's
whole apparatus, so the register UI, the tooltip, and the human-confirm flow all
work with no further change.

## 5. What changes downstream

1. **Journey detail** (`packages/web/src/pages/JourneyDetail.tsx`) gains a
   banner: what appears to be missing, and why we think so
   (`coverage_rationale`). Design system: status conveyed by text and icon, not
   colour alone.
2. **Journeys list** (`Journeys.tsx`) gains a chip on partial sales so the score
   column is never read bare.
3. **Adviser averages and org trend exclude partial journeys.** This is the
   substantive behavioural change. A coverage artefact must not drag an
   adviser's average or a tenant's compliance trend. Affects the aggregates in
   `routes/dashboard.ts` and `routes/insights.ts`; the sale stays fully visible
   on its own page.
4. **Zoho QA write-back is suppressed for partial journeys**, or writes the
   caveat into the QA note rather than a bare score. This is outward-facing into
   the client's own CRM and is the most damaging place for an unqualified 20.51%
   to land against a named adviser. Needs a tenant-level setting; default to
   suppress.
5. **Ops actionability.** A partial journey should say what to do about it.
   Where the customer has calls outside the journey, or a near-duplicate
   customer record exists, offer the mend-in-place path that already exists
   (`extendExisting` in `services/journey.ts:152`), which attaches missing calls
   and re-scores rather than opening a second sale.

## 6. Rollout

**Phase 1 (detect, do not act).** Ship §3 and §4. Populate `coverage` on every
new scoring run. Change nothing user-facing. Run for a week on Trust Point and
measure how often `partial` fires and whether it agrees with structure.

**Phase 2 (qualify).** Turn on the breach caveat, the banner, and the chip once
the false-positive rate is known.

**Phase 3 (exclude).** Aggregate exclusion and QA write-back suppression, which
change numbers the tenant may already be reporting on. Announce before enabling.

**Sizing it now.** The structural signal alone is computable over the existing
back catalogue with no re-scoring, so we can report tonight how many of Trust
Point's 30 journeys carry the front-fails/back-passes shape. That does not
prove they are partial, but it bounds the problem before any code ships.

**Backfill.** The model signal cannot be recovered without re-scoring. Do not
backfill `coverage` on historical journeys; leave it NULL (distinct from
`unknown`) so "never assessed" is not confused with "assessed as inconclusive".

## 7. Open questions

- Should a `partial` journey still count towards billing? It consumed
  transcription and scoring spend, but the tenant arguably did not get a usable
  compliance result.
- Should the checkpoints the model names in `missing_stages` be recorded as
  `manual_review` rather than `fail`? That would keep them off the register
  while flagging them for a human, but it changes the denominator and therefore
  the score. Deliberately deferred: it is a scoring-maths change, not a
  labelling one, and should not ride along with this.
- Is `starts_mid_conversation` the right primitive, or do we also need
  `ends_mid_conversation` for a sale whose closing call was missed? The Trust
  Point evidence only covers the former.
