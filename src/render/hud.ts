import type { GameState } from '../core/types';
import { VIEW_H, VIEW_W } from '../core/types';
import { getFrame } from './bake';
import { INK, PALE, STONE_DARK, percentColor, playerColor } from './colors';
import { drawPercent, percentWidth } from './font';
import { getCharVisual } from './visuals';

/**
 * Bottom HUD: one card per player with a portrait, a percent readout that
 * tints white to yellow to red and pops when it changes, and stock squares.
 */

const CARD_W = 124;
const CARD_H = 50;
const CARD_GAP = 8;
const CARD_Y = VIEW_H - CARD_H - 4;
const PORTRAIT_X = 4;
const PERCENT_RIGHT = CARD_W - 6;
const PERCENT_Y = 6;
const PERCENT_SCALE = 2;
const PERCENT_POP_SCALE = 3;
const POP_FRAMES = 10;
const STOCK_SIZE = 6;
const STOCK_GAP = 8;
const STOCK_X = 42;
const STOCK_Y = CARD_H - 14;
const MAX_STOCK_ICONS = 6;

export interface HudState {
  lastPercent: Float32Array;
  pop: Uint8Array;
}

export function createHudState(slots: number): HudState {
  return { lastPercent: new Float32Array(slots), pop: new Uint8Array(slots) };
}

export function resetHudState(hud: HudState): void {
  hud.lastPercent.fill(-1);
  hud.pop.fill(0);
}

/**
 * Advance the percent pop by `steps` elapsed sim frames. A percent that changed
 * this sim frame restarts the pop; repeat renders of the same sim frame pass
 * zero steps and leave the pop alone.
 */
export function stepHud(hud: HudState, state: GameState, steps: number): void {
  const count = Math.min(state.fighters.length, hud.pop.length);
  for (let i = 0; i < count; i++) {
    const percent = state.fighters[i].percent;
    if (hud.lastPercent[i] !== percent) {
      if (hud.lastPercent[i] >= 0) hud.pop[i] = POP_FRAMES;
      hud.lastPercent[i] = percent;
    } else if (hud.pop[i] > 0) {
      hud.pop[i] = hud.pop[i] > steps ? hud.pop[i] - steps : 0;
    }
  }
}

function drawBorder(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, CARD_W, 1);
  ctx.fillRect(x, y + CARD_H - 1, CARD_W, 1);
  ctx.fillRect(x, y, 1, CARD_H);
  ctx.fillRect(x + CARD_W - 1, y, 1, CARD_H);
}

export function drawHud(ctx: CanvasRenderingContext2D, state: GameState, hud: HudState): void {
  const count = state.fighters.length;
  if (count === 0) return;

  const totalW = count * CARD_W + (count - 1) * CARD_GAP;
  const startX = Math.round((VIEW_W - totalW) / 2);
  const prevAlpha = ctx.globalAlpha;

  for (let i = 0; i < count; i++) {
    const fighter = state.fighters[i];
    const x = startX + i * (CARD_W + CARD_GAP);
    const y = CARD_Y;
    const color = playerColor(fighter.slot);

    ctx.globalAlpha = fighter.stocks > 0 ? 1 : 0.45;

    ctx.fillStyle = INK;
    ctx.fillRect(x, y, CARD_W, CARD_H);
    ctx.fillStyle = STONE_DARK;
    ctx.fillRect(x + 1, y + 1, CARD_W - 2, 1);
    drawBorder(ctx, x, y, color);

    const visual = getCharVisual(fighter.charId);
    if (visual !== null && visual.portrait !== null) {
      const portrait = getFrame(visual.bodySheetId, visual.portrait, false, false);
      if (portrait !== null) {
        const px = x + PORTRAIT_X;
        const py = y + CARD_H - 4 - portrait.height;
        ctx.drawImage(portrait, px, py);
      }
    }

    const popping = i < hud.pop.length && hud.pop[i] > 0;
    const scale = popping ? PERCENT_POP_SCALE : PERCENT_SCALE;
    const shown = Math.floor(fighter.percent);
    const width = percentWidth(shown, scale);
    const textX = x + PERCENT_RIGHT - width;
    drawPercent(ctx, shown, textX, y + PERCENT_Y, scale, percentColor(shown));

    const icons = fighter.stocks > MAX_STOCK_ICONS ? MAX_STOCK_ICONS : fighter.stocks;
    for (let s = 0; s < icons; s++) {
      const sx = x + STOCK_X + s * STOCK_GAP;
      const sy = y + STOCK_Y;
      ctx.fillStyle = PALE;
      ctx.fillRect(sx, sy, STOCK_SIZE, STOCK_SIZE);
      ctx.fillStyle = color;
      ctx.fillRect(sx + 1, sy + 1, STOCK_SIZE - 2, STOCK_SIZE - 2);
    }
  }

  ctx.globalAlpha = prevAlpha;
}
