#!/usr/bin/env node
/**
 * Local dev server for the landing site.
 *
 * WHY THIS EXISTS
 *
 * landing/ is pure static HTML served by Apache in production, and its routing
 * lives in landing/.htaccess. Serving the folder with a naive static server
 * (python -m http.server, say) gets every internal link wrong: the site links
 * to /pricing, not /pricing.html, and those extensionless URLs only resolve
 * because of the rewrite at .htaccess:39-42. You end up clicking through a
 * site of 404s and "fixing" links that were never broken.
 *
 * So this mirrors the handful of .htaccess rules that are meaningful on
 * localhost, and deliberately skips the ones that are not:
 *
 *   MIRRORED
 *     .htaccess:39-42  extensionless -> .html when that file exists
 *     .htaccess:106    DirectoryIndex index.html
 *     .htaccess:119    ErrorDocument 404 -> /404.html
 *     .htaccess:35-36  /alternatives/* -> /compare/* (301)
 *
 *   DELIBERATELY NOT MIRRORED
 *     .htaccess:14-15  www -> apex redirect
 *     .htaccess:28-32  force-HTTPS redirect. %{HTTPS} is never "on" behind a
 *                      TLS-terminating CDN, which is why that block tests
 *                      X-Forwarded-Proto. On plain-HTTP localhost none of the
 *                      escape hatches match either, so honouring it would 301
 *                      every local request to https://callguardai.co.uk --
 *                      i.e. you would silently end up browsing production.
 *     .htaccess:48-49  .html -> extensionless canonical redirect (absolute,
 *                      points at the production host).
 *
 * Zero dependencies, matching scripts/build-blog.mjs.
 *
 * Run: node scripts/serve-landing.mjs [--port 4173]   (or: npm run dev:landing)
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO_ROOT, 'landing');

// Precedence: explicit --port, then PORT (what a launcher injects when it has
// had to move us off a busy port), then LANDING_PORT, then the default. Taking
// PORT is what makes `autoPort` in .claude/launch.json actually mean something
// here -- the vite apps ignore an injected port because their vite.config.ts
// hardcodes server.port, and then report a URL nothing is listening on.
// 4321 is not arbitrary: `npm run audit:links` and `npm run audit:perf` both
// point at http://localhost:4321, and neither ships a server of its own. Sharing
// the default means `npm run dev:landing` in one pane and `npm run audit` in
// another works with nothing to configure.
const DEFAULT_PORT = 4321;

const portArg = process.argv.indexOf('--port');
const PORT = Number(
  (portArg !== -1 && process.argv[portArg + 1]) ||
  process.env.PORT ||
  process.env.LANDING_PORT ||
  DEFAULT_PORT
);

// .htaccess:35-36
const REDIRECTS = new Map([
  ['/alternatives/callminer', '/compare/callminer-alternative'],
  ['/alternatives/observe-ai', '/compare/observe-ai-alternative'],
]);

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}));

/** An existing file at `p`, or null. Directories are not files. */
async function fileAt(p) {
  try {
    return (await stat(p)).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a URL path to a file on disk, applying the mirrored rewrites.
 * Returns null when nothing matches, which the caller turns into a 404.
 */
async function resolve(urlPath) {
  // Refuse to escape landing/ via ../ before touching the filesystem.
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const abs = join(ROOT, clean);
  if (!abs.startsWith(ROOT)) return null;

  // DirectoryIndex (.htaccess:106)
  if (clean.endsWith('/')) return fileAt(join(abs, 'index.html'));

  const direct = await fileAt(abs);
  if (direct) return direct;

  // Extensionless -> .html (.htaccess:39-42)
  const asHtml = await fileAt(`${abs}.html`);
  if (asHtml) return asHtml;

  // A bare directory name still gets its index.
  return fileAt(join(abs, 'index.html'));
}

const server = createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;

  const redirect = REDIRECTS.get(urlPath.replace(/\/$/, ''));
  if (redirect) {
    res.writeHead(301, { Location: redirect });
    return res.end();
  }

  const file = await resolve(urlPath);

  if (!file) {
    // ErrorDocument 404 (.htaccess:119)
    const notFound = await fileAt(join(ROOT, '404.html'));
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(notFound ? await readFile(notFound) : 'Not found');
  }

  res.writeHead(200, {
    'Content-Type': TYPES.get(extname(file)) || 'application/octet-stream',
    // No caching: this is a dev server and stale CSS is the whole problem.
    'Cache-Control': 'no-store',
  });
  res.end(await readFile(file));
});

server.listen(PORT, () => {
  console.log(`Landing site running on http://localhost:${PORT}`);
  console.log(`  serving ${ROOT}`);
  console.log('  note: .htaccess HTTPS/www redirects are intentionally not applied');
});
