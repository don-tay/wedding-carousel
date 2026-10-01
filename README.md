# Wedding Carousel

A browser-only, seamlessly looping photo carousel for a big screen. You drop in photo folders, pick a title, font and colour, and press **Full screen**. Photos never leave the computer, and you only need Node to build the file, not to run it.

## Build once (needs Node ≥ 20)

```bash
nvm use 24
npm install
npm run build          # → dist/index.html (one self-contained ~3.4 MB file)
```

To run it, **double-click `dist/index.html`**, or copy that one file to the other laptop (AirDrop or a USB stick). It works offline in Chrome and Safari, with no server, internet connection or Node install needed.

## Use

1. Drag one or more photo folders onto the page, or click **Choose folder…**. Subfolders are searched too, and you can drop more folders later to add them.
2. Open **Settings** to change the title, font (Formal / Flowing / Soft script, Romantic serif, Clean), background colour, and title colour (automatic by default).
3. Press **Full screen** (or `F`). The controls and cursor hide after 2 s. Moving the mouse brings them back.

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `F` | Full screen |
| `←` / `→` | Nudge by 10 % of the screen |
| `Esc` | Exit full screen / close settings |

- **Speed** is set in *seconds per screen width* (10–60, default 25). The bar shows the resulting full-loop length.
- **Feature or hide a photo:** pause, then hover over a photo. ★ gives it a full-height column of its own, and **Hide** removes it from the loop. Hidden photos are listed under *Settings → Hidden* with a **Restore** button.
- **Reshuffle** picks a new random order. The order stays the same across reloads until you reshuffle.
- **Remembered:** the title, font, colours, speed and shuffle are saved per photo set, and featured/hidden choices are saved per photo, all in the browser's `localStorage`. The photos themselves are not stored, so after a reload you drop the folder again and everything comes back as you left it.

## How it works

| Step | What happens |
|---|---|
| Decode | Each photo is decoded once to get its oriented size (EXIF rotation applied) and a 320 px thumbnail. Safari decodes HEIC natively. In Chrome, a bundled libheif WASM decoder (`heic-to`) converts HEIC to JPEG in memory, which takes about 1 s per photo. Unreadable files are listed under *Couldn't read* and skipped. |
| Duplicates | A 64-bit difference hash plus a colour grid identifies re-encoded copies (for example WhatsApp copies). The highest-resolution copy is kept and the others are auto-hidden, listed as "duplicate of X" with a **Restore** button. |
| Order | A seeded random shuffle. Photos that look alike are moved apart so they don't sit next to each other. |
| Layout (`src/layout.ts`) | Each column is either one full-height photo or a stack of 2–3 photos. A stack of photos with aspect ratios aᵢ is exactly `(H − gaps) / Σ(1/aᵢ)` wide, so every photo shows in full with no cropping and no padding, whatever the mix of ratios. Stack partners can be pulled from up to 6 positions ahead, and a cost function balances photo sizes, variety and similarity. Padding only happens for a lone photo wider than one column, and those are listed under *Shown with padding*. |
| Render (`src/renderer.ts`) | A single `<canvas>`. Photos within about 1.5 screens of view are decoded at the display's real pixel size (up to about 4K), with rounded corners pre-drawn, and are released under a memory budget. The loop repeats the strip at intervals of its own length, with the same gap across the wrap, so there is no visible jump. |

## Tests

```bash
npm test                          # layout/ordering unit tests (no crop, exact fit, gaps, determinism, featured, duplicates)
npm run test-photos               # synthetic nested test set → test-photos/ (needs Pillow; HEIC via macOS sips)
npm run build && npm run test:e2e # Chromium + WebKit: ingest, EXIF, HEIC, duplicates, no crop, seam, frame rate, persistence
REAL_PHOTOS=~/Desktop/friend-group-pics npx playwright test -g real   # read-only smoke test on a real folder
```

Before running the e2e tests for the first time, run `npx playwright install chromium webkit`. The seam test renders the frame just before the wrap, shifts it by a known amount, and compares it with the first frame. The mean pixel difference is 0.0000.

## Not in v1

MP4 export, automatic scoring for sharpness and faces, paper texture and floral themes, and a subtitle or title card. MP4 export is planned to record the same canvas, so the video will match the preview frame for frame.
