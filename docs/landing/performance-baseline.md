# Performance baseline — landing/

**Measured 2026-08-28**, Lighthouse 12.8.2, homepage, mobile emulation, against the
local preview on :4321. Regenerate: `npm run audit:perf`.

## Scores

| Category | Score |
|---|---|
| Performance | 95 |
| Accessibility | 94 |
| Best Practices | 100 |
| SEO | 100 |

| Metric | Value |
|---|---|
| First Contentful Paint | 0.8 s |
| **Largest Contentful Paint** | **3.0 s** |
| Speed Index | 1.7 s |
| Cumulative Layout Shift | 0 |
| Total Blocking Time | 0 ms |

CLS 0 and TBT 0 ms are the good news and they are structural, not luck: every `<img>`
carries explicit `width`/`height`, and both scripts are `defer`red. Protect both — they
are the two numbers a careless change breaks.

## The one real finding: the font is the page

Total transfer 379 KiB. `\/fonts\/InterVariable.woff2` is **352,526 bytes of it — 93%.**

| Resource | Bytes |
|---|---|
| `/fonts/InterVariable.woff2` | 352,526 |
| `/` (document) | 11,034 |
| `/style.css?v=14` | 10,188 |
| `/script.js?v=4` | 5,767 |
| brand SVGs (×2) | ~4,800 |

And the LCP element is `<p class="hero-sub">` — **text**. So the largest paint on the
page is waiting on the largest asset on the page, and the two facts are the same fact.
LCP 3.0s against FCP 0.8s is that gap.

This is the whole performance story. There is no bundle problem, no image problem, no
third-party problem. Before proposing anything else, ask whether it touches the font.

Worth testing, in rough order of payoff:

1. **Subset it.** The site is English-only marketing copy. A Latin + punctuation subset
   of a variable Inter typically lands under 40 KiB. That is a ~90% cut to 93% of the
   page.
2. **Check `font-display`.** Lighthouse scores the audit 1, so nothing is being blocked
   outright — but confirm what the fallback actually looks like rather than trusting the
   score.
3. **Metric-matched fallback stack**, so a swap does not reintroduce the CLS 0 you have.

## Known-noisy locally — do not report these as findings

- **`uses-long-cache-ttl` scores 0.5, "6 resources found."** That is `serve`, not
  production. `.htaccess` sets a year on CSS/fonts/images and `immutable` on hashed
  files. Verify against the live site or ignore.
- **`render-blocking-resources`, "est savings of 0 ms."** Scored 0.5 with nothing to
  save; local has no network latency, which is exactly the condition under which a
  render-blocking stylesheet costs nothing. Re-measure live before acting.
- **GZIP** is `mod_deflate` in `.htaccess` and absent locally, so every byte figure above
  is uncompressed. The font is already compressed (woff2), so its share is real; the
  CSS/JS/HTML shares are overstated.

Genuine and small: `unminified-css`, ~3 KiB.

## The trap

The site sits behind a TLS-terminating CDN, so `%{HTTPS}` is **never** `on` at Apache. A
redirect written against it puts the whole site in a 301 loop. Test
`%{HTTP:X-Forwarded-Proto}`. `.htaccess` edits go to a human — a bad one takes the site
down, not a page.

## Cache-versioning

`style.css?v=14` and `script.js?v=4` are shared by all 33 pages and cached for up to a
year. **Any edit to either must bump its `?v=` on every page that references it**, or
returning visitors keep the stale copy. There is no build step to do this for you.
