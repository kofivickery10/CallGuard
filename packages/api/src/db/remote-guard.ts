import { config } from '../config.js';

/**
 * Guard against a developer's worker processing production work.
 *
 * A dev checkout usually points DATABASE_URL at the production database (it is
 * the only place with real calls to look at), while UPLOADS_DIR resolves to the
 * local repo — where none of the audio exists. Start the worker in that state
 * and it happily claims real calls, fails on ENOENT reading audio that lives on
 * the production box, and writes a local filesystem path into the production
 * `calls.error_message`. The periodic stuck-repair sweep then feeds it more
 * work, so it does not stop at one call. This has already happened once, to 63
 * calls of a live tenant.
 *
 * A local Redis is no protection: the sweep reads the production DB and
 * enqueues into whatever Redis this process is pointed at.
 *
 * Set ALLOW_REMOTE_DB=true to run a worker against a remote DB deliberately
 * (a maintenance box, a staging worker with NODE_ENV unset).
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/** The host in a postgres:// URL, or null if it can't be parsed. */
export function databaseHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function isLocalDatabase(url: string): boolean {
  const host = databaseHost(url);
  return host !== null && LOCAL_HOSTS.has(host);
}

/**
 * Throws unless it is safe for this worker to mutate what the DATABASE_URL
 * points at. Called at worker boot only — the API server is read-mostly, and
 * the one-off scripts in src/scripts/ are deliberately production tools.
 */
export function assertWorkerDatabaseIsSafe(): void {
  if (config.nodeEnv === 'production') return;
  if (process.env.ALLOW_REMOTE_DB === 'true') {
    console.warn(
      `[worker] ALLOW_REMOTE_DB=true — running against remote database ` +
      `${databaseHost(config.database.url) ?? 'unknown host'} with NODE_ENV=${config.nodeEnv}.`
    );
    return;
  }
  if (isLocalDatabase(config.database.url)) return;

  throw new Error(
    `Refusing to start the worker: NODE_ENV=${config.nodeEnv} but DATABASE_URL points at ` +
    `${databaseHost(config.database.url) ?? 'a remote host'}. A dev worker against the ` +
    `production database claims real calls and fails them against a local uploads directory. ` +
    `Point DATABASE_URL at a local database, or set ALLOW_REMOTE_DB=true if this is deliberate.`
  );
}
