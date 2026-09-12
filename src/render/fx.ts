import { CHARACTER_DEFS } from '../characters/registry';
import { TUNING } from '../core/constants';
import { SIM_HZ } from '../core/types';
import type { FighterState, GameState, ProjectileDef } from '../core/types';
import { getFrame } from './bake';
import { GLOW, PALE, WHITE } from './colors';
import type { CharVisual } from './visuals';
import { getCharVisual, getProjectileVisual } from './visuals';

/**
 * Effect-sheet drawing: the up-special geyser and down-special whirl anchored
 * on the fighter, hit sparks from a small fixed pool, and projectiles.
 */

const SPARK_POOL = 24;
const SPARK_FPS = 20;
const SPARK_LIFE = 12;
const DEFAULT_PROJECTILE_FPS = 12;
const FALLBACK_PROJECTILE_R = 6;

/**
 * Charge tell: a ring of water beads gathering around the charge. A hold that
 * spawns a projectile rings the ball being held, and the ring swells to double
 * its starting radius as the hold runs to chargeMax; a hold with nothing in hand
 * (the smashes) keeps the old chest ring that tightens instead. Both gain beads
 * and brighten, and both disappear the frame the charge is released because the
 * sim clears `charging`. Directions are a fixed 16-step table so the ring never
 * builds an array or a trig call while drawing, and every bead lands on a whole
 * pixel.
 */
const CHARGE_DIRS = 16;
const CHARGE_COS = new Float32Array(CHARGE_DIRS);
const CHARGE_SIN = new Float32Array(CHARGE_DIRS);
for (let i = 0; i < CHARGE_DIRS; i++) {
  CHARGE_COS[i] = Math.cos((i * Math.PI * 2) / CHARGE_DIRS);
  CHARGE_SIN[i] = Math.sin((i * Math.PI * 2) / CHARGE_DIRS);
}
const CHARGE_Y = -22;
const CHARGE_R_MAX = 17;
const CHARGE_R_MIN = 8;
const CHARGE_BEADS_MIN = 4;
const CHARGE_BEADS_MAX = 8;
const CHARGE_BEAD_PX = 2;
// A ball-sized ring at rest, twice that at full charge.
const BALL_R_BASE = 9;
const BALL_R_GROWTH = 2;
// The drawn ball sits further out along her facing than the projectile's own
// spawn offset, so the ring gets pushed this many extra pixels forward to land
// on it. Single number to tune if the beads still read as off the ball.
const BALL_FORWARD = 12;

export interface SparkPool {
  x: Float32Array;
  y: Float32Array;
  age: Float32Array;
  live: Uint8Array;
  source: (CharVisual | null)[];
  cursor: number;
}

export function createSparks(): SparkPool {
  const source: (CharVisual | null)[] = new Array(SPARK_POOL).fill(null);
  return {
    x: new Float32Array(SPARK_POOL),
    y: new Float32Array(SPARK_POOL),
    age: new Float32Array(SPARK_POOL),
    live: new Uint8Array(SPARK_POOL),
    source,
    cursor: 0,
  };
}

export function clearSparks(pool: SparkPool): void {
  pool.live.fill(0);
  pool.cursor = 0;
}

export function spawnSpark(pool: SparkPool, x: number, y: number, charId: string): void {
  const visual = getCharVisual(charId);
  if (visual === null || visual.hitspark.length === 0) return;
  const i = pool.cursor;
  pool.cursor = (i + 1) % SPARK_POOL;
  pool.x[i] = x;
  pool.y[i] = y;
  pool.age[i] = 0;
  pool.live[i] = 1;
  pool.source[i] = visual;
}

/** Age the sparks by `steps` sim frames so they never run at display rate. */
export function stepSparks(pool: SparkPool, steps: number): void {
  if (steps <= 0) return;
  for (let i = 0; i < SPARK_POOL; i++) {
    if (pool.live[i] === 0) continue;
    pool.age[i] += steps;
    if (pool.age[i] >= SPARK_LIFE) {
      pool.live[i] = 0;
      pool.source[i] = null;
    }
  }
}

