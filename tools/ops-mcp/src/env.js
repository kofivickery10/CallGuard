/**
 * Where the ops server finds its configuration.
 *
 * Its secrets live in tools/ops-mcp/.env (gitignored), NOT the repo-root .env.
 * The root .env holds the app's own production credentials — a read-write
 * DATABASE_URL, the scoring and transcription keys — and none of those belong
 * in a tool whose rule is least privilege. Every variable here has an OPS- or
 * source-specific name for the same reason: values already in the environment
 * win over the file (Node's loadEnvFile never overrides), so a generic name
 * like DATABASE_URL could silently pick up the app's credential from a shell.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
export const ENV_FILE = path.join(PACKAGE_ROOT, '.env');

/** Load tools/ops-mcp/.env into process.env. Returns whether the file existed. */
export function loadEnv(file = ENV_FILE) {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
