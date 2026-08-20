# Backup & restore runbook

CallGuard stores a regulated firm's call-QA evidence for **5 years** (COBS 9.5 /
MiFID II). Three things must survive a disk failure, and **all three are
required together** — any one missing makes the record unrecoverable:

1. **Postgres** — scores, breaches, journeys, the append-only audit log, tenant
   config (encrypted secrets).
2. **The uploads directory** — the call audio, encrypted at rest (AES-256-GCM).
3. **`ENCRYPTION_KEY`** — decrypts both the stored secrets and the audio. It is
   deliberately **not** in any backup. Escrow it separately (see below).

## What runs

`scripts/backup.sh` produces, per run, a timestamped folder containing:
- `db.dump` — `pg_dump -Fc` custom-format dump
- `uploads.tar.gz` — the (already-ciphertext) audio directory
- `SHA256SUMS` — integrity manifest

Schedule it nightly via cron on the app host:

```cron
0 2 * * *  cd /opt/callguard && DATABASE_URL=... UPLOADS_DIR=/opt/callguard/uploads \
  BACKUP_DIR=/var/backups/callguard OFFSITE_RSYNC_TARGET=backup@dr-host:/callguard \
  ./scripts/backup.sh >> /var/log/callguard-backup.log 2>&1
```

Set `OFFSITE_RSYNC_TARGET` to a **second UK location** (DR host, or an
object-store mount). Without it the backup lives only on the host it is backing
up, which does not survive that host failing. Local copies are pruned after
`BACKUP_RETAIN_DAYS` (default 14); keep the off-box copies for the full 5-year
retention (configure lifecycle on the DR target).

## ENCRYPTION_KEY escrow

- Store the production `ENCRYPTION_KEY` in a secrets manager (or a sealed
  offline copy held by two named people), **separate from the backups**.
- It must never change once data exists — rotating it in place makes all prior
  audio and secrets undecryptable. Key rotation requires the re-encryption
  script (`packages/api/src/scripts/encrypt-existing-files.ts`) run against live
  data, not an env edit.

## Client version must be >= the server

`pg_dump` refuses to dump a server newer than itself, and `pg_restore` has the
same constraint. This is not theoretical: on the production host the managed
database was upgraded to Postgres 18 while the box still had only the client
Ubuntu ships (16), so **every backup aborted at the dump step**. Ubuntu's own
repositories carry 16 and nothing newer, so the fix is the PGDG repo:

```bash
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
. /etc/os-release
sudo sh -c "echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main' > /etc/apt/sources.list.d/pgdg.list"
sudo apt update && sudo apt install -y postgresql-client-18   # match the server
```

A second trap: on Debian and Ubuntu, `pg_dump` on `PATH` is postgresql-common's
`pg_wrapper`, which chooses a version from its own configuration rather than
the newest installed one — so installing the right client is not sufficient,
and `pg_dump --version` can still report the old one. `backup.sh` therefore
resolves the newest `/usr/lib/postgresql/*/bin/pg_dump` itself (overridable
with `PG_DUMP`) and compares majors against the server before dumping, failing
with what to install rather than libpq's terser "server version mismatch".

Do the same by hand when restoring: call the versioned binary, e.g.
`/usr/lib/postgresql/18/bin/pg_restore`, rather than trusting `PATH`. **Expect
this to bite again** the next time the managed database's major version moves.

## Restore procedure

On a clean host with the same major Postgres version and Node runtime:

1. **Provision** Postgres + Redis, install the app, `npm ci && npm run build`.
2. **Restore Postgres:**
   ```bash
   createdb callguard
   pg_restore --no-owner --dbname="$DATABASE_URL" /path/to/<stamp>/db.dump
   ```
3. **Restore uploads:**
   ```bash
   tar -xzf /path/to/<stamp>/uploads.tar.gz -C /opt/callguard/
   # verify it landed at the path UPLOADS_DIR points to
   ```
4. **Set env**, critically the **same `ENCRYPTION_KEY`** as the source system,
   plus `DATABASE_URL`, `REDIS_URL`, and the API keys (from the secrets manager).
5. **Verify integrity:** `cd <stamp> && sha256sum -c SHA256SUMS`.
6. **Start** (`npm run start` / PM2). Migrations are idempotent — run
   `npm run migrate` to ensure schema is current.
7. **Smoke-test:** hit `GET /api/health/ready` (expects DB + Redis + worker all
   ok), open a scored call and confirm the audio plays (proves the key decrypts
   the restored files), and confirm the audit log is intact.

## Test the restore

A backup you have never restored is a hope, not a backup. Do a full restore to a
scratch host at least **quarterly**, run the smoke test above, and record the
date + result. This is also the evidence an auditor will ask for.

## What is NOT backed up (and is fine)

- **Redis** — only transient job queues + the worker heartbeat; rebuilt on
  restart. In-flight jobs at crash time are recovered by BullMQ or re-enqueued
  by the stuck-job repair sweep.
- **`node_modules` / build output** — reproduced by `npm ci && npm run build`.
