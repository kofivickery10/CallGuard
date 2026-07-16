# CallGuard AI — Brand Guidelines

> Source of truth for the CallGuard brand. The **implemented design tokens**
> (`packages/web/tailwind.config.js` + `packages/web/src/index.css`) are
> authoritative — this document describes them, and if the two ever disagree,
> the code wins and this doc should be updated. For component/UX rules see
> [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

CallGuard AI is a standalone product. It is not part of, and should not be
co-branded with, any other product or company.

---

## 1. Identity

- **Name:** CallGuard AI (always "CallGuard AI" on first use; "CallGuard" acceptable thereafter).
- **Logo strapline:** SMARTER CALLS. SAFER BUSINESS.
- **Positioning statement (marketing, not the logo):** Every sales conversation, scored live by AI that learns from your compliance team.
- **Personality:** The expert analyst — calm, precise, trustworthy. Never alarmist, never flippant.
- **Voice & tone:**
  - Plain, direct English. Short sentences. Technical when the subject is technical.
  - Reassuring under pressure — this is a compliance product; users are often dealing with risk. State facts, then the action.
  - No hype, no emoji in product UI (see §5).
  - UK spelling in product copy and docs.

## 2. Logo

The mark is a **shield** containing a five-bar **audio equalizer** (call monitoring
+ protection). Wordmark "CallGuard" in dark ink with "AI" in primary green.

Assets live in `packages/web/public/` and `packages/admin-web/public/`:

| File | Use |
|------|-----|
| `callguard-logo-stacked.svg` | Mark above wordmark — auth screens, narrow/centred contexts |
| `callguard-logo-horizontal.svg` | Mark beside wordmark — headers, wide contexts |
| `callguard-logo-primary.svg` | Mark only — favicons, avatars, tight spaces |
| `*-dark.svg` variants | For dark backgrounds / dark mode |

Rules:
- Use the `-dark` variants on dark backgrounds; never recolour the SVGs inline.
- Preserve aspect ratio and clear space (≥ the height of one equalizer bar around the mark).
- Do not rotate, add effects, restretch, or place the light logo on a busy/low-contrast background.
- Use the `Logo` component (`components/Logo.tsx`) rather than embedding `<img>` directly, so variant + theme selection stays consistent.

## 3. Colour

Colours are **semantic tokens**, defined once as CSS custom properties in
`src/index.css` (light on `:root`, dark under `.dark`) and exposed to Tailwind
in `tailwind.config.js`. **Always use the token class** (e.g. `text-text-secondary`,
`bg-card`, `bg-fail-bg`) — never a raw hex value or `bg-white`/`text-black`.
Because tokens are RGB triples consumed via `rgb(var(--x) / <alpha>)`, opacity
modifiers work everywhere (`bg-primary/10`, `ring-primary/40`).

### Brand
| Token (class) | Light | Dark | Usage |
|---|---|---|---|
| `primary` | `#4A9E6E` | `#57AB7A` | Buttons, links, active nav, focus, brand green |
| `primary-hover` | `#3D8A5E` | `#6ABB8A` | Hover on primary surfaces |
| `primary-light` | `#E8F0E8` | `#1F2E24` | Active-nav background, subtle green fills |

### Semantic status (each has a matching `-bg`)
| Purpose | Token | Light text / bg | Dark text / bg |
|---|---|---|---|
| Pass / success | `pass` / `pass-bg` | `#2D6E4A` / `#E8F5E8` | `#5CC08A` / `#16301F` |
| Fail / error / breach | `fail` / `fail-bg` | `#C0392B` / `#FDE8E8` | `#F0726A` / `#3A1D1B` |
| Review / warning | `review` / `review-bg` | `#B8860B` / `#FEF3E0` | `#D6A838` / `#332714` |
| Processing / info | `processing` / `processing-bg` | `#2D5A9E` / `#E8F0FA` | `#6F9BDB` / `#16263A` |

### Neutrals & surfaces
| Token | Light | Dark | Usage |
|---|---|---|---|
| `page` | `#F8FAF8` | `#0F1512` | App/page background |
| `card` / `surface` | `#FFFFFF` | `#18211B` | Cards, panels, modals, sidebar, drawers |
| `border` | `#E2E8E2` | `#2B3630` | Card borders, dividers |
| `border-light` | `#F0F5F0` | `#222B25` | Subtle inner dividers |
| `text-primary` | `#1A2E1A` | `#E6EFE8` | Headings, primary body |
| `text-secondary` | `#5A6E5A` | `#A7B8AB` | Secondary text, labels |
| `text-muted` | `#8A9E8A` | `#7D8F81` | Placeholders, muted meta |
| `text-subtle` | `#6A7E6A` | `#93A596` | Page subtitles |
| `text-cell` | `#3A4E3A` | `#C4D2C7` | Table cell body |

### Accent & domain colours
| Token | Usage |
|---|---|
| `secondary` / `secondary-bg` | Gold accent — star ratings, premium/highlight chips only. Not a second brand colour. |
| `speaker-agent` / `speaker-customer` | Transcript speaker labels (agent = green, customer = indigo). |
| `flag-bg` / `flag-border` / `flag-text` | Inline compliance-flag callouts inside transcripts. |
| `chart-secondary` | Secondary series in bar charts. |
| `table-header` / `table-border` | Table chrome. |
| `sidebar-hover` / `sidebar-active` / `sidebar-border` | Sidebar states. |

### Dark mode
Dark mode is first-class (`darkMode: 'class'`, toggled on `<html>` via `lib/theme.ts`).
**Components never write `dark:` variants** — they use tokens, which re-resolve
under `.dark`. If you find yourself adding a `dark:` class or a raw colour, add/adjust
a token instead.

## 4. Typography

**Font:** Inter (weights 300–700), loaded in `index.css`; fallback `-apple-system, sans-serif`.
Use the **named type tokens** rather than ad-hoc `text-[Npx]`:

| Token (class) | Size / weight | Use |
|---|---|---|
| `text-page-title` | 19px / 700, ls -0.2px | Page H1 |
| `text-page-sub` | 13px / 400 | Page subtitle / description |
| `text-card-label` | 11px / 600, uppercase-style ls 0.4px | Stat-card labels |
| `text-card-value` | 24px / 700, ls -0.3px | Stat-card numbers |
| `text-table-header` | 11px / 600, ls 0.4px | Table column headers |
| `text-table-cell` | 13px / 400 | Table body / general body |
| `text-nav-item` | 13px / 500 | Sidebar nav items |
| `text-nav-label` | 10.5px / 600, ls 0.7px | Sidebar section headings |
| `text-badge` | 11px / 600 | Status pills / chips |

Standard Tailwind sizes (`text-sm`, `text-xs`) are acceptable for one-off body/UI
text, but anything that recurs (titles, labels, table text, badges) should use a
token so the scale stays consistent. If a new recurring size is needed, add a token.

## 5. Iconography

- **SVG only. No emoji in product UI.**
- Line/stroke style: `fill="none"`, `strokeWidth="1.8"`, `strokeLinecap="round"`, `strokeLinejoin="round"`.
- Default size 18–20px (`w-5 h-5`); colour via `stroke-text-secondary` / `stroke-icon-muted` (tokens, not hex).
- Interactive icon buttons: 40px hit area (`w-10 h-10`), rounded, `hover:bg-sidebar-hover`, and an `aria-label`.

## 6. Shape, elevation, motion

- **Radii:** cards/panels/modals `rounded-card` (10px); buttons/inputs/badges `rounded-btn` (8px); pills use `rounded-full`.
- **Shadow:** `shadow-card` for resting cards, `shadow-md` for hover lift, `shadow-lg` for modals/menus. Keep elevation subtle — this is a calm, data-dense product.
- **Motion:** reserve motion for meaning. Defined animations: `breach-pulse` (active/critical breach emphasis) and `skeleton-shimmer` (loading). Don't add decorative animation.

## 7. Quick do / don't

- ✅ Use token classes for every colour, and named type tokens for recurring text.
- ✅ Let dark mode fall out of tokens; test both themes.
- ✅ Use the `Logo` component and the correct variant for the background.
- ❌ No raw hex, `bg-white`, `text-black`, or `dark:` variants in components.
- ❌ No emoji, no decorative animation, no restyled/​recoloured logo.
