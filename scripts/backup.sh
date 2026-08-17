#!/usr/bin/env bash
#
# CallGuard nightly backup: Postgres + the encrypted uploads directory.
#
# The two together ARE the FCA 5-year evidence record — neither is recoverable
# without the other, and neither is recoverable without ENCRYPTION_KEY (which
# is NOT backed up here — escrow it separately; see docs/backup-and-restore.md).
#
# Run from cron, e.g.:  0 2 * * *  /opt/callguard/scripts/backup.sh >> /var/log/callguard-backup.log 2>&1
#
# Required env (or set inline below):
#   DATABASE_URL     Postgres connection string
#   UPLOADS_DIR      Path to the encrypted audio directory (default ./uploads)
#   BACKUP_DIR       Where backups are written (default ./backups)
#   BACKUP_RETAIN_DAYS  Local copies to keep (default 14)
#   OFFSITE_RSYNC_TARGET  Optional rsync target for an off-box copy (second UK location)

set -euo pipefail

# A step failing partway through must stop the script loudly rather than
# leave a partial/corrupt backup that looks complete — trap any error and
# name the line/command that caused it before exiting non-zero.
trap 'echo "[backup] FAILED at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

: "${DATABASE_URL:?DATABASE_URL must be set}"
UPLOADS_DIR="${UPLOADS_DIR:-./uploads}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

# libpq (and therefore pg_dump, unlike the app's own `pg` npm client) doesn't
# understand sslmode=no-verify — it's a pg-the-npm-package-only alias — so a
# production DATABASE_URL carrying it makes --dbname reject the whole URL and
# the dump aborts before writing anything. db/client.ts hits the same problem
# and solves it the same way: strip sslmode out of the URL and hand SSL
# behaviour to libpq separately instead of via the connection string.
#
# no-verify (and its cousin `true`) mean "encrypt, but don't verify the
# server cert" — libpq's equivalent of that is `require`, not a verify-*
# mode, so that's what unrecognised/no-verify values map to here. A
# libpq-native value (require/prefer/allow/disable/verify-ca/verify-full) in
# the URL is left alone.
#
# The URL is split on the first unencoded `?` and the query string rebuilt
# param-by-param (rather than regex-stripped in place) so that removing
# sslmode never leaves a stray leading/doubled/trailing `&` behind — that
# depended on sslmode being the last query param, which production URLs
# happen to do today but aren't guaranteed to keep doing.
DB_URL_BASE="${DATABASE_URL%%\?*}"
DB_URL_QUERY=""
if [[ "${DATABASE_URL}" == *'?'* ]]; then
  DB_URL_QUERY="${DATABASE_URL#*\?}"
fi

RAW_SSLMODE=""
DB_URL_KEPT_PARAMS=()
if [[ -n "${DB_URL_QUERY}" ]]; then
  IFS='&' read -r -a DB_URL_PARAMS <<< "${DB_URL_QUERY}"
  unset IFS
  for DB_URL_PARAM in "${DB_URL_PARAMS[@]}"; do
    DB_URL_PARAM_KEY_LOWER="$(printf '%s' "${DB_URL_PARAM%%=*}" | tr '[:upper:]' '[:lower:]')"
    if [[ "${DB_URL_PARAM_KEY_LOWER}" == "sslmode" ]]; then
      RAW_SSLMODE="${DB_URL_PARAM#*=}"
    else
      DB_URL_KEPT_PARAMS+=("${DB_URL_PARAM}")
    fi
  done
fi

DB_URL_NO_SSLMODE="${DB_URL_BASE}"
if [[ ${#DB_URL_KEPT_PARAMS[@]} -gt 0 ]]; then
  DB_URL_NO_SSLMODE="${DB_URL_BASE}?$(IFS='&'; echo "${DB_URL_KEPT_PARAMS[*]}")"
fi

case "${RAW_SSLMODE}" in
  require|prefer|allow|disable|verify-ca|verify-full)
    export PGSSLMODE="${RAW_SSLMODE}"
    ;;
  '')
    # No sslmode in the URL at all — leave PGSSLMODE alone (unset, or
    # whatever the caller's environment already has) so a plain local
    # DATABASE_URL keeps working exactly as before.
    ;;
  *)
    # no-verify / true — the pg-npm-only aliases that made pg_dump abort.
    export PGSSLMODE="require"
    ;;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_DIR}/${STAMP}"
mkdir -p "${DEST}"

echo "[backup] ${STAMP} starting"

# 1. Postgres — custom format (-Fc) so it restores with pg_restore and is
#    compressed. This is the scores/breaches/journeys/audit record.
echo "[backup] dumping database..."
pg_dump --format=custom --no-owner --dbname="${DB_URL_NO_SSLMODE}" --file="${DEST}/db.dump"

# 2. Uploads — already ciphertext on disk, so an off-box copy is safe to store
#    anywhere. Tar + gzip preserves the key layout the DB references.
echo "[backup] archiving uploads from ${UPLOADS_DIR}..."
if [ -d "${UPLOADS_DIR}" ]; then
  tar -czf "${DEST}/uploads.tar.gz" -C "$(dirname "${UPLOADS_DIR}")" "$(basename "${UPLOADS_DIR}")"
else
  echo "[backup] WARNING: uploads dir ${UPLOADS_DIR} not found — skipping"
fi

# 3. Checksum manifest so a restore can verify integrity.
( cd "${DEST}" && sha256sum ./* > SHA256SUMS )

echo "[backup] wrote ${DEST}"

# 4. Off-box copy (strongly recommended — a single-disk failure otherwise
#    destroys the record the disk was the only copy of).
if [ -n "${OFFSITE_RSYNC_TARGET:-}" ]; then
  echo "[backup] syncing to ${OFFSITE_RSYNC_TARGET}..."
  rsync -a "${DEST}/" "${OFFSITE_RSYNC_TARGET}/${STAMP}/"
else
  echo "[backup] NOTE: OFFSITE_RSYNC_TARGET unset — backup exists only on this host. Set it for disaster recovery."
fi

# 5. Local retention — prune old dated folders.
echo "[backup] pruning local backups older than ${BACKUP_RETAIN_DAYS} days..."
find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime "+${BACKUP_RETAIN_DAYS}" -exec rm -rf {} +

echo "[backup] ${STAMP} complete"
