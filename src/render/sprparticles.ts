import { PALETTES, VARIANT_COUNT, variantTable } from './palette';
import { getFrame } from './bake';
import type { CharVisual } from './visuals';
import { getCharVisual } from './visuals';

/**
 * Sprite particles: a fixed pool, structs of arrays, of small crops cut from a character's fx
 * sheet (visuals.ts PIECE_FAMILIES: shards, smoke, motes, slivers, spikes, dissolve smoke). Each particle has
 * position, velocity, gravity, drag, rotation, scale and an alpha fade, and draws from the fx
 * sheet in its owner's colour variant, so the palette swap tints it. A family the sheet has no
 * crops for draws a small rect in a per-variant colour instead. Nothing allocates after creation.
 *
 * Scatter comes from a local xorshift that the caller reseeds from sim state (frame, slot, move
 * frame) before each spawn, so an effect spawned for one sim frame is the same whenever it runs.
 */

const POOL_SIZE = 384;

export const PIECE_SHARD = 0;
export const PIECE_SMOKE = 1;
export const PIECE_MOTE = 2;
export const PIECE_SLIVER = 3;
export const PIECE_SPIKE = 4;
/** Heavy dissolve smoke (pSmoke4..5, cut from the dead row); draws the smoke crops when absent. */
export const PIECE_DSMOKE = 5;
const FAMILY_COUNT = 6;

/** Draw layer: behind the fighters, or over them. */
export const LAYER_BACK = 0;
export const LAYER_FRONT = 1;

/** Rect fallback: base colour, width and height per family. */
const FALLBACK_COLOR: readonly string[] = ['#b070ff', '#1a1024', '#e0c8ff', '#d8b8ff', '#8a4dff', '#1a1024'];
const FALLBACK_W = new Uint8Array([2, 4, 1, 3, 2, 5]);
const FALLBACK_H = new Uint8Array([2, 3, 1, 1, 5, 4]);
/** Share of the life (from the end) over which the alpha fades out, per family. */
const FADE_SHARE = new Float32Array([0.5, 1, 0.6, 1, 0.4, 1]);
/** Families drawn with additive ('lighter') blending, so they read as glow: motes and slivers. */
const ADDITIVE = new Uint8Array([0, 0, 1, 1, 0, 0]);

/** Characters with palettes; a particle's tint is charIndex * VARIANT_COUNT + variant. */
const CHARS: readonly string[] = Object.keys(PALETTES);
/** Fallback colours per (character, variant), [tint][family], built once. */
const COLOR_BY_TINT: readonly (readonly string[])[] = (() => {
  const out: string[][] = [];
  for (const charId of CHARS) {
    const perFamily = FALLBACK_COLOR.map((c) => variantTable(c, charId));
    for (let v = 0; v < VARIANT_COUNT; v++) out.push(perFamily.map((t) => t[v]));
  }
  return out;
})();

function charIndex(charId: string): number {
  for (let i = 0; i < CHARS.length; i++) if (CHARS[i] === charId) return i;
  return 0;
}

export interface SpritePool {
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  gravity: Float32Array;
  drag: Float32Array;
  rot: Float32Array;
  vrot: Float32Array;
  scale: Float32Array;
  alpha: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  family: Uint8Array;
  pick: Uint8Array;
  tint: Uint8Array;
  layer: Uint8Array;
  cursor: number;
  seed: number;
}

export function createSpritePool(): SpritePool {
  return {
    x: new Float32Array(POOL_SIZE),
    y: new Float32Array(POOL_SIZE),
    vx: new Float32Array(POOL_SIZE),
    vy: new Float32Array(POOL_SIZE),
    gravity: new Float32Array(POOL_SIZE),
    drag: new Float32Array(POOL_SIZE),
    rot: new Float32Array(POOL_SIZE),
    vrot: new Float32Array(POOL_SIZE),
    scale: new Float32Array(POOL_SIZE),
    alpha: new Float32Array(POOL_SIZE),
    life: new Float32Array(POOL_SIZE),
    maxLife: new Float32Array(POOL_SIZE),
    family: new Uint8Array(POOL_SIZE),
    pick: new Uint8Array(POOL_SIZE),
    tint: new Uint8Array(POOL_SIZE),
    layer: new Uint8Array(POOL_SIZE),
    cursor: 0,
    seed: 1,
  };
}

export function clearSpritePool(pool: SpritePool): void {
  pool.life.fill(0);
  pool.cursor = 0;
}

/** Live particle count (tests and debug). */
export function liveSprites(pool: SpritePool): number {
  let n = 0;
  for (let i = 0; i < POOL_SIZE; i++) if (pool.life[i] > 0) n++;
  return n;
}

