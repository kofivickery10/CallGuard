# Accessibility baseline — landing/

**Measured 2026-08-28; contrast errors and the footer rebuild both fixed and re-measured the same day.** pa11y 9.1.1 against WCAG 2.1 AA, 8 representative pages in
**both themes** (16 loads), plus html-validate across all 33 pages.
Regenerate: `npm run audit:a11y` and `npm run audit:html`.

## Headline

**0 AA errors — 0 in light, 0 in dark.** (Was 30: 15 light, 15 dark, on 2026-08-28.)

Both root causes were token-level, and both were fixed in one place, as predicted.
Keep auditing both themes: the even 15/15 split is what told us these were token
failures rather than theme-specific ones, and a fix verified in only one theme still
proves nothing.

### Fixed 2026-08-28 — the 30 contrast errors

| Was | Component | Before | After |
|---|---|---|---|
| 16 | `.cg-cc-accept` — cookie banner **Accept** | 3.28:1 both themes | **7.76:1** both themes |
| 14 | `.step-num` — numbered step circles | 3.28:1 light / 2.80:1 dark | **8.15:1** light / **10.95:1** dark |

**`.cg-cc-accept`.** The banner's CSS is injected as a `<style>` block by
`landing/analytics.js`, not written in `style.css` — which is why it had drifted to raw
hex and why an override in `style.css` could never have won on specificity (equal
specificity, injected later). The Accept button was `#4a9e6e` under white: 3.28:1.
Decline was 11.03:1. That asymmetry read as a dark pattern on a consent control.

Three new tokens on `:root`, with **no dark override**, because the banner is a dark
overlay in *both* themes — a theme-following token would invert the button off its own
surface:

```
--consent-accept:       #6cc18d;
--consent-accept-hover: #7fcf9d;
--consent-accept-text:  #10201a;
```

`--primary` could not serve: it is a mid-tone green that carries white text at 3.3:1
light / 2.8:1 dark, and dark ink on it only reaches 4.42:1 — a near miss is still a
miss. `analytics.js` now references the tokens instead of hex. Accept is 7.76:1 on the
fill, and the fill is 6.83:1 against the banner (well past the 3:1 non-text boundary),
so it is legible *and* still reads as the affirmative action.

**`.step-num`.** Was `background: var(--primary); color: white`. `--primary-dark`
already inverts per theme (dark green on light, mint on dark), so it is the correct
fill; it needed a knockout ink that inverts with it. One new token:

```
--on-primary-dark: #ffffff;   /* :root */
--on-primary-dark: #0b110d;   /* :root[data-theme="dark"] */
```

`--primary-dark` itself was **not** touched — its "darkened for AA" comment stands.
The circles also fixed on `/integrations/aws-connect`, `/microsoft-teams` and `/twilio`,
which use `.step-num` but are outside the 8 audited pages.

Verified in the browser at 375px and desktop, in both themes: deep-green circle with a
white numeral in light, mint circle with a near-black numeral in dark; consent banner
buttons legible and equal-width on mobile.

`style.css` went `?v=14 → ?v=15` and `analytics.js` `?v=1 → ?v=2` on all 35/34
referencing pages, including `landing/blog/_template.html` (posts regenerated with
`npm run blog:build`, never hand-edited).

### Fixed 2026-08-28 (later run) — the footer, and the heading skip under it

The footer was rebuilt as one canonical component and applied to all 33 real pages
(everything except `og-image.html`, which is a 1200x630 render template and correctly
has no footer). Before this run there were **nine distinct footer blocks** across the
site — five near-identical full footers that had drifted apart, and four minimal
legal-page footers. pa11y stayed at **0 errors, both themes, before and after**;
html-validate stayed at **62**, none of them in the footer.

Three accessibility things came out of it, none of which a contrast checker would find:

- **Heading skip on all 33 pages.** The footer column headings were `<h5>` following
  `<h3>` page content — a two-level skip. This is the "non-sequential heading" Lighthouse
  flags on the homepage; it was actually site-wide. They are now `<h2 class="footer-col-title">`,
  with the styling on the class so the level can move again without a repaint. Homepage
  heading order is now `h1 h2 h3 … h2` with no skips.
- **No visible focus ring on the footer.** The footer had no `:focus-visible` rule and
  fell back to the UA ring on a dark band. With 30 links it is the largest keyboard
  surface on the site. Added:

  ```
  .footer a:focus-visible { outline: 2px solid var(--accent-on-dark); outline-offset: 3px; border-radius: 3px; }
  ```

- **New token `--accent-on-dark: #6cc18d`** on `:root`, **no dark override** — same
  reasoning as the consent tokens: the footer band is dark in *both* themes, so a
  theme-following green would go dim against `--dark-bg` in light mode. Measured against
  the rendered footer: **6.66:1** light / **8.77:1** dark, so it clears AA as text and
  clears 3:1 as a focus indicator in both. This closes half of the "two remaining raw
  hexes" item below — `.footer-strapline` now reads the token. `.cg-cc a` in
  `analytics.js` still carries the literal; left alone to avoid a second file version bump.

Measured in the browser on the rendered footer, both themes:

| Element | Light | Dark |
|---|---|---|
| `.footer-col a` | 6.98:1 | 8.33:1 |
| `.footer-col-title` | 14.49:1 | 19.09:1 |
| `.footer-strapline` | 6.66:1 | 8.77:1 |
| `.footer-tag` | 6.18:1 | 7.23:1 |
| `.footer-bottom` / cookie prefs | 4.76:1 | 5.33:1 |