function drawCentered(
  ctx: CanvasRenderingContext2D,
  sheetId: string,
  frameName: string,
  x: number,
  y: number,
  flipped: boolean,
  scale: number
): boolean {
  const canvas = getFrame(sheetId, frameName, flipped, false);
  if (canvas === null) return false;
  if (scale === 1) {
    ctx.drawImage(canvas, Math.round(x - canvas.width / 2), Math.round(y - canvas.height / 2));
    return true;
  }
  // Whole-pixel destination size with smoothing off, so a charged sprite grows
  // in hard pixels rather than blurring.
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  ctx.drawImage(canvas, Math.round(x - w / 2), Math.round(y - h / 2), w, h);
  return true;
}

export function drawSparks(ctx: CanvasRenderingContext2D, pool: SparkPool): void {
  for (let i = 0; i < SPARK_POOL; i++) {
    if (pool.live[i] === 0) continue;
    const visual = pool.source[i];
    if (visual === null) continue;
    const frames = visual.hitspark;
    let idx = Math.floor((pool.age[i] * SPARK_FPS) / SIM_HZ);
    if (idx >= frames.length) idx = frames.length - 1;
    if (idx < 0) idx = 0;
    drawCentered(ctx, visual.fxSheetId, frames[idx], pool.x[i], pool.y[i], false, 1);
  }
}

/**
 * Frame for an action-driven effect. Clamps on the last frame by default, which
 * is what a one-shot like the rising geyser wants; pass `loop` for an effect that
 * has to keep cycling for the whole move, like the whirlpool.
 */
function frameForAction(
  frames: string[],
  actionFrame: number,
  fps: number,
  loop: boolean
): string | null {
  if (frames.length === 0) return null;
  let idx = Math.floor((actionFrame * fps) / SIM_HZ);
  if (idx < 0) idx = 0;
  if (loop) {
    idx = idx % frames.length;
  } else if (idx >= frames.length) {
    idx = frames.length - 1;
  }
  return frames[idx];
}

/**
 * The projectile a charging move is holding, or null when it holds nothing. The
 * ring rides the first projectile the move spawns, so it sits on the ball rather
 * than on a number of its own.
 */
function heldProjectile(fighter: FighterState): ProjectileDef | null {
  if (fighter.action !== 'attack' || fighter.moveId === null) return null;
  const def = CHARACTER_DEFS[fighter.charId];
  if (def === undefined) return null;
  const move = def.moves[fighter.moveId];
  if (move === undefined) return null;
  const projectiles = move.projectiles;
  if (projectiles === undefined || projectiles.length === 0) return null;
  return projectiles[0];
}

/** The beads a held charge gathers, drawn on top of the wind-up pose. */
function drawChargeRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  charge: number,
  spin: number,
  held: ProjectileDef | null,
  facing: number
): void {
  const max = TUNING.input.chargeMax > 0 ? TUNING.input.chargeMax : 1;
  let t = charge / max;
  if (t < 0) t = 0;
  if (t > 1) t = 1;

  let radius: number;
  let cx: number;
  let cy: number;
  if (held === null) {
    // Nothing in hand: the old chest ring, tightening as it fills.
    radius = CHARGE_R_MAX - (CHARGE_R_MAX - CHARGE_R_MIN) * t;
    cx = Math.round(x);
    cy = Math.round(y + CHARGE_Y);
  } else {
    // Around the ball, growing to double the base radius at full charge. The
    // centre is the projectile's own fighter-local spawn point pushed forward by
    // BALL_FORWARD, both mirrored by facing, so the ring sits on the drawn ball
    // instead of halfway back toward her chest.
    radius = BALL_R_BASE * (1 + (BALL_R_GROWTH - 1) * t);
    cx = Math.round(x + (held.x + BALL_FORWARD) * facing);
    cy = Math.round(y + held.y);
  }

  const beads = CHARGE_BEADS_MIN + Math.floor((CHARGE_BEADS_MAX - CHARGE_BEADS_MIN) * t);
  const step = CHARGE_DIRS / beads;

  ctx.fillStyle = t < 0.5 ? PALE : GLOW;
  for (let b = 0; b < beads; b++) {
    const dir = (Math.round(b * step) + spin) % CHARGE_DIRS;
    const bx = cx + Math.round(CHARGE_COS[dir] * radius) - 1;
    const by = cy + Math.round(CHARGE_SIN[dir] * radius) - 1;
    ctx.fillRect(bx, by, CHARGE_BEAD_PX, CHARGE_BEAD_PX);
  }

  // A full charge pops a bright core so the player knows there is nothing left.
  if (t >= 1) {
    ctx.fillStyle = WHITE;
    ctx.fillRect(cx - 2, cy - 2, 4, 4);
  }
}

