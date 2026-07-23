# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CallGuard AI is a **standalone product**: AI compliance scoring for sales/advice
calls, built for FCA-regulated firms. It is not part of, and must not be
co-branded or conflated with, any other product or company.

## Standalone boundary — do not cross (non-negotiable)

CallGuard is a **separate business**. It has **nothing to do with** ProperLeads,
Switcheroo, Telegen, KOA, or any other product or company — nor with the
ProperLeads people (including Beau, Jordan, James, and Kim). When working on this
project:

- **Never** save anything about this project to AVA's brain or any shared
  ProperLeads memory (`memory_remember`, `memory_learn`, `memory_ingest`, etc.).
  Use only this repo's own local file memory.
- **Never** share, sync, post, or surface CallGuard information into the
  ProperLeads ecosystem — no Slack, SFTP, Sheets, Drive, Notion, or any
  ProperLeads MCP/connector. Its data, code, clients, and decisions stay here.
- **Never** conflate, co-brand, or cross-reference CallGuard with those products,
  in code, docs, or customer-facing copy.

If a task would move CallGuard information into any of those systems, stop and
flag it rather than proceeding.

## Commands

npm workspaces monorepo, Node 20+. Run from the repo root unless noted.

```bash
npm install                # install all workspaces
npm run migrate            # apply pending DB migrations (idempotent)

# Dev (each is a long-running process — run in separate terminals)
npm run dev:api            # API server on :3001
npm run dev:worker         # BullMQ job worker (transcription/scoring/etc.)
npm run dev:web            # tenant React app on :5173
npm run dev:admin          # superadmin console (separate Vite app)

npm run build              # build all packages (shared → api → web → admin)
npm run build:shared       # build just @callguard/shared (needed after editing shared types — api/web consume its dist)

npm test                   # runs shared + api test suites (vitest)
npm start                  # production: pm2 start ecosystem.config.js (api + worker)
```

**Single test / focused runs** (from the package dir):
```bash
cd packages/api && npx vitest run src/services/crypto.test.ts
cd packages/api && npx vitest run -t "part of the test name"
```

**There is no ESLint.** "Linting" is the TypeScript compiler: `npx tsc --noEmit -p tsconfig.json` in `packages/api`/`packages/shared`, `npx tsc --noEmit` in `packages/web`/`packages/admin-web`. After changing shared types, run `npm run build:shared` before typechecking api/web, since they resolve `@callguard/shared` from its built `dist`.

**One-off operational scripts** live in `packages/api/src/scripts/` and run via `tsx` (e.g. `npx tsx src/scripts/onboard-tenant.ts`, `seed-demo.ts`, `bulk-reprocess-tenant.ts`). They connect to whatever `DATABASE_URL` points at — usually production — so treat them as production tools.

## Architecture

### Monorepo packages
- **`packages/shared`** — types, constants, and the scoring maths shared by every other package. Editing it requires a rebuild (`build:shared`) before dependents typecheck.
- **`packages/api`** — Express server **and** the BullMQ worker (two separate entrypoints, one codebase): `src/index.ts` (HTTP) and `src/jobs/worker.ts` (queues). PM2 (`ecosystem.config.js`) runs them as `callguard-api` and `callguard-worker`.
- **`packages/web`** — the tenant-facing React/Vite/Tailwind app.
- **`packages/admin-web`** — the cross-tenant superadmin console (hosted separately; not served by the API).

### The call → score pipeline (the core of the system)
A call flows through BullMQ queues, each stage enqueuing the next:

1. **Ingest** — three sources: recurring SFTP polling (`sftp-poll`), dialler webhooks (`ingest-call`), and Zoho sale triggers (`assemble-journey`). CloudTalk is the primary dialler.
2. **Hydrate** (`hydrate-call`) — fetch and store the audio (encrypted at rest, AES-256-GCM), setting `file_key`.
3. **Transcribe** (`transcribe`) — Deepgram `nova-3` with diarisation and source-side PII/PCI/PHI redaction (personal data becomes typed tags like `[NAME_GIVEN_1]` and never enters storage or the LLM passes). Deepgram returns anonymous speaker *clusters*, not roles; `services/transcription.ts` maps cluster→Agent/Customer using a stereo-channel pin (exact) or, for mono, a "who spoke first + call direction" heuristic, and records a `speaker_attribution_confidence`.
4. **Cleanup** (`services/transcript-cleanup.ts`) — a Claude Haiku pass fixes mishearings and, when confidence < 1.0, verifies/corrects the Agent/Customer labels against conversational content. Streamed at a high token cap; a truncated result must never silently replace the transcript.
5. **Score** — either per-call (`score`) or per-**journey** (`score-journey`). Alerts are evaluated after scoring; scored journeys write back to Zoho.

