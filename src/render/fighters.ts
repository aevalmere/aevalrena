import { SHIELD_MAX } from '../core/constants';
import type { GameState } from '../core/types';
import { frameNameFor } from './anim';
import { getFrame, getOutline } from './bake';
import { GLOW, INK, STONE, STONE_LIGHT, playerColor } from './colors';
import { getCharVisual } from './visuals';

/**
 * Fighter drawing in world space: player-color outline, body, white flash,
 * shield bubble, invulnerability blink and the respawn platform.
 */

const BLINK_PERIOD = 8;
const BLINK_ON = 4;
const SHIELD_MIN_R = 9;
const SHIELD_MAX_R = 24;
const SHIELD_ALPHA = 0.34;
const RESPAWN_PLAT_W = 44;
const RESPAWN_PLAT_H = 5;

/** Respawn platforms sit under any fighter waiting to drop back in. */
export function drawRespawnPlatforms(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  posX: Float32Array,
  posY: Float32Array
): void {
  const count = Math.min(state.fighters.length, posX.length);
  for (let i = 0; i < count; i++) {
    const fighter = state.fighters[i];
    if (fighter.action !== 'respawn') continue;
    const x = Math.round(posX[i] - RESPAWN_PLAT_W / 2);
    const y = Math.round(posY[i]);
    ctx.fillStyle = INK;
    ctx.fillRect(x, y + 2, RESPAWN_PLAT_W, RESPAWN_PLAT_H);
    ctx.fillStyle = STONE;
    ctx.fillRect(x, y, RESPAWN_PLAT_W, 2);
    ctx.fillStyle = STONE_LIGHT;
    ctx.fillRect(x + 2, y + 2, RESPAWN_PLAT_W - 4, 1);
    ctx.fillStyle = GLOW;
    ctx.fillRect(x + 6, y - 1, RESPAWN_PLAT_W - 12, 1);
  }
}

function drawShieldBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  shieldHp: number,
  color: string
): void {
  let ratio = shieldHp / SHIELD_MAX;
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  const r = SHIELD_MIN_R + (SHIELD_MAX_R - SHIELD_MIN_R) * ratio;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = SHIELD_ALPHA;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(Math.round(x), Math.round(y - 20), r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = prevAlpha;
}

export interface FighterDrawDeps {
  /** Baked body sheet id per fighter index, empty string when the char is unknown. */
  sheetIds: string[];
  /** Frame name per fighter index, empty string when nothing resolves. */
  frameNames: string[];
}

/**
 * Resolve the frame name for every fighter once per render frame. Kept out of
 * the draw loop so the debug overlay can reuse the same strings.
 */
export function resolveFighterFrames(state: GameState, deps: FighterDrawDeps): void {
  const count = Math.min(state.fighters.length, deps.frameNames.length);
  for (let i = 0; i < count; i++) {
    const fighter = state.fighters[i];
    const visual = getCharVisual(fighter.charId);
    if (visual === null) {
      deps.sheetIds[i] = '';
      deps.frameNames[i] = '';
      continue;
    }
    const name = frameNameFor(visual.sprites, fighter);
    deps.sheetIds[i] = visual.bodySheetId;
    deps.frameNames[i] = name === null ? '' : name;
  }
}

export function drawFighters(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  posX: Float32Array,
  posY: Float32Array,
  flash: Uint8Array,
  deps: FighterDrawDeps,
  renderTick: number
): void {
  const blinkOff = renderTick % BLINK_PERIOD >= BLINK_ON;
  const count = Math.min(state.fighters.length, posX.length);

  for (let i = 0; i < count; i++) {
    const fighter = state.fighters[i];
    if (fighter.action === 'dead') continue;

    const sheetId = deps.sheetIds[i];
    const frameName = deps.frameNames[i];
    const color = playerColor(fighter.slot);
    const x = posX[i];
    const y = posY[i];

    const hidden = fighter.invuln > 0 && blinkOff;

    if (!hidden && sheetId !== '' && frameName !== '') {
      const white = flash[i] > 0;
      const body = getFrame(sheetId, frameName, fighter.facing === -1, white);
      if (body !== null) {
        const dx = Math.round(x - body.width / 2);
        const dy = Math.round(y - body.height);
        const outline = getOutline(sheetId, frameName, fighter.facing === -1, color);
        if (outline !== null) ctx.drawImage(outline, dx - 1, dy - 1);
        ctx.drawImage(body, dx, dy);
      }
    }

    if (fighter.action === 'shield' || fighter.action === 'shieldStun') {
      drawShieldBubble(ctx, x, y, fighter.shieldHp, color);
    }
  }
}
