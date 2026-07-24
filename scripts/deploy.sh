#!/usr/bin/env bash
#
# CallGuard build & deploy — the one-command version of docs/go-live.md §4.
#
# Runs, in order: install -> build -> migrate -> (optional) test -> PM2
# start/reload -> health check. Safe to re-run: migrations are idempotent and
# advisory-locked, and a redeploy does a rolling PM2 reload (the API only cuts
# over once it signals 'ready'; the worker drains in-flight jobs first).
#
# Run from the repo root on the host:  npm run deploy   (or: scripts/deploy.sh)
#
# Env toggles:
#   SKIP_TESTS=1     skip the `npm test` gate (default: run it)
#   SKIP_INSTALL=1   skip `npm ci` (e.g. deps unchanged since last deploy)
#   HEALTH_URL=...   readiness endpoint to poll (default http://127.0.0.1:3001/api/health/ready)
#   HEALTH_RETRIES=N attempts, 2s apart, before failing (default 15)

set -euo pipefail

# Always operate from the repo root, wherever the script is invoked from.
cd "$(dirname "$0")/.."

SKIP_TESTS="${SKIP_TESTS:-}"
SKIP_INSTALL="${SKIP_INSTALL:-}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health/ready}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"

echo "[deploy] starting from $(pwd) (commit $(git rev-parse --short HEAD 2>/dev/null || echo 'n/a'))"

# 1. Install — clean, lockfile-exact. Skippable when deps are unchanged.
if [ -n "${SKIP_INSTALL}" ]; then
  echo "[deploy] SKIP_INSTALL set — skipping npm ci"
else
  echo "[deploy] installing dependencies (npm ci)..."
  npm ci
fi

# 2. Build all workspaces: shared -> api -> web -> admin-web.
echo "[deploy] building..."
npm run build

# 3. Migrate — advisory-locked, transactional, idempotent. Applied files skip.
echo "[deploy] applying database migrations..."
npm run migrate

# 4. Test gate — optional, on by default.
if [ -n "${SKIP_TESTS}" ]; then
  echo "[deploy] SKIP_TESTS set — skipping test gate"
else
  echo "[deploy] running tests..."
  npm test
fi

# 5. PM2: rolling reload if already running, otherwise first start. Detect on
#    the API process; both processes live in the same ecosystem file.
if pm2 describe callguard-api >/dev/null 2>&1; then
  echo "[deploy] reloading PM2 processes (rolling)..."
  pm2 reload ecosystem.config.js
else
  echo "[deploy] starting PM2 processes (first run)..."
  pm2 start ecosystem.config.js
fi
pm2 save

# 6. Health check — poll readiness (DB + Redis + worker heartbeat) so a broken
#    deploy fails loudly here rather than being discovered by a user.
echo "[deploy] waiting for readiness at ${HEALTH_URL}..."
for i in $(seq 1 "${HEALTH_RETRIES}"); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "[deploy] ✅ healthy — deploy complete"
    exit 0
  fi
  echo "[deploy]   not ready yet (attempt ${i}/${HEALTH_RETRIES}); retrying in 2s..."
  sleep 2
done

echo "[deploy] ❌ readiness check failed after ${HEALTH_RETRIES} attempts." >&2
echo "[deploy]    Inspect: pm2 logs   |   pm2 status   |   curl -v ${HEALTH_URL}" >&2
exit 1