/** Geyser and whirl follow the fighter for the duration of the special. */
export function drawFighterFx(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  posX: Float32Array,
  posY: Float32Array
): void {
  const count = Math.min(state.fighters.length, posX.length);
  for (let i = 0; i < count; i++) {
    const fighter = state.fighters[i];
    if (fighter.charging) {
      // The ring spins off the charge counter itself, so it holds still while
      // the game is paused and never needs a render clock of its own.
      drawChargeRing(
        ctx,
        posX[i],
        posY[i],
        fighter.charge,
        fighter.charge >> 1,
        heldProjectile(fighter),
        fighter.facing
      );
    }
    if (fighter.action !== 'attack') continue;
    if (fighter.moveId !== 'uspecial' && fighter.moveId !== 'dspecial') continue;
    const visual = getCharVisual(fighter.charId);
    if (visual === null) continue;

    // The geyser is a one-shot rise, so it clamps; the whirlpool keeps cycling
    // for the whole of dspecial instead of freezing on its last frame.
    const isGeyser = fighter.moveId === 'uspecial';
    const frames = isGeyser ? visual.geyser : visual.whirl;
    const name = frameForAction(frames, fighter.actionFrame, 12, !isGeyser);
    if (name === null) continue;

    const canvas = getFrame(visual.fxSheetId, name, fighter.facing === -1, false);
    if (canvas === null) continue;
    const x = Math.round(posX[i] - canvas.width / 2);
    const y = Math.round(posY[i] - canvas.height);
    ctx.drawImage(canvas, x, y);
  }
}

export function drawProjectiles(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  posX: Float32Array,
  posY: Float32Array
): void {
  const count = Math.min(state.projectiles.length, posX.length);
  for (let i = 0; i < count; i++) {
    const projectile = state.projectiles[i];
    if (!projectile.alive) continue;
    const x = posX[i];
    const y = posY[i];

    // A charged shot carries a bigger hit circle, so it has to look bigger too.
    const scale = projectile.scale > 0 ? projectile.scale : 1;

    const visual = getProjectileVisual(projectile.defId);
    let drawn = false;
    if (visual !== null && visual.frames.length > 0) {
      const fps = visual.def.animFps === undefined ? DEFAULT_PROJECTILE_FPS : visual.def.animFps;
      let idx = Math.floor((projectile.age * fps) / SIM_HZ);
      idx = ((idx % visual.frames.length) + visual.frames.length) % visual.frames.length;
      drawn = drawCentered(
        ctx,
        visual.owner.fxSheetId,
        visual.frames[idx],
        x,
        y,
        projectile.facing === -1,
        scale
      );
    }

    if (!drawn) {
      ctx.fillStyle = GLOW;
      ctx.beginPath();
      ctx.arc(Math.round(x), Math.round(y), FALLBACK_PROJECTILE_R * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
