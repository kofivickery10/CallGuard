#!/usr/bin/env node
// Render a markdown document to a branded, signable PDF.
//
// The markdown is the master. Never edit the generated .html or .pdf — change the
// markdown and re-run this, or the signed version and the source drift apart,
// which for an assessment a controller has signed is the one thing that must not
// happen.
//
// Deliberately self-contained and local: no ProperLeads brand tooling, no SFTP,
// no external service. CallGuard is a separate business and its client documents
// stay inside this repo (see CLAUDE.md).
//
// Usage:  node docs/dpia/build.mjs [path/to/source.md]
//
// Requires: npx marked (fetched on demand) and Google Chrome for the PDF step.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

const source = resolve(process.argv[2] ?? resolve(repoRoot, 'docs/dpia-data-forms-reconciliation.md'));
if (!existsSync(source)) {
  console.error(`No such source document: ${source}`);
  process.exit(1);
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME} — needed for the PDF step.`);
  process.exit(1);
}

const markdown = readFileSync(source, 'utf8');

// ---------------------------------------------------------------
// Pull the metadata table out of the head of the document so the cover page can
// show it as a cover page rather than as a table, and strip it from the body so
// it is not repeated.
// ---------------------------------------------------------------
// Everything from the first "### Change log" onward is the body. The H1, H2 and
// the metadata table become the cover.
const changeLogAt = markdown.indexOf('### Change log');
const head = changeLogAt > 0 ? markdown.slice(0, changeLogAt) : markdown;
const body = changeLogAt > 0 ? markdown.slice(changeLogAt) : markdown;

// Scanned over the head only. Across the whole document this also matched
// "**Identity**" and "**Full**" from the data-profile table in 4.2 and printed
// them on the cover as though they were document metadata.
const meta = {};
for (const [, key, value] of head.matchAll(/^\|\s*\*\*(.+?)\*\*\s*\|\s*(.*?)\s*\|$/gm)) {
  meta[key.trim()] = value.trim();
}

const title = (markdown.match(/^#\s+(.+)$/m) ?? [, 'Document'])[1].trim();
const subtitle = (markdown.match(/^##\s+(.+)$/m) ?? [, ''])[1].trim();

// Both ends go through files. Capturing marked's stdout truncated the render
// mid-tag at around 20KB, which is the dangerous kind of failure: the result
// still opens, still looks like a document, and silently stops halfway through
// section 4. Writing to -o and reading it back gives the whole thing.
const bodyFile = resolve(here, '.body.md');
const bodyHtml = resolve(here, '.body.html');
writeFileSync(bodyFile, body, 'utf8');
execFileSync('npx', ['--yes', 'marked@15', '-i', bodyFile, '-o', bodyHtml], {
  stdio: 'pipe',
  cwd: repoRoot,
});
let html = readFileSync(bodyHtml, 'utf8');
rmSync(bodyFile, { force: true });
rmSync(bodyHtml, { force: true });

/**
 * Refuse to produce a partial assessment.
 *
 * Silent loss is the failure mode that matters: a document missing its middle
 * still opens, still ends with a signature block, and still looks complete. Both
 * of the bugs hit while writing this script did exactly that. So every heading in
 * the markdown must be present in the output, checked after the transforms rather
 * than before, since a transform is what deleted them.
 */
function assertComplete(stage, generated) {
  // Tags stripped from both sides: inline emphasis in a heading becomes <em>, so
  // the raw markdown text is not contiguous in the HTML.
  const flatten = (s) =>
    s.replace(/<[^>]+>/g, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  const haystack = flatten(generated);
  const expected = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => flatten(m[1]));
  const missing = expected.filter((h) => !haystack.includes(h));
  if (missing.length > 0) {
    console.error(`Render is incomplete after ${stage} — ${missing.length} of ${expected.length} headings are missing:`);
    for (const h of missing.slice(0, 8)) console.error(`  - ${h}`);
    console.error('Refusing to build a partial assessment.');
    process.exit(1);
  }
}

assertComplete('markdown conversion', html);

// ---------------------------------------------------------------
// Turn the sign-off table into a real signature block.
//
// A 9pt table row is not something a person can sign. The rows are read out of
// the markdown so the source stays the single place the signatories are listed —
// adding a signatory there adds a card here, with no second list to forget.
// ---------------------------------------------------------------
// Tempered so it cannot cross a table boundary. Without the (?!</table>) guards
// this started at the FIRST table in the document and ran lazily forward to the
// "Signature" header in section 12, deleting sections 3 to 11 — and the result
// still ended correctly, so nothing looked wrong.
const NOT_TABLE_END = String.raw`(?:(?!<\/table>)[\s\S])*?`;
const SIGN_OFF_TABLE = new RegExp(
  `<table>${NOT_TABLE_END}<th>Signature</th>${NOT_TABLE_END}<tbody>(${NOT_TABLE_END})</tbody>\\s*</table>`
);

const signOff = html.match(SIGN_OFF_TABLE);
if (signOff) {
  const rows = [...signOff[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].trim())
  );

  const plain = (s) => (s ?? '').replace(/<[^>]+>/g, '').trim();

  // A name given in the source is pre-printed above its rule; an empty cell stays
  // a blank line to be filled in by hand. Keeping this driven by the markdown means
  // there is no second place to edit when a signatory changes.
  const filled = (value, label, cls = 'field') =>
    `<div class="${cls}"><label>${label}</label>` +
    (value ? `<div class="value">${value}</div>` : '') +
    `<div class="line"></div></div>`;

  const cards = rows
    .map(([role, name, org, date]) => {
      // Column order in the source is: label | Name | Role | Date | Signature.
      const who = plain(role) || 'Signatory';
      const forOrg = plain(org);
      return `  <div class="sig">
    <h4>${who}${forOrg ? ` &mdash; ${forOrg}` : ''}</h4>
    <div class="fields">
      ${filled(plain(name), 'Name', 'field wide')}
      ${filled('', 'Role or job title')}
      ${filled(plain(date), 'Date')}
    </div>
    <div class="fields">
      ${filled('', 'Signature', 'field signature')}
    </div>
  </div>`;
    })
    .join('\n');

  html = html.replace(SIGN_OFF_TABLE, `<div class="signature-set">\n${cards}\n</div>`);
}

// The enablement gate is the operative sentence of the whole document, so it is
// given a box rather than being a bold paragraph among others.
html = html.replace(
  /<p><strong>(This feature must not be enabled[\s\S]*?)<\/strong><\/p>/,
  '<div class="gate"><p>$1</p></div>'
);

// Section 12 starts the signing pages.
html = html.replace(
  /<h2>(12\.\s*Sign off)<\/h2>/,
  '<h2 class="signatures">$1</h2>'
);

// Checked again: the transforms above are what deleted content last time, so
// checking only the raw conversion would have missed it.
assertComplete('the sign-off and gate transforms', html);

// The shield mark, inlined so the PDF carries no external reference.
const logo = readFileSync(resolve(repoRoot, 'packages/web/public/callguard-logo-horizontal.svg'), 'utf8')
  .replace(/<\?xml[^>]*\?>/, '')
  .trim();

const metaRows = Object.entries(meta)
  .map(
    ([k, v]) => `      <div class="meta-row"><dt>${k}</dt><dd>${v.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</dd></div>`
  )
  .join('\n');

const version = (meta.Version ?? '').split(',')[0].trim() || 'draft';

const page = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>${title} — ${subtitle}</title>
<style>
/* CallGuard tokens (BRAND_GUIDELINES.md §3). Light only: this is print. */
:root {
  --primary: #4A9E6E;
  --ink: #1A2E1A;
  --secondary: #5A6E5A;
  --muted: #8A9E8A;
  --cell: #3A4E3A;
  --border: #E2E8E2;
  --border-light: #F0F5F0;
  --fail: #C0392B;
  --fail-bg: #FDE8E8;
  --review: #B8860B;
  --review-bg: #FEF3E0;
  --pass: #2D6E4A;
  --pass-bg: #E8F5E8;
}

@page {
  size: A4;
  margin: 18mm 16mm 20mm;
}

* { box-sizing: border-box; }

body {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 10pt;
  line-height: 1.55;
  color: var(--cell);
  margin: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ---------- Cover ---------- */
.cover {
  page-break-after: always;
  padding-top: 12mm;
}
.cover .logo svg { height: 34px; width: auto; }
.cover h1 {
  font-size: 26pt;
  font-weight: 700;
  letter-spacing: -0.6px;
  color: var(--ink);
  margin: 26mm 0 6px;
  line-height: 1.15;
}
.cover .subtitle {
  font-size: 12.5pt;
  font-weight: 400;
  color: var(--secondary);
  margin: 0 0 20mm;
  max-width: 150mm;
}
.rule { height: 3px; background: var(--primary); width: 54px; border-radius: 2px; margin: 0 0 16mm; }

dl.meta { margin: 0; }
.meta-row {
  display: flex;
  gap: 14px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border-light);
  page-break-inside: avoid;
}
.meta-row dt {
  flex: 0 0 44mm;
  font-size: 8.5pt;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  color: var(--muted);
  padding-top: 1px;
}
.meta-row dd { margin: 0; flex: 1; font-size: 9.5pt; color: var(--cell); }
.meta-row dd strong { color: var(--fail); }

.cover .footer {
  margin-top: 22mm;
  font-size: 8.5pt;
  color: var(--muted);
}

/* ---------- Body ---------- */
.doc { counter-reset: none; }

h2 {
  font-size: 15pt;
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--ink);
  margin: 14mm 0 4mm;
  padding-bottom: 2.5mm;
  border-bottom: 2px solid var(--primary);
  page-break-after: avoid;
}
h2:first-of-type { margin-top: 0; }

h3 {
  font-size: 11.5pt;
  font-weight: 600;
  color: var(--ink);
  margin: 8mm 0 2.5mm;
  page-break-after: avoid;
}

h4 {
  font-size: 10pt;
  font-weight: 600;
  color: var(--secondary);
  margin: 6mm 0 2mm;
  page-break-after: avoid;
}

p { margin: 0 0 3.2mm; orphans: 3; widows: 3; }
strong { color: var(--ink); font-weight: 600; }
em { color: var(--secondary); }
del { color: var(--muted); }

a { color: var(--primary); text-decoration: none; }

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 8.8pt;
  background: var(--border-light);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--ink);
}

ul, ol { margin: 0 0 3.2mm; padding-left: 6mm; }
li { margin-bottom: 1.4mm; }

blockquote {
  margin: 0 0 3.5mm;
  padding: 2.5mm 4mm;
  border-left: 3px solid var(--primary);
  background: var(--border-light);
  color: var(--secondary);
}
blockquote p:last-child { margin-bottom: 0; }

hr { border: 0; border-top: 1px solid var(--border); margin: 8mm 0; }

table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 4mm;
  font-size: 9pt;
  page-break-inside: avoid;
}
thead { background: var(--border-light); }
th {
  text-align: left;
  font-size: 8pt;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--muted);
  padding: 2.4mm 3mm;
  border-bottom: 1px solid var(--border);
  vertical-align: bottom;
}
td {
  padding: 2.4mm 3mm;
  border-bottom: 1px solid var(--border-light);
  vertical-align: top;
  color: var(--cell);
}
tr:last-child td { border-bottom: 1px solid var(--border); }

/* A risk heading reads better kept with the paragraph that grades it. */
h3 + p { page-break-before: avoid; }

/* ---------- Signature block ---------- */
/* The sign-off table is the point of the document existing as a PDF, so it gets
   real signing room rather than 9pt table rows. */
.signatures { page-break-before: always; }
.sig {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6mm;
  margin-bottom: 6mm;
  page-break-inside: avoid;
}
.sig h4 {
  margin: 0 0 5mm;
  font-size: 10.5pt;
  color: var(--ink);
  letter-spacing: 0.2px;
}
.sig .fields { display: flex; gap: 6mm; margin-bottom: 6mm; }
.sig .field { flex: 1; }
.sig .field.wide { flex: 1.4; }
.sig label {
  display: block;
  font-size: 8pt;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 8mm;
}
.sig .line { border-bottom: 1px solid var(--ink); height: 0; }
/* A pre-printed value sits on the rule, so the label's reserved gap collapses. */
.sig .field:has(.value) label { margin-bottom: 2mm; }
.sig .value { font-size: 11pt; color: var(--ink); padding-bottom: 1.5mm; }
.sig .signature label { margin-bottom: 16mm; }
.sig .note { font-size: 8.5pt; color: var(--secondary); margin: 0; }

.gate {
  border: 1px solid var(--fail);
  background: var(--fail-bg);
  border-radius: 6px;
  padding: 4mm 5mm;
  margin-top: 2mm;
  page-break-inside: avoid;
}
.gate p { margin: 0; color: var(--fail); font-size: 9.5pt; font-weight: 600; }
</style>
</head>
<body>

<section class="cover">
  <div class="logo">${logo}</div>
  <h1>${title}</h1>
  <p class="subtitle">${subtitle}</p>
  <div class="rule"></div>
  <dl class="meta">
${metaRows}
  </dl>
  <p class="footer">CallGuard AI · ${version} · This document is generated from
  <code>${basename(source)}</code>. Amend the source and re-render; do not edit the PDF.</p>
</section>

<section class="doc">
${html}
</section>

</body>
</html>
`;

const outHtml = resolve(here, 'dpia.generated.html');
writeFileSync(outHtml, page, 'utf8');

const outPdf = resolve(here, `dpia-${version.replace(/[^\w.]/g, '')}.pdf`);
execFileSync(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${outPdf}`,
    '--virtual-time-budget=4000',
    `file://${outHtml}`,
  ],
  { stdio: 'pipe' }
);

console.log(`html: ${outHtml}`);
console.log(`pdf : ${outPdf}`);
