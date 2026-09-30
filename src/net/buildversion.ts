/**
 * The game version this bundle was built from: `gameVersion()` of server/version.ts, computed
 * by vite.config.ts at build time and injected with a `define`. It is the same string the LAN
 * agent computes at run time, so both modes guard joins with one hash. Outside a Vite build
 * (tsx tests) it reads 'dev'.
 */
declare const __AEV_GAME_VERSION__: string;

export const BUILD_VERSION: string = typeof __AEV_GAME_VERSION__ === 'string' ? __AEV_GAME_VERSION__ : 'dev';