### Per-call vs journey (sale) scoring
A **journey** is a "sale": multiple calls with one customer scored as a single compliance unit. An org's `scoring_scope` decides the mode: `sales_only` defers per-call scoring and waits for a Zoho sale trigger to assemble + score a journey; otherwise every call is scored on its own. `assembleJourney` is **idempotent** — an already-scored sale over the same calls is returned, not re-scored (so manual "Score sale" is a safe no-op on a scored sale; re-scoring is a deliberate admin-only action). Low-confidence consent-gate items route to a **manual review** queue rather than auto-scoring, to avoid false passes.

### Queues (defined in `packages/api/src/jobs/queue.ts`, dispatched by name in `worker.ts`)
`transcription`, `scoring` (`score` + `score-journey`), `ingestion` (`sftp-poll`, `ingest-call`, `hydrate-call`, `assemble-journey`), `alerts` (alert-rule delivery + `notify-email`), `maintenance` (`retention-purge`, `stuck-repair`).

### Data layer
PostgreSQL accessed via **raw SQL** through `pg` — no ORM. Use `query`, `queryOne`, and `withTransaction` from `src/db/client.ts`. Schema changes are **numbered `.sql` files** in `src/db/migrations/` (e.g. `056_*.sql`), applied in filename order by `src/db/migrate.ts` and tracked in the `_migrations` table. Add a new migration; never edit an applied one.

### Multi-tenancy & RBAC
Everything is scoped by `organization_id`. Roles: `admin`, `supervisor`, `viewer`, `adviser` (tenant), plus platform `superadmin`. Advisers are **scoped to themselves** (`ORG_WIDE_ROLES` excludes them). Route guards `requireAdmin` / `requireActioner` / `requireOrgView` live in `src/middleware/auth.js`.

### External integrations & notifications
- **Deepgram** — transcription. **Claude (Anthropic)** — transcript cleanup and scoring.
- **Zoho CRM** (`services/zoho.ts`) — inbound sale triggers, and QA write-back of the AI score/agent to a configurable field map on the tenant's QA module.
- **Notifications** (`services/notify.ts`, `alert-evaluator.ts`) — event- and rule-driven, delivered in-app, by email (Resend), or Slack webhook.

### Config
Runtime config is env-driven (`src/config.ts`, `.env`; see `.env.example`). Key vars: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `APP_URL`. Operational docs are in `docs/` (`go-live.md`, `cloudtalk-integration.md`, `zoho-integration.md`, `backup-and-restore.md`).

## UI / UX work — follow the design system

Any change that touches the UI must follow the guidelines. Read these first:

- **[BRAND_GUIDELINES.md](BRAND_GUIDELINES.md)** — identity, colour tokens (light + dark), type scale, logo, voice, iconography.
- **[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)** — layout, component recipes, states, accessibility, and the new-feature checklist (§8).

Non-negotiables (the rest is in the docs):

- **Colour:** only token classes (`text-text-secondary`, `bg-card`, `bg-fail-bg`, …). No raw hex, no `bg-white`/`text-black`, no `dark:` variants — dark mode falls out of tokens.
- **Type:** named tokens (`text-page-title`, `text-card-value`, `text-table-header`, `text-badge`, …). Avoid arbitrary `text-[Npx]`.
- **Components:** use the canonical recipes / existing components (badges, modals) in DESIGN_SYSTEM §4 — don't inline a new variant.
- **Every screen:** handle loading + empty + error states, works in light **and** dark mode, has focus rings + `aria-label`s, status conveyed by text/icon not colour alone.
- **Icons:** stroke SVGs (`strokeWidth="1.8"`), no emoji.

The implemented tokens in `packages/web/tailwind.config.js` + `src/index.css` are the
source of truth; keep the docs in step with them.
