# CallGuard AI — Logo & Brand Assets

The CallGuard AI mark: a **shield** (guard, compliance, protection) carrying a
**waveform** (the live, monitored call). SVGs are the source of truth — all text
is converted to vector outlines, so they render identically everywhere (`<img>`,
background-image, design tools, print) with no font dependency. PNGs are
rasterized from the same SVGs with transparent backgrounds.

## Colours

| Token         | Hex       | Use                                        |
|---------------|-----------|--------------------------------------------|
| Ink           | `#1A2E1A` | Wordmark, inner shield stroke, tagline      |
| Primary green | `#4A9E6E` | "AI", outer shield stroke, waveform bars, tagline periods |
| AI on dark    | `#6CC18D` | "AI" + periods on dark backgrounds          |
| Tagline dark  | `#E8F0E8` | Tagline text on dark backgrounds            |

## Typography

- Wordmark: **Poppins Medium (500)**, "CallGuard AI" with a word space before "AI"
- Tagline: **Inter SemiBold (600)**, tracked out to match the wordmark width
- Lockup text is outlined (not live text); `fonts/` holds the typefaces for
  recreating or extending the lockups

## Files

### `svg/` — source of truth
- `callguard-logo-primary.svg` — **the main website logo**: icon + wordmark + tagline, light backgrounds
- `callguard-logo-primary-dark.svg` — same, for dark backgrounds
- `callguard-logo-horizontal.svg` / `-dark.svg` — no tagline; use in navbars and small placements
- `callguard-logo-stacked.svg` — centred vertical lockup (social cards, covers)
- `callguard-icon.svg` — the mark alone (full colour)
- `callguard-icon-mono-ink.svg` / `-mono-white.svg` — single-colour versions

### `png/` — transparent, high-res
Primary lockup at 3000w, horizontal at 2400w, stacked at 1400w, icon at 1024/512/256, monochrome at 1024.

### `favicon/` — drop into your site root
- `favicon.svg` — simplified mark (3 bars, heavier strokes) for crisp small sizes
- `favicon.ico` — 16 + 32 + 48 bundled
- `favicon-16/32/64.png`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180, white bg)

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest"> <!-- point at icon-192 / icon-512 -->
```

## Usage rules

- Clear space around the lockup: at least the height of the centre waveform bar ÷ 2.
- Minimum width: 120px for the primary lockup (drop the tagline below that — use the horizontal version), 32px for the icon.
- Don't recolour, stretch, rotate, outline, or add drop shadows.
- On photography or colour, use the dark variant or the monochrome white icon.
