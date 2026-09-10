/** Nonzero fallback for a seed of 0; xorshift32 cannot advance from a 0 state. */
const ZERO_SEED_REPLACEMENT = 0x9e3779b9;

export function createRng(seed: number): { s: number } {
  const s = seed === 0 ? ZERO_SEED_REPLACEMENT : seed >>> 0;
  return { s: s === 0 ? ZERO_SEED_REPLACEMENT : s };
}

/** Advances the xorshift32 state and returns the next unsigned 32-bit integer. */
export function nextU32(r: { s: number }): number {
  let x = r.s >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  r.s = x;
  return x;
}

/** Next float in [0, 1). */
export function nextFloat(r: { s: number }): number {
  return nextU32(r) / 4294967296;
}

/** Next integer in [0, n). */
export function nextInt(r: { s: number }, n: number): number {
  return Math.floor(nextFloat(r) * n);
}
