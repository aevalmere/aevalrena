import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { gameVersion } from './server/version';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  // The LAN version guard (src/net/buildversion.ts): the same hash the agent computes.
  define: {
    __AEV_GAME_VERSION__: JSON.stringify(gameVersion(root)),
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  server: {
    host: true,
    port: 5173,
  },
});