Verified at 1280, 768, 700, 605 and 375px in both themes: 6 columns → 3 → 2, tab order
follows visual order (33 links, no `tabindex`), no horizontal overflow at any width, and
nothing in the footer carries `.reveal`, so it is readable whether or not the observer
fires. Drawer re-smoke-tested after the change: Escape closes it, focus returns to the
trigger, `aria-expanded` and the body scroll lock both reset.

`style.css` went `?v=15 → ?v=16` on all 35 referencing files, including
`landing/blog/_template.html`; the six posts were regenerated with `npm run blog:build`.

## Per-page

All 8 audited pages: **0 errors** in both themes.

## Also flagged, not caught by pa11y

- **`aria-label` on a plain `<div>` — 30 instances, one per page.**
  `<div class="nav-drawer" id="mobile-drawer" aria-label="Mobile menu">` has no role, so
  the label is discarded and the mobile drawer is announced as nothing. html-validate
  catches this (`aria-label-misuse`); a contrast checker never will. Fix with a role, or
  a landmark element.
- **Heading order** — ~~Lighthouse flags a non-sequential heading on the homepage.~~
  **Fixed 2026-08-28**: it was the footer's `<h5>` under `<h3>` content, on all 33 pages.
  One skip remains and is *not* the footer: the four legal pages open `h1` → `<h3>Contents</h3>`.
  Pre-existing, confirmed against `HEAD`, out of scope for the footer run.
- **`<button>` without `type` — 30 instances.** Mostly cosmetic, except inside the demo
  form where the default `type="submit"` can fire an unintended submit.

`npm run audit:html` still reports **62 problems**, unchanged by the contrast work.

## Open — needs a design decision

- **Consent-button parity.** Accept is now a bright filled control and Decline is a
  transparent outline. That asymmetry pre-dates this fix (it was just invisible while
  Accept was illegible), but on a site selling compliance software, GDPR/PECR guidance
  points at Accept and Decline being *equally* prominent. Making Decline a filled
  control too is a copy/branding call, not a contrast one. **Kofi to decide.**
- **`.btn-light` on the dark bands in dark mode.** `.btn-light` resolves to `--card-bg`,
  which is dark in dark mode, so the design-partner CTA on `.section-coming` becomes a
  dark button on a dark band. Text contrast passes, so no tool flags it, but the button
  loses its prominence. Not in scope for this run.
- ~~**Two remaining raw hexes on dark surfaces**, `.footer-strapline` and `.cg-cc a`~~ —
  `.footer-strapline` now reads `--accent-on-dark` (added 2026-08-28). Only `.cg-cc a` in
  `analytics.js` still carries the literal `#6cc18d`; pointing it at the token means
  bumping `analytics.js?v=` on 34 pages for a no-op repaint, so it waits for the next
  change to that file.

### Decided 2026-08-28 during the footer run — needs Kofi to confirm or veto

A single shared footer can only carry one of each string, so canonicalising forced four
copy calls. Each is a one-line revert if wrong.

- **We set the footer tagline to "AI compliance scoring for every regulated conversation."
  everywhere, because** 27 of the 29 full-footer pages already said "regulated" and only
  `index.html` and `404.html` said "customer". The homepage keeps its own "Every customer
  conversation." in the `<h1>`, so the phrase is not lost from the page.
- **We put "Smarter calls. Safer business." under the footer logo on every page, because**
  `BRAND_GUIDELINES.md` calls it the *logo strapline* — it belongs to the lockup, and it
  was previously on `index.html` only. Dropping it instead would have removed it from the
  homepage, which is worse.
- **We made the copyright line "© 2026 CallGuard AI Ltd. Company no. 17279006." site-wide,
  because** the legal pages already carried the company number and the other 29 pages did
  not. Companies Act disclosure belongs in the shared footer, not on four pages. Nothing
  lost anywhere.
- **We gave the four legal pages the full footer, because** they had no header navigation
  either — a visitor arriving on `/privacy` from search could reach Home and three other
  legal pages and nothing else. Side effect: those pages now carry "UK-based ·
  GDPR-compliant by default", which is a claim and therefore **`claims-auditor`'s call,
  not mine**. Flagged, not settled.

## What is already right — protect it

- Every `<img>` carries explicit `width`/`height`. CLS is 0.
- `.btn-primary` uses a hand-written `#2d6e4a` with a "darker for AA contrast" comment
  (6.11:1 under white). Left alone deliberately this run — it passes, and re-pointing the
  site's primary button at a new token was outside the brief.
- Several tokens (`--primary-dark`, `--text-cell`, `--text-muted`) carry comments
  recording that they were **darkened to reach AA**. Do not lighten them back for
  aesthetics. That comment is a previous fix defending itself.

## How to audit properly

`npm run audit:a11y` sets `cg-theme` in `localStorage` and stamps `data-theme` before
first paint, so each page is measured in the theme a returning visitor would see. That
is the only reason the dark-mode failures above are visible at all — auditing the
default would have found 15 of 30 and called the site half as broken as it is.

Automated tools cover roughly a third of WCAG. They do not check focus order, focus
trapping in the drawer and demo modal, Escape-to-close, focus return to the trigger,
or whether `prefers-reduced-motion` actually stops the scroll reveals. Those are manual,
in a browser, at mobile and desktop width.

## Config note

`.htmlvalidate.json` disables `doctype-style`, `no-inline-style` and `no-redundant-role`.
These are house style, not defects — the site writes `<!doctype html>` deliberately, uses
inline style for one-off spacing, and `role="banner"` on `<header>` is harmless. That
tuning takes the report from 165 findings to 62 real ones. A tool that cries wolf gets
ignored, which is worse than not running it.
