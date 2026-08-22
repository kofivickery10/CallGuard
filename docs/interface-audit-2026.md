# CallGuard Interface Audit — August 2026

A UI/UX review of the tenant app (`packages/web`) with a phased plan to bring it to a
current standard. **Nothing here is implemented — this is a plan.**

Measured against commit `9ecc2ec`. Scope: 79 components, 20,419 LOC, 48 routes across
16 nav items. 12 findings: 7 high, 4 medium, 1 low.

**Verdict:** repaint and restructure, don't rebuild. The token architecture is better than
most products this size ever build, and every value in it is wrong for 2026. The pages that
hurt most (a call, a sale) hurt because their height is a function of the data — a
forty-minute call produces a forty-screen page. Both are fixable without a rewrite.

---

## 1. What not to touch

- **The token indirection is right.** Every colour resolves through
  `rgb(var(--cg-*) / <alpha>)`, so components carry no `dark:` variants at all. That is why
  the repaint below is a one-file change rather than a 79-file one.
- **Dark mode is measurably better than light mode.** Every dark text token clears WCAG AA
  on both surfaces; light mode has five failures.
- **The writing is excellent.** "Read this score with care", "Branch 'X' was assumed, not
  confirmed", "Transcript restricted to administrators" — honest interface copy about model
  uncertainty, which is what a regulated buyer needs and almost nobody writes. The visual
  design is letting the copy down, not the reverse.
- **Semantic correctness in the small components.** `ItemResultBadge` refusing to render
  N/A as a red fail; signed numerals so score deltas don't rely on hue; `useCountUp`
  honouring `prefers-reduced-motion`.

---

## 2. Why it reads as old

### A1 — The brand colour and the "pass" colour are the same colour (high)

Primary is `#4a9e6e`; pass is `#2d6e4a`. They contrast against **each other** at 1.86:1 in
light mode and 1.25:1 in dark — visually indistinguishable. A green thing on screen may
mean "click me" or "this call complied", and the interface cannot tell you which. In a
product whose job is rendering a verdict, that is a semantic failure, not a preference.

### A2 — Every neutral is tinted green, so nothing can stand out (high)

Text `#1a2e1a`, borders `#e2e8e2`, page `#f8faf8`, muted `#8a9e8a`. The greys are all
desaturated brand green, producing a single-hue wash in which the accent has nothing to be
an accent *against*. Largest single contributor to the flat, dated feel, and the cheapest
to fix.

Root cause: the palette was transcribed from a static HTML demo
(`callguard-redesign-prompt.md`, `callguard-demo.html`) rather than built as a ramp. That
also explains the arbitrary values in C1 — `px-[18px] py-[9px]` is a CSS rule from that
demo, copied 22 times by hand.

### A3 — Light mode fails accessibility in five places (high)

Computed from `src/index.css` (WCAG 2.1 relative luminance):

| Light token | On white | On page | AA body | Used for |
|---|---|---|---|---|
| `text-muted` `#8a9e8a` | 2.86 | 2.73 | **FAIL** | captions, table headers, timestamps, nav labels |
| `icon-muted` `#aabdaa` | 1.99 | 1.89 | **FAIL** | all stat-card and nav icons |
| `primary` `#4a9e6e` | 3.28 | 3.12 | **FAIL** | links, button labels, "Correct" |
| `review` `#b8860b` | 3.25 | 3.10 | **FAIL** | "Needs review" badge text |
| `text-subtle` `#6a7e6a` | 4.37 | 4.17 | marginal | every page subtitle |
| `text-secondary` `#5a6e5a` | 5.51 | 5.25 | pass | checkpoint labels |
| `text-primary` `#1a2e1a` | 14.49 | 13.81 | pass | headings, values |

`text-muted` fails AA for body text (4.5:1) *and* the large-text floor (3:1). White on a
primary green button is 3.28:1 — a fail at the 13px it is set in. Borders sit at 1.24:1
against card, below the 3:1 a meaningful boundary needs; with shadows defined but
effectively unused, container edges are near-invisible. That is the other half of "flat".

### A4 — Ten type tokens, six actual sizes, one 13.5px range (medium)

The scale runs 10.5→24px. Page titles (19px) sit only 4px above section titles (15px);
body is 13px; captions drop to 10.5–11px. Not enough distance between steps for hierarchy
to register, and the bottom of the scale is below comfortable reading — a problem
specifically for transcripts, the longest-form reading in the product. Three of the ten
tokens are uppercase and letter-spaced (`card-label`, `table-header`, `nav-label`), so
micro-caps appear on nearly every surface; uppercase micro-labels everywhere is the most
recognisable signature of a 2018 admin theme.

