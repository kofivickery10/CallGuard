---
version: 1
slug: "landing-index-html"
primary_target: "landing/index.html"
related_targets: []
---

# Surface brief: homepage (landing/index.html)

## Scope and mode
The public homepage at callguardai.co.uk. Mode: Persuade. Homepage only: other landing
pages keep their current design until they get their own round.

## Audience, job, action, proof
- Visitor: a compliance officer or compliance director at a UK FCA-regulated protection
  or mortgage advice firm, evaluating whether AI call scoring can evidence good outcomes
  on every sale.
- Belief to earn: every pass and fail comes with the exact words it was decided on, scored
  to the firm's own standard, with personal data kept away from the AI.
- One action: Request a demo (opens the existing demo form). Email links open email.
- Proof available: the product mechanism itself (synthetic, labelled), published prices,
  UK hosting, published DPA and sub-processor list, founders. No testimonials, logos,
  benchmarks or unverified figures.

## Constraints
- Brand palette and Inter only (BRAND_GUIDELINES.md); protect the AA-darkened tokens.
- Calm expert-analyst voice, UK spelling ("dialler", "adviser").
- Leave out every claim PRODUCT.md lists as unverified; roadmap items never shown.
- Zero findings in the detector's slop category: no kickers, icon tiles, side stripes,
  glows, gradient text, count-up stats.
- Shared style.css / script.js serve 35 pages: homepage styles live in their own file.
- Keep title, canonical, one h1, structured data in step with visible copy.

## Direction contract
THESIS: The compliance-software homepage a buyer expects, done at Vanta's level of craft,
where the product panel is not a screenshot but the verdict itself: a quoted FAIL with its
timecode. It refuses the icon-card feature grid and the unsourced hero statistic.

OWN-WORLD: CallGuard's own product language at marketing scale: green-tinted neutrals,
one committed primary-light field behind the hero, white cards with hairline borders,
pass/fail/review pills that carry text and a glyph, speaker labels, redaction tags set as
inline chips, tabular timecodes. Inter throughout, large and tight for display.

STORY: The visitor sees a real-looking verdict with its evidence, understands the product
checks every call against their own scorecard, sees it works across a whole sale and
against the submitted application, learns personal data never reaches the AI and prices
are published, then requests a demo.

FIRST VIEWPORT: Desktop: headline, one-sentence sub and Request a demo on the left five
columns over the primary-light field; the verdict panel on the right seven columns, showing
a protection advice call, three criterion rows and one FAIL latched to its quoted line at
14:31 with a redaction chip; a trust line (UK-hosted, published prices, DPA) under the CTA.
Mobile: headline, sub, CTA, then the panel full width.

FORM: Category standard (the standing exit, chosen by the user over the rolled hand); seed
key 6bcefa31; craft bar Vanta.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Memorable moment
The hero panel's criterion rows resolve one by one and the consent row latches FAIL on the
quoted line, once, then holds still. Reduced motion shows the final state.

## Unresolved
- Documentation (resolved 14 Sep 2026, owner): no DESIGN.md. The finished homepage patterns are
  recorded as a "Marketing homepage" section in DESIGN_SYSTEM.md, which stays the single authority.
- Site-wide "Book a demo" wording on the other 34 pages is out of scope.
