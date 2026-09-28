import { grabKitOf } from '../characters/common/grabkit';
import { CHARACTER_DEFS } from '../characters/registry';
import type { DebugFlags, FighterState, GameState, PerfSample } from '../core/types';
import { missingAnims } from './anim';
import { drawText, GLYPH_H } from './font';
import { liveView } from './scale';
import { getProjectileVisual } from './visuals';

/**
 * Debug overlays. Everything here runs only while a flag is on, so the small
 * amount of string building it does never touches the normal render path.
 */

const HITBOX_COLOR = '#ff4d4d';
const GRAB_COLOR = '#b266ff';
const HURTBOX_COLOR = '#ffe066';
const LEDGE_COLOR = '#66e0ff';
const TEXT_COLOR = '#c9d1e0';
const TEXT_SCALE = 1;
const LINE_H = GLYPH_H + 2;

/** The one sim-private field the grab box overlay reads. Absent on a plain FighterState. */
interface SimGrabFlags { grabDash?: boolean }

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

  ctx.strokeStyle = GRAB_COLOR;
  for (let i = 0; i < fcount; i++) {
    const fighter = state.fighters[i] as FighterState & SimGrabFlags;
    if (fighter.action !== 'grab') continue;
    const def = CHARACTER_DEFS[fighter.charId];
    if (def === undefined) continue;
    const kit = grabKitOf(def);
    const grab = fighter.grabDash === true ? kit.dash : kit.stand;
    if (fighter.actionFrame < grab.start || fighter.actionFrame > grab.end) continue;
    strokeCircle(
      ctx,
      Math.round(posX[i] + grab.x * fighter.facing) + 0.5,
      Math.round(posY[i] + grab.y) + 0.5,
      grab.r
    );
  }

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
      ctx.strokeStyle = hitbox.grab === undefined ? HITBOX_COLOR : GRAB_COLOR;
      strokeCircle(
        ctx,
        Math.round(posX[i] + hitbox.x * fighter.facing) + 0.5,
        Math.round(posY[i] + hitbox.y) + 0.5,
        hitbox.r
      );
    }
  }

  // Final Smash phase name over the attacker. Placeholder until the animation overhaul
  // draws the phases for real; the string is only built while the overlay is on.
  for (let i = 0; i < fcount; i++) {
    const fighter = state.fighters[i];
    if (fighter.action !== 'finalSmash') continue;
    const def = CHARACTER_DEFS[fighter.charId];
    if (def === undefined || def.finalSmash === undefined) continue;
    let label = 'FS';
    const phases = def.finalSmash.phases;
    for (let p = 0; p < phases.length; p++) {
      if (fighter.actionFrame >= phases[p].start && fighter.actionFrame < phases[p].end) label = phases[p].name.toUpperCase();
    }
    if (fighter.actionFrame < def.finalSmash.startup) label = 'FS STARTUP';
    drawText(ctx, label, posX[i] - label.length * 2, posY[i] - def.hurtbox.h - LINE_H * 2, TEXT_SCALE, GRAB_COLOR);
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
  let y = liveView.h - 60 - state.fighters.length * LINE_H;
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
