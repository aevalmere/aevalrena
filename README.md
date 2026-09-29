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

Output goes to `dist/`. `npm run typecheck` runs `tsc --noEmit` for the game and for the LAN agent (`server/`).

## Play on LAN

Everyone on the same Wi-Fi or wired network can see each other's lobbies and join any of them.
Each player needs this repo and [Node.js](https://nodejs.org) 20 or newer.

1. `npm install` (once).
2. `npm run lan`. It builds the game and prints `Open http://localhost:5180/`.
3. Open that address, then Mode select > LAN. Every lobby on the network shows up in the list
   within a second or two. Pick one to join, or create your own.

Windows asks once whether Node.js may use the network: allow it on Private networks, or other
machines cannot see or join your lobbies. If a lobby does not appear (some routers block the
discovery broadcast), type the other machine's address, as printed by its `npm run lan`
(for example `192.168.1.20:5180`), into "Join by address". To run a second agent on one machine,
use `npm run lan -- --port 5181`. Details and limits: [docs/LAN.md](docs/LAN.md).

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
