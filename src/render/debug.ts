import { CHARACTER_DEFS } from '../characters/registry';
import type { DebugFlags, GameState, PerfSample } from '../core/types';
import { VIEW_H } from '../core/types';
import { missingAnims } from './anim';
import { drawText, GLYPH_H } from './font';
import { getProjectileVisual } from './visuals';

/**
 * Debug overlays. Everything here runs only while a flag is on, so the small
 * amount of string building it does never touches the normal render path.
 */

const HITBOX_COLOR = '#ff4d4d';
const HURTBOX_COLOR = '#ffe066';
const LEDGE_COLOR = '#66e0ff';
const TEXT_COLOR = '#c9d1e0';
const TEXT_SCALE = 1;
const LINE_H = GLYPH_H + 2;

function strokeCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

/** World-space boxes. Call inside the camera transform. */
export function drawDebugWorld(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  posX: Float32Array,
  posY: Float32Array,
  projX: Float32Array,
  projY: Float32Array
): void {
  ctx.lineWidth = 1;
  const fcount = Math.min(state.fighters.length, posX.length);
  const pcount = Math.min(state.projectiles.length, projX.length);

  ctx.strokeStyle = HURTBOX_COLOR;
  for (let i = 0; i < fcount; i++) {
    const fighter = state.fighters[i];
    if (fighter.action === 'dead') continue;
    const def = CHARACTER_DEFS[fighter.charId];
    if (def === undefined) continue;
    const box = fighter.action === 'crouch' ? def.crouchHurtbox : def.hurtbox;
    ctx.strokeRect(
      Math.round(posX[i] - box.w / 2) + 0.5,
      Math.round(posY[i] - box.h) + 0.5,
      box.w - 1,
      box.h - 1
    );
  }

  ctx.strokeStyle = LEDGE_COLOR;
  for (let i = 0; i < fcount; i++) {
    const fighter = state.fighters[i];
    if (fighter.action === 'dead') continue;
    const def = CHARACTER_DEFS[fighter.charId];
    if (def === undefined) continue;
    const grab = def.ledgeGrabBox;
    ctx.strokeRect(
      Math.round(posX[i] - grab.w / 2) + 0.5,
      Math.round(posY[i] + grab.yOff) + 0.5,
      grab.w - 1,
      grab.h - 1
    );
  }

  ctx.strokeStyle = HITBOX_COLOR;
  for (let i = 0; i < fcount; i++) {
    const fighter = state.fighters[i];
    if (fighter.action !== 'attack' || fighter.moveId === null) continue;
    const def = CHARACTER_DEFS[fighter.charId];
    if (def === undefined) continue;
    const move = def.moves[fighter.moveId];
    if (move === undefined) continue;
    for (let h = 0; h < move.hitboxes.length; h++) {
      const hitbox = move.hitboxes[h];
      if (fighter.actionFrame < hitbox.start || fighter.actionFrame > hitbox.end) continue;
      strokeCircle(
        ctx,
        Math.round(posX[i] + hitbox.x * fighter.facing) + 0.5,
        Math.round(posY[i] + hitbox.y) + 0.5,
        hitbox.r
      );
    }
  }

  for (let i = 0; i < pcount; i++) {
    const projectile = state.projectiles[i];
    if (!projectile.alive) continue;
    const visual = getProjectileVisual(projectile.defId);
    const r = visual === null ? 6 : visual.def.r;
    strokeCircle(ctx, Math.round(projX[i]) + 0.5, Math.round(projY[i]) + 0.5, r);
  }
}

function fixed(value: number, places: number): string {
  return value.toFixed(places);
}

/** Screen-space text. Call after the camera transform is reset. */
export function drawDebugText(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  debug: DebugFlags,
  perf: PerfSample
): void {
  if (debug.perf) {
    drawText(ctx, 'SIM ' + fixed(perf.simMs, 2) + 'MS', 4, 4, TEXT_SCALE, TEXT_COLOR);
    drawText(ctx, 'RND ' + fixed(perf.renderMs, 2) + 'MS', 4, 4 + LINE_H, TEXT_SCALE, TEXT_COLOR);
    drawText(ctx, 'FPS ' + fixed(perf.fps, 1), 4, 4 + LINE_H * 2, TEXT_SCALE, TEXT_COLOR);
    drawText(
      ctx,
      'FRAME ' + state.frame,
      4,
      4 + LINE_H * 3,
      TEXT_SCALE,
      TEXT_COLOR
    );
  }

  if (!debug.frameData) return;

  const misses = missingAnims();
  let y = VIEW_H - 60 - state.fighters.length * LINE_H;
  if (y < 4) y = 4;
  if (misses.size > 0) {
    drawText(ctx, 'MISSING ANIMS ' + misses.size, 4, y - LINE_H, TEXT_SCALE, TEXT_COLOR);
  }
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    const line =
      'P' +
      (f.slot + 1) +
      ' ' +
      f.action.toUpperCase() +
      ' ' +
      (f.moveId === null ? '-' : f.moveId.toUpperCase()) +
      ' F' +
      f.actionFrame +
      ' ' +
      Math.floor(f.percent) +
      '% V' +
      fixed(f.vx, 1) +
      ':' +
      fixed(f.vy, 1);
    drawText(ctx, line, 4, y + i * LINE_H, TEXT_SCALE, TEXT_COLOR);
  }
}
