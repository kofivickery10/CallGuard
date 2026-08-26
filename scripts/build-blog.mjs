#!/usr/bin/env node
/**
 * Blog generator for the landing site.
 *
 * WHY THIS EXISTS
 *
 * Publishing a post used to mean hand-writing ~21KB of HTML that was ~85%
 * boilerplate, repeating the slug, title, description and date across
 * fourteen places in the head, then hand-adding a card to blog/index.html
 * and a <url> to sitemap.xml. Five error-prone steps, of which the last two
 * are the ones that get skipped. The blog went 113 days without a post.
 *
 * Now: write landing/blog/_posts/<slug>.md and run `npm run blog:build`.
 * The post, the index cards and the sitemap's blog entries are all derived.
 *
 * Zero dependencies on purpose. The Markdown subset below is exactly what
 * the existing posts use — headings, paragraphs, bold, links, and both
 * kinds of list. If a post needs something else, add it here deliberately
 * rather than reaching for a Markdown library and inheriting its whole
 * surface area, most of which would never survive contact with the design
 * system anyway.
 *
 * Run: node scripts/build-blog.mjs   (or: npm run blog:build)
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_DIR = join(REPO_ROOT, 'landing/blog');
const POSTS_DIR = join(BLOG_DIR, '_posts');
const TEMPLATE = join(BLOG_DIR, '_template.html');
const INDEX = join(BLOG_DIR, 'index.html');
const SITEMAP = join(REPO_ROOT, 'landing/sitemap.xml');

const SITE = 'https://callguardai.co.uk';

const REQUIRED = [
  'title', 'ogTitle', 'breadcrumb', 'description', 'ogDescription',
  'cardTag', 'cardSummary', 'date', 'section', 'readingTime', 'wordCount',
  'ctaSubject', 'useCaseLink', 'related',
];

// ── front-matter ─────────────────────────────────────────────────────────

/**
 * The YAML subset used by the posts: `key: "string"`, `key: 12`, and a list
 * of `  - item` lines. Deliberately strict — an unrecognised line is an
 * error rather than a silently dropped field, because a field that silently
 * vanishes reappears as a missing og:title in production.
 */
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
      data[key] = value.startsWith('"') ? JSON.parse(value) : Number(value);
      if (typeof data[key] === 'number' && Number.isNaN(data[key])) {
        throw new Error(`${file}: ${key} is neither a quoted string nor a number: ${value}`);
      }
    }
  }

  return { data, body: text.slice(m[0].length).trim() };
}

// ── markdown ─────────────────────────────────────────────────────────────

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline: **bold** and [text](href). Escaping happens first, so a literal
 *  ampersand in the copy survives as &amp; in both text and attributes. */
