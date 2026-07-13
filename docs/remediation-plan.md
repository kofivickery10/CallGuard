# CallGuard — Spec Remediation Implementation Plan

Closes every gap found auditing the codebase against `CallGuard_System_Spec.md`.
Overriding design rule: **nothing integration-specific or policy-specific is global or hardcoded — it lives in per-tenant, per-integration config.** CloudTalk is one dialer among several (Twilio / AWS Connect / generic already exist for live streaming), so its settings must be per-tenant rows, never `.env` or `shared/constants.ts`.

Migrations continue from the current head (`037`). New migrations are `038`+.

---

## 0. Tenant-scoping model (the backbone)

Two established house patterns, which everything here follows:

1. **Per-tenant integration credentials → a dedicated table with `organization_id` FK + AES-256-GCM-encrypted secrets**, exactly like `sftp_sources` (`004_ingestion.sql`) and `zoho_connections` (`035`). New CloudTalk config follows this shape — it does **not** go in `config.ts`.
2. **Per-tenant policy → typed columns / a `settings` JSONB on `organizations`**, like `adviser_channel` (`016`), `industry` (`032`), `data_improvement_opt_in` (`020`).

Global constants that are currently policy (`MIN_SCOREABLE_WORDS`, `MIN_SCOREABLE_DURATION_SECONDS`, `PASS_THRESHOLD` in `shared/constants.ts`; `mip_opt_out`, region in `config.ts`/`transcription.ts`) become **per-tenant with the current value as the default**, so behaviour is unchanged until a tenant overrides.

Resolution order for any setting: `dialer_connection`/`zoho_connection` row → `organizations` column → `shared/constants.ts` default. The constant stays as the floor/default only.

---

## 1. Data model changes (all new migrations)

### `038_org_scoring_settings.sql`
Per-tenant scoring policy (spec §10). Add to `organizations`:

| Column | Type | Default | Spec item |
|---|---|---|---|
| `scoring_scope` | TEXT CHECK in (`sales_only`,`over_threshold`,`everything`) | `sales_only` | §10 scope |
| `min_scoreable_seconds` | INTEGER | `15` | §10 length threshold |
| `min_scoreable_words` | INTEGER | `30` | §10 |
| `pass_threshold` | NUMERIC(5,2) | `70` | §8 |
| `retention_days` | INTEGER | `1825` (5yr) | §10/§15 |
| `transcription_mode` | TEXT CHECK in (`mono_diarize`,`stereo_multichannel`) | `mono_diarize` | §5/§10 |
| `deepgram_region` | TEXT | `eu` | §10 |
| `deepgram_mip_opt_out` | BOOLEAN | `true` (floor — cannot be set false without superadmin) | §5/§10 |

> Decision needed: spec says retention = 5yr; the compliance templates (`ropa.md`, `dpia.md`) currently say 7yr. Pick one and align both.

### `039_dialer_connections.sql`
Generalises inbound dialer integration per tenant (CloudTalk today, others later). New table:

```
dialer_connections
  id                          UUID PK
  organization_id             UUID FK -> organizations ON DELETE CASCADE
  provider                    TEXT CHECK in ('cloudtalk')  -- extend as providers are added
  name                        TEXT
  -- inbound webhook auth
  signing_secret_encrypted    TEXT            -- HMAC secret to verify inbound "Call Ended" posts
  -- outbound CloudTalk REST API auth (HTTP Basic: key id + secret)
  api_key_id_encrypted        TEXT
  api_secret_encrypted        TEXT
  api_base_url                TEXT DEFAULT 'https://my.cloudtalk.io/api'
  -- ingestion behaviour (per-tenant, was hardcoded)
  recording_fetch_delay_sec   INTEGER NOT NULL DEFAULT 60   -- spec §4 "add a delay"
  history_window_days         INTEGER NOT NULL DEFAULT 30   -- spec §9 journey window
  -- tolerant payload field mapping (agent id / phone / call id / timestamp)
  field_map                   JSONB NOT NULL DEFAULT '{...}'
  is_active                   BOOLEAN NOT NULL DEFAULT true
  last_event_at               TIMESTAMPTZ
  last_error                  TEXT
  created_at / updated_at
  UNIQUE (organization_id, provider)
```

