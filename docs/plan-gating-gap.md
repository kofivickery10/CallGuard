# Plan gating vs the pricing page — gap analysis

Analysis only. No feature gate, plan name or price was changed in this run
(the only code change is the in-app "live coaching" wording fix described at
the bottom). The owner confirmed on 14 Sep 2026 that `landing/pricing.html`
(Starter £199 / Growth £299 / Pro £399) is the contract; the code's plan
gates (`packages/shared/src/types/coaching.ts`) predate that and disagree
with it in several places. This document is what the owner needs to decide
before any gate is changed.

## What the owner has to decide

1. **Journey (sale) scoring has no plan gate at all**, and it is the
   *default* scoring mode (`scoring_scope` defaults to `'sales_only'` —
   `packages/api/src/db/migrations/038_org_scoring_settings.sql:6-7`). The
   pricing page puts journey scoring on Pro only. The one paying tenant today
   is on the Starter-equivalent plan and has 223 scored sales built on it
   (see Tenant impact). Gating this as written would take the tenant's core
   deliverable away mid-contract.
2. **AI learning, exemplars and per-agent coaching memory are on every
   plan** in code; the pricing page reserves them for Growth+. The same
   `coaching` flag also gates the coaching *draft* that pricing.html says is
   included in every plan's shared engine — so one flag currently covers two
   things pricing.html splits across tiers.
3. **Live streaming is gated from Growth** in code; pricing.html puts it on
   Pro only.
4. **Reconciliation has no plan gate at all** — it is a per-org boolean
   switched on by CallGuard staff, independent of `plan`. The owner has
   decided it belongs on Pro. Both organisations in production currently
   have it on, one of them on the Starter-equivalent plan.
5. **Slack alerts, HMAC webhooks and Zoho/CRM write-back have no plan gate**
   — pricing.html puts them on Growth+.
6. **The plan names in code (Core/Professional/Enterprise) don't match the
   site (Starter/Growth/Pro)**, and the code names are what a tenant admin
   and CallGuard staff actually see (billing page, org settings, the
   superadmin console). The per-seat prices do match (£199/£299/£399 —
   `packages/shared/src/constants.ts:142-146`).

## 1. Gap table

Plan tiers below use the code's names; read `core = Starter`,
`professional = Growth`, `enterprise = Pro` throughout.