/** Reseed the scatter from sim values, so a spawn depends only on the state it came from. */
export function seedSprites(pool: SpritePool, a: number, b: number, c: number): void {
  let h = 0x811c9dc5 ^ (a | 0);
  h = Math.imul(h, 0x01000193) ^ (b | 0);
  h = Math.imul(h, 0x01000193) ^ (c | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  pool.seed = h === 0 ? 0x9e3779b9 : h | 0;
}

/** 0 to 1 from the local xorshift. */
export function srand(pool: SpritePool): number {
  let s = pool.seed | 0;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  pool.seed = s | 0;
  return ((s >>> 0) % 65536) / 65536;
}

/** -amount to amount. */
export function sspread(pool: SpritePool, amount: number): number {
  return (srand(pool) * 2 - 1) * amount;
}

/**
 * Spawn one particle. `pick` chooses among the family's crops (taken modulo their count);
 * rotation is radians, `vrot` radians per sim frame.
 */
export function emitSprite(
  pool: SpritePool,
  family: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  gravity: number,
  drag: number,
  rot: number,
  vrot: number,
  scale: number,
  alpha: number,
  layer: number,
  variant: number,
  charId: string
): void {
  const i = pool.cursor;
  pool.cursor = (i + 1) % POOL_SIZE;
  pool.x[i] = x;
  pool.y[i] = y;
  pool.vx[i] = vx;
  pool.vy[i] = vy;
  pool.life[i] = life;
  pool.maxLife[i] = life;
  pool.gravity[i] = gravity;
  pool.drag[i] = drag;
  pool.rot[i] = rot;
  pool.vrot[i] = vrot;
  pool.scale[i] = scale;
  pool.alpha[i] = alpha;
  pool.family[i] = family < FAMILY_COUNT ? family : 0;
  pool.pick[i] = Math.floor(srand(pool) * 256);
  pool.layer[i] = layer;
  const v = variant > 0 && variant < VARIANT_COUNT ? variant : 0;
  pool.tint[i] = charIndex(charId) * VARIANT_COUNT + v;
}

/** Advance by `steps` sim frames; zero steps leaves the pool untouched. */
export function stepSpritePool(pool: SpritePool, steps: number): void {
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const l = pool.life[i];
      if (l <= 0) continue;
      const d = pool.drag[i];
      const vx = pool.vx[i] * d;
      const vy = pool.vy[i] * d + pool.gravity[i];
      pool.vx[i] = vx;
      pool.vy[i] = vy;
      pool.x[i] += vx;
      pool.y[i] += vy;
      pool.rot[i] += pool.vrot[i];
      pool.life[i] = l - 1;
    }
  }
}

/** Rotations smaller than this draw unrotated (no save/restore). */
const ROT_EPS = 0.08;

/**
 * Draw one layer in world space. Crops come from the owner's fx sheet in its colour variant; the
 * visual is looked up once per run of same-tint particles.
 */
export function drawSpritePool(ctx: CanvasRenderingContext2D, pool: SpritePool, layer: number): void {
  const prevAlpha = ctx.globalAlpha;
  const prevOp = ctx.globalCompositeOperation;
  let additive = 0;
  let tintOf = -1;
  let visual: CharVisual | null = null;
  for (let i = 0; i < POOL_SIZE; i++) {
    const life = pool.life[i];
    if (life <= 0 || pool.layer[i] !== layer) continue;
    const tint = pool.tint[i];
    if (tint !== tintOf) {
      tintOf = tint;
      const ci = Math.floor(tint / VARIANT_COUNT);
      visual = getCharVisual(CHARS[ci] === undefined ? 'aeval' : CHARS[ci], tint % VARIANT_COUNT);
    }
    const fam = pool.family[i];
    const t = life / pool.maxLife[i];
    const share = FADE_SHARE[fam];
    const fade = t >= share ? 1 : t / share;
    const a = pool.alpha[i] * fade;
    if (a <= 0.02) continue;
    ctx.globalAlpha = prevAlpha * (a > 1 ? 1 : a);
    if (ADDITIVE[fam] !== additive) {
      additive = ADDITIVE[fam];
      ctx.globalCompositeOperation = additive === 1 ? 'lighter' : prevOp;
    }
    let names = visual === null ? null : visual.pieces[fam];
    // The dissolve smoke falls back to the plain smoke crops on a sheet without pSmoke4..5.
    if (fam === PIECE_DSMOKE && visual !== null && (names === null || names === undefined || names.length === 0)) names = visual.pieces[PIECE_SMOKE];
    const canvas =
      visual === null || names === null || names === undefined || names.length === 0
        ? null
        : getFrame(visual.fxSheetId, names[pool.pick[i] % names.length], false, false);
    const x = pool.x[i];
    const y = pool.y[i];
    const sc = pool.scale[i];
    if (canvas === null) {
      const colors = COLOR_BY_TINT[tint];
      ctx.fillStyle = colors === undefined ? FALLBACK_COLOR[fam] : colors[fam];
      const w = Math.max(1, Math.round(FALLBACK_W[fam] * sc));
      const h = Math.max(1, Math.round(FALLBACK_H[fam] * sc));
      ctx.fillRect(Math.round(x - w / 2), Math.round(y - h / 2), w, h);
      continue;
    }
    const w = Math.max(1, Math.round(canvas.width * sc));
    const h = Math.max(1, Math.round(canvas.height * sc));
    let rot = pool.rot[i] % (Math.PI * 2);
    if (rot > Math.PI) rot -= Math.PI * 2;
    if (rot < -Math.PI) rot += Math.PI * 2;
    if (rot > -ROT_EPS && rot < ROT_EPS) {
      ctx.drawImage(canvas, Math.round(x - w / 2), Math.round(y - h / 2), w, h);
    } else {
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));
      ctx.rotate(rot);
      ctx.drawImage(canvas, -Math.round(w / 2), -Math.round(h / 2), w, h);
      ctx.restore();
    }
  }
  ctx.globalAlpha = prevAlpha;
  if (additive === 1) ctx.globalCompositeOperation = prevOp;
}
