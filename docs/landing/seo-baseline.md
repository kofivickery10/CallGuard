# SEO baseline — landing/

**Measured 2026-08-28** against the local preview and, where marked, the live site.
Regenerate: `npm run audit:onpage` (files, no server needed) and `npm run audit:links`
(needs the preview running).

## Shape of the site

33 indexable pages, hand-maintained `<head>` on every one. `404.html` and
`og-image.html` are excluded from the audit — the first is noindex, the second is a
render source for the social card, not a page.

```
  1  homepage                    6  compare/*-alternative
  1  pricing                     5  use-cases/*
  1  about                       4  integrations/*
  4  legal (privacy, terms,      2  templates/*
       dpa, sub-processors)      6  blog/* + index
```

## Head integrity — clean

0 errors. Every page has a title, a meta description and an absolute extensionless
canonical. No duplicate titles. No canonical ending `.html`. One `h1` each.

This is worth stating plainly because it is the part most likely to rot: the heads are
copy-pasted, so the next new page inherits whatever the page it was copied from had.
`npm run audit:onpage` exits non-zero on any of these, so wire it into the deploy if it
ever regresses.

9 length warnings (titles over 60ch, descriptions over 160ch) — truncation in the SERP,
not a defect:

| Page | Issue |
|---|---|
| `/compare/callminer-alternative` | title 69ch, description 187ch |
| `/templates/mcob-mortgage-scorecard` | title 68ch |
| `/blog/what-is-ai-call-qa` | title 64ch |
| `/about` | title 63ch |
| `/blog/ai-vs-human-call-scoring`, `/use-cases/collections` | title 62ch |
| `/compare/convin-alternative` | title 61ch |
| `/templates/protection-consent-gate-checklist` | description 178ch |

## Internal linking — the actual problem

**No orphans.** But seven pages have exactly one inbound link, and all seven are the
pages that need crawl budget most:

- all six `compare/*-alternative` pages, each reachable only from `/compare/`
- `/blog/vulnerable-customer-call-monitoring`, reachable only from `/blog/`

Given that indexation and not ranking is this domain's constraint, a single inbound link
from a hub page is a thin crawl path to the six pages that target competitor-alternative
queries — commercially the highest-intent terms on the site. This is the single highest-
leverage on-page fix available and it costs nothing but links.

## Live-site state

`/blog/vulnerable-customer-call-monitoring` **404s in production** while existing in the
repo and in the local sitemap. The post was merged in `b93453a`; the build output was
never uploaded. The repo is ahead of production.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cache-Control: no-cache' \
  https://callguardai.co.uk/blog/vulnerable-customer-call-monitoring
```

Re-check this before concluding anything about indexation: a sitemap entry that 404s
teaches the crawler to trust the sitemap less.

## Broken outbound links — verified dead

117 links checked, 5 broken. Four are on `/sub-processors`, and all four still 404 with a
browser user agent, so this is not bot-blocking:

- `https://www.anthropic.com/legal/dpa`
- `https://deepgram.com/legal/dpa` (308s, then 404s at the destination)
- `https://resend.com/privacy`
- `https://slack.com/intl/en-gb/trust/data-management/customer-data-request-process`

Worth escalating rather than silently repointing: `sub-processors.html` is a published
data-protection disclosure, and each dead link is a DPA it claims a customer can go and
read. Finding the current URL is an SEO fix; deciding whether the disclosure is still
accurate is not, and belongs with whoever owns the DPA.

## Carried forward — NOT re-measured

From the August 2026 review, which is not in this repo and which nothing here verifies:
18 pages indexed against 53 known URLs, 23 in "Discovered — currently not indexed",
average position 9. **Treat as stale.** Search Console needs Kofi's login; until someone
pulls it, these are the last known values and not current state.

Note the discrepancy worth resolving: that review counted 53 URLs, this audit finds 33
pages. Either the count included non-page URLs, or 20 URLs have since gone.

---

## Re-measured 2026-09-14 (blog + page-architecture audit, report only, no site files edited)

### Tool output

- `npm run audit:onpage`: 33 pages, 0 errors, 16 warnings (the 9 length warnings above,
  unchanged, plus the same 7 thin-inbound pages). Nothing moved since 2026-08-28.
