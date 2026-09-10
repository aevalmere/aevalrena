# Aevalrena

Aevalrena is a browser platform fighter (percent damage, knockback, blast zones, stocks) built with Canvas 2D and TypeScript.

Full design and rules: [docs/SPEC.md](docs/SPEC.md).

## Local development

```
npm install
npm run dev
```

## Build

```
npm run build
```

Output goes to `dist/`. `npm run typecheck` runs `tsc --noEmit` on its own.

## Deploy to GitHub Pages

1. In the repo settings, under Pages, set the source to "GitHub Actions".
2. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and publishes `dist/`.

## Deploy to Cloudflare Pages

1. Connect the repository in the Cloudflare Pages dashboard.
2. Set the build command to `npm run build`.
3. Set the output directory to `dist`.

## Default controls

### Player 1

| Action | Key |
|---|---|
| Left | KeyA |
| Right | KeyD |
| Up | KeyW |
| Down | KeyS |
| Jump | Space |
| Attack | KeyJ |
| Special | KeyK |
| Shield | KeyL |
| Taunt | KeyT |
| Start | Escape |

Tap jump: off.

### Player 2

| Action | Key |
|---|---|
| Left | ArrowLeft |
| Right | ArrowRight |
| Up | ArrowUp |
| Down | ArrowDown |
| Jump | ShiftRight |
| Attack | Comma |
| Special | Period |
| Shield | Slash |
| Taunt | Quote |
| Start | Enter |

Tap jump: off.

Controls are remappable in game and saved to `localStorage`.
