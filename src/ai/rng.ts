/**
 * Counter-based randomness for the CPU brain (02 section 14.6).
 *
 * Every draw is a pure function of (seed, slot, frame, stream, k): no state, no sequence, so a
 * skipped frame, a stall or a rollback re-simulation never shifts later draws. Integer hashing
 * only; no Math.random and no transcendental Math functions. Derived distributions use plain
 * arithmetic, so results are identical on every JS engine.
 */

/** Stream ids, one per kind of decision so draws never collide across uses. */
export const STREAM = { reaction: 1, jitter: 2, lapse: 3, softmax: 4, error: 5, mix: 6, opening: 7, bait: 8, wake: 9,
  mash: 10, route: 11, target: 12 } as const;

/** 32-bit hash of the key; the reference from 02 section 14.6 before the division. */
function hash32(seed: number, slot: number, frame: number, stream: number, k: number): number {
  let h = (seed ^ Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(frame, 0x85ebca6b)
         ^ Math.imul(stream + 1, 0xc2b2ae35) ^ Math.imul(k + 1, 0x27d4eb2f)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in [0, 1). Bit-identical to the reference in 02 section 14.6. */
export function u01(seed: number, slot: number, frame: number, stream: number, k = 0): number {
  return hash32(seed, slot, frame, stream, k) / 4294967296;
}

/** Integer in [0, n) for integer n >= 1; returns 0 when n < 1. */
export function randInt(n: number, seed: number, slot: number, frame: number, stream: number, k = 0): number {
  if (!(n >= 1)) return 0;
  return Math.floor(u01(seed, slot, frame, stream, k) * Math.floor(n));
}

/** True with probability p (p <= 0 never, p >= 1 always). */
export function bernoulli(p: number, seed: number, slot: number, frame: number, stream: number, k = 0): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return u01(seed, slot, frame, stream, k) < p;
}

/**
 * Index drawn with probability proportional to weights[i] over the first `n` entries.
 * Negative or NaN weights count as 0. Returns -1 when the total weight is 0.
 */
export function weightedPick(weights: ArrayLike<number>, n: number,
  seed: number, slot: number, frame: number, stream: number, k = 0): number {
  let total = 0;
  for (let i = 0; i < n; i++) { const w = weights[i]; if (w > 0) total += w; }
  if (!(total > 0)) return -1;
  let x = u01(seed, slot, frame, stream, k) * total;
  let last = -1;
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    if (!(w > 0)) continue;
    last = i;
    if (x < w) return i;
    x -= w;
  }
  return last;   // rounding left x at or above the last positive weight
}

const LN2 = 0.6931471805599453;

/** Natural log of x in [1, 2) by the atanh series: ln x = 2 (t + t^3/3 + t^5/5 + ...), t = (x-1)/(x+1). */
function lnMantissa(x: number): number {
  const t = (x - 1) / (x + 1);   // t in [0, 1/3)
  const t2 = t * t;
  let term = t, sum = 0;
  for (let i = 1; i <= 29; i += 2) { sum += term / i; term *= t2; }
  return 2 * sum;
}

/** -ln(u) for u = (h + 1) / 2^32 with h the 32-bit hash: an Exp(1) draw, finite for every h. */
function expFromHash(h: number): number {
  // u = (h + 1) / 2^32 in (0, 1]; -ln u = 32 ln2 - ln(h + 1)
  const v = h + 1;                              // 1 .. 2^32
  if (v === 4294967296) return 0;
  const e = 31 - Math.clz32(v);                 // v = m * 2^e, m in [1, 2)
  const m = v / (e === 31 ? 2147483648 : (1 << e));
  return (32 - e) * LN2 - lnMantissa(m);
}

/** Sub-keys used per skewNormal draw: 1 exponential + 12 uniforms (Irwin-Hall). */
const SKEW_KEYS = 16;

/**
 * Unit-variance, right-skewed, zero-mean draw: 0.7 * (Exp(1) - 1) + 0.7 * N(0, 1) (03 section 2.1).
 * N(0, 1) is Irwin-Hall (sum of 12 uniforms minus 6), so tails stop at 6; the variance is 0.98.
 * Draw `k` uses sub-keys k * 16 .. k * 16 + 12 of the stream.
 */
export function skewNormal(seed: number, slot: number, frame: number, stream: number, k = 0): number {
  const base = k * SKEW_KEYS;
  const ex = expFromHash(hash32(seed, slot, frame, stream, base));
  let sum = 0;
  for (let i = 1; i <= 12; i++) sum += u01(seed, slot, frame, stream, base + i);
  return 0.7 * (ex - 1) + 0.7 * (sum - 6);
}

/** Fixed inputs for rngSelfCheck: [seed, slot, frame, stream, k]. */
const CHECK_KEYS: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 0, 0],
  [1, 0, 0, 1, 0],
  [12345, 1, 600, 4, 0],
  [12345, 1, 600, 4, 1],
  [0x7fffffff, 3, 99999, 12, 7],
  [42, 2, 1, 6, 3],
];
/** Expected hash32 values for CHECK_KEYS (computed from the reference and frozen). */
const CHECK_HASH: readonly number[] = [2366707307, 1864889068, 275811199, 3031739896, 1740247299, 1333264708];
/** Expected skewNormal values for CHECK_KEYS, rounded to 1e-9. */
const CHECK_SKEW: readonly number[] = [-1.111185911, -0.536255581, 1.41518542, 0.229769157, 1.042633542, 1.985762289];

/**
 * Recomputes known values for known inputs. `ok` is false when any draw differs, which means the
 * hash or a derived distribution changed and golden seeds are no longer valid.
 */
export function rngSelfCheck(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (let i = 0; i < CHECK_KEYS.length; i++) {
    const [seed, slot, frame, stream, k] = CHECK_KEYS[i];
    const h = hash32(seed, slot, frame, stream, k);
    if (h !== CHECK_HASH[i]) failures.push(`u01 key ${i}: got ${h}, want ${CHECK_HASH[i]}`);
    const z = Math.round(skewNormal(seed, slot, frame, stream, k) * 1e9) / 1e9;
    if (z !== CHECK_SKEW[i]) failures.push(`skewNormal key ${i}: got ${z}, want ${CHECK_SKEW[i]}`);
  }
  return { ok: failures.length === 0, failures };
}
