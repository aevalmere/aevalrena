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

## Play on LAN with the local agent

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

## Play on LAN in the browser (nothing to install)

Mode select > LAN > Host game shows a 4 letter code. Friends on the same Wi-Fi open the site,
go to LAN, type the code and press Join. A small online helper passes the connection details
between the browsers while they join; the game itself runs directly over the Wi-Fi.

To try it locally: `npm run rendezvous` in one terminal (the helper, port 8788) and `npm run dev`
in another, then open the game in two tabs. Without the helper the LAN screen falls back to long
codes copied by hand. Details: [docs/LAN.md](docs/LAN.md) section 11.

## Deploy to Cloudflare Pages (with the LAN helper)

1. Connect the repository in the Cloudflare Pages dashboard.
2. Set the build command to `npm run build` and the output directory to `dist`.
3. Create the KV namespace for the LAN helper: `npx wrangler kv namespace create LOBBY`. In
   `wrangler.toml`, uncomment the `[[kv_namespaces]]` block (binding `LOBBY`) and paste the id.
   `functions/api/[[route]].ts` then serves `/api/*` next to the site.
4. Check `https://<your site>/api/health` returns `{"ok":true}`.

## Deploy to GitHub Pages

1. In the repo settings, under Pages, set the source to "GitHub Actions".
2. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and publishes `dist/`.
3. For short LAN codes, deploy the helper as a Worker
   (`npx wrangler deploy -c server/rendezvous/wrangler.worker.toml`, after pasting a `LOBBY` KV
   namespace id into that file) and add a repository variable `RENDEZVOUS_URL` with the Worker's
   URL (Settings > Secrets and variables > Actions > Variables). Without it, LAN uses long codes.

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
