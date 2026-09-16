#!/usr/bin/env node
/**
 * Per-post social share images for the blog.
 *
 * WHY THIS EXISTS
 *
 * content/blog/post.html points every post at
 * https://callguardai.co.uk/og/blog-<slug>.png (see its og:image and
 * twitter:image tags). Without a file at that path, every LinkedIn/Slack/X
 * unfurl of a blog link falls back to nothing or a stale image — the same
 * "five error-prone steps, two of which get skipped" problem build-blog.mjs
 * exists to fix, just for the share card instead of the post page. Run
 * alongside it: `npm run blog:build && npm run og:build`.
 *
 * WHY A SEPARATE SCRIPT RATHER THAN ONE MORE STEP IN build-blog.mjs
 *
 * build-blog.mjs is zero-dependency and synchronous; this needs a real
 * browser (Playwright/Chromium) to lay out and rasterise a font-shrink-to-
 * fit title, which is a different, heavier kind of work with its own
 * failure modes (a missing Chrome install, a font that hasn't painted yet).
 * Keeping it separate means a Chrome problem never blocks a text-only
 * rebuild of the post pages.
 *
 * WHY THE FRONT-MATTER PARSER AND THE TOPIC/AUTHOR TABLES ARE COPIED, NOT
 * IMPORTED
 *
 * build-blog.mjs has no exports — it's a script that parses its posts and
 * calls main() as a side effect of being loaded. Importing it here would
 * re-render the whole blog (and write landing/blog/*.html) as a side effect
 * of building share images, which is a surprising thing for `og:build` to
 * do on its own. Mirroring the small pieces this script actually needs
 * keeps the two scripts independent; keep them in sync by hand if either
 * changes.
 *
 * Run: node scripts/build-og.mjs   (or: npm run og:build)
 */

import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_DIR = join(REPO_ROOT, 'content/blog/posts');
const OG_DIR = join(REPO_ROOT, 'content/og');
const TEMPLATE = join(OG_DIR, 'blog-card.html');
const OUT_DIR = join(REPO_ROOT, 'landing/og');

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const MAX_BYTES = 300 * 1024;

// Mirrors scripts/build-blog.mjs's AUTHORS table (see the file header for
// why this is a copy, not an import). Only the display name is needed here.
const AUTHORS = {
  kofi: { name: 'Kofi Vickery' },
  charlotte: { name: 'Charlotte Court' },
};

// Mirrors scripts/build-blog.mjs's TOPICS table. Only key → display name.
const TOPICS = {
  regulation: 'Regulation',
  operations: 'Running QA',
  foundations: 'How the scoring works',
};

// ── front-matter (copy of scripts/build-blog.mjs's parser — see file header) ──

function parseFrontMatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: no front-matter block`);

  const data = {};
  let listKey = null;

  for (const raw of m[1].split('\n')) {
    if (!raw.trim()) continue;
    const item = raw.match(/^ {2}- (.+)$/);
    if (item) {
      if (!listKey) throw new Error(`${file}: list item outside a list: ${raw}`);
      data[listKey].push(item[1].trim());
      continue;
    }
    const kv = raw.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: cannot parse front-matter line: ${raw}`);
    const [, key, value] = kv;
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else {
      listKey = null;
      if (value === 'true' || value === 'false') {
        data[key] = value === 'true';
      } else {
        data[key] = value.startsWith('"') ? JSON.parse(value) : Number(value);
        if (typeof data[key] === 'number' && Number.isNaN(data[key])) {
          throw new Error(`${file}: ${key} is neither a quoted string nor a number: ${value}`);
        }
      }
    }
  }

  return { data };
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fill(template, values, what) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`${what} uses {{${key}}}, which the generator does not provide`);
    return values[key];
  });
}

/** slug, cardTitle, topic and author display name — everything the card
 *  needs, read straight off each post's front matter. */
function loadCards() {
  const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) throw new Error('no posts in content/blog/posts');

  return files.map((file) => {
    const slug = file.replace(/\.md$/, '');
    const { data } = parseFrontMatter(readFileSync(join(POSTS_DIR, file), 'utf8'), file);

    for (const key of ['title', 'topic', 'author']) {
      if (data[key] === undefined) throw new Error(`${file}: missing required front-matter field "${key}"`);
    }
    if (!TOPICS[data.topic]) throw new Error(`${file}: topic "${data.topic}" is not one of ${Object.keys(TOPICS).join(', ')}`);
    if (!AUTHORS[data.author]) throw new Error(`${file}: author "${data.author}" is not one of ${Object.keys(AUTHORS).join(', ')}`);

    return {
      slug,
      // Same rule as build-blog.mjs's cardTitle: the H1 is a sentence, the
      // card title is a label, so the trailing full stop comes off. Titles
      // that end in "?" (a couple of posts do) are left alone — only a
      // trailing "." is a label artefact, a "?" is part of the question.
      title: data.title.replace(/\.$/, ''),
      topic: TOPICS[data.topic],
      author: AUTHORS[data.author].name,
    };
  });
}

async function main() {
  const cards = loadCards();
  const template = readFileSync(TEMPLATE, 'utf8');

  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({
      viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
      deviceScaleFactor: 1,
    });

    for (const card of cards) {
      const html = fill(
        template,
        { title: escapeHtml(card.title), topic: escapeHtml(card.topic), author: escapeHtml(card.author) },
        TEMPLATE,
      );

      // Written next to blog-card.html, not to a temp dir, so the template's
      // relative asset paths (the logo SVG, the font) resolve exactly as
      // they do for the template itself — no separate "resolve relative to
      // X" rule to keep in sync with the template's own paths.
      const tmp = join(OG_DIR, `.tmp-${card.slug}.html`);
      writeFileSync(tmp, html);
      try {
        await page.goto(`file://${tmp}`);
        // Belt and braces with the template's own document.fonts.ready
        // wait: this one guards Playwright's side of the handoff, the
        // other guards the title-shrink measurement inside the page.
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.body.getAttribute('data-og-ready') === 'true');

        const out = join(OUT_DIR, `blog-${card.slug}.png`);
        await page.screenshot({ path: out, type: 'png' });

        const bytes = statSync(out).size;
        if (bytes > MAX_BYTES) {
          throw new Error(`landing/og/blog-${card.slug}.png is ${bytes} bytes, over the ${MAX_BYTES}-byte budget`);
        }
        process.stdout.write(`  landing/og/blog-${card.slug}.png  (${(bytes / 1024).toFixed(1)} KB)\n`);
      } finally {
        unlinkSync(tmp);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
