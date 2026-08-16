import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import * as sftp from '../../services/sftp.js';
import { parseFilename } from '../../services/filename-parser.js';
import { ingestCall, inferMimeType } from '../../services/ingestion.js';

interface SFTPSourceRow {
  id: string;
  organization_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'privatekey';
  password_encrypted: string | null;
  private_key_encrypted: string | null;
  remote_path: string;
  file_pattern: string | null;
  filename_template: string | null;
  is_active: boolean;
}

interface ProcessedFileRow {
  id: string;
  status: 'processed' | 'errored' | 'abandoned';
  attempt_count: number;
}

// A file gets this many attempts (the first ingest try plus retries on later
// polls) before the poller stops touching it automatically. Bounding it stops
// a permanently-broken file (bad audio, a corrupt upload) from being retried
// for ever; the manual retry endpoints on sftpRouter (routes/ingestion.ts)
// are the way back once whatever caused it is fixed.
export const MAX_FILE_ATTEMPTS = 5;

// Whether a file already on record should be left alone this poll. A
// 'processed' file must never be re-ingested — that is the idempotency
// guarantee the existence check exists for. An 'abandoned' file has already
// exhausted its attempts and only a manual retry (which resets it back to
// 'errored') brings it back into play. Only 'errored' is retried automatically.
export function shouldSkipFile(existing: ProcessedFileRow | null): boolean {
  return !!existing && existing.status !== 'errored';
}

// The status/attempt_count to persist after a file fails to ingest. Bounded at
// MAX_FILE_ATTEMPTS: once reached, the file flips to 'abandoned' so the next
// poll's shouldSkipFile stops retrying it, and the poll log records the
// give-up rather than it happening silently.
export function nextErrorState(priorAttemptCount: number): {
  status: 'errored' | 'abandoned';
  attemptCount: number;
} {
  const attemptCount = priorAttemptCount + 1;
  return {
    status: attemptCount >= MAX_FILE_ATTEMPTS ? 'abandoned' : 'errored',
    attemptCount,
  };
}

export async function processSFTPPoll(job: Job<{ sourceId: string }>) {
  const { sourceId } = job.data;
  console.log(`[SFTP] Polling source ${sourceId}`);

  const source = await queryOne<SFTPSourceRow>(
    `SELECT * FROM sftp_sources WHERE id = $1 AND is_active = true`,
    [sourceId]
  );

  if (!source) {
    console.log(`[SFTP] Source ${sourceId} not found or inactive, skipping`);
    return;
  }

  // Start log entry
  const logRows = await query<{ id: string }>(
    `INSERT INTO sftp_poll_logs (source_id) VALUES ($1) RETURNING id`,
    [sourceId]
  );
  const logId = logRows[0]!.id;

  let filesFound = 0;
  let filesIngested = 0;
  let filesSkipped = 0;
  let filesAbandoned = 0;
  let errorMessage: string | null = null;

  try {
    const remoteFiles = await sftp.listFiles(source, source.remote_path, source.file_pattern);
    filesFound = remoteFiles.length;

    for (const file of remoteFiles) {
      // Check whether this file has been seen before. A 'processed' row must
      // never be touched again (idempotency); an 'errored' row is retried
      // here, up to MAX_FILE_ATTEMPTS, before it is abandoned below.
      const existing = await queryOne<ProcessedFileRow>(
        `SELECT id, status, attempt_count FROM sftp_processed_files
          WHERE source_id = $1 AND remote_path = $2`,
        [sourceId, file.path]
      );
      if (shouldSkipFile(existing)) {
        filesSkipped++;
        continue;
      }
      if (existing) {
        console.log(
          `[SFTP] Retrying previously errored file ${file.path} (attempt ${existing.attempt_count + 1}/${MAX_FILE_ATTEMPTS})`
        );
      }

      try {
        const buffer = await sftp.downloadFile(source, file.path);
        const metadata = parseFilename(file.name, source.filename_template);

        const { call } = await ingestCall({
          organizationId: source.organization_id,
          uploadedBy: null,
          fileName: file.name,
          buffer,
          mimeType: inferMimeType(file.name),
          ingestionSource: 'sftp',
          agentName: metadata.agent_name ?? null,
          customerPhone: metadata.customer_phone ?? null,
          callDate: metadata.call_date ?? null,
          externalId: file.path, // use remote path as idempotency key
        });

        await query(
          `INSERT INTO sftp_processed_files
             (source_id, remote_path, file_size, call_id, status, error, attempt_count, last_attempt_at)
           VALUES ($1, $2, $3, $4, 'processed', NULL, $5, now())
           ON CONFLICT (source_id, remote_path) DO UPDATE SET
             file_size       = EXCLUDED.file_size,
             call_id         = EXCLUDED.call_id,
             status          = 'processed',
             error           = NULL,
             attempt_count   = EXCLUDED.attempt_count,
             last_attempt_at = now()`,
          [sourceId, file.path, file.size, call.id, (existing?.attempt_count ?? 0) + 1]
        );
        filesIngested++;
        console.log(`[SFTP] Ingested ${file.name} -> call ${call.id}`);
      } catch (fileErr) {
        console.error(`[SFTP] Failed to ingest ${file.path}:`, fileErr);
        const { status, attemptCount } = nextErrorState(existing?.attempt_count ?? 0);
        if (status === 'abandoned') {
          filesAbandoned++;
          console.error(
            `[SFTP] Giving up on ${file.path} after ${attemptCount} attempts (cap ${MAX_FILE_ATTEMPTS}) — ` +
              `it will not be retried automatically again; use the sftp-sources retry endpoint to reset it.`
          );
        }
        await query(
          `INSERT INTO sftp_processed_files
             (source_id, remote_path, file_size, error, status, attempt_count, last_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (source_id, remote_path) DO UPDATE SET
             file_size       = EXCLUDED.file_size,
             error           = EXCLUDED.error,
             status          = EXCLUDED.status,
             attempt_count   = EXCLUDED.attempt_count,
             last_attempt_at = now()`,
          [sourceId, file.path, file.size, (fileErr as Error).message, status, attemptCount]
        );
      }
    }

    await query(
      `UPDATE sftp_sources SET last_polled_at = now(), last_error = NULL WHERE id = $1`,
      [sourceId]
    );
  } catch (err) {
    errorMessage = (err as Error).message;
    console.error(`[SFTP] Poll failed for source ${sourceId}:`, err);
    await query(
      `UPDATE sftp_sources SET last_polled_at = now(), last_error = $1 WHERE id = $2`,
      [errorMessage, sourceId]
    );
  } finally {
    await query(
      `UPDATE sftp_poll_logs SET
         completed_at = now(),
         files_found = $1,
         files_ingested = $2,
         files_skipped = $3,
         files_abandoned = $4,
         error_message = $5
       WHERE id = $6`,
      [filesFound, filesIngested, filesSkipped, filesAbandoned, errorMessage, logId]
    );
  }
}
