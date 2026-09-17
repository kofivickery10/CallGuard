/**
 * Which sources are configured, without calling any of them.
 *
 * Reports variable NAMES only, never values. Key-file variables are checked for
 * existence and for sitting outside the repo — a service-account key inside the
 * working tree is one `git add -A` from being committed.
 */
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env.js';

function fileProblem(name, value) {
  const resolved = path.resolve(REPO_ROOT, value);
  const rel = path.relative(REPO_ROOT, resolved);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return `${name} points inside the repo; move the key file outside it`;
  }
  try {
    accessSync(resolved, constants.R_OK);
  } catch {
    return `${name} points at a file that does not exist or cannot be read`;
  }
  return null;
}

export function checkSource(source, env = process.env) {
  const missing = source.env.filter((v) => !v.optional && !env[v.name]).map((v) => v.name);
  const problems = source.env
    .filter((v) => v.file && env[v.name])
    .map((v) => fileProblem(v.name, env[v.name]))
    .filter(Boolean);
  const configured = missing.length === 0 && problems.length === 0;
  let status;
  if (!source.register) status = 'not built yet';
  else status = configured ? 'ready' : 'needs configuration';
  return { id: source.id, title: source.title, status, built: Boolean(source.register), configured, missing, problems };
}

export function healthReport(sources, env = process.env, { envFileFound } = {}) {
  return {
    envFile: envFileFound ? 'tools/ops-mcp/.env loaded' : 'tools/ops-mcp/.env not found (copy .env.example)',
    sources: sources.map((s) => checkSource(s, env)),
  };
}
