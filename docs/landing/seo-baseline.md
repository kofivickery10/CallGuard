# SEO baseline — landing/

**Measured 2026-09-08** against the local preview and, where marked, the live site.
Regenerate: `npm run audit:onpage` (files, no server needed) and `npm run audit:links`
(needs the preview running).

## Shape of the site

33 indexable pages, hand-maintained `<head>` on every one. `404.html` and
`og-image.html` are excluded from the audit — the first is noindex, the second is a
render source for the social card, not a page. `blog/_template.html` is a build input,
not a page; see "Build sources were being served" below.

```
  1  homepage                    6  compare/*-alternative
  1  pricing                     5  use-cases/*
  1  about                       4  integrations/*
  4  legal (privacy, terms,      2  templates/*
       dpa, sub-processors)      6  blog/* + index
```

## On-page audit — clean

`npm run audit:onpage`: **33 pages, 0 errors, 0 warnings.** First fully clean run.
The nine title/description length warnings and the seven thin-inbound warnings carried
by the 2026-08-28 baseline were fixed on 2026-09-08; see below.

Heads remain copy-pasted, so the next new page inherits whatever it was copied from.
`audit:onpage` exits non-zero on any ERROR-level finding — wire it into the deploy.

## Build sources were being served — NEW, found 2026-09-08

Not in the previous baseline, and the most consequential finding of that run.

- `https://callguardai.co.uk/blog/_template` returned **200**, with
  `<meta name="robots" content="index,follow">`, `<title>{{ogTitle}} | CallGuard AI</title>`
  and `<link rel="canonical" href="https://callguardai.co.uk/blog/{{slug}}">`.
- All six `https://callguardai.co.uk/blog/_posts/*.md` returned **200** — the raw
  Markdown source of every published post, byte-for-byte duplicate content.

Cause: the landing site deploys by manual whole-folder upload (`landing/DEPLOY.md`),
which has no exclude list on the cPanel and SFTP routes.

Fix applied in-repo: `.htaccess` now returns **410 Gone** for both, `DEPLOY.md` grew
rsync `--exclude`s and an explicit warning, and the rules sit *before* the pretty-URL
rewrite that would otherwise map `/blog/_template` to the `.html`.

**Decided: 410, not robots.txt `Disallow`.** A `Disallow` blocks the very fetch that
would remove an already-indexed URL, and can strand it as a title-less entry. Google
must be able to crawl these to drop them. Revisit adding a `Disallow` only once Search
Console shows them gone.

**Still owed:** the `.htaccess` change is in the repo and NOT on the server. It does
nothing until uploaded. Verify after upload:

```bash
for u in /blog/_template /blog/_posts/what-is-ai-call-qa.md; do
  curl -s -o /dev/null -w "%{http_code} $u\n" -H 'Cache-Control: no-cache' \
    "https://callguardai.co.uk$u"
done   # both should be 410
```

## Internal linking — was the problem, now fixed

The 2026-08-28 baseline recorded seven pages with one inbound link. The 2026-09-08
analysis sharpened that: `compare/*` was not merely thin, it was a **closed cluster** —
the six children linked only to their hub and (after the first pass) each other, with
no inbound from any commercial page. `templates/*` was the weakest-linked section on
the site: four inbound sources against 30+ for use-cases and integrations, and absent
from the sitewide footer.

Inbound *source pages* per target, before → after:

| Target | Before | After | What changed |
|---|---|---|---|
| each `compare/*-alternative` | 1 | 7 | sibling cross-links + a money-page link |
| `/templates/` | 4 | 30 | added to the sitewide footer |
| `/blog/vulnerable-customer-call-monitoring` | 1 | 3 | reciprocal `related:` front-matter |

Money-page links that broke the cluster open:

- `/use-cases/financial-services` → Aveni, Recordsure
- `/use-cases/bpo` → CallMiner, Observe.AI, Convin
- `/use-cases/outbound-sales` → Balto

Implemented with a new shared `.link-list` CSS recipe in `style.css` (token-only,
`:focus-visible` ring, responsive auto-fit grid) rather than an inlined per-section
variant. Verified rendering in light and dark, desktop and mobile.

**Why the blog orphan happened, because it will recur:** `related:` in post
front-matter is *one-directional*. The newest post listed two others; nobody listed it.
Every new post is born orphaned unless an existing post's front-matter is edited to
point back. Consider making `build-blog.mjs` warn on a post with zero inbound `related:`.

## Titles and descriptions

All nine length warnings cleared on 2026-09-08 by shortening. `(34 Criteria)` was
*removed* from one `<title>` while `og:title` and `twitter:title` deliberately keep it —
social cards have no SERP truncation limit, so that divergence is intentional, not drift.

