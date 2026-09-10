import { SIM_HZ } from '../core/types';
import type { GameState } from '../core/types';
import { getFrame } from './bake';
import { GLOW } from './colors';
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
  flipped: boolean
): boolean {
  const canvas = getFrame(sheetId, frameName, flipped, false);
  if (canvas === null) return false;
  ctx.drawImage(canvas, Math.round(x - canvas.width / 2), Math.round(y - canvas.height / 2));
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
    drawCentered(ctx, visual.fxSheetId, frames[idx], pool.x[i], pool.y[i], false);
  }
}

function frameForAction(frames: string[], actionFrame: number, fps: number): string | null {
  if (frames.length === 0) return null;
  let idx = Math.floor((actionFrame * fps) / SIM_HZ);
  if (idx >= frames.length) idx = frames.length - 1;
  if (idx < 0) idx = 0;
  return frames[idx];
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
    if (fighter.action !== 'attack') continue;
    if (fighter.moveId !== 'uspecial' && fighter.moveId !== 'dspecial') continue;
    const visual = getCharVisual(fighter.charId);
    if (visual === null) continue;

    const frames = fighter.moveId === 'uspecial' ? visual.geyser : visual.whirl;
    const name = frameForAction(frames, fighter.actionFrame, 12);
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
        projectile.facing === -1
      );
    }

    if (!drawn) {
      ctx.fillStyle = GLOW;
      ctx.beginPath();
      ctx.arc(Math.round(x), Math.round(y), FALLBACK_PROJECTILE_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
