# CallGuard AI — Design System & UI/UX Guidelines

> How to build UI in CallGuard so every feature looks and behaves like one product.
> Pairs with [BRAND_GUIDELINES.md](BRAND_GUIDELINES.md) (identity, colour, type tokens).
> The implemented tokens in `packages/web/tailwind.config.js` + `src/index.css` are
> the source of truth; this doc defines the **patterns** built on top of them.
>
> **The one rule that prevents most drift:** never hardcode. Use token colour
> classes (not hex / `bg-white` / `dark:`), named type tokens (not `text-[22px]`),
> and the canonical component recipes below (not a fresh inline variant).

---

## 1. Layout & shell

- **Tenant app (`packages/web`)** — the shell provides page padding and width:
  `Layout.tsx` wraps content in `py-6 px-4 sm:px-6 lg:px-8 w-full max-w-[1760px] mx-auto`.
  Pages are plain `<div>`s; **don't add your own outer padding** — space sections with `mb-*`.
- **Admin app (`packages/admin-web`)** — the shell does **not** pad (`<main class="flex-1 overflow-auto bg-page">`),
  so admin pages self-wrap in `<div className="p-6 space-y-6">`. Follow the existing
  admin convention on admin pages; follow the web convention on tenant pages.
- Both apps share the same tokens, type scale, radii and shadows. Prefer `space-y-*`
  on a page wrapper over per-element `mb-*` for new pages — it's the more robust of the two.

## 2. Page header (canonical)

Every page starts with this. Use `h2` + the type tokens; put actions/filters on the right.

```tsx
<div className="flex items-center justify-between mb-7">
  <div>
    <h2 className="text-page-title text-text-primary">Title</h2>
    <p className="text-page-sub text-text-subtle mt-1">One-line description</p>
  </div>
  {/* right-aligned actions / filters */}
</div>
```

Reference: `web/src/pages/Dashboard.tsx`. Do **not** use `h1` + `text-xl font-bold`
(admin pages currently do — see §10; new work should use the token). Subtitle colour
is `text-text-subtle` (not `text-text-secondary`).

## 3. Spacing & grid rhythm

- **Section gaps:** `mb-7` after the header and between major sections; `mb-5`/`mb-4` between cards. On new pages prefer a `space-y-6` wrapper.
- **Grid gaps:** `gap-4` for large cards/tiles, `gap-3` for dense stat rows, `gap-2` for chips/inputs. Don't invent new gap values.
- **Stat/KPI grid:** `grid grid-cols-2 md:grid-cols-4 gap-3` (or `gap-4`).
- **Tile grid:** `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4` (settings tiles, scorecards).

## 4. Components — canonical recipes

Until shared components exist (see §9), copy these exact recipes so variants don't multiply.

### Buttons
No shared `Button` exists yet (see §9), so these are the canonical recipes to copy.
Text is the `text-table-cell font-semibold` token pair; always include a `disabled:`
state (`disabled:opacity-50`) and `transition-colors`. Don't invent new paddings —
the app currently has 6+ (`px-3 py-1.5`, `px-6 py-3`, `px-[14px] py-[7px]`, …); use the
recipe padding below.

```tsx
// Primary (the dominant recipe, ~25 uses)
className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
// Secondary / outline (cancel)
className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors"
// Destructive — no standard exists today; use this. Solid for the main action,
// outline for a secondary destructive control.
className="... bg-fail text-white hover:opacity-90 ..."      // or: border border-fail text-fail hover:bg-fail-bg
// Ghost icon button (40px hit area — ALWAYS aria-label)
className="w-10 h-10 rounded-full hover:bg-sidebar-hover flex items-center justify-center transition-colors"
```

(When the shared `Button` is extracted, normalise padding onto the clean scale, e.g. `px-4 py-2`.)