**Two of the nine shortenings strengthened a claim, and `claims-auditor` caught both.**
Recorded here because the failure mode will recur every time a title is trimmed:

- `/use-cases/collections`: shortened to "CONC Debt Collection Call Compliance Software".
  The page's own `h1` says **"CONC-ready"**, and its body says the regime comes from the
  scorecard *the customer uploads*. Dropping "-ready" moved a firm obligation onto the
  product. Now "CONC-Ready Debt Collection Call Compliance | CallGuard AI".
- `/compare/convin-alternative`: "Convin Alternative**:** Compliance Call Scoring"
  reads appositively — tagging *Convin* with that category — which contradicts the site's
  own label for them ("Omnichannel QA suite") and that page's own thesis. The purposive
  "for" was doing real work. Restored: "Convin Alternative **for** Compliance Scoring".

**Rule that follows: when trimming a title, check the page's own `h1` first.** In both
cases the `h1` was more careful than the title that replaced it. A hedge word
("-ready", "typically", "for") is usually load-bearing, and dropping one to save four
characters is never worth it.

### Check `<title>` against the JSON-LD `name`

Compare pages carry the page title twice — in `<title>`/`og:title`/`twitter:title`, and
again as `WebPage.name` in the JSON-LD. Editing one and not the other leaves a
machine-readable contradiction on the exact string a crawler indexes. Found on three of
six pages on 2026-09-08 (two caused by that day's edits, one pre-existing on
`/compare/observe-ai-alternative`); all six now match. Worth adding to `audit:onpage`:

```bash
for f in landing/compare/*-alternative.html; do
  t=$(grep -m1 -oP '(?<=<title>).*(?=</title>)' "$f" | sed 's/ | CallGuard AI//;s/&amp;/\&/g')
  n=$(sed -n '/"@type": "WebPage"/,/"url"/p' "$f" | grep -m1 -oP '(?<="name": ").*(?=",)')
  [ "$t" = "$n" ] || echo "DRIFT $f"
done
```

### Competitor category labels

The six `compare/` category labels are now reused as `.link-note` text on eleven pages,
so each is an unqualified assertion about a named third party rather than a caption above
a paragraph that qualifies it. Two were changed on 2026-09-08 because **the site's own
body copy contradicted them**: Observe.AI was labelled "Mid-market" while that page cites
their US enterprise references (now "US contact centre conversation intelligence"), and
Recordsure "UK wealth file review" while that page describes UK government customers and
face-to-face capture (now "UK advice file review and meeting capture"). A comparison must
be objective and must not denigrate; a bare label that understates a competitor **and is
contradicted by your own page** is the worse half of that problem. Change labels in
`compare/index.html` and every `.link-note` together — they must stay in one voice.

Also fixed, pre-existing: `/compare/callminer-alternative` and
`/compare/observe-ai-alternative` both said "Three things they do well" above **four**
blocks. The other four pages said "Four". This matters more now that the cross-link copy
invites readers to compare the six side by side.

## Sitemap

`lastmod` is now derived, not hand-edited: from the file's last commit date, today's
date for a page edited in the working tree, and for `blog/*` from the post's front-matter
`date` (which `npm run blog:build` owns and will overwrite). The previous spread ran
back to 2026-04-28 on pages that a site-wide commit had since touched.

## Live-site state

- `/blog/vulnerable-customer-call-monitoring` **still 404s in production** (re-verified
  2026-09-08, cache-bypassed). Merged in `b93453a`; the build output was never uploaded.
  A sitemap entry that 404s teaches the crawler to distrust the sitemap, which on a
  crawl-constrained domain is the most expensive single defect open.
- `www` → apex redirects resolve in one hop, no chain, no loop.

## Broken outbound links — verified dead, still open

117 links checked, 5 broken. Four are on `/sub-processors`, all still 404 with a browser
user agent, so this is not bot-blocking:

- `https://www.anthropic.com/legal/dpa`
- `https://deepgram.com/legal/dpa` (308s, then 404s at the destination)
- `https://resend.com/privacy`
- `https://slack.com/intl/en-gb/trust/data-management/customer-data-request-process`

Escalate rather than silently repointing: `sub-processors.html` is a published
data-protection disclosure, and each dead link is a DPA it claims a customer can read.
Finding the current URL is an SEO fix; deciding whether the disclosure is still accurate
belongs with whoever owns the DPA.

## Pre-existing HTML validation errors — not SEO, for landing-ux

`npx html-validate "landing/compare/*.html"` reports 2 errors on every compare page
(14 total), both in the shared nav at lines 132/137: `<button>` missing a `type`, and
`aria-label` on a `<div class="nav-drawer">`. Present before 2026-09-08 and untouched.

## Open claim defects — NOT SEO, but they gate the pages SEO touches

