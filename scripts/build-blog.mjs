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
 * Now: write content/blog/posts/<slug>.md and run `npm run blog:build`.
 * The post, the index, the feed and the sitemap's blog entries are derived.
 *
 * WHERE THE SOURCES LIVE
 *
 * Under content/, not landing/. landing/ is the document root, so anything
 * in it is served: the old landing/blog/_posts/*.md and _template.html were
 * publicly fetchable, and /blog/_template was indexable. Sources that
 * generate a page must not sit inside the folder that is published.
 *
 * WHAT IS DERIVED RATHER THAN TYPED
 *
 * Word count and reading time are counted from the body. They used to be
 * front-matter fields, which meant an edited post kept its original figures
 * — including inside the Article schema, where a wrong wordCount is a wrong
 * claim to a search engine. Heading ids, the contents list, the feed and the
 * topic grouping are derived for the same reason.
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
const CONTENT_DIR = join(REPO_ROOT, 'content/blog');
const POSTS_DIR = join(CONTENT_DIR, 'posts');
const POST_TEMPLATE = join(CONTENT_DIR, 'post.html');
const INDEX_TEMPLATE = join(CONTENT_DIR, 'index.html');
const BLOG_DIR = join(REPO_ROOT, 'landing/blog');
const INDEX_OUT = join(BLOG_DIR, 'index.html');
const FEED_OUT = join(BLOG_DIR, 'feed.xml');
const SITEMAP = join(REPO_ROOT, 'landing/sitemap.xml');

const SITE = 'https://callguardai.co.uk';

/**
 * Bylines are split by subject, not shared. Regulation posts are Charlotte's,
 * product and operations posts are Kofi's. The role is all the biography a
 * reader needs; the E-E-A-T signal is the named person with a stable URL,
 * not a paragraph about them.
 */
const AUTHORS = {
  kofi: {
    name: 'Kofi Vickery',
    role: 'Co-founder, CallGuard AI',
    remit: 'Writes about how the scoring works and what running QA on every call takes.',
    url: `${SITE}/about`,
  },
  charlotte: {
    name: 'Charlotte Court',
    role: 'Co-founder, CallGuard AI',
    remit: 'Writes about what the FCA and the ICO expect to see evidenced on a recorded call.',
    url: `${SITE}/about`,
  },
};

/**
 * Topics are the blog's hubs. Each one is an anchor on /blog/ rather than a
 * URL of its own: with six posts, three more indexable pages listing two
 * posts each would be thin, and thin pages are the thing this site can least
 * afford while the domain is still establishing itself.
 */
const TOPICS = [
  {
    key: 'regulation',
    name: 'Regulation',
    blurb: 'What the FCA and the ICO expect a recorded advice call to evidence, and how firms show it.',
  },
  {
    key: 'operations',
    name: 'Running QA',
    blurb: 'Coverage, sampling and what changes in a compliance team when every call is scored rather than 5%.',
  },
  {
    key: 'foundations',
    name: 'How the scoring works',
    blurb: 'Plain-English explanations of the technology, including what it is not good at.',
  },
];

const TOPIC_KEYS = new Set(TOPICS.map((t) => t.key));
// 200 words a minute rather than the usual web figure of 230: this is dense
// regulatory prose with rule references in it, and a reading time that
// undersells the effort is worse than no reading time.
const WORDS_PER_MINUTE = 200;

const REQUIRED = [
  'title', 'ogTitle', 'breadcrumb', 'description', 'ogDescription',
  'cardTag', 'cardSummary', 'date', 'section', 'topic', 'author',
  'ctaSubject', 'useCaseLink', 'related',
];

/** Fields the generator now derives. Leaving one in a post is an error, not
 *  a value to prefer: two sources of truth for the same number is how the
 *  old hand-typed reading times drifted from the prose in the first place. */
const DERIVED = ['readingTime', 'wordCount'];

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
      // Unquote exactly as a scalar is below. Pushing the raw text kept the quote
      // marks, so a source written "Label|https://…" rendered a label opening with a
      // stray " and an href ending in one: a broken link on every source of the
      // three held regulation posts, invisible only because none had published.
      const itemValue = item[1].trim();
      data[listKey].push(itemValue.startsWith('"') ? JSON.parse(itemValue) : itemValue);
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

  return { data, body: text.slice(m[0].length).trim() };
}

// ── markdown ─────────────────────────────────────────────────────────────

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

/** Inline: **bold** and [text](href). Escaping happens first, so a literal
 *  ampersand in the copy survives as &amp; in both text and attributes. */
