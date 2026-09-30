import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { gameVersion } from './server/version';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command, mode }) => ({
  base: './',
  define: {
    // The LAN version guard (src/net/buildversion.ts): the same hash the agent computes.
    __AEV_GAME_VERSION__: JSON.stringify(gameVersion(root)),
    // Where the LAN short-code helper lives (src/net/signal/api.ts). Unset: this page's own
    // origin in a build (Cloudflare Pages), port 8788 on the page's host under `npm run dev`
    // (next to `npm run rendezvous`).
    __AEV_RENDEZVOUS_URL__: JSON.stringify(
      process.env.VITE_RENDEZVOUS_URL ?? loadEnv(mode, root, 'VITE_').VITE_RENDEZVOUS_URL ?? (command === 'serve' ? ':8788' : ''),
    ),
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  server: {
    host: true,
    port: 5173,
  },
}));
