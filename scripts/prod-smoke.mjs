#!/usr/bin/env node
/**
 * Production parity check for the landing site (landing/).
 *
 * WHY THIS EXISTS
 *
 * The landing site is static HTML deployed by hand through the 20i File
 * Manager. There is no pipeline, so nothing compares what is in main with
 * what is actually serving. In August 2026 the .htaccess in the web root
 * turned out to be ten weeks behind main: the /alternatives/* redirects
 * added in July never fired, and the canonical-host rule that would have
 * stopped Google indexing the www. hostname was sitting unused in the repo.
 * Everything around that file had been re-uploaded; the hidden dotfile had
 * not, and nothing caught it for ten weeks.
 *
 * So this check runs against the live site rather than against a build. It
 * asserts externally observable behaviour that only the current .htaccess
 * and the current HTML can produce. Red means production and main disagree,
 * which usually means an upload is outstanding.
 *
 * Run: node scripts/prod-smoke.mjs   (or: npm run smoke:prod)
 * Exits non-zero if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SITE = 'https://callguardai.co.uk';
const WWW = 'https://www.callguardai.co.uk';

/**
 * .htaccess fingerprints — the point of the whole exercise.
 *
 * .htaccess is invisible from outside except through the behaviour it
 * causes, so we pin the behaviour instead. The CSP is the cheapest of these:
 * one header, changed on 14 Aug to allow app.callguardai.co.uk, and no other
 * version of the file emits it.
 *
 * When you change .htaccess, add or update a fingerprint here. A check that
 * still passes against last quarter's config is not a check.
 */
const CSP_MUST_CONTAIN = 'https://app.callguardai.co.uk';

/** Be a good guest on shared hosting: one request at a time, spaced out. */
const DELAY_MS = 300;
const USER_AGENT = 'CallGuard-prod-smoke/1.0 (+https://callguardai.co.uk)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;

async function request(url) {
  const wait = DELAY_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  // One retry, for transport errors only. This runs daily and unattended;
  // a check that cries wolf on a dropped connection is a check people mute.
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT },
      });
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(1000);
    }
  }
}

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ok  ' : 'FAIL  '}${name}\n`);
  if (!ok) process.stdout.write(`        ${detail}\n`);
}

/**
 * Assert a single-hop 301 to an exact absolute URL.
 *
 * Exact-matching the Location is deliberate. A path-only or http:// target
 * still "works" in a browser but costs an extra hop, and behind the
 * TLS-terminating CDN in front of this site that extra hop is plaintext.
 * Only an absolute https URL proves the redirect is doing what it claims.
 */
async function expectRedirect(from, expectedLocation) {
  let res;
  try {
    res = await request(from);
  } catch (err) {
    return record(`301  ${from}`, false, `request failed: ${err.message}`);
  }
  const location = res.headers.get('location');
  const ok = res.status === 301 && location === expectedLocation;
  record(
    `301  ${from}`,
    ok,
    `expected 301 -> ${expectedLocation}, got ${res.status}${location ? ` -> ${location}` : ' with no Location'}`,
  );
  return res;
}

async function expectOk(url) {
  let res;
  try {
    res = await request(url);
  } catch (err) {
    record(`200  ${url}`, false, `request failed: ${err.message}`);
    return null;
  }
  const location = res.headers.get('location');
  const ok = res.status === 200;
  record(
    `200  ${url}`,
    ok,
    `expected 200, got ${res.status}${location ? ` -> ${location}` : ''}`,
  );
  return ok ? res : null;
}

