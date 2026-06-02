# hexabounds

A small SvelteKit + Vite web app: a full-viewport hex grid where clicking hexes
outlines them. Click several touching hexes and the outline merges into a single
boundary that wraps the whole cluster. A side panel adjusts the hex radius and
the grid angle.

## Features

- **Click to select** a hex (click again to deselect).
- **Merged outline** around any group of touching hexes — computed as the union
  boundary (edges shared by two selected hexes are dropped, the rest are stitched
  into closed loops). Non-touching clusters each get their own outline.
- **Hex radius** slider.
- **Angle** slider (0° = flat top/bottom, the default; up to 60°). The whole grid
  rotates about its center.
- **Library** — save the current shape (with its radius and angle) and pull it
  back up later with one click. Items show a live thumbnail, are renameable, and
  persist in `localStorage`.
- **Export** the current shape as **SVG** (transparent background) or **PNG**
  (white background, 2× scale). Exports are tightly cropped to the shape and
  bake in the current angle.
- Minimal palette: white, black, green, plus a couple of alpha tones.

## Run

This project uses [pnpm](https://pnpm.io/).

```sh
pnpm install
pnpm dev
```

Then open the printed local URL. Other scripts: `pnpm build`, `pnpm preview`, `pnpm check`.

## Where things live

- `src/lib/hex.js` — grid generation, the outline (union-boundary) algorithm,
  and rebuilding hex geometry from saved ids.
- `src/lib/export.js` — cropping a selection to a standalone SVG and downloading
  it as SVG or PNG.
- `src/routes/+page.svelte` — the UI: settings panel, library, and SVG stage.
- `src/app.css` — color variables and base styles.
