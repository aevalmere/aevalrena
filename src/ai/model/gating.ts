/**
 * Exploit gating and safe exploitation (02 sections 6.3 and 6.4).
 *
 * A habit is acted on only when the Wilson lower bound of its decayed frequency clears the
 * break-even probability of its counter; how much of the reply model the habit may take is the
 * restricted-response weight; the gift budget measures how far below the safe value an
 * exploitative plan may go. Also holds the deterministic ln and exp the model files use, since
 * decision code may not call Math.log or Math.exp (plan section 3).
 */
import type { BreakEvenFn, CreateGiftBudgetFn, GiftBudget, RestrictedWeightFn, WilsonLBFn } from '../contracts';

/** One-sided 90%, the god tier's z (02 section 6.3). */
export const Z_GOD = 1.282;
/** Guessing-regime cap on the habit's share of the reply model (02 section 6.4). */
export const P_MAX = 0.75;
/** LB at which the restricted weight starts to rise from 0. */
const RW_FLOOR = 0.4;

/**
 * Wilson score lower bound for k successes in n (decayed, so both may be fractional) trials.
 * 0 when n is not positive.
 */
export const wilsonLB: WilsonLBFn = (k: number, n: number, z: number): number => {
  if (!(n > 0)) return 0;
  let p = k / n;
  if (p < 0) p = 0; else if (p > 1) p = 1;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  const lb = (centre - spread) / (1 + z2 / n);
  return lb < 0 ? 0 : lb;
};

/**
 * p* = (V_safe + m - L) / (G - L): the habit probability at which the counter-plan's expected
 * value equals the safe plan's. 0 when the counter is at least as good as the safe plan even if
 * the habit never occurs; Infinity when no probability makes it worth it (G <= L and L below
 * the safe value, or p* above 1 is returned as is and no LB reaches it).
 */
export const breakEven: BreakEvenFn = (G: number, L: number, vSafe: number, margin: number): number => {
  const need = vSafe + margin - L;
  if (need <= 0) return 0;
  const gain = G - L;
  if (!(gain > 0)) return Infinity;
  return need / gain;
};

/** Restricted-response weight: p = pMax * clamp((LB - 0.4) / 0.6, 0, 1). */
export const restrictedWeight: RestrictedWeightFn = (lb: number, pMax: number): number => {
  let t = (lb - RW_FLOOR) / (1 - RW_FLOOR);
  if (!(t > 0)) t = 0; else if (t > 1) t = 1;
  return pMax * t;
};

/**
 * The full gate of 02 section 6.3: at least `nMin` decayed observations and LB >= p*.
 * `z` and `nMin` come from `LevelVector.learning`.
 */
export function exploitAllowed(k: number, n: number, z: number, nMin: number, pStar: number): boolean {
  if (!(n >= nMin)) return false;
  return wilsonLB(k, n, z) >= pStar;
}

/**
 * Gift budget (02 section 6.4, gift regime). `add(vBestOpp, vChosen)` adds the expected-value
 * difference `vBestOpp - vChosen`: a gift is positive. Spending is the same call with the
 * exploitative plan's worst-case value and the safe value, `add(vWorstExploit, vSafe)`, which is
 * negative. The budget never goes below 0. Only expected values go in, never realized damage.
 */
class Gifts implements GiftBudget {
  private k = 0;
  add(vBestOpp: number, vChosen: number): void {
    const d = vBestOpp - vChosen;
    if (!Number.isFinite(d)) return;
    const next = this.k + d;
    this.k = next > 0 ? next : 0;
  }
  allowance(): number { return this.k; }
  reset(): void { this.k = 0; }
}

export const createGiftBudget: CreateGiftBudgetFn = (): GiftBudget => new Gifts();

// ---------------------------------------------------------------------------------------------
// Deterministic ln and exp: plain IEEE arithmetic, identical on every engine.
// ---------------------------------------------------------------------------------------------

const LN2 = 0.6931471805599453;

/** ln of m in [1, 2) by the atanh series 2 (t + t^3/3 + ...), t = (m - 1) / (m + 1) < 1/3. */
function lnMantissa(m: number): number {
  const t = (m - 1) / (m + 1);
  const t2 = t * t;
  let term = t, sum = 0;
  for (let i = 1; i <= 29; i += 2) { sum += term / i; term *= t2; }
  return 2 * sum;
}

/** Natural log for x > 0 (x <= 0 returns -Infinity). */
export function lnDet(x: number): number {
  if (!(x > 0)) return -Infinity;
  if (x === Infinity) return Infinity;
  let e = 0;
  while (x >= 2) { x *= 0.5; e++; }
  while (x < 1) { x *= 2; e--; }
  return e * LN2 + lnMantissa(x);
}

/** e^x; below -700 returns 0, above 700 returns Infinity. */
export function expDet(x: number): number {
  if (x !== x) return NaN;
  if (x < -700) return 0;
  if (x > 700) return Infinity;
  let n = Math.floor(x / LN2);
  const r = x - n * LN2;             // r in [0, ln 2)
  let term = 1, sum = 1;
  for (let i = 1; i <= 20; i++) { term *= r / i; sum += term; }
  while (n > 0) { sum *= 2; n--; }
  while (n < 0) { sum *= 0.5; n++; }
  return sum;
}
