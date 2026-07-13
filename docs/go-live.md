# CallGuard go-live runbook

Covers the **application** (API + worker + tenant web app + superadmin app) and
the **landing site**. Read `docs/backup-and-restore.md` alongside this — backups
are a go-live blocker, not a follow-up.

---

## 1. Architecture recap

| Component | What it is | How it's served |
|---|---|---|
| **API** (`packages/api`, `dist/index.js`) | Express API + WebSocket streaming | Node process under PM2; also serves the tenant web app's static build in production |
| **Worker** (`dist/jobs/worker.js`) | BullMQ processors (transcribe, score, journeys, ingestion, retention, repair) | Separate Node process under PM2 |
| **Tenant web app** (`packages/web`) | React SPA | Built to `packages/web/dist`, served by the API (`express.static`) |
| **Superadmin app** (`packages/admin-web`) | React SPA (cross-tenant ops) | Built to `packages/admin-web/dist` — **NOT served by the API**; host separately (see §6) |
| **Landing site** (`landing/`) | Static HTML/CSS | Separate static host — see `landing/DEPLOY.md` |
| **Postgres** | System of record | Managed (AWS RDS today) |
| **Redis** | BullMQ queues + worker heartbeat | Managed or co-located |
| **External** | Deepgram (EU), Anthropic, Zoho, CloudTalk | Per-tenant creds encrypted at rest |

Single API instance + single worker instance is the intended scale (see
`ecosystem.config.js`). Both trap SIGINT/SIGTERM and drain gracefully.

---

## 2. Prerequisites

- A Linux host with **Node 20.19+**, PM2, and outbound HTTPS to Deepgram/Anthropic/Zoho.
- **Postgres** reachable via `DATABASE_URL`, with the provider CA bundle for
  `DATABASE_CA_CERT` (so TLS is verified — do not ship with `sslmode=no-verify`).
- **Redis** reachable via `REDIS_URL`.
- **Secrets** ready in a manager (not a committed file): `JWT_SECRET`,
  `ENCRYPTION_KEY` (32-byte hex, escrowed — never changes once data exists),
  `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `OPS_ALERT_EMAIL`.
- DNS for the app host and the landing host; TLS terminated at Cloudflare/nginx.

---

## 3. Configuration

1. Create `.env` from `.env.example` (every variable is documented there).
2. **Critical for production:**
   - `NODE_ENV=production`
   - `JWT_SECRET`, `ENCRYPTION_KEY` — from the secrets manager, never a default.
   - `DATABASE_CA_CERT` — set it; otherwise TLS is unverified.
   - `ALLOWED_ORIGINS` — the tenant + admin app URLs.
   - `TRUST_PROXY_HOPS` — match the real proxy chain (Cloudflare + nginx = 2), or
     rate-limit/audit IPs are wrong.
   - `APP_URL` — the public app URL (used in alert emails + Zoho redirect).
   - `OPS_ALERT_EMAIL` — so failed jobs page someone.
3. The API **fails fast at boot** if a production-required var is missing.

---

## 4. Build & deploy (app)

From the repo root on the host:

```bash
npm ci
npm run build            # shared -> api -> web -> admin-web
npm run migrate          # advisory-locked, transactional; idempotent
npm test                 # optional gate — 23 unit tests
pm2 start ecosystem.config.js   # or: pm2 reload ecosystem.config.js on redeploy
pm2 save
```

- `migrate` is safe to run on every deploy — already-applied files are skipped,
  and a concurrent deploy is serialised by the advisory lock.
- `pm2 reload` does a rolling restart; the API only cuts over once it signals
  `ready`, and the worker finishes in-flight jobs before exiting (PM2
  `kill_timeout` is set generously in `ecosystem.config.js`).

---

## 5. Reverse proxy & TLS

Terminate TLS at Cloudflare and/or nginx in front of the API. Minimum nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket streaming
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- Set `TRUST_PROXY_HOPS` to the number of proxies actually in front of the app.
- If the origin is reachable directly (not only through Cloudflare), restrict
  ingress to Cloudflare IP ranges — the rate-limit/audit IP trusts the
  `cf-connecting-ip` header (security-review item).

---

## 6. Superadmin app (separate hosting)

The API serves the **tenant** app only. Host `packages/admin-web/dist` separately:
either a second nginx `server{}` / subdomain (e.g. `admin.callguard…`) serving
the static build, or a static host. Point its API base at the same API origin.
Lock it down (IP allowlist / SSO) — it is the cross-tenant control plane.

---

## 7. Observability & backups (must be live at go-live)

- **Health:** point an uptime monitor at `GET /api/health/ready` (checks DB +
  Redis + worker heartbeat; 503 if any is down). `GET /api/health` is the cheap
  liveness probe.
- **Alerting:** `OPS_ALERT_EMAIL` set → failed jobs (after all retries) email
  ops. PM2 logs shipped/rotated (`pm2-logrotate`).
- **Backups:** cron `scripts/backup.sh` nightly with `OFFSITE_RSYNC_TARGET` to a
  second location; verify a restore per `docs/backup-and-restore.md`.

---

## 8. Landing site

Static HTML — no build step. Deploy per **`landing/DEPLOY.md`** (cPanel / SFTP /
rsync to the web root, DNS A records, Let's Encrypt/AutoSSL, and the
`hello@…` inbox/forwarder). The `.htaccess` handles HTTPS redirect, pretty URLs,
security headers, and caching. Keep the legal pages (privacy, terms, DPA,
sub-processors) in sync with the compliance templates the product generates.

---

## 9. Go-live checklist

- [ ] Secrets in a manager; `ENCRYPTION_KEY` escrowed; nothing sensitive in git
      (`.env` is gitignored — confirmed).
- [ ] `DATABASE_CA_CERT` set; `sslmode=no-verify` removed.
- [ ] `npm run build` clean, `npm test` green, `npm run migrate` applied.
- [ ] PM2 running API + worker; `pm2 save` + startup hook (`pm2 startup`).
- [ ] `GET /api/health/ready` returns 200 with all checks ok.
- [ ] TLS active on app + admin + landing; `TRUST_PROXY_HOPS` correct.
- [ ] Backup cron installed + one restore drill completed.
- [ ] `OPS_ALERT_EMAIL` receives a test failure alert.
- [ ] First tenant onboarded (see §10) and a real call scores end-to-end.

## 10. Onboarding the first tenant (Trust Point)

Use the DB onboarding script (bypasses the mandatory-2FA gate a fresh admin
would otherwise hit via the API):

```bash
# Edit the admin email first: packages/api/src/scripts/onboard/trustpoint.json
npm run onboard-tenant --workspace=packages/api -- --config src/scripts/onboard/trustpoint.json --dry-run
# review the plan, then run for real (drop --dry-run)
npm run onboard-tenant --workspace=packages/api -- --config src/scripts/onboard/trustpoint.json
```

This provisions the org + admin, sets the scoring policy, imports the 47-item
branched scorecard, and seeds the Knowledge Base sections. It prints the admin's
one-time temp password. Then follow `docs/trustpoint-onboarding.md` for the
CloudTalk/Zoho integration steps, the manual-item sign-off, and calibration.

---

## 11. Rollback

- **App:** `pm2 reload` the previous build (keep the last `dist/`), or redeploy
  the prior git tag. Migrations are additive — avoid destructive down-migrations;
  roll forward with a fix instead.
- **Scoring regressions:** switch a scorecard to `per_call` mode (independent of
  the Zoho trigger) to keep QA running while investigating journeys.
- **Data:** restore from the nightly backup per `docs/backup-and-restore.md`.
