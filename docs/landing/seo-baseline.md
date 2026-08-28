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