function inline(text) {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const IND = '    ';

/**
 * Block-level render. The first paragraph becomes the lead, which is how
 * every existing post opens and what the stylesheet expects.
 */
function renderMarkdown(md, file) {
  const blocks = md.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  let leadDone = false;

  return blocks
    .map((block) => {
      if (block.startsWith('### ')) return `${IND}<h3>${inline(block.slice(4))}</h3>`;
      if (block.startsWith('## ')) return `${IND}<h2>${inline(block.slice(3))}</h2>`;

      const lines = block.split('\n').map((l) => l.trim());

      if (lines.every((l) => l.startsWith('- '))) {
        const items = lines.map((l) => `${IND}  <li>${inline(l.slice(2))}</li>`).join('\n');
        return `${IND}<ul class="article-list">\n${items}\n${IND}</ul>`;
      }
      if (lines.every((l) => /^\d+\.\s/.test(l))) {
        const items = lines.map((l) => `${IND}  <li>${inline(l.replace(/^\d+\.\s/, ''))}</li>`).join('\n');
        return `${IND}<ol class="article-list">\n${items}\n${IND}</ol>`;
      }
      if (lines.some((l) => l.startsWith('- ') || /^\d+\.\s/.test(l))) {
        throw new Error(`${file}: a block mixes list items with prose:\n${block.slice(0, 160)}`);
      }
      if (block.startsWith('#')) throw new Error(`${file}: only ## and ### headings are supported: ${block.slice(0, 80)}`);

      const text = inline(lines.join(' '));
      if (!leadDone) {
        leadDone = true;
        return `${IND}<p class="lead">${text}</p>`;
      }
      return `${IND}<p>${text}</p>`;
    })
    .join('\n\n');
}

// ── dates ────────────────────────────────────────────────────────────────

const humanDate = (iso) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T12:00:00Z`));

/**
 * Publication timestamps are 09:00 London. Deriving the offset rather than
 * hardcoding +01:00 means a post published in December gets Z, not an hour
 * that never happened.
 */
function londonTimestamp(iso, time) {
  const at = new Date(`${iso}T${time}:00Z`);
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName').value;
  const offset = name === 'GMT' ? '+00:00' : name.replace('GMT', '');
  return `${iso}T${time}:00${offset}`;
}

// ── build ────────────────────────────────────────────────────────────────

function loadPosts() {
  const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) throw new Error('no posts in landing/blog/_posts');

  const posts = files.map((file) => {
    const slug = file.replace(/\.md$/, '');
    const { data, body } = parseFrontMatter(readFileSync(join(POSTS_DIR, file), 'utf8'), file);

    for (const key of REQUIRED) {
      if (data[key] === undefined) throw new Error(`${file}: missing required front-matter field "${key}"`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error(`${file}: date must be YYYY-MM-DD, got ${data.date}`);
    if (data.updated && !/^\d{4}-\d{2}-\d{2}$/.test(data.updated)) {
      throw new Error(`${file}: updated must be YYYY-MM-DD, got ${data.updated}`);
    }
    if (data.time && !/^\d{2}:\d{2}$/.test(data.time)) {
      throw new Error(`${file}: time must be HH:MM, got ${data.time}`);
    }

    return {
      slug,
      file,
      ...data,
      body,
      url: `${SITE}/blog/${slug}`,
      // cardTitle is the H1 without its full stop: the H1 is a sentence, the
      // card title is a label. Derived so the two can never drift apart.
      cardTitle: data.title.replace(/\.$/, ''),
      lastmod: data.updated || data.date,
      time: data.time || '09:00',
      // Most posts reuse one description in three places. These two exist for
      // the posts that deliberately word them differently, and default rather
      // than being required so a new post needs one description, not four.
      twitterDescription: data.twitterDescription || data.ogDescription,
      schemaDescription: data.schemaDescription || data.description,
      // `order` only breaks ties. The five launch posts genuinely share a
      // publication date, so without it their sequence on the index would be
      // arbitrary and would churn on every build.
      order: data.order ?? 0,
    };
  });

  // Newest first, then explicit order, then slug — fully deterministic.
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order || a.slug.localeCompare(b.slug));

  const bySlug = new Map(posts.map((p) => [p.slug, p]));
  for (const post of posts) {
    for (const slug of post.related) {
      if (!bySlug.has(slug)) throw new Error(`${post.file}: related post "${slug}" does not exist`);
      if (slug === post.slug) throw new Error(`${post.file}: lists itself as related`);
    }
  }
  return { posts, bySlug };
}

function renderPost(post, bySlug, template) {
  const bodyHtml = renderMarkdown(post.body, post.file);

  // The use-case link is asserted, not injected. The SEO review was explicit
  // that these belong in the prose as contextual links, not appended as a
  // footer list — so the generator's job is to refuse a post that quietly
  // lost one, not to bolt one on.
  if (post.useCaseLink && !bodyHtml.includes(`href="${post.useCaseLink}"`)) {
    throw new Error(
      `${post.file}: front-matter declares useCaseLink ${post.useCaseLink} but the body does not link to it. ` +
        'Add a contextual link in the prose, or change the field.',
    );
  }

  const related = post.related
    .map((slug) => `      <li><a href="/blog/${slug}">${escapeHtml(bySlug.get(slug).cardTitle)}</a></li>`)
    .join('\n');

  const values = {
    slug: post.slug,
    title: escapeHtml(post.title),
    ogTitle: escapeHtml(post.ogTitle),
    breadcrumb: escapeHtml(post.breadcrumb),
    description: escapeHtml(post.description),
    ogDescription: escapeHtml(post.ogDescription),
    twitterDescription: escapeHtml(post.twitterDescription),
    schemaDescription: escapeHtml(post.schemaDescription),
    section: escapeHtml(post.section),
    dateHuman: humanDate(post.date),
    readingTime: String(post.readingTime),
    wordCount: String(post.wordCount),
    publishedISO: londonTimestamp(post.date, post.time),
    modifiedISO: londonTimestamp(post.updated || post.date, post.time),
    ctaSubject: post.ctaSubject,
    body: bodyHtml,
    related,
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`_template.html uses {{${key}}}, which the generator does not provide`);
    return values[key];
  });
}

function renderCards(posts) {
  return posts
    .map(
      (post) => `        <article class="post-card">
          <a href="/blog/${post.slug}" class="post-card-link">
            <div class="post-card-tag">${escapeHtml(post.cardTag)}</div>
            <h2 class="post-card-title">${escapeHtml(post.cardTitle)}</h2>
            <p class="post-card-summary">${escapeHtml(post.cardSummary)}</p>
            <div class="post-card-meta">
              <span>${humanDate(post.date)}</span>
              <span class="post-card-dot">·</span>
              <span>${post.readingTime} min read</span>
            </div>
          </a>
        </article>`,
    )
    .join('\n\n');
}

function renderSitemapBlock(posts) {
  const entry = (loc, lastmod, changefreq, priority) =>
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n` +
    `    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

  const newest = posts.reduce((acc, p) => (p.lastmod > acc ? p.lastmod : acc), posts[0].lastmod);
  return [
    entry(`${SITE}/blog/`, newest, 'weekly', '0.8'),
    ...posts.map((p) => entry(p.url, p.lastmod, 'monthly', '0.7')),
  ].join('\n');
}

function replaceRegion(text, startMarker, endMarker, replacement, what) {
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`${what}: could not find the opening marker ${JSON.stringify(startMarker)}`);
  const from = start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  if (end === -1) throw new Error(`${what}: could not find the closing marker ${JSON.stringify(endMarker)}`);
  return text.slice(0, from) + replacement + text.slice(end);
}

function main() {
  const { posts, bySlug } = loadPosts();
  const template = readFileSync(TEMPLATE, 'utf8');

  for (const post of posts) {
    writeFileSync(join(BLOG_DIR, `${post.slug}.html`), renderPost(post, bySlug, template));
    process.stdout.write(`  blog/${post.slug}.html\n`);
  }

  const index = readFileSync(INDEX, 'utf8');
  writeFileSync(
    INDEX,
    replaceRegion(index, '<div class="post-grid">\n\n', '\n\n      </div>', renderCards(posts), 'blog/index.html'),
  );
  process.stdout.write(`  blog/index.html (${posts.length} cards)\n`);

  // The blog's <url> entries are one contiguous run in the sitemap. Locate it
  // by scanning every entry rather than by slug, so the run is found on its
  // own terms and rewriting it leaves every other page untouched.
  const sitemap = readFileSync(SITEMAP, 'utf8');
  const entries = [...sitemap.matchAll(/ {2}<url>[\s\S]*?<\/url>/g)];
  const blogAt = entries
    .map((m, i) => (m[0].includes(`<loc>${SITE}/blog/`) ? i : -1))
    .filter((i) => i !== -1);
  if (blogAt.length === 0) throw new Error('sitemap.xml: no blog <url> entries to replace');
  if (blogAt[blogAt.length - 1] - blogAt[0] !== blogAt.length - 1) {
    throw new Error('sitemap.xml: the blog <url> entries are not contiguous; tidy them by hand once, then rebuild');
  }
  const first = entries[blogAt[0]];
  const last = entries[blogAt[blogAt.length - 1]];
  const blockStart = first.index;
  const blockEnd = last.index + last[0].length;
  writeFileSync(SITEMAP, sitemap.slice(0, blockStart) + renderSitemapBlock(posts) + sitemap.slice(blockEnd));
  process.stdout.write(`  sitemap.xml (${posts.length + 1} blog entries)\n`);
}

main();
