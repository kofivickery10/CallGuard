# Landing-site baselines

Ground truth for the three agents that own the static marketing site in `landing/`:
`search-analyst`, `landing-performance`, `landing-ux`.

These files exist because a brief full of principles produces plausible findings, and a
brief anchored to measured numbers produces checkable ones. An agent that knows the
homepage LCP was 3.0s on 2026-08-28 can tell you whether it moved. An agent that only
knows "LCP should be under 2.5s" can only tell you it is too slow.

| File | Owner | Regenerate with |
|---|---|---|
| `seo-baseline.md` | `search-analyst` | `npm run audit:onpage`, `npm run audit:links` |
| `performance-baseline.md` | `landing-performance` | `npm run audit:perf` |
| `accessibility-baseline.md` | `landing-ux` | `npm run audit:a11y`, `npm run audit:html` |

## The rule that makes these worth keeping

**Every agent that owns one of these files updates it at the end of a run.** Not the
prose — the numbers, the open-defect list, and anything a human overruled you on.

The last one matters most. A correction that lives only in a chat transcript has to be
re-taught every session. A correction written into the baseline as a line saying *"we
decided X, because Y"* is the only mechanism any of these agents has for accumulating
judgement. Treat "Kofi told me the opposite last time" as a defect in this file.

## Measurement caveat, applies to all three

Everything here was measured against the local `landing` preview (`npx serve landing`,
port 4321) unless the entry says otherwise. Local has no network latency, no CDN, and
none of the `.htaccess` caching or GZIP that production applies. **Local numbers are
valid for before-and-after comparison and invalid as absolute judgements.** Where a
figure needs the live site, the entry says so and gives the command.
