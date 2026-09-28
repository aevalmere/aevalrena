import { PLAYER_COLORS, colorIndexOf } from '../render/colors';
import { MAX_CPU_LEVEL, cpuLevelName } from './context';

/**
 * Shared UI look (docs/UI_STYLE.md sections 1 to 4): fonts, CSS variables and the shared
 * classes every screen and the HUD build on. Injected once by createUi.
 */

/** Vite's base path. The project has no vite/client types, so the env shape is asserted here. */
const BASE: string = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;

/** The four player colors, index = slot. */
export const PLAYER_ACCENTS: readonly string[] = PLAYER_COLORS;

/** Display names of the four team colours, index = PLAYER_ACCENTS index. */
export const TEAM_NAMES: readonly string[] = ['Blue', 'Red', 'Yellow', 'Green'];

/** Accent for elements that belong to no player. */
export const DEFAULT_ACCENT = '#8fd3ff';

/** Hue of the reference blue the backdrop art is painted in. */
const REFERENCE_HUE = 215;

/** Path of a file under public/ui/. */
export function uiAsset(name: string): string {
  return BASE + 'ui/' + name;
}

/** Path of a public/ file named relative to the site root, e.g. a character's `icons/aeval.png`. */
export function iconAsset(path: string): string {
  return BASE + path;
}

function hexHue(hex: string): number {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return REFERENCE_HUE;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/** Degrees to rotate the blue backdrop art so it matches `hex`, normalised to -180..180. */
export function hueShift(hex: string): number {
  let shift = hexHue(hex) - REFERENCE_HUE;
  while (shift > 180) shift -= 360;
  while (shift < -180) shift += 360;
  return Math.round(shift);
}

/** Inline style text setting `--accent` and `--hue-shift` for a player slot, or the default for null. */
export function accentVars(slot: number | null): string {
  const accent = slot === null ? DEFAULT_ACCENT : PLAYER_ACCENTS[slot] ?? DEFAULT_ACCENT;
  return `--accent:${accent};--hue-shift:${hueShift(accent)}deg`;
}

/**
 * Inline accent vars for a player in a match or results list: its team colour when one is
 * set (MatchConfig.players[].team), else its slot colour.
 */
export function playerAccentVars(players: readonly { slot: number; team?: number }[], slot: number): string {
  return accentVars(colorIndexOf(players, slot));
}

/**
 * The typed name (or 'P1') for a human slot, 'CPU LV 5' for a CPU slot, and the select
 * screen's level name ('AEVALMERE') for a top level CPU. Unknown slots fall back to 'P<n>'.
 */
export function playerTag(
  players: readonly { slot: number; cpu: boolean; cpuLevel: number; name?: string }[],
  slot: number
): string {
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.slot !== slot) continue;
    if (p.cpu) {
      return p.cpuLevel >= MAX_CPU_LEVEL ? cpuLevelName(p.cpuLevel).toUpperCase() : `CPU LV ${p.cpuLevel}`;
    }
    const name = p.name === undefined ? '' : p.name.trim();
    return name === '' ? `P${slot + 1}` : name;
  }
  return `P${slot + 1}`;
}

const FONT = BASE + 'fonts/';

const CHAMFER_POLY =
  'polygon(var(--chamfer) 0, 100% 0, 100% calc(100% - var(--chamfer)), calc(100% - var(--chamfer)) 100%, 0 100%, 0 var(--chamfer))';
/** The outer chamfer shrunk by the line width (a 45 degree cut moves in by line * (sqrt 2 - 1)). */
const INNER_CHAMFER_POLY =
  'polygon(var(--chamfer-in) 0, 100% 0, 100% calc(100% - var(--chamfer-in)), calc(100% - var(--chamfer-in)) 100%, 0 100%, 0 var(--chamfer-in))';