Plus ~95 arbitrary `text-[Npx]` declarations across ~40 files escaping the scale entirely,
mostly `text-[11px]` and `text-[10px]`, because no 400-weight caption token exists.

---

## 3. Why the pages get so long

### B1 — Detail pages are one unbounded scroll of equally-weighted panels (high)

`JourneyDetail` stacks up to eleven sections in a single column: back link, header, failure
banner, processing state, scoring-history table, caveats, coaching, checkpoints (*n*),
calls, breaches, capture, reconciliation, feedback. `CallDetail` stacks seven, two of them
unbounded. Every one is `bg-card border border-border rounded-card` — identical weight, so
nothing announces itself as primary, and there is no indication of how much page is below
you or how to reach it.

The mechanism: `TranscriptViewer` is capped at `max-h-[75vh]` on mobile and
`lg:max-h-none` on desktop — so on the screens people actually review on, the transcript
grows without limit and stretches its grid row to match. **Page height becomes a function
of call duration.**

### B2 — The transcript is a plain div-per-line, unvirtualised, untimestamped, unsearchable (high)

A 40-minute call is roughly 600–1,200 speaker turns, all rendered into the DOM at once, at
13px, running the full ~1,400px content width — four times the comfortable reading measure.
No in-transcript search, no timestamps, no speaker jumping, no filter to lines cited as
evidence. Redaction tags (`[NAME_GIVEN_1]`) render as raw text mid-sentence.

Evidence linking is one-shot and one-directional: `?evidence=` highlights a single line on
arrival. Clicking a checkpoint later does nothing, and a transcript line never tells you
which checkpoints cite it.

### B3 — Nothing is findable: no search, no command palette, no durable filters (high)

A product whose primary objects are keyed by customer name, phone and file name has no
global search and no way to jump to a record. Filter state on `Calls` lives in component
state, not the URL — a filtered list cannot be shared, bookmarked or returned to. The back
link on a sale is hardcoded to `/journeys`, discarding whatever the reviewer had filtered.
The absence of ⌘K is on its own the strongest "this is an old app" signal in the product.

### B4 — Sixteen nav items, two of them called "Dashboard" (medium)

Sixteen destinations in four groups, with *Dashboard* at top level and again inside
*Compliance*. Five destinations answer "where do I look at problems?" (Review Queue,
Breaches, Adviser Risk, AI Insights, Calibration), and the Quality/Compliance split is not
a distinction users arrive with. `ComplianceDashboard` (1,044 LOC, eight stacked sections)
and `Integrations` (1,162 LOC) have the same infinite-scroll shape as the detail pages.

---

## 4. Why it will drift back

### C1 — No shared primitives, so "the design" is 135 copies of a string (high)

No `Button`, `Card`, `PageHeader`, `DataTable`, `Modal` or `EmptyState` exists. The card
recipe is inlined **135 times**; the primary button 22 times; `py-[9px]` appears 70 times
and `px-[18px]` 65 times; 21 files hand-roll a `<table>`; 14 hand-roll a spinner.
`DESIGN_SYSTEM.md` §9 already recommends extracting these. Until it happens, any visual
change is a 135-file edit and every new page re-derives the design from whichever page its
author copied.

### C2 — Seven badge families, all the same size and weight (medium)

`ItemResultBadge`, `CallStatusBadge`, `JourneyStatusBadge`, `SeverityBadge`,
`ReconciliationBadge`, `CaptureResultBadge`, `RiskLevelBadge`. Each is individually
sensible; on a sale page five can be visible at once, all pastel-on-tint pills at 11px. The
verdict that matters and the metadata that doesn't shout at the same volume. Should be one
`Badge` with `tone` and `emphasis` props, so a page can have a loudest element.

### C3 — Three loading patterns, two error patterns, no motion policy (medium)

Skeleton shimmer on `Calls`/`Dashboard`, a bare spinner on `CallDetail`/`JourneyDetail`,
plain "Loading…" text on Team/Alerts/Scorecards/Notifications/Breaches. Errors are
sometimes an inline banner and sometimes still `alert()`. And while `useCountUp` respects
`prefers-reduced-motion`, the CSS animations do not — `breach-pulse` runs *infinitely* with
no guard, which for a vestibular-sensitive user is a persistent, unstoppable pulse beside
their most important information.

`DESIGN_SYSTEM.md` §10 is itself now partly stale: it lists raw hex in `TrendCharts`, which
has since been fixed to read CSS vars. Worth a pass so the backlog stays trustworthy.

### C4 — Nothing enforces any of it (low effort, high leverage)

