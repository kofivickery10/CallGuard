# CLAUDE.md

Guidance for working in the CallGuard AI codebase.

## What this is

CallGuard AI provides AI compliance scoring for sales conversations. It transcribes
calls and scores them against a firm's scorecard — both live (as the call happens)
and after the fact. Target users are FCA-regulated advice firms, contact centres,
BPOs, and field-sales operations.

## Monorepo layout

npm workspaces. Four packages plus a static marketing site:

- `packages/shared` — TypeScript types, constants, and shared scoring logic
  (`@callguard/shared`). Built first; other packages depend on it.
- `packages/api` — Node + Express + TypeScript backend, BullMQ job worker, and
  WebSocket live-streaming server. PostgreSQL for data, Redis for queues.
- `packages/web` — React + Vite + TypeScript + Tailwind + Shadcn/UI customer app.
- `packages/admin-web` — React/Vite superadmin console (same stack as `web`).
- `landing/` — static marketing site (plain HTML/CSS/JS), deployed separately
  (see `landing/DEPLOY.md`). Not part of the npm workspace build.

Other top-level dirs: `docs/` (API + integration notes), `tools/`,
`sample_scorecards/`, `brand/`, plus generated PDF/HTML sales collateral.

## Common commands

Run from the repo root:

```bash
npm install            # install all workspaces
cp .env.example .env   # then fill in API keys

npm run migrate        # apply DB migrations (idempotent, tracked in _migrations table)

npm run dev:api        # API server on :3001
npm run dev:worker     # background job worker
npm run dev:web        # customer frontend on :5173
npm run dev:admin      # superadmin frontend

npm run build          # builds shared -> api -> web -> admin-web in order
```

Production runs under PM2 (`pm2 start ecosystem.config.js`), which launches
`callguard-api` and `callguard-worker` from the compiled `packages/api/dist/`.

Useful API package scripts (run via `--workspace=packages/api` or `cd` in):
`seed-demo`, `export-training-data`, `encrypt-existing` (re-encrypt stored files).

## Architecture notes

- **Processing pipeline:** uploads/ingestion → `transcription` queue (Deepgram) →
  `scoring` queue (Claude). Queues are BullMQ over Redis; workers live in
  `packages/api/src/jobs/worker.ts`, processors in `jobs/processors/`, queue
  definitions in `jobs/queue.ts`. There are also `ingestion` (SFTP poll) and
  `alerts` (delivery) queues.
- **AI:** Deepgram for transcription (EU endpoint by default for UK/EU data
  residency), Claude (Anthropic) for scoring/coaching/insights. Model IDs come
  from `CLAUDE_MODELS` in `@callguard/shared`; scoring logic is in
  `packages/api/src/services/scoring.ts`. The scorer supports a learning context
  (past corrections, firm exemplars, prior coaching).
- **Live scoring:** WebSocket stream server attached to the HTTP server in
  `packages/api/src/index.ts` (`services/stream-server.ts`, `live-scorer.ts`,
  `deepgram-stream.ts`).
- **API surface:** Express routers in `packages/api/src/routes/` (auth, calls,
  scorecards, alerts, breaches, ingestion, insights, superadmin, etc.), wired in
  `app.ts`. Diallers authenticate with API keys; browsers go through CORS.
- **Config:** all env access flows through `packages/api/src/config.ts`, which
  loads the repo-root `.env`. Required vars (`DATABASE_URL`, `JWT_SECRET`,
  `ENCRYPTION_KEY`) throw on startup if missing. **`ENCRYPTION_KEY` must never
  change once data is encrypted with it.**
- **Database:** raw SQL migrations in `packages/api/src/db/migrations/`, applied
  in filename order by `db/migrate.ts`. To change the schema, add the next
  numbered `NNN_description.sql` file — do not edit applied migrations.

## Conventions

- TypeScript everywhere, `strict` mode (`tsconfig.base.json`), ES modules with
  `Node16` resolution — **use `.js` extensions in relative imports** in `api`.
- Node >= 20.
- Dev uses `tsx watch`; builds use `tsc` (and `vite` for the web apps).
- Shared types are the contract between API and frontends — change them in
  `packages/shared/src/types/` and rebuild shared before depending packages.
- No automated test suite currently exists in the repo; verify changes by
  running the relevant dev server and exercising the affected flow.
