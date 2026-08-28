#!/usr/bin/env node
/**
 * On-page SEO audit for the static site in landing/.
 *
 * Reads the files directly — no server needed — and reports the head-level and
 * internal-linking defects that a crawler would care about. Written for
 * `search-analyst`, which is told to run it rather than eyeball 33 hand-
 * maintained <head> blocks.
 *
 *   node scripts/audit-onpage.mjs            # human-readable
 *   node scripts/audit-onpage.mjs --json     # machine-readable
 *
 * Exits 1 if any ERROR-level finding is present, so it can gate a deploy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Recursive .html walk — Node 20 has no fs.globSync. */
function walk(dir, base = '') {
  return readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((e) => {
    const rel = base ? path.join(base, e.name) : e.name;
    if (e.isDirectory()) return walk(dir, rel);
    return e.name.endsWith('.html') ? [rel] : [];
  });
}

const ROOT = 'landing';
const TITLE_MAX = 60;   // beyond this Google truncates in most SERP layouts
const DESC_MAX = 160;

// og-image.html is a render source for the social card, 404.html is noindex.
const EXCLUDE = new Set(['og-image.html', '404.html']);

const pages = walk(ROOT)
  .filter((p) => !p.startsWith('blog/_') && !EXCLUDE.has(p))
  .sort();

/** File path -> the URL it serves at (extensionless, per .htaccess rewrites). */
function toUrl(p) {
  const u = '/' + p.replace(/\.html$/, '');
  if (u === '/index') return '/';
  return u.endsWith('/index') ? u.slice(0, -'index'.length) : u;
}

const urls = new Map(pages.map((p) => [toUrl(p), p]));
const inbound = new Map([...urls.keys()].map((u) => [u, new Set()]));
const findings = [];
const titles = new Map();

const add = (level, page, code, detail) => findings.push({ level, page, code, detail });

for (const p of pages) {
  const src = readFileSync(path.join(ROOT, p), 'utf8');
  const self = toUrl(p);
  const pick = (re) => (src.match(re) || [])[1]?.trim();

  const title = pick(/<title>([\s\S]*?)<\/title>/);
  const desc = pick(/name="description"\s+content="([\s\S]*?)"/);
  const canon = pick(/rel="canonical"\s+href="([^"]*)"/);
  const h1s = (src.match(/<h1[\s>]/g) || []).length;

  if (!title) add('ERROR', self, 'no-title', 'no <title>');
  else {
    if (title.length > TITLE_MAX) add('WARN', self, 'title-long', `${title.length}ch > ${TITLE_MAX}`);
    if (!titles.has(title)) titles.set(title, []);
    titles.get(title).push(self);
  }

  if (!desc) add('ERROR', self, 'no-description', 'no meta description');
  else if (desc.length > DESC_MAX) add('WARN', self, 'desc-long', `${desc.length}ch > ${DESC_MAX}`);

  if (!canon) add('ERROR', self, 'no-canonical', 'no rel=canonical');
  else if (canon.endsWith('.html')) add('ERROR', self, 'canonical-html', `${canon} — must be extensionless`);
  else if (!canon.startsWith('https://')) add('ERROR', self, 'canonical-relative', canon);

  if (h1s !== 1) add(h1s === 0 ? 'ERROR' : 'WARN', self, 'h1-count', `${h1s} <h1> elements`);

  // Internal link graph. Indexation, not ranking, is this domain's constraint,
  // so a page nothing links to is a real defect and not a tidiness note.
  for (const m of src.matchAll(/<a\s[^>]*href="([^"#?]+)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|tel:)/.test(href)) continue;
    const abs = href.startsWith('/')
      ? href
      : '/' + path.normalize(path.join(path.dirname(p), href));
    for (const cand of [abs, abs.replace(/\.html$/, ''), abs.replace(/\/$/, '')]) {
      if (inbound.has(cand) && cand !== self) inbound.get(cand).add(self);
    }
  }
}

for (const [t, us] of titles) {
  if (us.length > 1) add('ERROR', us.join(', '), 'duplicate-title', t.slice(0, 60));
}
for (const [u, from] of inbound) {
  if (u === '/') continue; // the homepage is reached directly
  if (from.size === 0) add('ERROR', u, 'orphan', 'no internal inbound links');
  else if (from.size === 1) add('WARN', u, 'thin-inbound', `1 inbound link (from ${[...from][0]})`);
}

const errors = findings.filter((f) => f.level === 'ERROR');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ pages: pages.length, findings }, null, 2));
} else {
  console.log(`on-page audit — ${pages.length} pages, ${errors.length} errors, ${findings.length - errors.length} warnings\n`);
  for (const level of ['ERROR', 'WARN']) {
    for (const f of findings.filter((x) => x.level === level)) {
      console.log(`  ${level.padEnd(5)} ${f.code.padEnd(18)} ${f.page}  ${f.detail}`);
    }
  }
  if (!findings.length) console.log('  clean');
}

process.exit(errors.length ? 1 : 0);