Surfaced by `claims-auditor` on 2026-09-08 while auditing the title changes, and
independently verified by grep. None was introduced by SEO work; all are pre-existing and
none is an agent's to rewrite, because they are product and regulatory claims.

**1. `/use-cases/collections` line 260 claims zero false positives.**

> "High confidence threshold means no false positives."

An absolute zero-false-positive claim is unsubstantiable in principle for an LLM
classifier, and it is the exact opposite of this project's stated positioning of
publishing the rate it measured itself. Per `reconciliation-aug-2026-baseline`, the
published false-positive figures are stale and a production re-run is still owed — so the
site asserts *zero* while the honest number is *unknown*.

**2. The manual-sampling statistic appears in three mutually contradictory ranges.**

| Figure | Where |
|---|---|
| 1 to 3% | `use-cases/collections.html:181`, `use-cases/outbound-sales.html:181` |
| 1% to 3% | `use-cases/bpo.html:183` |
| 1% to 5% / 1-5% | `blog/_posts/what-is-ai-call-qa.md:29` and `:83` — **disagreeing inside one file** |
| 5 to 10% (and a `5-10%` stat card) | `index.html:266`, `:271` |

None carries a source or a date. Two of them are in the same file. `about.html:113`
already models the fix — *"most compliance teams can only review a tiny sample of their
calls"* — unquantified, and so needs no source.

**3. `/use-cases/collections` line 256 attributes an operational control to Consumer Duty.**

> "...a webhook fires for floor-manager intervention. The standard expected by FCA
> Consumer Duty."

Consumer Duty requires firms to deliver good outcomes; FG21/1 is guidance on vulnerable
customers. Neither prescribes real-time supervisor intervention mid-call. The regulator
sets the outcome, not the control.

**Caveat on the above:** `claims-auditor` could not load its canonical register —
`claude/positioning-brief.md`, `claude/handbook-citations-verified.md` and
`claude/cobs-92-correction.md` are all absent from this repo. Its *passes* are therefore
provisional; only the failures above were independently verified here. **Restoring or
relocating that register is a prerequisite for trusting any future claims audit.**

## Search performance — NOT measured, needs Kofi's login

The August 2026 figures (18 indexed of 53 known URLs, 23 "Discovered — currently not
indexed", average position 9) remain **stale and unverified**. The 53-vs-33 discrepancy
is still unresolved. What to pull when Search Console is available:

1. Coverage: indexed vs "Discovered — currently not indexed", with the URL list for the
   second — this resolves the 53-vs-33 question.
2. Performance, 6 months, impressions by page — specifically whether
   `/blog/score-100-percent-contact-centre-calls` out-impresses `/use-cases/bpo`.
3. Non-brand queries at positions 11–30 — the page-two set, fixable by title and meta.
4. Query split for "consumer duty", "vulnerable customer", "mcob".
5. Brand queries, to size the same-name collision below.

## Open decisions for a human

- **Retarget `/use-cases/financial-services` onto Consumer Duty and vulnerable
  customers.** Both terms are currently owned only by blog posts, one of which 404s.
  The use-case page carries neither in its `<title>` or `h1`. Judged the highest-value
  remaining change, but it puts a regulatory citation in customer-facing copy, so the
  wording must go through `claims-auditor` and is not an agent's call to apply.
- **Brand SERP collision.** Three same-name entities compete on brand queries: Eckoh's
  CallGuard (UK PCI-DSS contact-centre product), `callguardai.ai` (AI receptionist) and
  `callguard.tech`. Not an on-page fix; a positioning question. Unverifiable without
  Search Console.
- **Compare pages worth the crawl budget** (proxy SERP evidence, not ranking data):
  Recordsure and Aveni are the cheapest wins — no competitor has built the page.
  CallMiner has real demand but a saturated SERP. Observe.AI, Convin and Balto are
  saturated and the least positioning overlap. Deprioritise in the link graph rather
  than deleting — removing published URLs destroys signal.
- **Queued, deliberately NOT built:** compare pages for Voyc, Sedric and Callytics, all
  unrepresented on the site. See below.

## Decided: add nothing this quarter

Depth before breadth, made explicit. The site has 33 pages, of which (stale, August)
roughly 18 were indexed. Until that ratio moves, **no new URLs** — not the Consumer Duty
page, not an FG21/1 explainer, not the three missing compare pages. Every one has a
defensible business case and every one makes the crawl problem worse.

Equally: **consolidate nothing and drop nothing.** The five use-cases are distinct
regulatory contexts, the four integrations distinct diallers, the two templates distinct
scorecards. Merging or deleting any of them discards accrued signal for a marginal crawl
saving, and every one is a published canonical — a migration decision for a human.