- `audit:links` (linkinator on the preview): 119 links, 25 "broken", every one a
  trailing-slash variant (`/pricing/`, `/compare/aveni-alternative/`, ...) reported with
  the extensionless page as its parent. No relative href in the source explains it and
  production serves those variants 200, so treat it as a preview artefact. Not proven.
- JSON-LD parses on the blog index and all 6 generated posts.

### Closed

- `/blog/vulnerable-customer-call-monitoring` now **200 in production** with the cache
  bypassed. All 33 sitemap URLs return 200. The live blog HTML matches local except
  `style.css?v=15` (live) vs `v=16` (local).

### New defects, production (verified with curl, cache bypassed)

| Severity | Defect | Evidence |
|---|---|---|
| High | `/blog/_template` is live and indexable: `<title>{{ogTitle}} \| CallGuard AI`, canonical `https://callguardai.co.uk/blog/{{slug}}`, robots `index,follow` | `curl https://callguardai.co.uk/blog/_template` → 200 |
| Medium | Post sources are public: `/blog/_posts/<slug>.md` → 200 | `curl -o /dev/null -w '%{http_code}' .../blog/_posts/what-is-ai-call-qa.md` |
| Medium | Internal ops doc is public: `/DEPLOY.md` → 200 | same |
| Medium | Directory URLs without a slash take 2 hops through `http://`: `/blog`, `/compare`, `/templates`, `/use-cases` → 301 `http://.../x/` → 301 `https://.../x/`. mod_dir's DirectorySlash builds the scheme itself behind the TLS CDN, the same failure the `.html` strip rule already had. No internal link uses the slashless form, so only external links are exposed. | `curl -sI https://callguardai.co.uk/blog` |
| Low | `/use-cases/` and `/integrations/` → 403 (no index file). Nothing links there. | curl |
| Low | `/index`, `/blog/index` and trailing-slash post URLs serve 200 duplicates. They canonicalise correctly. `/index.html` 301s to `/index`, not `/`. | curl |

`.htaccess` fixes go to a human. Proposed, untested against live:
`RewriteCond %{REQUEST_FILENAME} -d` + `RewriteRule ^(.+[^/])$ https://callguardai.co.uk/$1/ [R=301,L]`
placed before the pretty-URL rule, and `RedirectMatch 404 ^/(blog/_|DEPLOY\.md)`.

### New defects, repo

- All 6 generated posts still say "Book a 15-min demo". `_template.html` now says "Request
  a demo" (changed 2026-09-14), but `npm run blog:build` has not been re-run. PRODUCT.md
  says not to state a demo length.
- `wordCount` is hand-typed front-matter and has drifted: ai-vs-human 1500 (body 1674),
  what-is-ai-call-qa 1500 (1682), pecr 1500 (1578), fca 1600 (1518).
- The redesigned homepage (`index.html`, commit 1c94c0b) is **not live**. Production still
  serves the old `hero-headline` design.
- Blog head gaps against the homepage standard: no `og:image:width/height/alt`, no
  `article:modified_time`. Every post has `dateModified` = `datePublished`, author is
  Organization, and `publisher` is an `@id` reference to a node defined only on `/`.
- Only 1 of 6 posts links to fca.org.uk (vulnerable-customer, 2 links). None links to the
  FCA Handbook or the ICO.
- Claims routed to `claims-auditor`, not fixed here: "Live AI Scoring" in the
  `/integrations/twilio` and `/integrations/aws-connect` titles (live is breach detection
  only); "the four outcomes" in the fca post card summary and the pecr post; ">75%"
  threshold in what-is-ai-call-qa; unsourced 5% sample figures across posts.

### Proxy, not measured

A public `site:callguardai.co.uk` query surfaced one URL, and on the **www** host
(`www.callguardai.co.uk/blog/score-100-percent-contact-centre-calls`). www 301s to the
bare host in one hop, so this is either stale or a consolidation still pending. Search
Console is the only real answer: pull Pages → indexed / not indexed by reason, and URL
Inspection for `/blog/vulnerable-customer-call-monitoring`, `/compare/aveni-alternative`,
and `/blog/_template`.

### Open recommendations, awaiting owner decision

- Page architecture: add **one** capability URL now (Reconciliation), a security/trust
  page second, and none for journey scoring, live detection or "how it works".
- Named author bylines for blog E-E-A-T.
- Move `_template.html` and `_posts/` out of `landing/` so they cannot be uploaded.

No human overrules recorded this run.