### Cards, panels, stat cards
- **Card/panel:** `bg-card border border-border rounded-card` (+ `shadow-card` when resting on the page). Keep class order `bg-card border border-border rounded-card` (admin flips it — don't).
- **Padding:** `p-5` (standard) or `p-6` (roomy settings cards). Not `p-4`-for-cards.
- **Stat card:** `bg-card border border-border rounded-card p-5`; label `text-card-label uppercase text-text-muted`; value `text-card-value` (never `text-2xl font-bold`); optional change indicator `text-[12px]` in `text-pass`/`text-fail`.
- **Panel header row:** `px-5 py-4 border-b border-border flex justify-between items-center`, title `text-[15px] font-semibold text-text-primary`, optional `text-primary hover:underline` link on the right.

> **Missing token:** the `text-[15px] font-semibold` section/panel title recurs 50+ times as an arbitrary value. It should become a real type token (e.g. `text-section-title` = 15px/600) so it stops being hand-typed. Until then, keep using `text-[15px] font-semibold` verbatim for panel titles so at least they match.

### Checkboxes / toggles
Native checkboxes must be branded: add `accent-primary` (only one place does today) and an
associated label. For on/off settings use the toggle pattern in
`OrganizationSettings.tsx` (`role="switch"` + `aria-checked`).

### Charts
Recharts colours must read the theme, not raw hex — otherwise they don't re-theme in
dark mode (some line strokes in `CustomerProfile.tsx` are stuck light). Feed chart
colours from the CSS variables / token values, and branch tick/grid colours on theme.
When building a **new** chart, load the `dataviz` skill first for palette/plotting rules.

### Tables
Wrap in a card: `bg-card border border-border rounded-card overflow-hidden`, then an
`overflow-x-auto` scroll container.
- **Header cell:** `text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border`.
- **Row:** `hover:bg-table-header transition-colors border-b border-border-light last:border-0`; cells `px-5 py-3.5 text-table-cell text-text-cell`.
- Use the `text-table-header` token for headers (admin's `text-xs font-semibold uppercase tracking-wider` is the off-token variant — don't copy it).

### Status badges / pills
**Reuse the existing badge components — don't inline a new pill.** These already
encode the correct token pairs and defensive status logic:
`components/ItemResultBadge.tsx` (pass/fail/na/review), `CallStatusBadge.tsx`
(processing states + pulse), `RiskLevelBadge.tsx`, `BreachBadges.tsx`.

If you must build a new pill, match their shape: `text-badge font-semibold px-2.5 py-[3px] rounded-full`
with a semantic token pair (`bg-pass-bg text-pass`, `bg-fail-bg text-fail`,
`bg-review-bg text-review`, `bg-processing-bg text-processing`). Use `rounded-full`,
not the `rounded-[20px]` arbitrary value that's scattered about, and `text-badge`,
not `text-[11px]`. Never colour-only — the label text carries the meaning too (§7).

### Form inputs
```tsx
// text / select
className="w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary disabled:opacity-60 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
```
Label: `block text-xs font-medium text-text-muted mb-1`. Validation/error text:
`text-sm text-fail`. Reference: `OrganizationSettings.tsx`. Use `bg-card`, never `bg-white`.

### Modals / dialogs
Overlay + centred surface. **Accessibility is required, not optional** (§7):

```tsx
<div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
     role="dialog" aria-modal="true" aria-labelledby="dlg-title" onKeyDown={onEscClose}>
  <div className="relative bg-card border border-border rounded-card shadow-lg w-full max-w-md p-6 space-y-4">
    <h3 id="dlg-title" className="text-lg font-semibold text-text-primary">…</h3>
    …
  </div>
</div>
```
Model on the existing modal components — `components/InviteAgentModal.tsx`,
`ScoreCorrectionModal.tsx`, `AlertRuleModal.tsx`, and the `BreachDetailDrawer.tsx`
for slide-in drawers — rather than duplicating the shell inline (the five Integrations
modals do; don't add a sixth). Use `bg-card` (not `bg-white`), trap focus, close on
Escape, and return focus to the trigger.

### Feedback states
- **Loading (canonical):** skeleton shimmer — `h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer` blocks shaped like the content. Full-page/detail views may use the spinner `w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin`. **Don't** ship a bare `Loading…` string.
- **Empty state:** table → `<td colSpan={n} className="px-5 py-12 text-center text-text-muted text-table-cell">`; non-table → `bg-card border border-border rounded-card p-10 text-center` (use `rounded-card`, not `rounded-xl`).
- **Errors:** inline banner `bg-fail-bg text-fail px-3 py-2 rounded-btn`. **Never `window.alert()`** for errors (there are 13 to migrate — don't add more).
- **Success:** inline `text-sm text-pass` near the action, or a toast once the shared toast exists.

### Filters & pagination
- Reuse `<AgentFilter>` where an agent filter is needed. Filter bars: `bg-card border border-border rounded-card p-4 mb-4 grid … gap-3`; reset to page 1 on any filter change.
- Pagination: Prev/Next `text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40`, **1-indexed**, with a `{page} / {total}` counter. (AuditLog's 0-indexed variant is the odd one out.)

## 5. Iconography
SVG only, no emoji. `fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"`, ~`w-5 h-5`, colour via `stroke-text-secondary`/`stroke-icon-muted`. See BRAND_GUIDELINES §5.

## 6. Dark mode
`darkMode: 'class'`. **Components never use `dark:` variants or raw colours** — they use tokens, which re-resolve under `.dark`. Test every new screen in both themes (toggle via the app). If something looks wrong in dark mode, the fix is almost always "replace a raw colour/`bg-white` with a token", not a `dark:` override.

## 7. Accessibility (baseline for every feature)
- **Focus:** standardise on `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40` for interactive elements. (`focus-visible` is currently unused — new work sets the standard.)
- **Labels:** every icon-only button/control needs `aria-label`. Inputs need an associated `<label>`.
- **Status not by colour alone:** always pair a status colour with text or an icon.
- **Modals/menus:** `role="dialog"`/`aria-modal`, focus trap, Escape to close, focus returned to trigger. Menus close on outside-click and Escape.
- Prefer native `<button>`/`<a>`/`<select>` over click-handlers on `<div>`s.

## 8. New-feature checklist
Before opening a PR with UI, confirm:
- [ ] Colours are token classes — no hex, `bg-white`, `text-black`, or `dark:`.
- [ ] Recurring text uses type tokens (`text-page-title`, `text-card-value`, `text-table-header`, `text-badge`, …).
- [ ] Page header matches §2; sections use the §3 spacing/grid values.
- [ ] Buttons/inputs/cards/tables/badges use the §4 recipes (no new one-off variants).
- [ ] Loading, empty, and error states are all handled (skeleton / empty component / inline banner — no `alert()`).
- [ ] Works in light **and** dark mode.
- [ ] Focus ring, `aria-label`s, keyboard support for any modal/menu; status has text/icon, not colour only.
- [ ] Icons are stroke SVGs, no emoji.

## 9. Recommended shared components (to stop re-inlining)
The biggest source of drift is that these are hand-rolled on every page. Extracting them
(and making both apps import them) would let the recipes above live in one place:
`Button`, `PageHeader`, `Card`/`Panel`, `StatCard`, `DataTable`, `Field`/`Input`,
`Modal` (with focus-trap + a11y), `EmptyState`, `Spinner`, and a `Toast`/inline-error
provider to replace `alert()`. (Status badges already exist — reuse them.) Treat §4 as the spec for each.

Two token additions would also cut drift: a **`section-title`** type token (15px/600, used 50+×
as `text-[15px]`) and **z-index tokens** (`z-overlay`/`z-modal`) to replace the raw
`z-20/30/40/50` layering that's ordered only by convention today.

## 10. Known drift / remediation backlog
Current inconsistencies to converge on the rules above (don't copy these; fix opportunistically):

| Area | Standard | Where it drifts |
|---|---|---|
| Admin headings | `h2.text-page-title` | raw `text-xl font-bold` across ~8 admin pages (`TenantList`, admin `Dashboard`, `Usage`, `Audit`, `Billing`, `TenantDetail`, …) |
| Web headings | `h2` + `text-text-primary` | `h1`, no colour: `Customers`, `Account`, `BillingOverview`, `CustomerProfile` |
| KPI value | `text-card-value` | raw `text-2xl font-bold`: admin `Usage`, `Billing`, `TenantDetail` |
| Card corner | `rounded-card` | `rounded-xl`: `JourneyDetail`, `CallDetail`, `Upload`; `rounded-lg`: `SupportInbox`, `Support` |
| Surfaces | `bg-card` token | `bg-white` (breaks dark mode): admin `TenantDetail` modals, `TwoFactorEnroll` QR (both apps) |
| Loading | skeleton shimmer | plain `Loading…` (Team/Alerts/Scorecards/Notifications/Breaches), spinner (CallDetail/JourneyDetail), **none** (all admin pages) |
| Errors | inline `bg-fail-bg` banner | 13× `alert()` across 7 files; bare `text-fail text-sm` in admin |
| Pagination | 1-indexed Prev/Next + counter | 0-indexed (`AuditLog`); none (`ReviewQueue`, `CustomerProfile`, admin) |
| Focus | `focus-visible:ring-2 ring-primary/40` | `focus:border-primary` vs `focus:ring-*` split; `focus-visible` never used |
| Admin loading | react-query + skeletons (like web) | admin uses `useEffect`+fetch, renders nothing while loading |
| **Font sizes (biggest drift)** | named type tokens | arbitrary px app-wide: `text-[12px]`×130, `text-[11px]`×63, `text-[15px]`×54, `text-[13px]`×27 |
| Button padding | one recipe (§4) | 6+ paddings (`px-3 py-1.5`, `px-6 py-3`, `px-[14px] py-[7px]`…); some primaries have no `disabled:` state |
| Pill radius | `rounded-full` + `text-badge` | `rounded-[20px]` everywhere; `SeverityBadge` uses plain `rounded` + `text-[11px]` |
| Callout banners | `rounded-card` | `rounded-r-lg` (JourneyDetail, CallDetail, AIInsights) |
| Checkboxes | `accent-primary` + label | native unstyled everywhere except `ScorecardEditor` |
| Charts | read token/CSS-var colours | raw hex in `TrendCharts`, `CustomerProfile`; some strokes don't dark-theme |
| Icon-only buttons | `aria-label` | present in ~7 files only; most delete/close/edit icon buttons lack it |
| Z-index | `z-overlay`/`z-modal` tokens | raw `z-20/30/40/50`, ordered by convention |

Biggest wins, in order: (1) extract the shared components in §9; (2) bring admin-web onto the semantic type tokens + skeleton loading; (3) replace all `alert()` and `bg-white`; (4) standardise focus + add modal a11y.
