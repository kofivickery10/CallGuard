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
  let errorMessage: string | null = null;

  try {
    const remoteFiles = await sftp.listFiles(source, source.remote_path, source.file_pattern);
    filesFound = remoteFiles.length;

    for (const file of remoteFiles) {
      // Check if already processed
      const existing = await queryOne(
        `SELECT id FROM sftp_processed_files WHERE source_id = $1 AND remote_path = $2`,
        [sourceId, file.path]
      );
      if (existing) {
        filesSkipped++;
        continue;
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
          `INSERT INTO sftp_processed_files (source_id, remote_path, file_size, call_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_id, remote_path) DO NOTHING`,
          [sourceId, file.path, file.size, call.id]
        );
        filesIngested++;
        console.log(`[SFTP] Ingested ${file.name} -> call ${call.id}`);
      } catch (fileErr) {
        console.error(`[SFTP] Failed to ingest ${file.path}:`, fileErr);
        await query(
          `INSERT INTO sftp_processed_files (source_id, remote_path, file_size, error)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_id, remote_path) DO NOTHING`,
          [sourceId, file.path, file.size, (fileErr as Error).message]
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
         error_message = $4
       WHERE id = $5`,
      [filesFound, filesIngested, filesSkipped, errorMessage, logId]
    );
  }
}
