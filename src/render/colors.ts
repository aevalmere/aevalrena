/** Shared color constants for the renderer. Values come from SPEC sections 6 and 8. */

import { PALETTES, variantTable } from './palette';

export const PLAYER_COLORS: readonly string[] = ['#7fb2ff', '#ff7f7f', '#ffd27f', '#9fff7f'];

export const INK = '#1a1b26';
export const STONE_DARK = '#2b2d42';
export const STONE = '#3a4a6b';
export const STONE_LIGHT = '#6e7a94';
export const PALE = '#c9d1e0';
export const GLOW = '#7fb2ff';
/** Aeval's GLOW per colour variant (src/render/palette.ts). Per character: glowFor(v, charId). */
export const GLOW_VARIANTS: readonly string[] = variantTable(GLOW);

/** Each character's glow base (PaletteConfig.glow) per variant, built once at load. */
const GLOW_BY_CHAR = new Map<string, readonly string[]>();
for (const charId in PALETTES) GLOW_BY_CHAR.set(charId, variantTable(PALETTES[charId].glow, charId));

/**
 * `charId`'s glow in colour variant `v`: charge beads, respawn glow, crit sparks. An unknown
 * character reads as Aeval's; an out of range variant reads as the base colour.
 */
export function glowFor(v: number, charId = 'aeval'): string {
  const table = GLOW_BY_CHAR.get(charId);
  const list = table === undefined ? GLOW_VARIANTS : table;
  const c = list[v];
  return c === undefined ? list[0] : c;
}

export const WHITE = '#ffffff';

/** Percent tint ramp: white to yellow to red. Discrete so no color string is built per frame. */
export const PERCENT_RAMP: readonly string[] = [
  '#f0ead6', '#e8e3b8', '#ffd27f', '#ffb066', '#ff8f5a', '#ff7f7f', '#ff5a5a',
];
export const PERCENT_RAMP_STEP = 25;

export function playerColor(slot: number): string {
  const c = PLAYER_COLORS[slot];
  return c === undefined ? GLOW : c;
}

export function percentColor(percent: number): string {
  let i = Math.floor(percent / PERCENT_RAMP_STEP);
  if (i < 0) i = 0;
  if (i >= PERCENT_RAMP.length) i = PERCENT_RAMP.length - 1;
  return PERCENT_RAMP[i];
}

/**
 * Colour index (into PLAYER_COLORS) for a slot: its chosen team colour, else the slot's own.
 * With the Teams rule off the team colour is cosmetic; the sim reads it only under the rule.
 */
export function colorIndexOf(players: readonly { slot: number; team?: number }[], slot: number): number {
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.slot !== slot) continue;
    const t = p.team;
    return t !== undefined && t >= 0 && t < PLAYER_COLORS.length ? t : slot;
  }
  return slot;
}

/** The accent colour a slot plays in: its team colour when one is set. */
export function slotColor(players: readonly { slot: number; team?: number }[], slot: number): string {
  return playerColor(colorIndexOf(players, slot));
}
