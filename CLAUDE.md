# CallGuard AI

CallGuard AI is a standalone product. It is not part of, and must not be co-branded
or conflated with, any other product or company.

Monorepo (npm workspaces): `packages/api` (Express + Postgres + BullMQ),
`packages/web` (tenant React/Vite app), `packages/admin-web` (superadmin console),
`packages/shared` (shared types/constants).

## UI / UX work — follow the design system

Any change that touches the UI must follow the guidelines. Read these first:

- **[BRAND_GUIDELINES.md](BRAND_GUIDELINES.md)** — identity, colour tokens (light + dark), type scale, logo, voice, iconography.
- **[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)** — layout, component recipes, states, accessibility, and the new-feature checklist (§8).

Non-negotiables (the rest is in the docs):

- **Colour:** only token classes (`text-text-secondary`, `bg-card`, `bg-fail-bg`, …). No raw hex, no `bg-white`/`text-black`, no `dark:` variants — dark mode falls out of tokens.
- **Type:** named tokens (`text-page-title`, `text-card-value`, `text-table-header`, `text-badge`, …). Avoid arbitrary `text-[Npx]`.
- **Components:** use the canonical recipes / existing components (badges, modals) in DESIGN_SYSTEM §4 — don't inline a new variant.
- **Every screen:** handle loading + empty + error states, works in light **and** dark mode, has focus rings + `aria-label`s, status conveyed by text/icon not colour alone.
- **Icons:** stroke SVGs (`strokeWidth="1.8"`), no emoji.

The implemented tokens in `packages/web/tailwind.config.js` + `src/index.css` are the
source of truth; keep the docs in step with them.
