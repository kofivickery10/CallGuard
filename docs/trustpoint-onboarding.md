# Trust Point onboarding runbook

How to take Trust Point (FCA-regulated protection brokerage; CloudTalk dialer,
Zoho CRM, multi-call sales) from nothing to live QA scoring. Ordered by
dependency — each phase assumes the ones before it are done.

Trust Point is a **journey tenant**: a sale spans several calls and closes in
Zoho, so the primary scoring output is the journey, not the individual call.
That shapes the whole setup (scoring_scope, sale-trigger, journey scorecard).

> **Blocking dependency:** the journey UI (list, detail, manual-review queue,
> journey-breach display) is not built yet — see `docs/remediation-plan.md`
> section 3 and the review verdict. Do not run Trust Point on `journey` mode in
> production until that ships, OR run the calibration/soft-launch below on
> per-call mode first. This runbook is written for the target (journey) state
> and flags the per-call fallback where it matters.

---

## Phase 0 — What Trust Point must provide first

Collect these before touching the platform; several later phases block on them.

| Item | Needed for | Notes |
|---|---|---|
| Admin contact (name + email) | Tenant provisioning | Becomes the first admin user |
| Adviser roster (name, email, CloudTalk agent ID) | Team setup + call attribution | The CloudTalk agent ID maps to `users.external_agent_id` |
| QA Framework & Scoring Matrix (the June 2026 xlsx) | Scorecard | Already converted to `sample_scorecards/trustpoint/trustpoint-protection.csv` |
| The 6 remaining "manual vs AI" item decisions | Scorecard sign-off | Open question in the sample README — Trust Point must confirm |
| Sales Process v4 + both Wrap-Up scripts | Knowledge base | Uploaded to the `scripts` section |
| Regulatory word-for-word statement list | Knowledge base | Uploaded to the `compliance` section |
| CloudTalk API key ID + secret, webhook signing secret | Dialer integration | Generated in CloudTalk admin |
| Zoho admin who can authorise OAuth + create custom fields | CRM integration | Must have Zoho CRM admin rights |
| Data-processing sign-off (DPA, retention = 5 years confirmed) | Compliance | Generate the DPIA/ROPA/security docs for their records |

---

## Phase 1 — Provision the tenant (you, superadmin)

Create the org + first admin in one step (`POST /api/superadmin/tenants`):

```
{
  "org_name": "Trust Point Mortgage and Protection Services",
  "admin_name": "<their admin>",
  "admin_email": "<their admin email>",
  "plan": "enterprise",          // journeys/learning context want the top tier
  "subscription_notes": "..."
}
```

- Returns `temp_password` **once** — send it to the admin over a secure channel,
  not email/chat. They change it on first login (2FA enrolment is mandatory).
- Plans are `core | professional | enterprise`. Trust Point should be
  `enterprise` (multi-adviser, journey scoring, learning context).
- Seat billing = advisers with ≥1 scored call in the month; nothing to set now.

---

## Phase 2 — Organisation policy (their admin, or you on their behalf)

Organisation Settings → set the scoring policy (`PUT /api/organization/scoring-settings`)
and industry. Recommended Trust Point values:

| Setting | Value | Why |
|---|---|---|
| Industry / advice domain | `FCA-regulated protection insurance advice (life, critical illness, income protection)` | Frames the AI scoring prompt |
| `scoring_scope` | `sales_only` | Only fully score closed-sale journeys — cost control. **Requires a working Zoho sale-trigger (Phase 6); until then it safely falls back to per-call scoring** |
| `pass_threshold` | Confirm with their QA (default 70) | Their matrix weights items ~equally |
| `retention_days` | `1825` (5 years) | COBS 9.5 / MiFID II. Floored at 30 by validation |
| `transcription_mode` | `mono_diarize` | **Trust Point records mono**, so speaker split comes from diarisation (a heuristic, not a deterministic channel). See the consent-gate note below. |
| `adviser_channel` | `null` | N/A on mono — only applies to split-stereo recordings; leave unset. |
| `deepgram_region` | `eu` | UK data residency |

> **Mono + consent gates:** because Trust Point is mono, the adviser/customer
> split is a diarisation guess rather than a pinned channel. Where
> speaker-attribution confidence on a consent checkpoint is low, that item
> routes to **manual review** (in the Review Queue) instead of being auto-scored
> — the safe behaviour for a hard-consent point, but it means the 7 consent
> gates will land for human sign-off more often than they would on split-stereo.
> Factor that into the QA team's review workload.

---

## Phase 3 — Team / advisers

For each adviser (Team page, `POST /api/agents`):
- name, email, role `member`
- **`external_agent_id` = their CloudTalk agent ID** — this is how dialer
  webhooks attribute a call to the right adviser. Without it, calls come in
  unattributed and per-seat billing/adviser dashboards are wrong.

Admins (compliance/QA managers) get role `admin`. Advisers see only their own
calls; admins see everything.

---

## Phase 4 — Scorecard

1. **Import.** Scorecards → New → Import CSV →
   `sample_scorecards/trustpoint/trustpoint-protection.csv` (the merged 49-item
   branched card: 38 common + 5 on_risk + 3 referred + 3 manual). The importer
   reads all columns: `label, description, score_type, weight, severity,
   section, item_type, branch, expectation, ai_check, consent_gate`.
2. **Scoring mode** = `journey` (target) — a consent/statement counts if present
   anywhere in the sale, not per partial call. Use `per_call` only for the
   calibration/soft-launch fallback.
