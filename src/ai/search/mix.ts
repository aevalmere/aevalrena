/**
 * Fictitious play over a payoff matrix (02 sections 6.8, 7.4 and 11.3; research 32 "simultaneous
 * choice"). Rollouts already form M[plan][reply]; argmax against predicted replies is exploitable,
 * so near-equal candidates are mixed by the equilibrium the row player converges to.
 *
 * M is row-major, rows x cols, the payoff to the row player (who maximizes); the column player
 * minimizes it. Each iteration both sides best-respond to the other's empirical mix. Ties between
 * best responses are broken by a seeded rotation (counter hash, no sequence), so the output is a
 * pure function of (M, rows, cols, iters, seed).
 *
 * `out[0..rows)` receives the row player's empirical mix (sums to 1). When `out` has room for
 * rows + cols entries, `out[rows..rows+cols)` receives the column player's mix too.
 * Allocation-free after the scratch has grown to the largest matrix seen.
 */
import type { FictitiousPlayFn } from '../contracts';
import { STREAM, u01 } from '../rng';

let rowPay: Float64Array = new Float64Array(16);   // sum over column plays of M[r][c]
let colPay: Float64Array = new Float64Array(16);   // sum over row plays of M[r][c]
let rowCnt: Float64Array = new Float64Array(16);
let colCnt: Float64Array = new Float64Array(16);

function grow(n: number, a: Float64Array): Float64Array {
  if (a.length >= n) return a;
  let m = a.length;
  while (m < n) m *= 2;
  return new Float64Array(m);
}

const TIE_EPS = 1e-9;

/** Index of the max of a[0..n) (min when `minimize`), ties broken from a seeded start index. */
function bestIndex(a: Float64Array, n: number, minimize: boolean, start: number): number {
  let best = -1, bv = 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const v = minimize ? -a[i] : a[i];
    if (best < 0 || v > bv + TIE_EPS) { best = i; bv = v; }
  }
  return best;
}

export const fictitiousPlay: FictitiousPlayFn = (M: Float64Array, rows: number, cols: number, iters: number,
  seed: number, out: Float64Array): void => {
  if (rows <= 0) return;
  if (cols <= 0) {
    for (let r = 0; r < rows; r++) out[r] = 1 / rows;
    return;
  }
  rowPay = grow(rows, rowPay); rowCnt = grow(rows, rowCnt);
  colPay = grow(cols, colPay); colCnt = grow(cols, colCnt);
  rowPay.fill(0, 0, rows); rowCnt.fill(0, 0, rows);
  colPay.fill(0, 0, cols); colCnt.fill(0, 0, cols);
  const n = iters < 1 ? 1 : Math.floor(iters);

  // First row: best against the uniform column mix (row sums), seeded tie-break.
  for (let r = 0; r < rows; r++) {
    let s = 0;
    for (let c = 0; c < cols; c++) s += M[r * cols + c];
    rowPay[r] = s;
  }
  let r0 = bestIndex(rowPay, rows, false, Math.floor(u01(seed, 0, 0, STREAM.mix, 0) * rows));
  rowPay.fill(0, 0, rows);

  for (let it = 0; it < n; it++) {
    // Row r0 is played: columns accumulate its payoffs, the column player best-responds.
    rowCnt[r0] += 1;
    for (let c = 0; c < cols; c++) colPay[c] += M[r0 * cols + c];
    const c0 = bestIndex(colPay, cols, true, Math.floor(u01(seed, 0, it, STREAM.mix, 1) * cols));
    colCnt[c0] += 1;
    for (let r = 0; r < rows; r++) rowPay[r] += M[r * cols + c0];
    r0 = bestIndex(rowPay, rows, false, Math.floor(u01(seed, 0, it, STREAM.mix, 2) * rows));
  }

  let tr = 0;
  for (let r = 0; r < rows; r++) tr += rowCnt[r];
  for (let r = 0; r < rows; r++) out[r] = rowCnt[r] / tr;
  if (out.length >= rows + cols) {
    let tc = 0;
    for (let c = 0; c < cols; c++) tc += colCnt[c];
    for (let c = 0; c < cols; c++) out[rows + c] = colCnt[c] / tc;
  }
};

/** Value of the row mix `p` against the column player's best response: min over c of sum_r p_r M[r][c]. */
export function mixValue(M: Float64Array, rows: number, cols: number, p: Float64Array): number {
  let worst = Infinity;
  for (let c = 0; c < cols; c++) {
    let s = 0;
    for (let r = 0; r < rows; r++) s += p[r] * M[r * cols + c];
    if (s < worst) worst = s;
  }
  return worst;
}