Add `'dialer_webhook'` to the `calls.ingestion_source` CHECK (currently `upload,api,sftp,live_stream`).

### `040_scorecard_checkpoint_model.sql`
Turn the flat item model into the spec's checkpoint model (§8). Add to `scorecard_items`:

| Column | Type | Purpose |
|---|---|---|
| `section` | TEXT | §8 grouping |
| `item_type` | TEXT CHECK in (`ai`,`manual`) DEFAULT `ai` | §8 38 AI / 9 manual split |
| `applies_when` | JSONB | §8 branch condition, e.g. `{"branch":"on_risk"}`; null = always |
| `expectation` | TEXT | §8 expectation text fed to the model |
| `ai_check` | TEXT | §8 explicit check instruction (presence-and-meaning) |
| `consent_gate` | BOOLEAN DEFAULT false | §8 requires explicit customer affirmative |

`severity` already exists (`006`). Add result states on `call_item_scores` (and the new journey equivalent):

```
ALTER TABLE call_item_scores ADD COLUMN result TEXT
  CHECK (result IN ('pass','fail','na','manual_review'));
ALTER TABLE call_item_scores ADD COLUMN source_timestamp NUMERIC;  -- §8 per-checkpoint timestamp
```

`na` and `manual_review` are **excluded from the denominator** and never sent to Claude for auto-scoring.

### `041_scorecard_versioning.sql`
Spec §10 versioned scorecards. Add `version INTEGER NOT NULL DEFAULT 1` to `scorecards`; add `branch_config JSONB` (defines branches + the detection rule, e.g. On Risk vs Referred) and `scoring_mode TEXT CHECK in ('per_call','journey') DEFAULT 'journey'`. Pin scored rows to the version: add `scorecard_version INTEGER` to `call_scores` and the journey score table. Editing a live scorecard bumps `version` and snapshots items (copy-on-write) rather than mutating in place; already-scored calls keep their old version for audit.

### `042_journeys.sql`
Spec §9 multi-call journey scoring. New tables:

```
journeys
  id, organization_id, customer_id FK, scorecard_id, scorecard_version,
  window_start, window_end, trigger_source TEXT ('zoho_sale','manual','fallback'),
  status TEXT ('pending','scoring','scored','failed'),
  branch TEXT,           -- resolved branch (on_risk/referred)
  overall_score, pass, scored_at, created_at

journey_calls            -- which calls composed the journey (audit)
  journey_id FK, call_id FK, role TEXT ('wrap_up','context'), PRIMARY KEY(journey_id, call_id)

journey_item_scores      -- per-checkpoint result across the whole call set
  journey_id FK, scorecard_item_id FK, result, score, normalized_score,
  confidence, evidence, reasoning, source_call_id FK, source_timestamp
  UNIQUE(journey_id, scorecard_item_id)
```

Add `journey_id UUID REFERENCES journeys(id)` to `calls`. Breaches gain an optional `journey_id` so a breach can be journey-level.

### `043_zoho_inbound.sql`
Spec §9/§11. Add to `zoho_connections`: `inbound_secret_encrypted TEXT` (verifies the sale webhook), `sale_phone_field TEXT DEFAULT 'Phone'`, `qa_module TEXT`, `qa_field_map JSONB` (adviser + month + score field API names for the QA module write-back). Bump the write-back path to `crm/v8` and widen `module` beyond Leads/Contacts to allow the tenant's QA custom module.

### `044_retention_and_audit.sql`
Spec §15. Add `deleted_at` / lifecycle columns where needed for archive tiering. Make `audit_log` genuinely append-only: a `BEFORE UPDATE OR DELETE` trigger that raises, plus `REVOKE UPDATE, DELETE ON audit_log FROM <app_role>`.

