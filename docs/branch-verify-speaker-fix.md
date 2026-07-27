# Go-live + repair: branch resolution, single-pass scoring, speaker attribution

Ships the fixes for the three faults found on Trust Point sale
`27bbb305-b4b7-4612-8783-c7c5022c4d42` (scored 39.53% against the wrong branch,
with a silently-dead verify stage and an inverted transcript), then corrects
the affected calls.

**Do it in order.** Re-scoring before re-transcribing achieves nothing: the bad
speaker labels are baked into the stored transcript, so scoring would just read
them again.

## What's being fixed

1. **Branch from the CRM, not the transcript** (`shared/scoring.ts`,
   `services/zoho.ts`) — `resolveBranch` matched literal phrases and silently
   defaulted to `branches[0]` when none hit. None of the five configured
   `referred` phrases appeared anywhere in 64k characters of this sale, so it
   scored as `on_risk`: Trust and Direct-Debit-on-risk checkpoints were failed
   against a policy that never went on risk, and the referred ones were marked
   n/a. The branch now comes from the Zoho Deal `Stage` (read on the same
   related-list request as `Product`, so no extra CRM call), with
   `branch_source` recorded and surfaced. Keywords remain as a fallback and were
   widened to what advisers actually say.

2. **Two-pass scoring retired; one Sonnet pass instead** (`services/scoring.ts`)
   — scoring ran on Haiku with a Sonnet second opinion over flagged items. The
   second pass had a fixed `max_tokens: 2048` against a set that scales at ~300
   tokens per item, so it truncated and threw into a best-effort `catch`,
   silently, on exactly the calls with the most breaches. Across 25 recorded
   verifies the largest was 1889 output tokens with nothing above it — a
   censored distribution, because everything above the cap died.

   Rather than repair the stage, it is gone. Scoring now runs once on
   `claude-sonnet-4-6`, which costs roughly half the two-pass design (~$0.16 vs
   ~$0.30 per sale on a 44-item scorecard) and applies the strictness and
   compound-criteria rules that used to live in the verify prompt to EVERY item
   on the first pass. The cheap first pass was itself the source of the errors
   that prompted this work: a false breach at 0.95 confidence, two missed
   consent responses, and a compound criterion passed on half its content.

3. **Speaker attribution** (`services/transcription.ts`,
   `services/speaker-integrity.ts`, `services/transcript-cleanup.ts`) — the
   adviser was picked by "who speaks first", flipped by the org's
   `mono_first_speaker`. Deepgram put the customer's opening "Hello?" (at 2s) in
   the ADVISER's cluster, so the adviser looked like the first speaker, the
   outbound rule chose the other cluster, and all 33 minutes came out inverted.
   A critical "adviser led the customer" breach was then raised on the
   customer's own words. The adviser is now identified from what each cluster
   says across the whole call (measured: positional 1/3, content 3/3 on real
   calls), and the cleanup model's swap is applied mechanically instead of being
   performed by the model mid-rewrite.

Fixes 1 and 2 apply on a re-score. **Fix 3 only takes effect on a fresh
Deepgram transcription** — correcting historical calls needs a full
re-transcribe, not a re-clean.

## Step 0 — Already done (DB only)

Applied directly to production ahead of the deploy; both are additive and safe
against the currently-running code:

- `071_branch_provenance_and_verify_status.sql` — applied, and it auto-set
  `zoho_connections.policy_stage_field = 'Stage'` for the Deals related list.
- `src/scripts/set-trustpoint-branch-map.sql` — applied. Maps `On Risk` →
  `on_risk`; `Referred` / `Referred - Decision Back` → `referred`; and
  `Referred - NTU` / `Referred - Decision Back - NTU` → not scored at all.

Verify:

```sql
SELECT name FROM _migrations ORDER BY name DESC LIMIT 1;  -- expect 071_...
SELECT policy_stage_field FROM zoho_connections;          -- expect 'Stage'
```

## Step 0b — Pending migration (applied by the deploy)

`073_drop_verify_stage.sql` removes the `verify_status`/`verify_error` columns
that migration 071 added a few hours before the two-pass architecture was
retired. Nothing ever wrote to them — verified as all-NULL before dropping. Left
to `npm run migrate` in Step 1 so schema and code change together.
(`072_org_journey_window.sql` belongs to separate in-flight work and also
applies there.)

## Step 1 — Deploy the code

```bash
git checkout feat/journey-calls-panel-today-filter && git pull
npm install
npm run build            # shared → api → web → admin
npm run migrate          # applies 072 + 073; 071 already applied
pm2 restart callguard-api callguard-worker
```

The worker MUST be restarted — queued transcribe/score jobs run the new code
only after restart.

## Step 2 — Re-transcribe the affected calls

The audio is on the server's local disk (`services/storage.ts` reads from the
filesystem, encrypted at rest), so this can only run on the server, with the
worker up on the same Redis.

Pilot on the worst call first — the 33-minute H&L where the inversion produced
the critical false breach:

