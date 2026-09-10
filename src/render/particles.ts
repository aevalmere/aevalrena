import type { Facing } from '../core/types';

/**
 * Fixed particle pool, structs of arrays. Nothing is allocated after creation.
 * Particles live in world space and draw as 1 to 3 px rects, so hundreds of
 * them cost only fillRect calls and never touch ctx.arc.
 */

const POOL_SIZE = 512;

const P_SPARK_A = 0;
const P_SPARK_B = 1;
const P_KO_A = 2;
const P_KO_B = 3;
const P_DUST = 4;
const P_DASH = 5;
const P_DROP_A = 6;
const P_DROP_B = 7;
const TYPE_COUNT = 8;

const TYPE_COLOR: readonly string[] = [
  '#b8e3ff', '#f0ead6', '#c9d1e0', '#7fb2ff', '#9aa5b8', '#6e7a94', '#7fb2ff', '#b8e3ff',
];
const TYPE_SIZE = new Uint8Array([2, 1, 3, 2, 2, 1, 2, 1]);
const TYPE_GRAVITY = new Float32Array([0.05, 0.05, 0.02, 0.02, -0.012, 0, 0.11, 0.11]);
const TYPE_DRAG = new Float32Array([0.94, 0.94, 0.97, 0.97, 0.9, 0.88, 0.99, 0.99]);

export interface ParticlePool {
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  life: Float32Array;
  kind: Uint8Array;
  cursor: number;
  seed: number;
}

export function createParticles(): ParticlePool {
  return {
    x: new Float32Array(POOL_SIZE),
    y: new Float32Array(POOL_SIZE),
    vx: new Float32Array(POOL_SIZE),
    vy: new Float32Array(POOL_SIZE),
    life: new Float32Array(POOL_SIZE),
    kind: new Uint8Array(POOL_SIZE),
    cursor: 0,
    seed: 0x9e3779b9,
  };
}

export function clearParticles(pool: ParticlePool): void {
  pool.life.fill(0);
  pool.cursor = 0;
}

/** Local xorshift so particle scatter never touches the sim rng. */
function rand(pool: ParticlePool): number {
  let s = pool.seed | 0;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  pool.seed = s | 0;
  return ((s >>> 0) % 65536) / 65536;
}

function spread(pool: ParticlePool, amount: number): number {
  return (rand(pool) * 2 - 1) * amount;
}

function emit(
  pool: ParticlePool,
  kind: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number
): void {
  const i = pool.cursor;
  pool.cursor = (i + 1) % POOL_SIZE;
  pool.x[i] = x;
  pool.y[i] = y;
  pool.vx[i] = vx;
  pool.vy[i] = vy;
  pool.life[i] = life;
  pool.kind[i] = kind;
}

export function spawnHitSparks(pool: ParticlePool, x: number, y: number, damage: number): void {
  const count = 4 + Math.min(10, Math.floor(damage));
  for (let i = 0; i < count; i++) {
    const speed = 0.8 + rand(pool) * 2.2;
    const a = rand(pool) * Math.PI * 2;
    emit(
      pool,
      i % 3 === 0 ? P_SPARK_B : P_SPARK_A,
      x,
      y,
      Math.cos(a) * speed,
      Math.sin(a) * speed,
      10 + rand(pool) * 10
    );
  }
}

export function spawnKoBurst(pool: ParticlePool, x: number, y: number): void {
  for (let i = 0; i < 40; i++) {
    const speed = 1.5 + rand(pool) * 3.5;
    const a = (i / 40) * Math.PI * 2 + spread(pool, 0.1);
    emit(
      pool,
      i % 2 === 0 ? P_KO_A : P_KO_B,
      x,
      y,
      Math.cos(a) * speed,
      Math.sin(a) * speed,
      24 + rand(pool) * 16
    );
  }
}

export function spawnLandDust(pool: ParticlePool, x: number, y: number, hard: boolean): void {
  const count = hard ? 12 : 6;
  for (let i = 0; i < count; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    emit(
      pool,
      P_DUST,
      x + spread(pool, 6),
      y - rand(pool) * 2,
      dir * (0.5 + rand(pool) * (hard ? 1.6 : 0.8)),
      -rand(pool) * 0.5,
      12 + rand(pool) * 10
    );
  }
}

export function spawnDashDust(pool: ParticlePool, x: number, y: number, facing: Facing): void {
  for (let i = 0; i < 5; i++) {
    emit(
      pool,
      P_DASH,
      x + spread(pool, 4),
      y - rand(pool) * 3,
      -facing * (0.4 + rand(pool) * 1.2),
      -rand(pool) * 0.4,
      10 + rand(pool) * 8
    );
  }
}

export function spawnDroplets(pool: ParticlePool, x: number, y: number, count: number): void {
  for (let i = 0; i < count; i++) {
    emit(
      pool,
      i % 2 === 0 ? P_DROP_A : P_DROP_B,
      x + spread(pool, 5),
      y + spread(pool, 5),
      spread(pool, 1.4),
      -rand(pool) * 1.6,
      16 + rand(pool) * 14
    );
  }
}

export function stepParticles(pool: ParticlePool): void {
  const { x, y, vx, vy, life, kind } = pool;
  for (let i = 0; i < POOL_SIZE; i++) {
    const l = life[i];
    if (l <= 0) continue;
    const k = kind[i];
    let ivx = vx[i];
    let ivy = vy[i];
    ivx *= TYPE_DRAG[k];
    ivy = ivy * TYPE_DRAG[k] + TYPE_GRAVITY[k];
    vx[i] = ivx;
    vy[i] = ivy;
    x[i] += ivx;
    y[i] += ivy;
    life[i] = l - 1;
  }
}

/** Draw in world space, grouped by type so fillStyle changes at most once per type. */
export function drawParticles(ctx: CanvasRenderingContext2D, pool: ParticlePool): void {
  const { x, y, life, kind } = pool;
  for (let k = 0; k < TYPE_COUNT; k++) {
    let styled = false;
    const size = TYPE_SIZE[k];
    for (let i = 0; i < POOL_SIZE; i++) {
      if (life[i] <= 0 || kind[i] !== k) continue;
      if (!styled) {
        ctx.fillStyle = TYPE_COLOR[k];
        styled = true;
      }
      ctx.fillRect(Math.round(x[i]), Math.round(y[i]), size, size);
    }
  }
}