---

## 2. Workstreams

Each lists the gap, the design, the files, the tenant-scoping note, and acceptance criteria.

### W1 — Config foundation *(prerequisite for W2, W3, W6, W7, W9)*
**Gap:** policy + integration config is global (`config.ts`, `shared/constants.ts`).
**Build:** migrations `038`,`039`; a `services/tenant-settings.ts` resolver (`getScoringSettings(orgId)`, `getDialerConnection(orgId, provider)`) that layers row → org column → constant default and decrypts secrets via `services/crypto.ts`. Route `routes/integrations.ts` gains CRUD for `dialer_connections` (admin-guarded, org-scoped).
**Tenant-scoping:** all reads keyed by `organization_id`; secrets encrypted at rest like `sftp_sources`.
**Acceptance:** every current global default reproduces today's behaviour with no tenant override; a second tenant can run a different scope/threshold without code change.

### W2 — CloudTalk ingestion rework
**Gap:** synchronous inline download; no signature verification; no delayed pull from the CloudTalk API; no multi-call history; no `ingest-call` job.
**Build:**
- `middleware/verify-dialer-signature.ts` — HMAC-verify the inbound post against `dialer_connections.signing_secret` before trusting it (resolve tenant from the connection, not just `X-API-Key`).
- Rework `routes/ingestion.ts` CloudTalk handler: parse via `field_map`, enqueue an `ingest-call` job, **return `202` immediately**.
- New `jobs/processors/ingest-call.ts` on the existing `ingestion` queue with `delay: recording_fetch_delay_sec * 1000`: fetch the recording from CloudTalk `GET /calls/recording/{callId}.json` (HTTP Basic from the connection), store encrypted, then enqueue `transcribe`.
- `services/cloudtalk.ts` — API client (recording fetch + `GET /calls/index.json?phone=` history for W6), Basic auth from the connection.
**Tenant-scoping:** creds + delay + field map all from the tenant's `dialer_connections` row.
**Acceptance:** unsigned/mis-signed posts rejected 401; valid post returns 202 in <200ms; recording fetched after the delay; ingest survives CloudTalk lag.

### W3 — Transcription mono fix + attribution + consent guard
**Gap:** `multichannel:true` contradicts mono-only; channel-pin attribution not agent-ID; no consent-speaker confidence guard; `diarize_model` unset.
**Build:** `services/transcription.ts` — drive `multichannel` vs `diarize` from `transcription_mode` (default `mono_diarize` → `diarize:true`, no `multichannel`); set `diarize_model`. Attribution: prefer agent-ID metadata from the ingest payload, then adviser-first heuristic, emit a per-utterance confidence. Add a guard so **consent-gate items require the utterance be attributed to the customer above a confidence floor**, else → `manual_review`. Test on the 22-min sample.
**Tenant-scoping:** `transcription_mode`, `deepgram_region`, `deepgram_mip_opt_out` per tenant (W1); `mip_opt_out` floor stays `true`.
**Acceptance:** mono file diarises correctly; a deliberately swapped-speaker sample routes consent items to `manual_review` not a false pass.

### W4 — Checkpoint scorecard model
**Gap:** flat items; no section/branch/NA/manual/consent; every item auto-scored.
**Build:** migration `040`; extend `shared/types/scorecard.ts` and scorecard CRUD (`routes/scorecards.ts`, importer) to carry the new fields; CSV importer reads `section,item_type,applies_when,severity,expectation,ai_check`. Rework `services/scoring.ts`: resolve branch first, mark non-applicable items `na`, return `manual` items as `manual_review` (never sent to Claude, excluded from the AI denominator), enforce consent gates, per-checkpoint timestamp + result state. Auto-fail keyed to consent/regulatory breach category, not just weight.
**Tenant-scoping:** scorecards already per-org; no change to isolation.
**Acceptance:** an On-Risk call marks Referred-only items `na`; NA excluded from denominator; the 9 manual items never auto-scored; a missing consent gate hard-fails.

