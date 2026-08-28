#!/usr/bin/env node
/**
 * WCAG 2.1 AA audit of the landing site, in BOTH themes.
 *
 * The site ships light and dark and persists the choice in localStorage under
 * `cg-theme`, so auditing only the default misses half the surface. Each page is
 * loaded twice, once per theme, with the theme set before first paint.
 *
 * Needs the `landing` preview running on :4321.
 *
 *   node scripts/audit-a11y.mjs           # human-readable
 *   node scripts/audit-a11y.mjs --json
 *
 * Exits 1 if any issue is found, so it can gate a deploy.
 */
import pa11y from 'pa11y';

const BASE = process.env.LANDING_URL || 'http://localhost:4321';
const PAGES = [
  '/', '/pricing', '/about', '/blog/', '/compare/',
  '/use-cases/financial-services', '/templates/', '/integrations/cloudtalk',
];
const THEMES = ['light', 'dark'];

const results = [];
for (const page of PAGES) {
  for (const theme of THEMES) {
    const r = await pa11y(BASE + page, {
      standard: 'WCAG2AA',
      timeout: 30000,
      chromeLaunchConfig: { args: ['--no-sandbox'] },
      // Set the theme the way the site does, before the page paints, so the
      // audit sees the same tokens a returning visitor would.
      beforeScript: (page_) =>
        page_.evaluateOnNewDocument((t) => {
          try { localStorage.setItem('cg-theme', t); } catch (e) {}
          document.documentElement.setAttribute('data-theme', t);
        }, theme),
    });
    for (const i of r.issues) {
      if (i.type !== 'error') continue;
      results.push({ page, theme, code: i.code.split('.').pop(), selector: i.selector, message: i.message });
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`a11y audit — ${PAGES.length} pages x ${THEMES.length} themes, ${results.length} errors\n`);
  for (const r of results) {
    console.log(`  ${(r.page + ' [' + r.theme + ']').padEnd(42)} ${r.selector}`);
    console.log(`  ${''.padEnd(42)} ${r.message.slice(0, 120)}`);
  }
  if (!results.length) console.log('  clean');
}
process.exit(results.length ? 1 : 0);