3. **Branch keywords.** The CSV pre-fills branches `on_risk` and `referred`. Set:
   - `on_risk` = default branch, leave keywords empty
   - `referred` = `referred for underwriting, referred to the underwriters, not active yet, no final decision`
4. **Consent gates** — 6 hard-consent items are pre-flagged (`consent_gate=true`).
   Confirm they match Trust Point's mandatory-yes points.
5. **Manual items** — 3 back-office items ship as `item_type=manual` (fact find
   on CRM, suitability review, data-entry accuracy). **Get Trust Point to confirm
   the other 6** their matrix counts as manual (open item in the sample README)
   and flip those to `manual` before go-live.
6. **Save.** Version starts at 1; every structural edit bumps it, and each
   score is pinned to the version it was judged against.

---

## Phase 5 — Knowledge base

Upload Trust Point's docs so the scorer has their expected call flow as context
(injected into the scoring prompt). Section types: `company_overview, products,
compliance, scripts, objections, glossary`.

| Document | Section |
|---|---|
| Sales Process v4 | `scripts` |
| Protection Wrap-Up Script — On Risk | `scripts` |
| Protection Wrap-Up Script — Referred | `scripts` |
| Regulatory word-for-word statements | `compliance` |
| Product/provider notes (optional) | `products` |

---

## Phase 6 — Integrations

### CloudTalk (dialer ingestion)
Integrations → CloudTalk → configure (`dialer_connections`, per-tenant, secrets
AES-256-GCM encrypted):
- API key ID + secret (from CloudTalk admin)
- Webhook signing secret (enables HMAC verification on the ingest webhook)
- `recording_fetch_delay_seconds` (default 60) — recordings finish processing
  on CloudTalk's side after the call-ended event; the ingest job now retries
  for ~30 min so a slow recording is not lost
- In CloudTalk, point the "call ended" webhook at `/webhooks/cloudtalk` with the
  CallGuard API key as the auth header

### Zoho (write-back + sale trigger)
Integrations → Zoho:
1. **Connect** — OAuth as a Zoho CRM admin (region `eu`, module `Leads` or
   `Contacts` to match where their sales live).
2. **Sale trigger** — set the inbound secret and `sale_phone_field` (the Zoho
   field carrying the customer phone, e.g. `Phone` or `Mobile`). In Zoho, add a
   Workflow Rule → Webhook on "deal marked as sale" → `/webhooks/zoho` with the
   CallGuard API key header and the `x-callguard-zoho-signature` HMAC. This is
   what fires journey assembly. **`sales_only` scope depends on this working.**
3. **QA write-back** — set `qa_module` and the field map. Trust Point must
   create these custom fields in Zoho (defaults shown):

   | Map key | Zoho field API name | Holds |
   |---|---|---|
   | `adviser` | `Adviser_Name` | Adviser the journey closed under |
   | `month` | `Period` | Scoring month |
   | `score` | `Compliance_Score` | Overall compliance score |
   | `result` | `Compliance_Result` | Pass/fail |
   | `link` | `CallGuard_Link` | Deep link to the scored journey |

   Field API names must be alphanumeric/underscore (validated at save).

---

## Phase 7 — Calibration (before trusting the scores)

1. Ingest 10–20 historical Trust Point calls (bulk upload, or let a day of
   CloudTalk calls flow in).
2. If journey UI isn't live yet, run these on a **`per_call`** copy of the
   scorecard so results are visible.
3. Sit the QA manager down with the AI scores vs their own manual scoring on the
   same calls. Use the calibration/score-correction flow to log disagreements —
   corrections feed the learning context.
4. Tune: pass_threshold, item rubrics/expectations, branch keywords, and the
   manual/AI split until AI and human agree on the calls that matter (especially
   the critical consent + regulatory items).
5. Only promote to `journey` + `sales_only` once calibrated **and** the journey
   UI is live.

---

## Phase 8 — Go-live & monitoring

- Confirm the ops shell is in place first (backups, graceful shutdown, health
  checks, alerting — remediation-plan sections 4/5). Do not put a 5-year FCA
  record on the platform without backups.
- Flip `scoring_scope` to `sales_only` once the Zoho trigger is verified.
- Watch: breach register volume (false-positive rate), failed-job alerts,
  journeys stuck in `pending` (the repair sweep re-enqueues, but a persistent
  backlog means Zoho payloads aren't matching — check phone normalisation),
  and Zoho write-back errors.
- Generate their compliance docs (DPIA, ROPA, security policy — all now say
  5 years) for their file.

---

## Open dependencies (must close before full go-live)

1. **Journey UI** — list, detail, manual-review queue, journey-breach display
   (remediation section 3). Trust Point can't operate journey mode without it.
2. **Trust Point's 6 manual-item decisions** — Phase 4 step 5.
3. **Ops shell** — backups, graceful shutdown, health/alerting, minimal tests
   (remediation section 4).
4. **Security hygiene** — rotate `.env` secrets, DB TLS verification
   (remediation section 5).

## Rollback / safety

- A bad scorecard edit never rewrites history — scores are version-pinned.
- Re-scores that fail keep the previous valid score (don't flip to failed).
- Retention is floored at 30 days and journeys/customers purge on termination.
- If journey scoring misbehaves, switch the scorecard to `per_call` — per-call
  auto-scoring is independent of the Zoho trigger and keeps QA running.