function locsIn(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

function canonicalOf(html) {
  const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  return m ? m[1] : null;
}

async function main() {
  process.stdout.write(`Production parity check — ${SITE}\n\n`);

  process.stdout.write('Canonical host and legacy redirects\n');
  await expectRedirect(`${WWW}/pricing`, `${SITE}/pricing`);
  await expectRedirect(`http://callguardai.co.uk/pricing`, `${SITE}/pricing`);
  await expectRedirect(`${SITE}/alternatives/callminer`, `${SITE}/compare/callminer-alternative`);
  await expectRedirect(`${SITE}/alternatives/observe-ai`, `${SITE}/compare/observe-ai-alternative`);
  await expectRedirect(`${SITE}/pricing.html`, `${SITE}/pricing`);

  process.stdout.write('\n.htaccess fingerprint\n');
  const pricing = await expectOk(`${SITE}/pricing`);
  if (pricing) {
    const csp = pricing.headers.get('content-security-policy') || '';
    record(
      `CSP contains ${CSP_MUST_CONTAIN}`,
      csp.includes(CSP_MUST_CONTAIN),
      csp
        ? `header present but missing the fingerprint — production is running an older .htaccess:\n        ${csp}`
        : 'no Content-Security-Policy header at all — production .htaccess is missing or its mod_headers block is not applying',
    );
  }

  process.stdout.write('\nProduction matches the sitemap in main\n');

  // Comparing the live sitemap against the repo's is what turns this from
  // "production is self-consistent" into "production is main". Checking only
  // the live sitemap would have missed the whole /templates/ section, which
  // was added to main in Aug 2026 and never uploaded: production's sitemap
  // did not mention it, so nothing looked wrong from outside.
  let repoLocs = [];
  try {
    repoLocs = locsIn(readFileSync(join(REPO_ROOT, 'landing/sitemap.xml'), 'utf8'));
    record('read landing/sitemap.xml', repoLocs.length > 0, 'no <loc> entries in the repo sitemap');
  } catch (err) {
    record('read landing/sitemap.xml', false, `could not read the repo sitemap: ${err.message}`);
  }

  let liveLocs = [];
  const sitemapRes = await expectOk(`${SITE}/sitemap.xml`);
  if (sitemapRes) liveLocs = locsIn(await sitemapRes.text());

  if (repoLocs.length > 0 && liveLocs.length > 0) {
    const live = new Set(liveLocs);
    const repo = new Set(repoLocs);
    const notUploaded = repoLocs.filter((u) => !live.has(u));
    const stale = liveLocs.filter((u) => !repo.has(u));
    record(
      'live sitemap matches landing/sitemap.xml',
      notUploaded.length === 0 && stale.length === 0,
      [
        notUploaded.length ? `in main but not live (upload outstanding):\n          ${notUploaded.join('\n          ')}` : '',
        stale.length ? `live but no longer in main (stale copy):\n          ${stale.join('\n          ')}` : '',
      ]
        .filter(Boolean)
        .join('\n        '),
    );
  }

  process.stdout.write('\nEvery sitemap URL resolves directly, and owns its canonical\n');
  const allLocs = [...new Set([...repoLocs, ...liveLocs])].sort();
  if (allLocs.length === 0) {
    record('sitemap URLs', false, 'no URLs to check from either the repo or the live sitemap');
  } else {
    process.stdout.write(`  (${allLocs.length} URLs)\n`);
    for (const loc of allLocs) {
      let res;
      try {
        res = await request(loc);
      } catch (err) {
        record(`sitemap  ${loc}`, false, `request failed: ${err.message}`);
        continue;
      }
      if (res.status !== 200) {
        const location = res.headers.get('location');
        record(
          `sitemap  ${loc}`,
          false,
          `expected 200 with no redirect, got ${res.status}${location ? ` -> ${location}` : ''}` +
            (res.status === 404 ? '. The page is in main but has not been uploaded.' : '') +
            (res.status >= 300 && res.status < 400
              ? '. A sitemap must list the URL that answers directly, not one that redirects to it.'
              : ''),
        );
        continue;
      }
      const canonical = canonicalOf(await res.text());
      record(
        `sitemap  ${loc}`,
        canonical === loc,
        canonical === null
          ? 'page has no <link rel="canonical">'
          : `canonical is ${canonical}, which is not the URL that served it`,
      );
    }
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);

  if (failed.length > 0) {
    process.stdout.write(`\n${failed.length} failed:\n`);
    for (const f of failed) process.stdout.write(`  - ${f.name}\n`);
    process.stdout.write(
      '\nThe landing site is uploaded by hand through the 20i File Manager, so the\n' +
        'usual cause is a file changed in main that has not been uploaded yet.\n' +
        'Check landing/.htaccess in particular: it is a hidden dotfile and file\n' +
        'managers do not show it unless you turn hidden files on.\n' +
        '\n' +
        'If you have just uploaded, the CDN caches HTML for an hour. Purge the\n' +
        'cache in the 20i panel, or re-run this once it has expired.\n',
    );
    process.exitCode = 1;
  }
}

await main();
