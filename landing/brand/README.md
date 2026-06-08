# CallGuard AI — brand assets

The CallGuard AI logo: a **shield** (guard / protection / compliance) carrying a
**pulse** line (a live, monitored call). SVGs are the source of truth (infinitely
scalable); PNGs are pre-rendered at high resolution with transparent backgrounds.

## Colours

| Token        | Hex       | Use                                  |
|--------------|-----------|--------------------------------------|
| Brand green  | `#4a9e6e` | Shield, "AI", accents                |
| Ink          | `#1a2b22` | Wordmark "CallGuard" on light bg     |
| Green (dark) | `#6cc18d` | "AI" on dark backgrounds             |
| White        | `#ffffff` | Pulse on the shield; wordmark on dark|

Typeface: **Inter** (Bold, 700), `-5` letter-spacing for the wordmark.

## Files

### Icon (the mark — shield + pulse)
- `logo-icon.svg` — master, green shield + white pulse
- `logo-icon-1024.png`, `-512.png`, `-256.png` — transparent corners
- `favicon.svg` — same mark, slightly thicker pulse for small sizes

Use the icon for app icons, favicons, avatars, social profile images.

### Monochrome (single colour, pulse knocked out so the background shows through)
- `logo-mono-white.svg` / `-1024.png` — for dark or photographic backgrounds
- `logo-mono-ink.svg` / `-1024.png` — for light backgrounds, one-colour print

### Horizontal lockup (icon + "CallGuard AI")
- `logo-lockup.svg` — vector
- `logo-lockup.png` — for light backgrounds
- `logo-lockup-dark.png` — white wordmark for dark backgrounds

## Clear space & minimum size

- Keep clear space around the logo equal to the width of the pulse stroke.
- Minimum icon size: 20px. Minimum lockup width: 150px.
- Don't recolour the shield, stretch, rotate, add shadows, or set the white-pulse
  icon on a light background without the green shield behind it.

## Re-rendering the PNGs

PNGs are produced from the SVGs with headless Chrome. The lockup harness embeds
`../fonts/InterVariable.woff2` so the wordmark uses Inter, not a system fallback.
