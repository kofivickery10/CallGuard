## Wrapping and setup

These are the tenant-facing components from CallGuard's `packages/web` React/Vite/Tailwind app — a real production app, not a components-only library. Most exported pieces (badges, panels, gauges, `Layout`) are **presentational**: they take data via props and render with no context requirement, which is why they render cleanly with no provider configured.

- **Dark mode** is a class toggle, not a provider: Tailwind's `darkMode: 'class'`. Wrap your composition root in a `<div class="dark">` (or set it on `<html>`) to preview the dark palette — light is the default with no class needed. `ThemeToggle` flips this by toggling `dark` on `document.documentElement`.
- `DialogProvider` (context: `confirm()`/`notify()`, replacing `window.confirm`/`alert`) sits high in the real app's tree (`BrowserRouter > QueryClientProvider > AuthProvider > DialogProvider > App`). Only wrap it if you compose a piece that explicitly calls the `useDialog()` hook — most components here don't.
- Nothing in this set needs a router or query client to render; components that show live data (`ScorecardResultCard`, `TrendCharts`, `TranscriptViewer`, …) take that data as props, they don't fetch it themselves.

## The styling idiom

Tailwind, but **only through this design system's named tokens** — never raw hex, never `bg-white`/`text-black`, never a `dark:` variant (dark mode falls out of the tokens automatically because every color is a CSS custom property Tailwind reads via `rgb(var(--cg-*) / <alpha-value>)`). Real vocabulary from `tailwind.config.js`:

| Purpose | Classes |
|---|---|
| Surfaces | `bg-page`, `bg-card`, `border-border`, `border-border-light` |
| Text | `text-text-primary`, `text-text-secondary`, `text-text-muted`, `text-text-subtle`, `text-text-cell` |
| Brand | `bg-primary`, `hover:bg-primary-hover`, `bg-primary-light`, `text-primary` |
| Status | `bg-pass`/`bg-pass-bg`, `bg-fail`/`bg-fail-bg`, `bg-review`/`bg-review-bg`, `bg-processing`/`bg-processing-bg` |
| Type scale | `text-page-title`, `text-page-sub`, `text-section-title`, `text-card-label`, `text-card-value`, `text-table-header`, `text-table-cell`, `text-nav-item`, `text-badge` |
| Shadow | `shadow-card` |

Status must never be color-only — pair a status class with text or an icon (`strokeWidth="1.8"` outline SVGs, no emoji). Compose new screens only from this table plus the canonical component recipes (badges, modals) — don't invent a one-off variant with arbitrary `text-[Npx]` or a new raw color.

## Where the truth lives

Read before styling anything new: `guidelines/BRAND_GUIDELINES.md` (identity, full color/type tokens, voice) and `guidelines/DESIGN_SYSTEM.md` (layout, component recipes, states, accessibility, the new-feature checklist) — both are the bound copies of this repo's real design docs. The compiled stylesheet reachable from `styles.css` is the token source of truth; `tailwind.config.js` (not shipped, but mirrored in BRAND_GUIDELINES.md) is where every token above is defined.

## Idiomatic build snippet

```tsx
<div className="bg-card border border-border rounded-lg shadow-card p-4">
  <div className="text-card-label text-text-muted mb-1">Calls scored</div>
  <div className="text-card-value text-text-primary">1,204</div>
  <span className="inline-flex items-center gap-1 text-badge bg-pass-bg text-pass rounded px-2 py-0.5 mt-2">
    <CheckIcon strokeWidth={1.8} className="w-3.5 h-3.5" /> Pass
  </span>
</div>
```
