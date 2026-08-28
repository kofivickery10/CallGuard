# Accessibility baseline — landing/

**Measured 2026-08-28; contrast errors fixed and re-measured the same day.** pa11y 9.1.1 against WCAG 2.1 AA, 8 representative pages in
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

## Per-page

All 8 audited pages: **0 errors** in both themes.

## Also flagged, not caught by pa11y

- **`aria-label` on a plain `<div>` — 30 instances, one per page.**
  `<div class="nav-drawer" id="mobile-drawer" aria-label="Mobile menu">` has no role, so
  the label is discarded and the mobile drawer is announced as nothing. html-validate
  catches this (`aria-label-misuse`); a contrast checker never will. Fix with a role, or
  a landmark element.
- **Heading order** — Lighthouse flags a non-sequential heading on the homepage.
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
- **Two remaining raw hexes on dark surfaces**, `.footer-strapline` and `.cg-cc a`, both
  `#6cc18d` — now duplicated by `--consent-accept`. Both pass contrast; folding them
  into a shared token is tidy-up, not a defect.

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