There is no ESLint in this repo, and `tsc` cannot see a hardcoded hex, a `bg-white`, a
`dark:` variant or a `text-[11px]`. Every rule in the design docs is enforced by memory
alone. That is why the drift table exists.

---

## 5. The direction — repaint: same tokens, new values

Because components read tokens and carry no `dark:` variants, changing ~60 CSS custom
properties in one file restyles all 79 components at once. Highest leverage, lowest risk.

**Colour**

- **Neutrals go near-neutral** with a whisper of cool bias (2–4% chroma), so surfaces read
  as paper and the accent has ground to sit on.
- **Brand moves off green** to a deep regulatory ink for actions and links; green is
  retained *exclusively* for pass. Verdict and action stop colliding.
- **Every text token re-derived** to clear 4.5:1 on both surfaces, non-text to 3:1, before
  it ships.
- **Four surface levels** (page / card / raised / overlay) in both themes, so depth carries
  hierarchy. Today there is one raised level, so a modal over a card is invisible without a
  shadow.

> **Decision needed.** Moving the brand off green touches the logo and the marketing site,
> so it is a business call. If green must stay as the brand, the fallback is to separate
> brand from pass by *value* rather than hue: a much deeper, desaturated green for actions
> (~`#1F5F43`) against a lighter, brighter green reserved for pass. That works and clears
> contrast — it is a smaller step forward than the ink. Recommend the ink; either beats
> today.

**Type — six steps with real distance between them**

| Role | Now | Proposed | Why |
|---|---|---|---|
| Display / KPI value | 24px/700 | 30px/600 | a number carrying a compliance verdict should dominate its tile |
| Page title | 19px/700 | 24px/600 | currently only 4px above a section title |
| Section title | 15px/600 | 17px/600 | — |
| Body / table cell | 13px/400 | 14px/400 | biggest legibility win; transcripts most of all |
| Small | 11px/600 | 13px/400 | — |
| Micro / caption | 10.5px | 12px/500 | gives the ~95 escaped sizes a token to land on |

- Retire uppercase micro-caps everywhere except table headers; 12px medium in a muted tone
  reads calmer and more current immediately.
- Cap the reading measure at `68ch` for transcripts, coaching, reasoning and caveats.
- Tabular numerals on all data, not just `ScoreGauge`.
- Optical sizing / a variable display cut for headings costs nothing and reads current.

**Shape, depth, motion**

- A radius *scale*: 8px controls, 12px cards, 16px sheets and modals, full for pills. One
  10px everywhere is why every element looks like every other element.
- Elevation with a job: border-only for dense data containers, one soft shadow for floating
  cards, stronger for popovers, strongest for modals and drawers. Drop the green-tinted
  shadows (`rgba(74,158,110,.08)`) — tinted shadows read cheap.
- A motion policy: 120ms hover/press, 180–240ms overlay entrance, one spring for drawers.
  Guard `breach-pulse` and `skeleton-shimmer` with `prefers-reduced-motion`.
- Give the charts a real palette: a categorical ramp of 5–6 theme-aware series colours,
  emphasised endpoints, a faint grid. There is one `chart-secondary` token today.

---

## 6. The structural fix — the review workbench

The fix for long pages is not smaller components or more collapsing. It is to stop page
height from depending on the data at all.

- **A sticky context header** that compacts on scroll and keeps identity, score, verdict
  and primary actions on screen. Today the header scrolls away, so three screens into a
  transcript you have lost the score and every action.
- **Bound panes, not a bound page.** Checkpoints left, transcript right, each scrolling
  independently inside the viewport.
- **Two-way evidence linking.** Select a checkpoint → the transcript scrolls to and
  highlights its quote and the audio cues to it. A cited transcript line carries a marker
  showing which checkpoints depend on it. Keep the `?evidence=` URL contract — make it
  drive selection instead of a one-shot highlight.
- **Collapse the passes.** Default to failures and needs-review expanded, with "18 passed"
  as one expandable row. Today every item renders full evidence and reasoning regardless.
- **Virtualise the transcript**, with timestamps at each turn head, speaker grouping, a
  sticky current-speaker divider, in-transcript search with match count and next/previous, a
  "cited lines only" filter, and redaction tags as inline chips rather than raw bracket text.
- **A persistent audio dock** with checkpoint markers on its timeline, replacing the
  per-panel players.
- **Modules become tabs with counts** — Capture 3, Reconciliation 2 amendments, Feedback,
  History 4 runs. An unused module costs one tab, not a screenful of empty panel.
