# design-sync notes — @callguard/web

## Repo-specific setup

- `packages/web` is a Vite **app**, not a published component library — it ships no `dist/`
  or `.d.ts` tree. `cfg.buildCmd` (`.design-sync/prepare.sh`) synthesizes both:
  compiles Tailwind to `packages/web/.ds-css/tailwind.css` and emits declarations to
  `packages/web/.ds-types/`, then generates a root `index.d.ts` mirroring
  `.design-sync/entry.tsx`'s export list.
- The converter's `--entry` is `.design-sync/entry.tsx` — a hand-authored barrel that
  re-exports only the component surface meant for claude.ai/design (pages, routing, the
  API client stay out). **Keep it in step with `cfg.componentSrcMap`** when components are
  added/removed in `packages/web/src/components/`.
- npm workspace hoisting: `react`/`react-dom` resolve from the **repo root**
  `node_modules`, not `packages/web/node_modules` (which doesn't have its own copy). Always
  pass `--node-modules ./node_modules` from the repo root.
- Playwright/Chromium isn't committed (gitignored cache) — a fresh clone needs
  `npx playwright install chromium` before `package-validate.mjs`'s render check will run
  (~200MB, ~1-2 min). Repo pins `playwright@1.62.1` in `.ds-sync/package.json`.

## Preview scope (as of this sync)

All 35 components ship the honest floor card — **none have an authored preview yet**
(`.design-sync/previews/` is empty by design, not by omission). This was a deliberate
scope choice for speed on the first successful sync. Authoring is incremental and safe to
pick up on any future re-sync: start with the highest-traffic pieces (badges, panels,
modals, `ScoreGauge`, `Layout`) — see non-storybook SKILL.md §4.2 for the recipe.

## Known render warns

None — render check passed clean (0 bad / 0 thin / 0 identical-variants) on the first
pass, no self-heal iterations needed. `tokens: 94 defined, 62 referenced (1 missing, below
threshold)` — informational, not chased down; re-check if it grows.

## Re-sync risks

- **The claude.ai/design project this repo was pinned to (`6b527e58-…`, from an Aug 9-10
  run) was deleted remotely before this sync** — `get_project` 404'd and `list_projects`
  showed nothing, so this run created a **new** project (`122fa2d8-…`, "CallGuard Design
  System") and re-pinned it in `config.json`. If that one also goes missing, don't treat a
  stale-looking pin as a bug — recreate per SKILL.md §1 and re-pin.
- **`conventions.md`'s class-name table was validated against the *compiled* Tailwind
  CSS**, not `tailwind.config.js` directly — Tailwind only emits utilities actually
  referenced somewhere in `packages/web/src/**`. Config-only tokens (`surface`,
  `shadow.sm`, `shadow.md`) don't currently appear in the shipped CSS and were cut from
  the header for that reason. If the app's own source stops using a token that's currently
  in the header table (or starts using one that isn't), re-run the grep-against-compiled-CSS
  check in the base SKILL.md's "Author the conventions header" step before trusting it.
- Nothing else was hand-edited or config-overridden this run — `componentSrcMap`,
  `cssEntry`, and `guidelinesGlob` are all first-run defaults from the Aug 9-10 setup and
  weren't touched.