```bash
cd packages/api
npx tsx src/scripts/reprocess-call.ts 75e2fcf7-e016-4148-a017-8f5ee24b4070            # dry run
npx tsx src/scripts/reprocess-call.ts 75e2fcf7-e016-4148-a017-8f5ee24b4070 --commit
```

Then confirm the fix actually landed before doing the rest:

```sql
SELECT speaker_attribution_confidence, speaker_integrity_flag
  FROM calls WHERE id = '75e2fcf7-e016-4148-a017-8f5ee24b4070';
```

Expect confidence `0.80` and `speaker_integrity_flag` NULL — the adviser cluster
was identified from content and the labels now agree with it. Spot-check the
transcript: the health-and-lifestyle questions must sit under `Agent:` and the
answers under `Customer:`.

Worker log should show:

```
[Transcription] Adviser identified by content as cluster 0, overriding the positional guess of 1 — ...
```

If confidence comes back `0.30` with a flag set, the labels are still wrong —
**stop and investigate rather than re-scoring**, because the sale would be
scored off a transcript we already know we cannot trust.

Then the remaining seven calls in the sale:

```bash
for id in 41bfa393-4243-4e49-912b-1aba5b0b30bd 0f6c059c-f0df-421d-89ae-cf5cab048ed2 \
          379b172b-74a0-423b-bb9d-d8d8eda657b1 0f40f50d-8161-4047-8e44-2e0d11a83ca6 \
          d6b82968-1ed4-48bb-9506-f8cf87e025e2 93c1f68d-85e6-4000-a371-b69e68a9a939 \
          2e00b39f-9425-4194-aa77-6a3ef0323543; do
  npx tsx src/scripts/reprocess-call.ts "$id" --commit
done
```

Wait for all eight to reach `status = 'transcribed'` before Step 3.

## Step 3 — Re-score the sale

Re-scoring **pushes the corrected score to the tenant's Zoho QA record** and
rewrites their breach register, replacing the 39.53% and its 26 breaches. That
is the intent here — the score on the record is wrong — but it is a live,
outward-facing write, so do it deliberately and only after Step 2 verifies.

Use the admin "Re-score" button on the sale, or:

```bash
npx tsx src/scripts/rescore-tenant-journeys.ts "Trust Point" --status=scored --commit
```

(That targets every scored sale for the tenant. For this one sale only, prefer
the admin button.)

### What to expect

- `branch_source` — `keyword` (resolving to `referred`), since this journey was
  assembled before the stage was captured and its `crm_stage` is NULL. The
  widened keywords now catch it; the CRM path applies to new sales.
- Items 8, 39, 40 (Policy in Trust — On Risk) → `na` rather than failed.
- Item 31 (Direct Debit — On Risk) → `na`; item 32 (Direct Debit — Referred) →
  scored, and it should pass.
- The `score` row in `usage_events` should now read `claude-sonnet-4-6`, not
  `claude-haiku-4-5-20251001`, and there should be **no** `verify` row — the
  stage no longer exists.
- Items 15 and 18 should flip to pass, and item 35 (exclusions given, 30-day
  cancellation rights never mentioned) should flip to fail — that last one is
  the compound-criteria rule earning its place.
- Score should land materially above 39.53% but still fail: the word-for-word
  regulatory block genuinely was never read, and items 10 and 17 are real
  criticals.

## Step 4 — Backfill the rest of the tenant

Corrects metadata only; deliberately does not re-score.

```bash
npx tsx src/scripts/backfill-call-metadata.ts --org e7cc43ef-8490-4ec9-990a-006071b45e92
npx tsx src/scripts/backfill-call-metadata.ts --org e7cc43ef-8490-4ec9-990a-006071b45e92 --commit
```

It links the six `'Lewis'` calls to the `Lewis Moore` user, and flags any other
transcribed call whose speaker labels look unreliable — printing the sales those
calls belong to, so you can decide which are worth re-transcribing.

## Step 5 — Watch the first week

One pass on a stronger model is cheaper and simpler, but it is a real change to
how every sale is judged. Two things to look at once live sales start flowing:

- **`usage_events` cost per sale.** Expect the `score` row to grow (Sonnet
  output at $15/MTok vs Haiku's $5) and the `verify` row to disappear entirely.
  Net should land near half of what the repaired two-pass design would have cost.
- **Whether breach counts move.** A stronger model applying a stricter
  compound-criteria rule should catch things the old first pass missed —
  expect *more* correctly-failed compound checkpoints, not fewer breaches
  overall. A sharp drop in breaches is worth investigating rather than
  celebrating.

`score_corrections` is the ground truth to watch: every correction on record so
far is a Haiku error. If humans stop needing to correct the AI, the change
worked.

## Rollback

The code is additive; reverting is `git revert` + rebuild + `pm2 restart`. The
migration only adds columns and widens a CHECK, so it can be left in place. To
restore the previous branch behaviour without a deploy, drop the CRM mapping:

```sql
UPDATE scorecards SET branch_config = branch_config - 'crm_values' - 'no_score_crm_values'
 WHERE id = '56516d2d-cbc7-4405-8147-14af5b644c3c';
```