| Feature | Enforced at | Current plan (code) | Contract plan (pricing.html) | Gap |
|---|---|---|---|---|
| Plan names | `packages/shared/src/types/coaching.ts:1-9` (`PLAN_LABELS`); surfaced in `packages/web/src/pages/BillingOverview.tsx:42,137`, `packages/web/src/pages/Welcome.tsx:115-128`, `packages/admin-web/src/pages/CreateTenantModal.tsx:11,83` | Core / Professional / Enterprise | Starter / Growth / Pro | Name-only mismatch, visible to tenants and to CallGuard staff creating tenants. Prices already match (`packages/shared/src/constants.ts:142-146`). |
| Per-call coaching draft (breach register + coaching text) | `coaching:['core','professional','enterprise']` — `coaching.ts:186`; used at `packages/api/src/jobs/processors/score.ts:147` | All plans | All plans ("breach register and coaching drafts" is in the shared-engine intro, not a per-tier bullet) | No gap for this half of the flag. |
| Per-agent coaching memory (prior coaching fed into the scoring prompt) | Same `coaching` flag, second use — `packages/api/src/services/learning-context.ts:112` | All plans | Growth+ only | Gap. The single `coaching` flag conflates two things the contract splits across tiers; fixing this needs a new flag, not a rename. |
| AI learning from corrections + exemplar library | `ai_learning:['core','professional','enterprise']` — `coaching.ts:187`; enforced at `packages/api/src/services/learning-context.ts:17` | All plans | Growth+ only | Gap. Starter tenants get Growth-tier calibration for free. |
| AI insights & trends | `insights:['core','professional','enterprise']` — `coaching.ts:188`; enforced at `packages/api/src/routes/insights.ts:17` | All plans | **Not on pricing.html at all** (no plan bullet mentions it) | Not one of the named mismatches, but there is nothing in the contract to gate it against. Needs an owner decision on which tier it belongs to, or that it stays a free add-on. |
| Customer tracking (the Customers/journey-browse list page, grouped by phone number) | `customer_journey:['core','professional','enterprise']` — `coaching.ts:189`; enforced at `packages/api/src/routes/customers.ts:26` | All plans | Not named on pricing.html; distinct from "journey (sale-level) compliance scoring" below | Not a named mismatch in the brief, but worth the owner's eye — it's a UI convenience over the same data journey scoring produces, so if journey scoring becomes Pro-only, this page's continued availability to Starter/Growth needs a decision too. |
| **Sale (journey) compliance scoring** — `assemble-journey`, `score-journey`, viewing a sale in `/journeys/*`, and `scoring_scope='sales_only'` (the column default) | **No `hasFeature` check anywhere** in `packages/api/src/jobs/processors/assemble-journey.ts`, `score-journey.ts`, `packages/api/src/services/journey.ts`, or `packages/api/src/routes/journeys.ts`. Confirmed in the tenant-facing feature matrix too: `packages/web/src/pages/OrganizationSettings.tsx:367` lists "Multi-call sale scoring" with `has: () => true` | All plans, unconditionally, and it is the *default* mode a new org is created in | Pro only | Largest gap. Not opt-in — every org scores sales by default unless a staff member sets `scoring_scope` to something else. |
| Live mid-call streaming + breach detection | `live_streaming:['professional','enterprise']` — `coaching.ts:191`; enforced at `packages/api/src/routes/stream.ts:42,195` | Growth+ | Pro only | Gap, one tier too low. No production tenant is actually using it yet (see Tenant impact — 0 orgs hold a streaming-enabled API key), so today this is a latent gap, not a live regression. |
| "Live coaching" flag | `live_coaching:['professional','enterprise']` — `coaching.ts:192`; surfaced only as a label in `packages/web/src/pages/OrganizationSettings.tsx:377` and `packages/admin-web/src/pages/TenantDetail.tsx:15` | Growth+ (cosmetic only) | Not built; not on any plan on pricing.html | Not a pricing gap so much as a "this doesn't exist" gap — the flag gates nothing (no route or job checks it). PRODUCT.md ("Not built: live in-call AI coaching") already says this must never be presented as available. `packages/web/src/pages/OrganizationSettings.tsx:377` still lists it as a plan feature; out of scope for this run (the brief scoped the one safe fix to `coaching.ts:13` only), flagging for the owner to fold into the same decision. |
| Reconciliation (calls checked against the insurer application) | Per-org boolean `organizations.reconciliation_enabled`, switched by CallGuard staff via `packages/api/src/routes/superadmin.ts:1175-1193`, read at `packages/api/src/services/reconciliation-runs.ts:69-73`, surfaced to tenants via `packages/web/src/hooks/useOrgFeatures.ts:23` | Independent of `plan` entirely | **Owner's decision: belongs on Pro** | Gap by design of the current mechanism, not an accident — it was deliberately built as a staff-controlled per-firm switch, before there was a Pro tier concept. Needs folding into `FEATURES` (or kept as a staff switch layered under a Pro-plan default) per the owner's call. |
| Slack alerts + HMAC-signed webhooks | No `hasFeature`/plan check in `packages/api/src/services/slack.ts` or `packages/api/src/services/webhook-delivery.ts` | All plans | Growth+ only | Gap. |
| CRM / Zoho write-back | No `hasFeature`/plan check in `packages/api/src/services/zoho.ts` or `packages/api/src/services/score-writeback.ts` | All plans | Growth+ only | Gap. |
| Email alerts on critical breaches | No plan check (`packages/api/src/services/alert-evaluator.ts`, `notify.ts`) | All plans | Starter+ (i.e. all plans) | No gap — matches. |
| Upload / REST API ingest | No plan check (`packages/api/src/routes/ingestion.ts`) | All plans | Starter+ (i.e. all plans) | No gap — matches. |
| SFTP ingestion | No plan check; listed as always-on in `packages/web/src/pages/OrganizationSettings.tsx:373` | All plans | Not named on pricing.html at all | Same pattern as Reconciliation used to be — an ops-configured integration outside the pricing ladder. Not one of the brief's named mismatches; flagged for completeness. |
| Dedicated support | `dedicated_support:['enterprise']` — `coaching.ts:194` | Pro only | Pro ("Priority support") | No gap — matches, though it gates nothing in code (support is a process, not a code path); cosmetic only. |
| White-label branding | `white_label:['enterprise']` — `coaching.ts:195` | Pro only | Not named on pricing.html at all | Not a named mismatch, but nothing in the contract to check it against. Gates nothing in code today either. |
| Score-only display mode | `score_only:[]` — `coaching.ts:197`, i.e. no plan grants it by default; per-tenant `feature_overrides` only, enforced at `packages/api/src/routes/share.ts:245` and `packages/web/src/context/AuthContext.tsx:177` | Not plan-tied, by design | Not on pricing.html | No gap — this one was built deliberately outside the plan system and should stay that way. |
| "Multi-tenant client scorecards and portals" (Pro bullet on pricing.html) | No `FeatureFlag`, no dedicated route or table found for this as a distinct capability | N/A | Pro only | No code representation to check the gate against. Either this describes an existing always-on capability (per-org scorecard versioning, which every plan already has) under a different name, or it isn't built yet. Needs the owner to say which, before it can be gated or the pricing copy corrected. |