function inline(text) {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** Plain text of an inline span, for a heading's contents entry and for the
 *  word count — markup and link syntax are not words a reader reads. */
const plain = (text) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');

/** Heading ids are the anchor a reader copies out of the address bar and the
 *  target of the contents list, so they have to be stable: derived from the
 *  heading text, deduplicated by suffix, never renumbered by position. */
function headingId(text, used) {
  const base =
    plain(text)
      .toLowerCase()
      .replace(/[’'"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      // Several posts number their headings ("3. Fair value…"). An id has to
      // start with a letter, so the number comes off; the words that follow
      // are the durable part of the anchor anyway, and a renumbered list
      // then does not break links people have already shared.
      .replace(/^\d+-/, '')
      .replace(/^\d+/, '')
      .replace(/^-+/, '')
      .slice(0, 60) || 'section';
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

const IND = '    ';

/**
 * Block-level render. The first paragraph becomes the lead, which is how
 * every existing post opens and what the stylesheet expects. Returns the
 * body HTML alongside the H2 headings, which become the contents list.
 */
function renderMarkdown(md, file) {
  const blocks = md.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const used = new Set();
  const outline = [];
  let leadDone = false;

  const html = blocks
    .map((block) => {
      if (block.startsWith('### ')) {
        const text = block.slice(4);
        return `${IND}<h3 id="${headingId(text, used)}">${inline(text)}</h3>`;
      }
      if (block.startsWith('## ')) {
        const text = block.slice(3);
        const id = headingId(text, used);
        outline.push({ id, text: plain(text) });
        // The anchor is a real link rather than a hover-only affordance: it
        // works on a phone, where there is no hover, and it is the thing a
        // compliance lead sends a colleague when they cite one section.
        return (
          `${IND}<h2 id="${id}">${inline(text)}` +
          `<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a></h2>`
        );
      }

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

  return { html, outline };
}

/** Words a person reads: headings and prose, without the markup. */
function countWords(md) {
  const text = plain(md)
    .replace(/^#{2,3}\s+/gm, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '');
  return (text.match(/[A-Za-z0-9’'£%–—-]+/g) || []).length;
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

/** RFC 822, which is what RSS 2.0 wants and ISO 8601 is not. */
function rssDate(iso, time) {
  const stamp = londonTimestamp(iso, time);
  const d = new Date(stamp);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const offset = stamp.slice(-6).replace(':', '');
  const p = (n) => String(n).padStart(2, '0');
  const local = new Date(d.getTime() + (offset === '+0000' ? 0 : 3600000));
  return (
    `${days[local.getUTCDay()]}, ${p(local.getUTCDate())} ${months[local.getUTCMonth()]} ` +
    `${local.getUTCFullYear()} ${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:00 ${offset}`
  );
}

// ── load ─────────────────────────────────────────────────────────────────

function loadPosts() {
  const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) throw new Error('no posts in content/blog/posts');

  const posts = files.map((file) => {
    const slug = file.replace(/\.md$/, '');
    const { data, body } = parseFrontMatter(readFileSync(join(POSTS_DIR, file), 'utf8'), file);

    for (const key of REQUIRED) {
      if (data[key] === undefined) throw new Error(`${file}: missing required front-matter field "${key}"`);
    }
    for (const key of DERIVED) {
      if (data[key] !== undefined) {
        throw new Error(`${file}: "${key}" is counted from the body now — remove it from the front-matter`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error(`${file}: date must be YYYY-MM-DD, got ${data.date}`);
    if (data.updated && !/^\d{4}-\d{2}-\d{2}$/.test(data.updated)) {
      throw new Error(`${file}: updated must be YYYY-MM-DD, got ${data.updated}`);
    }
    if (data.updated && data.updated < data.date) {
      throw new Error(`${file}: updated (${data.updated}) is before date (${data.date})`);
    }
    if (data.time && !/^\d{2}:\d{2}$/.test(data.time)) {
      throw new Error(`${file}: time must be HH:MM, got ${data.time}`);
    }
    if (!TOPIC_KEYS.has(data.topic)) {
      throw new Error(`${file}: topic "${data.topic}" is not one of ${[...TOPIC_KEYS].join(', ')}`);
    }
    if (!AUTHORS[data.author]) {
      throw new Error(`${file}: author "${data.author}" is not one of ${Object.keys(AUTHORS).join(', ')}`);
    }
    for (const source of data.sources || []) {
      if (!source.includes('|')) throw new Error(`${file}: source must be "Label|https://…", got ${source}`);
    }

    const words = countWords(body);

    return {
      slug,
      file,
      ...data,
      body,
      author: AUTHORS[data.author],
      url: `${SITE}/blog/${slug}`,
      // cardTitle is the H1 without its full stop: the H1 is a sentence, the
      // card title is a label. Derived so the two can never drift apart.
      cardTitle: data.title.replace(/\.$/, ''),
      lastmod: data.updated || data.date,
      time: data.time || '09:00',
      wordCount: words,
      readingTime: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
      sources: data.sources || [],
      featured: data.featured === true,
      // A held post. It stays in the repo and keeps being edited, but it is
      // not written, listed, fed or put in the sitemap. Used when a post is
      // written but not yet cleared to publish — on a compliance product's
      // blog that is a normal state, not an exception.
      draft: data.draft === true,
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

  const held = posts.filter((p) => p.draft);
  const published = posts.filter((p) => !p.draft);
  if (published.length === 0) throw new Error('every post is a draft; there is nothing to publish');

  // "related" may name a held post — that is how a held post keeps its place
  // in the map while it waits — but the link is dropped from what is built,
  // because a link to an unpublished page is a 404 with extra steps.
  const all = new Map(posts.map((p) => [p.slug, p]));
  for (const post of posts) {
    for (const slug of post.related) {
      if (!all.has(slug)) throw new Error(`${post.file}: related post "${slug}" does not exist`);
      if (slug === post.slug) throw new Error(`${post.file}: lists itself as related`);
    }
  }
  for (const post of published) {
    post.related = post.related.filter((slug) => !all.get(slug).draft);
    if (post.related.length === 0) {
      throw new Error(
        `${post.file}: every post it links to is held, so it would publish with no "Read next". ` +
          'Add a published post to its "related" list.',
      );
    }
  }

  const featured = published.filter((p) => p.featured);
  if (featured.length !== 1) {
    throw new Error(
      `exactly one published post must set "featured: true" (found ${featured.length}). ` +
        'The index leads with it, so the choice is editorial rather than whichever post is newest. ' +
        'Note that holding a post takes it out of this count.',
    );
  }

  // Every post must be reachable from at least one other post. A post nothing
  // links to is one search engines discover only through the index, and it is
  // the first thing an internal-link audit flags.
  const linkedTo = new Set(published.flatMap((p) => p.related));
  const orphans = published.filter((p) => !linkedTo.has(p.slug) && !p.featured);
  if (orphans.length) {
    throw new Error(
      `no other published post links to: ${orphans.map((p) => p.slug).join(', ')}. ` +
        'Add each to another post\'s "related" list.',
    );
  }

  const bySlug = new Map(published.map((p) => [p.slug, p]));
  return { posts: published, held, bySlug, allPosts: all, featured: featured[0] };
}

// ── render: post ─────────────────────────────────────────────────────────

function renderPost(post, bySlug, allPosts, template) {
  const { html: bodyHtml, outline } = renderMarkdown(post.body, post.file);

  // A prose link to a held post is a link to a page that is not being
  // published. Dropping it silently would change the sentence around it, so
  // the build stops and the writer decides what the sentence should say.
  for (const [, slug] of bodyHtml.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)) {
    const target = allPosts.get(slug);
    if (!target) throw new Error(`${post.file}: links to /blog/${slug}, which does not exist`);
    if (target.draft) {
      throw new Error(
        `${post.file}: links in its prose to /blog/${slug}, which is held. ` +
          'Rewrite the sentence, or publish that post.',
      );
    }
  }

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

  // A contents list of one or two entries is furniture, not navigation.
  const contents =
    outline.length >= 4
      ? `<nav class="article-contents" aria-labelledby="contents-heading">
        <h2 id="contents-heading">On this page</h2>
        <ol>
${outline.map((h) => `          <li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('\n')}
        </ol>
      </nav>`
      : '';

  const sources = post.sources.length
    ? `<section class="article-sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading">Sources</h2>
      <ul>
${post.sources
  .map((s) => {
    const [label, href] = [s.slice(0, s.indexOf('|')).trim(), s.slice(s.indexOf('|') + 1).trim()];
    const external = /^https?:\/\//.test(href) && !href.startsWith(SITE);
    const rel = external ? ' rel="noopener" target="_blank"' : '';
    return `        <li><a href="${escapeAttr(href)}"${rel}>${escapeHtml(label)}</a></li>`;
  })
  .join('\n')}
      </ul>
    </section>`
    : '';

  const related = post.related
    .map((slug) => {
      const r = bySlug.get(slug);
      return `        <li>
          <a href="/blog/${r.slug}">
            <span class="related-topic">${escapeHtml(topicOf(r).name)}</span>
            <span class="related-title">${escapeHtml(r.cardTitle)}</span>
            <span class="related-meta">${r.readingTime} min read</span>
          </a>
        </li>`;
    })
    .join('\n');

  const updatedHuman = post.updated ? humanDate(post.updated) : '';

  const values = {
    slug: post.slug,
    title: escapeHtml(post.title),
    ogTitle: escapeAttr(post.ogTitle),
    breadcrumb: escapeAttr(post.breadcrumb),
    description: escapeAttr(post.description),
    ogDescription: escapeAttr(post.ogDescription),
    twitterDescription: escapeAttr(post.twitterDescription),
    schemaDescription: escapeAttr(post.schemaDescription),
    section: escapeHtml(post.section),
    topicKey: topicOf(post).key,
    topicName: escapeHtml(topicOf(post).name),
    authorName: escapeHtml(post.author.name),
    authorRole: escapeHtml(post.author.role),
    authorRemit: escapeHtml(post.author.remit),
    authorUrl: post.author.url,
    dateHuman: humanDate(post.date),
    // The reviewed line only appears when a post has actually been revisited.
    // A "last updated" stamp that always equals the publication date tells a
    // reader nothing and tells a search engine something untrue.
    updatedLine: post.updated
      ? `<span class="post-card-dot">·</span> <span>Reviewed <time datetime="${post.updated}">${updatedHuman}</time></span>`
      : '',
    readingTime: String(post.readingTime),
    wordCount: String(post.wordCount),
    publishedISO: londonTimestamp(post.date, post.time),
    modifiedISO: londonTimestamp(post.updated || post.date, post.time),
    ctaSubject: post.ctaSubject,
    contents,
    sources,
    body: bodyHtml,
    related,
  };

  return fill(template, values, 'content/blog/post.html');
}

// ── render: index ────────────────────────────────────────────────────────

const topicOf = (post) => TOPICS.find((t) => t.key === post.topic);

function renderFeatured(post, posts) {
  // The featured briefing is an editorial choice, so it is not necessarily the
  // newest one — and calling a five-month-old explainer the latest briefing is
  // a small lie that a reader can check against the date two lines below it.
  const flag = post === posts[0] ? 'Latest briefing' : 'Start here';
  return `<a class="brief" href="/blog/${post.slug}">
          <div class="brief-label">
            <span class="brief-topic">${escapeHtml(topicOf(post).name)}</span>
            <span class="brief-flag">${flag}</span>
          </div>
          <h2 class="brief-title">${escapeHtml(post.cardTitle)}</h2>
          <p class="brief-summary">${escapeHtml(post.cardSummary)}</p>
          <div class="brief-meta">
            <span>${escapeHtml(post.author.name)}</span>
            <span class="post-card-dot">·</span>
            <time datetime="${post.date}">${humanDate(post.date)}</time>
            <span class="post-card-dot">·</span>
            <span>${post.readingTime} min read</span>
          </div>
          <span class="brief-more">Read the briefing</span>
        </a>`;
}

/* The dates here are publication dates, not the reviewed date. Showing the
   reviewed date stamped every briefing with today, which made six posts
   written months apart look as though they had all appeared this morning. */
function renderColumns(posts) {
  return TOPICS.map((topic) => {
    const inTopic = posts.filter((p) => p.topic === topic.key);
    // A topic whose briefings are all held is left out rather than shown
    // empty: a hub with a heading, a description and nothing under it reads
    // as a broken page, not as a promise.
    if (inTopic.length === 0) return '';

    const items = inTopic
      .map(
        (post) => `            <li class="topic-item">
              <a href="/blog/${post.slug}">
                <h3 class="topic-item-title">${escapeHtml(post.cardTitle)}</h3>
                <p class="topic-item-summary">${escapeHtml(post.cardSummary)}</p>
                <div class="topic-item-meta">
                  <span>${escapeHtml(post.author.name)}</span>
                  <span class="post-card-dot">·</span>
                  <time datetime="${post.date}">${humanDate(post.date)}</time>
                  <span class="post-card-dot">·</span>
                  <span>${post.readingTime} min</span>
                </div>
              </a>
            </li>`,
      )
      .join('\n');

    return `        <section class="topic" id="${topic.key}" aria-labelledby="${topic.key}-heading">
          <h2 class="topic-name" id="${topic.key}-heading">${escapeHtml(topic.name)}</h2>
          <p class="topic-blurb">${escapeHtml(topic.blurb)}</p>
          <ul class="topic-list">
${items}
          </ul>
        </section>`;
  }).filter(Boolean).join('\n\n');
}

function renderTopicNav(posts) {
  return TOPICS.filter((t) => posts.some((p) => p.topic === t.key))
    .map((t) => `          <a href="#${t.key}">${escapeHtml(t.name)}</a>`)
    .join('\n');
}

/** The index's Blog + ItemList schema, listing every post in index order. */
function renderIndexSchema(posts) {
  const items = posts
    .map(
      (p, i) =>
        `        {"@type": "ListItem", "position": ${i + 1}, "url": "${p.url}", "name": ${JSON.stringify(p.cardTitle)}}`,
    )
    .join(',\n');
  return `      {
      "@type": "ItemList",
      "name": "CallGuard AI briefings",
      "itemListElement": [
${items}
      ]
    }`;
}

function renderIndex(posts, featured, template) {
  const newest = posts.reduce((acc, p) => (p.lastmod > acc ? p.lastmod : acc), posts[0].lastmod);
  return fill(
    template,
    {
      featured: renderFeatured(featured, posts),
      columns: renderColumns(posts),
      topicNav: renderTopicNav(posts),
      itemList: renderIndexSchema(posts),
      postCount: String(posts.length),
      updatedISO: londonTimestamp(newest, '09:00'),
      updatedHuman: humanDate(newest),
    },
    'content/blog/index.html',
  );
}

// ── render: feed ─────────────────────────────────────────────────────────

/**
 * RSS rather than nothing: the compliance and adviser trade press runs on
 * feed readers, and a feed is the one syndication format that costs a static
 * site nothing to keep accurate.
 */
function renderFeed(posts) {
  const items = posts
    .map(
      (post) => `  <item>
    <title>${escapeHtml(post.cardTitle)}</title>
    <link>${post.url}</link>
    <guid isPermaLink="true">${post.url}</guid>
    <pubDate>${rssDate(post.date, post.time)}</pubDate>
    <category>${escapeHtml(topicOf(post).name)}</category>
    <dc:creator>${escapeHtml(post.author.name)}</dc:creator>
    <description>${escapeHtml(post.cardSummary)}</description>
  </item>`,
    )
    .join('\n');

  const newest = posts[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>CallGuard AI briefings</title>
  <link>${SITE}/blog/</link>
  <atom:link href="${SITE}/blog/feed.xml" rel="self" type="application/rss+xml" />
  <description>Briefings on call compliance for FCA-regulated protection and mortgage advice firms.</description>
  <language>en-GB</language>
  <copyright>© ${new Date().getUTCFullYear()} CallGuard AI Ltd</copyright>
  <lastBuildDate>${rssDate(newest.lastmod, newest.time)}</lastBuildDate>
${items}
</channel>
</rss>
`;
}

// ── sitemap ──────────────────────────────────────────────────────────────

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

// ── plumbing ─────────────────────────────────────────────────────────────

function fill(template, values, what) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`${what} uses {{${key}}}, which the generator does not provide`);
    return values[key];
  });
}

function main() {
  const { posts, held, bySlug, allPosts, featured } = loadPosts();

  for (const post of held) {
    process.stdout.write(`  HELD  ${post.slug} — written, not published\n`);
  }

  const postTemplate = readFileSync(POST_TEMPLATE, 'utf8');
  for (const post of posts) {
    writeFileSync(join(BLOG_DIR, `${post.slug}.html`), renderPost(post, bySlug, allPosts, postTemplate));
    process.stdout.write(`  blog/${post.slug}.html  (${post.wordCount} words, ${post.readingTime} min)\n`);
  }

  writeFileSync(INDEX_OUT, renderIndex(posts, featured, readFileSync(INDEX_TEMPLATE, 'utf8')));
  process.stdout.write(`  blog/index.html (${posts.length} posts, leading with ${featured.slug})\n`);

  writeFileSync(FEED_OUT, renderFeed(posts));
  process.stdout.write(`  blog/feed.xml (${posts.length} items)\n`);

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
  writeFileSync(
    SITEMAP,
    sitemap.slice(0, first.index) + renderSitemapBlock(posts) + sitemap.slice(last.index + last[0].length),
  );
  process.stdout.write(`  sitemap.xml (${posts.length + 1} blog entries)\n`);
}

main();
