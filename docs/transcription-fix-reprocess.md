# Go-live + reprocess: transcription fixes (CG-010)

This runbook ships three linked fixes and then corrects the calls scored before
them. Do it in order. Do not skip the pilot.

## What's being fixed

1. **Cleanup content-loss guard** (`services/transcript-cleanup.ts`) — the Haiku
   cleanup pass could silently drop a chunk of a long transcript, so scoring
   never saw it (e.g. a compliance intro), producing false fails. The guard now
   falls back to the raw transcript if the cleaned output loses >20% of length.
2. **Narrowed redaction** (`services/transcription.ts`) — Deepgram's broad `pii`
   group was redacting organisation/regulator names (turning "FCA" and the firm
   name into `[ORGANIZATION_n]`), so FCA/firm-name scorecard items couldn't be
   verified. Now uses `pci` + `phi` + `numbers` groups plus explicit identity
   entities: real identifiers (incl. bank sort code + account number) stay
   redacted, org names come through. Verified with `scripts/verify-redaction.ts`.
3. **Compliance keyterms** (`services/transcription.ts`) — "authorised and
   regulated" was misheard as "all fine"; boosted so Nova-3 recognises it.

Fixes 2 and 3 only take effect on a **fresh Deepgram transcription**. Fix 1
applies on any cleanup run. So correcting historical calls needs a full
**re-transcribe**, not just a re-clean.

## Step 0 — Confirm the DB is migrated (BLOCKER)

The transcribe worker selects `organizations.keyterms` (migration 058)
unconditionally. Confirm prod has it before deploying:

```sql
SELECT filename FROM _migrations ORDER BY filename DESC LIMIT 5;
```

If 058 (or later) is missing, run `npm run migrate` first. If it's present,
proceed.

## Step 1 — Deploy the code

```bash
git checkout CG-010 && git pull
npm install
npm run build            # shared → api → web → admin
npm run migrate          # idempotent; applies anything pending
pm2 restart callguard-api callguard-worker
```

The worker MUST be restarted — queued transcription/scoring jobs run the new
code only after restart.

## Step 2 — Pilot on ONE call (William Roberts) before scaling

Prove the fix in prod on a single, known call. Cheap, reversible.

```bash
cd packages/api

# 2a. See current state
npx tsx src/scripts/reprocess-call.ts c74d15c2-0360-43e9-bcfc-2e7614b9e223

# 2b. Re-transcribe through the full fixed pipeline (worker must be running)
npx tsx src/scripts/reprocess-call.ts c74d15c2-0360-43e9-bcfc-2e7614b9e223 --commit

# 2c. When status shows 'transcribed', re-score just this journey:
#     use the admin "Re-score" button on the journey, OR the tenant rescore
#     script scoped tightly. Confirm the FCA/advised/recording items now pass.
```

Optional sanity check (on the server, real audio present):

```bash
npx tsx src/scripts/verify-redaction.ts c74d15c2-0360-43e9-bcfc-2e7614b9e223
# expect: no raw identifiers leaked; [ORGANIZATION] gone; "authorised and regulated": true
```

Only continue once the pilot journey scores correctly.

## Step 3 — Tenant-wide reprocess (Trust Point)

Two async steps: re-transcribe everything, let the queue drain, then re-score.

```bash
cd packages/api

# 3a. Dry run — scope + Deepgram/cleanup cost estimate. Change nothing.
npx tsx src/scripts/bulk-reprocess-tenant.ts "Trust Point" --retranscribe

# 3b. Commit — enqueue re-transcription for every call in scored/failed sales.
npx tsx src/scripts/bulk-reprocess-tenant.ts "Trust Point" --retranscribe --commit

# 3c. WAIT for the transcription queue to drain (watch the worker logs / queue
#     depth). Do not start 3d until transcription has finished, or it re-scores
#     stale transcripts.

# 3d. Re-score the sales. --no-crm keeps the Zoho write-back + webhook quiet so
#     a bulk correction doesn't flood the tenant's CRM with re-pushed scores and
#     duplicate breach tasks. Dry-run first (omit --commit).
npx tsx src/scripts/rescore-tenant-journeys.ts "Trust Point" --status=scored,failed
npx tsx src/scripts/rescore-tenant-journeys.ts "Trust Point" --status=scored,failed --commit --no-crm
```

### The CRM decision

`--no-crm` corrects CallGuard's own scores without re-pushing to Zoho. Use it
for the bulk backfill. Drop it only if you deliberately want every corrected
score re-pushed to Trust Point's CRM (re-raising breach tasks). Live sales going
forward always push as normal — the suppression is per bulk run only.

## Notes

- All reprocess scripts are **dry-run by default**; `--commit` is required to
  change anything. Read the dry-run output before committing.
- Everything in Step 3 needs the api/worker host (audio in `uploads/`, Redis,
  Deepgram key). It won't run from a laptop pointed only at the prod DB.
- Cost: Step 3b re-bills Deepgram per audio-minute + Anthropic for re-clean;
  Step 3d re-bills Anthropic for scoring. The dry run prints the audio-minute
  total.