## 2. Tenant impact (read-only production query, 15 Sep 2026)

Per the brief, this was a **read-only session**: `SET LOCAL
default_transaction_read_only = on` for the whole transaction, `SELECT`
statements only, ended with `ROLLBACK`. No write was attempted or possible.
No customer personal data is reproduced below — only organisation names,
plan, and product-config columns (plan, scoring scope, reconciliation flag,
counts).

Production currently has **two** organisations:

| Organisation | Plan (code) | Status | Scoring scope | Reconciliation enabled | Scored sales (journeys) | Notable overrides |
|---|---|---|---|---|---|---|
| Trust Point Mortgage and Protection Services | `core` (Starter) | active | `sales_only` | **on** | **223** | `feature_overrides`: `score_only: true`, `live_coaching`/`live_streaming`/`white_label`: explicitly `false` |
| Brookfield Protection (demo tenant) | `enterprise` (Pro) | active | `sales_only` | on | 4 | none |

No org currently holds an API key with `allow_streaming = true` (0 rows),
and no user has a `plan_override` set.

What each org would gain or lose if the gates in section 1 were changed to
match pricing.html exactly, with no grandfathering:

- **Trust Point (Starter)** would **lose**: journey/sale scoring (their
  primary deliverable — 223 scored sales already exist and their whole
  workflow is built on CloudTalk → Zoho sale-trigger → journey score),
  reconciliation (a paid, contracted module — see the Trust Point data
  capture memory, deal value £2,000), AI learning from corrections, the
  exemplar library, and per-agent coaching memory. It would **keep** email
  alerts, upload/API ingest, breach register, coaching drafts, and (already
  overridden off) live streaming/live coaching/white-label. This is the
  scenario the owner needs to rule out before any gate changes — a live,
  paying tenant would regress on its core use case and a module it is
  already paying for.
- **Brookfield (Pro/demo)** would **gain** nothing new (already the top
  tier) and lose nothing, since it already sits on the plan the contract
  maps everything to.

Because there are only two organisations in production and one of them
already exceeds every proposed Starter-tier restriction, the practical
"blast radius" of a straight code-to-contract cutover is small in tenant
count but large in impact for the one paying tenant.

## 3. Rollout note (not applied — for approval)

Goal: make the code match pricing.html **without taking anything away from
an existing tenant mid-contract**.

**Recommended shape — grandfather by dated cutover plus a per-org
escape hatch, not a new plan tier:**