### W5 — Scorecard versioning
**Gap:** in-place mutation.
**Build:** migration `041`; copy-on-write on edit; pin `call_scores.scorecard_version` and journey scores. Historical calls render against their scored version.
**Acceptance:** editing a scorecard doesn't retroactively change past scores.

### W6 — Journey scoring engine *(biggest build; spec §9)*
**Gap:** scoring is strictly per-call; customer `avg_score` is an average of isolated calls.
**Build:** migration `042`; `services/journey.ts` — assemble a journey: all of a customer's calls within `history_window_days` (CloudTalk history via W2 client + local `customers`/`calls`). New `jobs/processors/score-journey.ts`: gather transcripts, resolve branch, score each checkpoint **across the whole set** (a consent/statement counts if present in any call, evidence tagged with `source_call_id`), write `journey_scores` + `journey_item_scores`. Interim fallback: if no clean sale link, score the wrap-up/close call with earlier calls as context. Add a `score-journey` job type.
**Tenant-scoping:** journeys are `organization_id`-scoped; window from the tenant's dialer connection.
**Acceptance:** a consent given in call 1 and a sale in call 3 produces one passing journey score; no per-partial-call false fails.

### W7 — Zoho inbound sale trigger *(spec §9)*
**Gap:** no inbound webhook; Zoho is outbound only.
**Build:** migration `043`; route `POST /api/integrations/zoho/sale` (also mount an alias `POST /webhooks/zoho` to match the spec's path) — verify `inbound_secret`, resolve tenant from the `zoho_connection`, extract the phone from `sale_phone_field`, resolve/create the `customer`, enqueue `score-journey`.
**Tenant-scoping:** tenant resolved from the connection that owns the inbound secret.
**Acceptance:** a Zoho "deal marked sale" post triggers exactly one journey score for the right tenant + customer; replayed/forged posts rejected.

### W8 — Zoho write-back v8 + QA module *(spec §11)*
**Gap:** `crm/v6`; no QA module; per-checkpoint evidence only on a breach Task.
**Build:** `services/zoho.ts` → `crm/v8`; push per-checkpoint evidence to the customer record; write the QA custom-module record (adviser + month + score) using `qa_module`/`qa_field_map`. Fire from journey completion (W6) as a discrete `writeback-zoho` job, not inline.
**Tenant-scoping:** module + field names from the tenant's `zoho_connection`.
**Acceptance:** journey score lands on the customer record and a QA record filterable by adviser + month.

### W9 — Cost controls *(spec §16)*
**Gap:** no sales triage; no Batch API.
**Build:** scope triage in the ingest/transcribe path — `scoring_scope=sales_only` defers scoring until a Zoho sale trigger (W7); `over_threshold` gates on `min_scoreable_seconds`. Move journey scoring to the Anthropic **Batch API** (non-live, 50% off) with the synchronous path kept only for on-demand rescore. Prompt caching already implemented — verify the cache prefix still covers the (now larger) checkpoint scorecard.
**Acceptance:** a non-sales call is transcribed but not scored under `sales_only`; journey scoring runs via Batch.

### W10 — Storage, retention, audit immutability *(spec §7/§15)*
**Gap:** audio on local disk not S3; no retention lifecycle; audit append-only by convention only.
**Build:** `services/storage.ts` — S3 (London) adapter behind the existing interface, keep AES-256-GCM (client-side) + signed URLs; env-select local vs S3 so dev is unaffected. Retention job (new repeatable on the `ingestion`/a `maintenance` queue) enforcing per-tenant `retention_days`: 2yr live → archive tier yr3–5 → delete at limit; deletion-on-request already works; add 30-day termination export/delete on `org.status=cancelled`. Migration `044` for audit trigger + REVOKE.
**Tenant-scoping:** retention window per tenant (W1).
**Acceptance:** S3 object exists encrypted; a call past `retention_days` is purged by the job; a manual `UPDATE audit_log` fails.

> Decision needed: confirm S3 London is required for launch. Spec, DPA and the sub-processor list all say S3 London — local disk is likely a compliance discrepancy, so this may be go-live-blocking rather than a fast-follow.

### W11 — Frontend surfaces *(spec §17)*
**Gap:** no integration-settings UI, no transcript timestamps, no branch display, review queue is breach-ranked not the manual items, no 2yr portal.
**Build (`packages/web`, `packages/admin-web`):**
- Integration settings pages: CloudTalk connection (W1/W2), scoring scope + threshold + retention (W1), Zoho connection incl. QA module (W7/W8).
- `TranscriptViewer.tsx` — render timestamps; evidence deep-links to the utterance.
- Journey/branch view on the call + a new journey detail page (W6): show branch, per-checkpoint result incl. `na`/`manual_review`, source call per evidence.
- A **manual-review queue** for `item_type=manual` items (distinct from the breach queue).
- 2-year portal window on the calls list (retention-aware).
**Acceptance:** an admin can configure CloudTalk + Zoho + scope entirely from the UI; a journey renders with branch + evidence provenance.

### W12 — Testing & rollout
Unit tests for the settings resolver and branch/NA/consent logic; an integration test replaying a signed CloudTalk post → ingest job → transcribe → (deferred) → Zoho sale → journey score → write-back; the 22-min diarisation sample as a fixture. Backfill: existing calls default to the new columns' defaults (behaviour unchanged); existing scorecards get `version=1`, `item_type='ai'`.

---

## 3. Sequencing & phasing

Dependency order: **W1 → (W2, W3, W4) → (W5, W6) → (W7, W8, W9) → W10/W11 → W12.**

Go-live is **13 July** (4 days out). Fitting all of the above by then is not realistic; proposed cut:

**Phase A — land before 13 July (correctness + compliance, low risk):**
- W1 config foundation (unblocks everything, no behaviour change).
- W2 signature verification + async 202 + delayed fetch (the ingest correctness fixes).
- W3 drop `multichannel` for mono + `diarize_model` + consent-speaker guard (fixes a real mis-scoring risk).
- W10 S3 decision — **if** compliance-blocking, this jumps into Phase A; otherwise flag it explicitly to the customer.

**Phase B — the product core, first fast-follow (1–2 weeks):**
- W4 checkpoint model, W6 journey scoring, W7 Zoho sale trigger. These three are the spec's reason for existing (§8/§9) and are large; do them together, properly, not rushed for the date.

**Phase C — completeness (following sprint):**
- W5 versioning, W8 v8 + QA module, W9 Batch/triage, W10 retention lifecycle + audit immutability, W11 frontend.

Honest framing for the customer: per-call scoring works today; multi-call journey scoring and the branch/NA/manual checkpoint model are Phase B. If Trust Point's sale genuinely spans several calls, per-call scoring will mis-fire on consent/regulatory items that live in an earlier call — so either land W6 before real scoring runs, or explicitly agree per-call v1 with them.

---

## 4. Decisions needed from you

1. **Retention period:** 5yr (spec) vs 7yr (compliance templates) — align both.
2. **S3 vs local disk:** is S3 London go-live-blocking (compliance) or a Phase C fast-follow?
3. **Go-live scope:** ship Phase A on 13 July with per-call scoring and journey/checkpoint as a declared fast-follow — agreed?
4. **Auto-fail policy (§8):** confirm which breach categories hard-fail a journey (consent + which regulatory items) — pending calibration.
5. **`/webhooks/*` paths:** keep the current `/api/ingestion/cloudtalk` + `/api/integrations/zoho/sale` and add spec-matching `/webhooks/*` aliases, or migrate wholesale?