- **Caveats stay above the fold.** The "read this score with care" block is the most
  valuable thing on the page for a regulated firm; give it real weight, not an amber border.

The same pattern retires the other long pages: `ComplianceDashboard`'s eight stacked
sections become a fixed tile summary with drill-through, and `Integrations` becomes a list
of connections that open individually rather than one page rendering all of them.

---

## 7. Findability and the reviewer's flow

**Getting to a record**

- A command palette (⌘K): jump to a customer, call or sale by name, phone or file; run
  actions; navigate. Highest perceived-modernity per unit of effort in this document.
- Global search in the header, typed by result kind.
- Filters in the URL, plus saved views per user ("My failures this week", "Consent gates
  awaiting me") and a remembered default. Filter state must survive a share, a bookmark and
  a back button.
- Date range and free-text search on Calls — today it offers two dropdowns and 20-per-page
  paging over what will become tens of thousands of rows.
- Back that returns you to your list, filters intact, rather than to a bare `/journeys`.

**Working the queue**

- Queue mode with auto-advance: resolve an item, land on the next, "3 of 27" visible
  throughout. Today: click in, resolve one, navigate back, lose your place.
- Keyboard first: `J/K` to move, `P/F` to pass or fail, `Space` to play, `←/→` to scrub,
  `/` to search the transcript. Reviewers live here all day; every mouse trip is a tax.
- Toast with undo for reversible actions, replacing the confirm dialog. Keep hard confirms
  where they belong — deleting a call, and re-scoring a sale (which spends tokens and writes
  to the CRM).
- Bulk select in the review queue and on breaches.
- Nav down to ~8 destinations with tabs on arrival: Home, Calls, Sales, **Review** (queue +
  breaches + adviser risk), Customers, **Insights** (insights + calibration + compliance
  overview), **Compliance** (docs + capture + reconciliation + audit), Settings. And one
  page called Dashboard, not two.

---

## 8. Sequence

Ordered so each phase makes the next cheaper, and so visible improvement lands before the
expensive structural work starts. Effort is engineering-days, indicative.

| Phase | Work | Effort | Risk |
|---|---|---|---|
| **0 — Guardrails** | CI script failing on hardcoded hex, `bg-white`, `dark:`, `text-[Npx]` outside an allowlist. Refresh `DESIGN_SYSTEM.md` §10 against reality. | 0.5d | none |
| **1 — Repaint** | Rewrite the ~60 custom properties: neutral ramp, brand separated from pass, contrast-verified text and non-text, four surface levels, untinted shadows, radius scale, chart ramp. Add the type scale and caption token, retire uppercase micro-caps, guard the CSS animations. Sweep the ~95 escaped font sizes. **80% of "it looks new" comes from here.** | 3–5d | needs the brand-colour decision |
| **2 — Primitives** | Extract `Button`, `Card`/`Panel`, `PageHeader`, `StatCard`, `DataTable`, `Badge` (absorbing all seven families), `EmptyState`, `Skeleton`, `Modal`/`Drawer` with focus trap, `Field`, `Toast`. Codemod the 135 card and 22 button recipes onto them. Do it *before* the workbench. | 5–8d | mechanical, reviewable in slices |
| **3 — Workbench** | Rebuild `CallDetail` and `JourneyDetail` per §6, then apply the same treatment to `ComplianceDashboard` and `Integrations`. The real answer to "pages get very long". | 8–12d | behaviour change — test with reviewers |
| **4 — Velocity** | ⌘K, global search, URL filters and saved views, keyboard queue mode, bulk actions, the 16→8 nav collapse. Each ships independently. | 5–8d | additive |

---

## 9. What I would *not* do

- **Not a rewrite, and not a component-library swap.** Dropping in shadcn or Radix
  wholesale would discard a token system better than what most starters ship with, and put a
  79-file migration between you and any visible improvement.
- **No glass, gradient meshes or animated aurora.** The buyer is a compliance officer
  assembling evidence for an insurer or the Ombudsman. Credibility is the aesthetic.
  "Modern" here means clear hierarchy, real depth, honest density and fast keyboard work.
- **No AI-chat surface bolted onto the shell.** The intelligence belongs where the evidence
  is — the checkpoint pane and the coaching panel, both of which already exist and are good.
- **Don't hide the uncertainty to look slicker.** The caveats, confidence percentages and
  manual-review routing are the product's most defensible feature. They should get *more*
  visual weight, not less.
- **Don't skip Phase 0 or 2 to reach Phase 3 faster.** Every previous attempt at this app's
  look was a hand-transcribed spec with no enforcement, which is precisely why there are 135
  copies of one card and a drift table in the docs.