1. Add a `grandfathered_at` (or reuse `feature_overrides`) mechanism so an
   org created before the cutover date keeps its current effective feature
   set, while an org created after gets the contract's gates.
   - Simplest version: a migration that, for every org that exists at
     migration time, writes an explicit `feature_overrides` entry for every
     flag whose contract tier is *stricter* than what they currently have
     (e.g. Trust Point would get `ai_learning: true`, `customer_journey:
     true`, and — new flag — `journey_scoring: true`, `reconciliation:
     true` written into its own `feature_overrides`, pinning today's
     behaviour regardless of future plan changes).
   - This uses the override mechanism that already exists
     (`hasFeature`'s `overrides` parameter, `coaching.ts:200-212`) rather
     than inventing a new one.
2. Introduce the two flags the current `FEATURES` map is missing before
   touching any gate:
   - `journey_scoring` (new) — currently unconditional; needs its own flag
     so it can be set to `['enterprise']` without being silently merged into
     an existing flag that something else also depends on.
   - Split `coaching` into `coaching_draft` (stays on every plan) and
     `coaching_memory` (moves to Growth+), so the per-call draft doesn't
     regress when per-agent memory is restricted.
   - Fold `reconciliation_enabled` into the same `hasFeature`/override
     model (`FEATURES.reconciliation = ['enterprise']`), replacing the
     ad hoc staff-only switch with a plan default a staff override can still
     lift for a specific firm — same pattern as `score_only` today.
3. Only once every existing org has an explicit override pinning its
   current behaviour should the `FEATURES` map itself be changed to match
   pricing.html and the plan names renamed (`core`→`starter`,
   `professional`→`growth`, `enterprise`→`pro` — a rename migration in the
   same shape as `025_plan_rename.sql`, which already did this exercise
   once).
4. Fix the "live coaching" label in the tenant-facing feature matrix
   (`packages/web/src/pages/OrganizationSettings.tsx:377`) at the same time
   as the flag it decorates is either removed or genuinely wired up — not
   before, and not as part of this analysis (out of scope here; the brief
   scoped the one text fix to `coaching.ts:13`, done below).

**What a migration would need to do:**
- Read every row in `organizations`, compute today's effective feature set
  under the *current* (pre-contract) `FEATURES` map for that org's plan,
  and write any flag that the *new* map would deny into that org's
  `feature_overrides` as `true`. Idempotent: re-running it should not
  overwrite an override a superadmin has since set deliberately (check
  `hasOwnProperty` before writing, matching `hasFeature`'s own precedence
  rule at `coaching.ts:207`).
- Log a superadmin audit event per org touched (the existing
  `recordAuditEvent` pattern used elsewhere in `superadmin.ts`), so the
  grandfathering is itself visible in the audit trail, not a silent data
  change.
- Not touch `plan` itself in the same migration as the rename — rename and
  grandfather are separable; do the grandfather first, verify nothing
  regresses, then rename.

**Rollback:** because grandfathering only *adds* `feature_overrides` keys
and the plan rename is a straight value swap (as `025_plan_rename.sql`
already demonstrates for the same three-value enum), rollback is: (a) a
down-migration that clears the specific override keys the up-migration
added — recorded, so it doesn't touch overrides a human set since — and
(b) a second down-migration that reverses the plan-name `UPDATE`s. Neither
requires a backup restore; both are plain `UPDATE`s over two organisations
today, so the actual blast radius of a bad rollout or a rollback is very
small at current tenant count, but the same migration should still be
written to be safe at 200+ tenants, since PRODUCT.md and the owner's
intent are for CallGuard to grow past two.

## 4. The wording fix made in this run

`packages/shared/src/types/coaching.ts:13` (`PLAN_DESCRIPTIONS.professional`)
said "Adds real-time call monitoring and live coaching". Live in-call AI
coaching is not built (PRODUCT.md, "Not built: live in-call AI coaching");
what Professional/Growth actually adds today is live streaming with
mid-call breach detection. Changed to:

```
professional: 'Adds real-time call monitoring and live breach detection',
```

No feature gate, plan name, or price was touched.

**Validation run for this change:**
- `npm run build:shared` — passed.
- `cd packages/api && npx tsc --noEmit -p tsconfig.json` — passed, no errors.
- `cd packages/web && npx tsc --noEmit` — passed, no errors.
- `npm test` (repo root) — 54 test files, 1280 tests, all passed.
