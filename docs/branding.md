# FORKSY branding

Source files supplied by the owner are kept untouched in `branding/source/`: the pin-and-fork icon (`forksy-icon-1000.png`) and the wordmark (`forksy-wordmark-original.jpg`).

## Colour
Brand orange sampled from the logo: **#ff6917** (RGB 255, 105, 23). The whole admin theme (primary colour), the customer website, the portal and the demo pages use it. White (#ffffff) is the second brand colour.

## Logo files
| Use | File |
|---|---|
| Icon, transparent, any size | `admin/public/brand/icon-{16,32,48,64,96,128,192,256,384,512}.png`, `branding/forksy-icon-transparent-1024.png` |
| Horizontal logo (icon + wordmark), for light or dark backgrounds | `admin/public/brand/logo-horizontal-orange.png` |
| Horizontal logo for orange backgrounds | `admin/public/brand/logo-horizontal-white.png` |
| Wordmark only (transparent, exact lettering from the supplied artwork) | `wordmark-orange.png`, `wordmark-white.png` |
| Browser tab icon | `admin/public/favicon.ico` (16/32/48), `favicon.png` |
| iPhone / iPad home screen | `admin/public/apple-touch-icon.png` (180 px, icon on orange) |
| Installable web app (PWA) | `admin/public/site.webmanifest`, `brand/icon-192.png`, `icon-512.png` and the *maskable* variants (safe-zone padded) |

## App icons for the future mobile apps
Ready to drop into the native projects, in `branding/app-icons/`:
- `ios/` every AppIcon size (20 to 180) plus `AppStore-1024.png` (opaque, no transparency, as the App Store requires)
- `android/mipmap-*/ic_launcher.png` (48 to 192 px) and `play-store-512.png`; for adaptive icons use the transparent 1024 icon as foreground on #ff6917 (see the note file)

## Wordmark typeface
The "FORKSY" lettering is a heavy, rounded, bouncy display face. The closest open font is **Chewy** (Apache License 2.0), bundled locally at `admin/public/fonts/Chewy-Regular.ttf` with its licence, and used with a slight outline to match the supplied artwork's weight. Use the CSS class `.forksy-wordmark` (defined in `admin/public/assets/css/brand.css`) for any live "FORKSY" text; add `is-white` on orange backgrounds. The logo images already contain the exact artwork, so use those wherever the logo is shown, and the font only for text that must be real text.

If the supplied wordmark was drawn in a specific commercial font, send the font file and it can replace Chewy in one place (`brand.css`).

## Rules of thumb
- Keep clear space around the logo equal to the height of the fork's tines.
- On orange use the white logo; on white or dark use the orange logo.
- Do not stretch, recolour or add effects.