export const THEME_CSS = `
@font-face { font-family: "Cormorant Garamond"; font-style: normal; font-weight: 500; font-display: swap;
  src: url("${FONT}CormorantGaramond-500.woff2") format("woff2"); }
@font-face { font-family: "Cormorant Garamond"; font-style: normal; font-weight: 600; font-display: swap;
  src: url("${FONT}CormorantGaramond-600.woff2") format("woff2"); }
@font-face { font-family: "Cormorant Garamond"; font-style: italic; font-weight: 500; font-display: swap;
  src: url("${FONT}CormorantGaramond-500i.woff2") format("woff2"); }
@font-face { font-family: "Space Mono"; font-style: normal; font-weight: 400; font-display: swap;
  src: url("${FONT}SpaceMono-400.woff2") format("woff2"); }
@font-face { font-family: "Space Mono"; font-style: normal; font-weight: 700; font-display: swap;
  src: url("${FONT}SpaceMono-700.woff2") format("woff2"); }

.aev-ui-root, #hud {
  --accent: ${DEFAULT_ACCENT};
  --hue-shift: ${hueShift(DEFAULT_ACCENT)}deg;
  --line: 1.5px;
  --chamfer: 14px;
  --font-display: "Cormorant Garamond", Georgia, "Times New Roman", serif;
  --font-ui: "Space Mono", Consolas, "Courier New", monospace;
  --ink: #070a16;
  --panel: #0b1020;
  --text: #c9d4ea;
  --glow: 0 0 8px color-mix(in srgb, var(--accent) 55%, transparent);
}

/* ---- Chamfered double frame ---- */
.ui-frame {
  --chamfer-in: calc(var(--chamfer) - var(--line) * 0.414);
  position: relative;
  isolation: isolate;
  clip-path: ${CHAMFER_POLY};
  background: var(--accent);
  color: var(--text);
}
.ui-frame::before {
  content: "";
  position: absolute;
  inset: var(--line);
  z-index: -1;
  clip-path: ${INNER_CHAMFER_POLY};
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  pointer-events: none;
}

/* ---- Separator: line, centre diamond, arrow tips ---- */
.ui-rule {
  position: relative;
  height: 10px;
  width: 100%;
  flex-shrink: 0;
}
.ui-rule::after {
  content: "";
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--accent) 85%, transparent);
  clip-path: polygon(0 50%, 8px 20%, 8px calc(50% - 0.5px), calc(100% - 8px) calc(50% - 0.5px),
    calc(100% - 8px) 20%, 100% 50%, calc(100% - 8px) 80%, calc(100% - 8px) calc(50% + 0.5px),
    8px calc(50% + 0.5px), 8px 80%);
}
.ui-rule::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 7px;
  height: 7px;
  transform: translate(-50%, -50%) rotate(45deg);
  background: var(--accent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 60%, transparent);
  z-index: 1;
}

/* ---- Four-point spark before headers ---- */
.ui-spark {
  display: inline-block;
  color: var(--accent);
  text-shadow: var(--glow);
  margin-right: 0.6em;
  font-family: var(--font-ui);
  letter-spacing: 0;
}
.ui-spark::before { content: "\\2726"; }

.ui-header {
  margin: 0;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.95rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent);
  text-shadow: var(--glow);
}

.ui-glow { text-shadow: var(--glow); }

/* ---- Menu cursor (mask painted in the accent) ---- */
.ui-cursor {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  width: 36px;
  height: 22px;
  /* Filters run before masks, so the mask sits on ::before and the glow on the box. The cut
     mask is soft (mean alpha ~0.35); the two zero-blur shadows stack the shape on itself so
     the selector reads as clearly as the reference. */
  filter: drop-shadow(0 0 0 color-mix(in srgb, var(--accent) 55%, #fff))
    drop-shadow(0 0 0 color-mix(in srgb, var(--accent) 55%, #fff))
    drop-shadow(0 0 4px color-mix(in srgb, var(--accent) 80%, transparent));
  transition: transform 120ms ease-out, opacity 120ms ease-out;
}
.ui-cursor::before {
  content: "";
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--accent) 55%, #fff);
  -webkit-mask-image: url("${uiAsset('cursor.png')}");
  mask-image: url("${uiAsset('cursor.png')}");
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
}

/* ---- Menu rows and the highlight bar ---- */
.ui-item {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.45rem 1rem 0.45rem 0.9rem;
  font-family: var(--font-ui);
  font-size: 1.05rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text);
  background: none;
  border: 0;
  text-align: left;
  cursor: pointer;
  transition: color 120ms ease-out;
}
.ui-item::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 30%, transparent), transparent);
  clip-path: polygon(12px 0, 100% 0, 100% 100%, 12px 100%, 0 50%);
  opacity: 0;
  transition: opacity 120ms ease-out;
  pointer-events: none;
}
.ui-item:hover::before { opacity: 0.5; }
.ui-item.ui-item-selected { color: var(--accent); text-shadow: var(--glow); }
.ui-item.ui-item-selected::before { opacity: 1; }
.ui-item.ui-item-disabled { opacity: 0.4; cursor: default; }
.ui-item.ui-item-disabled:hover::before { opacity: 0; }
.ui-item:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

/* Standalone highlight bar, for layouts that position it themselves. */
.ui-bar {
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 30%, transparent), transparent);
  clip-path: polygon(12px 0, 100% 0, 100% 100%, 12px 100%, 0 50%);
  transition: opacity 120ms ease-out, transform 120ms ease-out;
}

/* ---- Tags: P1, CPU LV 5, SOON, stage name ---- */
.ui-tag {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--accent) 80%, transparent);
  white-space: nowrap;
}

/* ---- Buttons: small chamfered double frame ---- */
.ui-btn {
  --chamfer: 9px;
  --chamfer-in: calc(var(--chamfer) - var(--line) * 0.414);
  position: relative;
  isolation: isolate;
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  border-radius: 0;
  margin: 0;
  padding: 0.55rem 1.3rem;
  font-family: var(--font-ui);
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  clip-path: ${CHAMFER_POLY};
  cursor: pointer;
  transition: color 120ms ease-out, background-color 120ms ease-out;
}
.ui-btn::before {
  content: "";
  position: absolute;
  inset: var(--line);
  z-index: -1;
  clip-path: ${INNER_CHAMFER_POLY};
  background: var(--panel);
  transition: background-color 120ms ease-out;
}
.ui-btn:hover:not(:disabled), .ui-btn.ui-btn-selected {
  background: var(--accent);
  color: var(--accent);
  text-shadow: var(--glow);
}
.ui-btn:hover:not(:disabled)::before, .ui-btn.ui-btn-selected::before {
  background: color-mix(in srgb, var(--accent) 20%, var(--panel));
}
.ui-btn:disabled { opacity: 0.35; cursor: default; }
.ui-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: 3px; }

/* ---- Tables ---- */
.ui-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-family: var(--font-ui);
  font-size: 0.85rem;
  color: var(--text);
}
.ui-table th, .ui-table td {
  padding: 0.4rem 0.7rem;
  text-align: left;
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
}
.ui-table th {
  font-weight: 700;
  font-size: 0.72rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent);
  border-bottom-color: color-mix(in srgb, var(--accent) 60%, transparent);
}

/* ---- Thin range slider with an accent thumb ---- */
.ui-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 16px;
  margin: 0;
  background: transparent;
  cursor: pointer;
}
.ui-slider::-webkit-slider-runnable-track {
  height: 2px;
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  border: 0;
}
.ui-slider::-moz-range-track {
  height: 2px;
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  border: 0;
}
.ui-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 9px;
  height: 14px;
  margin-top: -6px;
  background: var(--accent);
  border: 0;
  border-radius: 0;
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 60%, transparent);
}
.ui-slider::-moz-range-thumb {
  width: 9px;
  height: 14px;
  background: var(--accent);
  border: 0;
  border-radius: 0;
}
.ui-slider:focus-visible { outline: 1px solid var(--accent); outline-offset: 3px; }

/* ---- Dim character backdrop behind a panel ---- */
.ui-backdrop {
  position: absolute;
  right: 0;
  top: 0;
  height: 100%;
  width: auto;
  z-index: -1;
  pointer-events: none;
  opacity: 0.55;
  filter: hue-rotate(var(--hue-shift)) saturate(0.9);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 45%);
  mask-image: linear-gradient(90deg, transparent, #000 45%);
}

/* ---- Drifting petals ---- */
.ui-petals {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.ui-petal {
  position: absolute;
  top: -30px;
  width: 22px;
  height: 22px;
  background: color-mix(in srgb, var(--accent) 70%, #ffffff);
  opacity: 0;
  -webkit-mask-image: var(--petal, url("${uiAsset('petal-1.png')}"));
  mask-image: var(--petal, url("${uiAsset('petal-1.png')}"));
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  animation: ui-petal-drift var(--dur, 11s) linear var(--delay, 0s) infinite;
  will-change: transform;
}
.ui-petal-1 { --petal: url("${uiAsset('petal-1.png')}"); }
.ui-petal-2 { --petal: url("${uiAsset('petal-2.png')}"); }
.ui-petal-3 { --petal: url("${uiAsset('petal-3.png')}"); }
.ui-petal-4 { --petal: url("${uiAsset('petal-4.png')}"); }
@keyframes ui-petal-drift {
  0% { transform: translate(0, 0) rotate(0deg); opacity: 0; }
  10% { opacity: 0.85; }
  85% { opacity: 0.7; }
  100% { transform: translate(var(--dx, -120px), var(--dy, 110vh)) rotate(var(--rot, 320deg)); opacity: 0; }
}

/* ---- Blink (PRESS ANY KEY) and heading entrance (WIN / LOSE) ---- */
.ui-blink { animation: ui-blink 1.1s steps(1) infinite; }
@keyframes ui-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
.ui-scale-in { animation: ui-scale-in 260ms ease-out both; }
@keyframes ui-scale-in {
  from { transform: scale(1.15); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .aev-ui-root *, .aev-ui-root *::before, .aev-ui-root *::after,
  #hud *, #hud *::before, #hud *::after {
    animation: none !important;
    transition: none !important;
  }
  .ui-petal { display: none; }
}
`;
