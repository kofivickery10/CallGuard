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

: "${DATABASE_URL:?DATABASE_URL must be set}"
UPLOADS_DIR="${UPLOADS_DIR:-./uploads}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_DIR}/${STAMP}"
mkdir -p "${DEST}"

echo "[backup] ${STAMP} starting"

# 1. Postgres — custom format (-Fc) so it restores with pg_restore and is
#    compressed. This is the scores/breaches/journeys/audit record.
echo "[backup] dumping database..."
pg_dump --format=custom --no-owner --dbname="${DATABASE_URL}" --file="${DEST}/db.dump"

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
