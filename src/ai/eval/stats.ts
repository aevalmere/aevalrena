/**
 * Harness statistics (06 section 1, research report 32 section 4). Offline code: transcendental Math
 * functions are allowed here, since nothing in this file runs inside a brain.
 */
import type {
  BradleyTerryFn, CohensDFn, EloFromPFn, MannWhitneyFn, PFromEloFn, SprtFn, SprtState, WilsonFn, WilsonResult,
} from '../contracts';

/** Two-sided 95% normal quantile, the z every gate in 06 uses. */
export const Z95 = 1.96;
/** One-sided quantile for power 0.8. */
export const Z_POWER80 = 0.8416212335729143;

/** Wilson score interval for k successes in n trials. n = 0 gives p 0 and the interval [0, 1]. */
export const wilson: WilsonFn = (k: number, n: number, z = Z95): WilsonResult => {
  if (!(n > 0)) return { k, n, p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
};

/** Smallest n whose Wilson half-width at proportion p is at most h. 0.05 at 0.5 is 381, 0.10 is 93. */
export function wilsonNForHalfWidth(h: number, p = 0.5, z = Z95): number {
  const z2 = z * z;
  for (let n = 1; n < 1e7; n++) {
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    if (half <= h) return n;
  }
  return Infinity;
}

/**
 * Matches needed in one sample to tell p1 from p0 (normal approximation, two-sided alpha 0.05,
 * power 0.8). 06 section 1: 0.6 vs 0.5 is 194, 0.65 vs 0.5 is 85, 0.55 vs 0.5 is 783.
 */
export function oneSampleN(p0: number, p1: number, zAlpha = Z95, zBeta = Z_POWER80): number {
  const num = zAlpha * Math.sqrt(p0 * (1 - p0)) + zBeta * Math.sqrt(p1 * (1 - p1));
  const r = num / (p1 - p0);
  return Math.ceil(r * r);
}

/** The SPRT's per-result steps and stopping bounds. (0.5, 0.65, 0.05, 0.05): +0.262, -0.357, +-2.944. */
export function sprtSteps(p0: number, p1: number, alpha: number, beta: number): { win: number; loss: number; upper: number; lower: number } {
  return {
    win: Math.log(p1 / p0), loss: Math.log((1 - p1) / (1 - p0)),
    upper: Math.log((1 - beta) / alpha), lower: Math.log(beta / (1 - alpha)),
  };
}

/**
 * Wald SPRT on a Bernoulli score. A win adds ln(p1/p0), a loss ln((1-p1)/(1-p0)), a half point
 * (timeout or draw) half of each. Stops at ln((1-beta)/alpha) for H1 and ln(beta/(1-alpha)) for H0;
 * once decided, further results are ignored.
 */
export const sprt: SprtFn = (p0: number, p1: number, alpha: number, beta: number) => {
  const k = sprtSteps(p0, p1, alpha, beta);
  const st: SprtState = { llr: 0, n: 0, decision: 'continue' };
  return {
    add(score: 0 | 0.5 | 1): SprtState {
      if (st.decision === 'continue') {
        st.llr += score * k.win + (1 - score) * k.loss;
        st.n++;
        if (st.llr >= k.upper) st.decision = 'H1';
        else if (st.llr <= k.lower) st.decision = 'H0';
      }
      return { llr: st.llr, n: st.n, decision: st.decision };
    },
  };
};

/** Expected score of the stronger side for an Elo gap d. 100 gives 0.640, 200 gives 0.760, 382 gives 0.900. */
export const pFromElo: PFromEloFn = (d: number): number => 1 / (1 + Math.pow(10, -d / 400));

/** Elo gap for an expected score p, clamped away from 0 and 1. */
export const eloFromP: EloFromPFn = (p: number): number => {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return -400 * Math.log10(1 / q - 1);
};

/** Standard error in Elo points of a gap measured as p over n games (delta method). 0.64 at n = 100 is about 36. */
export function eloSe(p: number, n: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const seP = Math.sqrt(q * (1 - q) / n);
  return (400 / Math.LN10) * seP / (q * (1 - q));
}

/** Weight of the virtual draw every player plays against a mean-strength anchor, so perfect records stay finite. */
const BT_PRIOR = 1e-3;

/**
 * Bradley-Terry by maximum likelihood (the MM iteration of Hunter 2004) over fractional scores,
 * reported on the Elo scale centred on the geometric mean strength. `se` is the diagonal Fisher
 * approximation in Elo points.
 */
export const bradleyTerry: BradleyTerryFn = (games) => {
  const names: string[] = [];
  const index = new Map<string, number>();
  const idOf = (s: string): number => {
    let i = index.get(s);
    if (i === undefined) { i = names.length; names.push(s); index.set(s, i); }
    return i;
  };
  for (const g of games) { idOf(g.a); idOf(g.b); }
  const m = names.length;
  const n = new Float64Array(m * m);
  const w = new Float64Array(m);
  for (const g of games) {
    const a = idOf(g.a); const b = idOf(g.b);
    if (a === b) continue;
    n[a * m + b] += 1; n[b * m + a] += 1;
    w[a] += g.scoreA; w[b] += 1 - g.scoreA;
  }
  const gamma = new Float64Array(m).fill(1);
  for (let it = 0; it < 20000; it++) {
    let delta = 0;
    for (let i = 0; i < m; i++) {
      let den = (2 * BT_PRIOR) / (gamma[i] + 1);
      for (let j = 0; j < m; j++) {
        const nij = n[i * m + j];
        if (nij > 0) den += nij / (gamma[i] + gamma[j]);
      }
      const next = (w[i] + BT_PRIOR) / den;
      delta = Math.max(delta, Math.abs(Math.log(next / gamma[i])));
      gamma[i] = next;
    }
    let lg = 0;
    for (let i = 0; i < m; i++) lg += Math.log(gamma[i]);
    const s = Math.exp(lg / Math.max(1, m));
    for (let i = 0; i < m; i++) gamma[i] /= s;
    if (delta < 1e-12) break;
  }
  const out = new Map<string, { elo: number; se: number }>();
  const k = 400 / Math.LN10;
  for (let i = 0; i < m; i++) {
    let info = 0;
    for (let j = 0; j < m; j++) {
      const nij = n[i * m + j];
      if (nij <= 0) continue;
      const p = gamma[i] / (gamma[i] + gamma[j]);
      info += nij * p * (1 - p);
    }
    out.set(names[i], { elo: k * Math.log(gamma[i]), se: info > 0 ? k / Math.sqrt(info) : Infinity });
  }
  return out;
};

export function mean(a: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length > 0 ? s / a.length : 0;
}

function sampleVariance(a: readonly number[], m: number): number {
  if (a.length < 2) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
  return s / (a.length - 1);
}

/** Median of a copy of `a`; NaN when empty. */
export function median(a: readonly number[]): number {
  return quantile(a, 0.5);
}

/** Linear-interpolated quantile of a copy of `a`; NaN when empty. */
export function quantile(a: readonly number[], q: number): number {
  if (a.length === 0) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Cohen's d with the pooled sample SD; positive when `a` is larger. */
export const cohensD: CohensDFn = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  const na = a.length; const nb = b.length;
  if (na + nb < 3) return 0;
  const pooled = Math.sqrt(((na - 1) * sampleVariance(a, ma) + (nb - 1) * sampleVariance(b, mb)) / (na + nb - 2));
  if (!(pooled > 0)) return ma === mb ? 0 : (ma > mb ? Infinity : -Infinity);
  return (ma - mb) / pooled;
};

/** Standard normal CDF (Zelen and Severo 26.2.17, absolute error under 7.5e-8). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Mann-Whitney U for sample `a` (ties get average ranks) with a two-sided p from the normal
 * approximation, tie-corrected, with continuity correction.
 */
export const mannWhitney: MannWhitneyFn = (a, b) => {
  const na = a.length; const nb = b.length;
  if (na === 0 || nb === 0) return { u: 0, p: 1 };
  const all: { v: number; g: number }[] = [];
  for (let i = 0; i < na; i++) all.push({ v: a[i], g: 0 });
  for (let i = 0; i < nb; i++) all.push({ v: b[i], g: 1 });
  all.sort((x, y) => x.v - y.v);
  const N = na + nb;
  let rankA = 0;
  let tieSum = 0;
  for (let i = 0; i < N;) {
    let j = i;
    while (j + 1 < N && all[j + 1].v === all[i].v) j++;
    const r = (i + j + 2) / 2;
    const t = j - i + 1;
    if (t > 1) tieSum += t * t * t - t;
    for (let q = i; q <= j; q++) if (all[q].g === 0) rankA += r;
    i = j + 1;
  }
  const u = rankA - na * (na + 1) / 2;
  const mu = na * nb / 2;
  const sigma2 = (na * nb / 12) * ((N + 1) - tieSum / (N * (N - 1)));
  if (!(sigma2 > 0)) return { u, p: 1 };
  const z = Math.max(0, Math.abs(u - mu) - 0.5) / Math.sqrt(sigma2);
  return { u, p: Math.min(1, 2 * (1 - normalCdf(z))) };
};
