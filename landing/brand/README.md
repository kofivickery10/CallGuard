# CallGuard AI — brand assets

High-quality logo files. SVGs are the source of truth (infinitely scalable);
PNGs are pre-rendered at high resolution with transparent backgrounds.

## Colours

| Token        | Hex       | Use                                  |
|--------------|-----------|--------------------------------------|
| Brand green  | `#4a9e6e` | Disc, "AI", accents                  |
| Ink          | `#1a2b22` | Wordmark "CallGuard" on light bg     |
| Green (dark) | `#6cc18d` | "AI" on dark backgrounds             |
| White        | `#ffffff` | Mark on green; wordmark on dark bg   |

Typeface: **Inter** (Bold, 700), `-5` letter-spacing for the wordmark.

## Files

### Icon (the mark — green disc + ascending bars + signal dot)
- `logo-icon.svg` — master, 512 viewBox, white-on-green disc
- `logo-icon-1024.png`, `logo-icon-512.png`, `logo-icon-256.png` — transparent corners

Use the icon for app icons, favicons, avatars, social profile images.

### Mark only (no disc, transparent)
- `logo-mark-green.svg` / `logo-mark-green-1024.png` — green mark for light backgrounds
- `logo-mark-white.svg` / `logo-mark-white-1024.png` — white mark for dark/photo backgrounds

### Horizontal lockup (icon + "CallGuard AI")
- `logo-lockup.svg` — vector (renders with Inter where available)
- `logo-lockup.png` — 2060×560, for light backgrounds
- `logo-lockup-dark.png` — 2060×560, white wordmark for dark backgrounds

## Clear space & minimum size

- Keep clear space around the logo equal to the height of one bar.
- Minimum icon size: 24px. Minimum lockup width: 140px.
- Don't recolour, stretch, rotate, add shadows, or place the green mark on a
  busy background without the disc.

## Re-rendering the PNGs

PNGs are produced from the SVGs with headless Chrome. To regenerate, render
each SVG into a transparent canvas at the target pixel size (the lockup embeds
`../fonts/InterVariable.woff2` so the wordmark uses Inter, not a fallback).
