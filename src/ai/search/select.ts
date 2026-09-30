/**
 * Aggregation and selection (02 sections 6.4, 6.8, 7.4, 7.5, 7.6).
 *
 * `cvar` is the lower-tail mean at level alpha over weighted outcomes: sort ascending, take weight
 * until it sums to alpha (partial weight on the last), average. A reply of weight w < alpha
 * contributes w / alpha of the tail, so no weight floor or per-reply veto is needed.
 *
 * `selectPlan` ranks in tiers, then by value (dual utility):
 *   1. reflexes are the brain's and never reach here;
 *   2. a Final Smash that catches in every sample is taken at once;
 *   3. certain-loss candidates (stock lost under weight >= 0.5) are removed while any other exists;
 *   4. a spike or kill route that KOs in every sample and leaves us on the stage or ledge is taken;
 *   5. otherwise the best effective value: V(c) from the rollouts plus the stall pressure term,
 *      with the gift budget allowing an exploitative plan (02 section 6.4), plan hold against
 *      jitter, and the decision temperature `LevelVector.tau` (a seeded softmax; tau = 0 is
 *      argmax). The god (tau 0) mixes near-ties (within 2%) by fictitious play over the rollout
 *      payoff matrix instead of always giving the same answer (02 section 6.8).
 *
 * Per-slot memory (running plan, hold start, gift budget) lives here, resets on a backward frame
 * jump, and is cleared by `resetSelect`.
 */
import type { CvarFn, DecisionView, GiftBudget, PlanInstance, Scored, SearchResult, SelectPlanFn } from '../contracts';
import { PF_ATTACK, PF_KILL, PF_SPIKE } from '../contracts';
import { createGiftBudget, expDet } from '../model/gating';
import { STREAM, u01 } from '../rng';
import { fictitiousPlay } from './mix';
import { SURE_FS, SURE_KILL, sureOf } from './outcome';

// ---------------------------------------------------------------------------------------------
// CVaR
// ---------------------------------------------------------------------------------------------

let order: Int32Array = new Int32Array(64);

export const cvar: CvarFn = (w: Float64Array, J: Float64Array, n: number, alpha: number): number => {
  if (n <= 0) return 0;
  if (order.length < n) order = new Int32Array(n * 2);
  let total = 0;
  for (let i = 0; i < n; i++) { const x = w[i]; if (x > 0) total += x; }
  if (!(total > 0)) {
    let mn = Infinity;
    for (let i = 0; i < n; i++) if (J[i] < mn) mn = J[i];
    return mn;
  }
  // Stable insertion sort of indices by J ascending (n is small).
  for (let i = 0; i < n; i++) {
    let j = i - 1;
    const v = J[i];
    while (j >= 0 && J[order[j]] > v) { order[j + 1] = order[j]; j--; }
    order[j + 1] = i;
  }
  if (!(alpha > 0)) {
    for (let k = 0; k < n; k++) if (w[order[k]] > 0) return J[order[k]];
    return J[order[0]];
  }
  const a = alpha >= 1 ? 1 : alpha;
  let acc = 0, sum = 0;
  for (let k = 0; k < n && acc < a; k++) {
    const i = order[k];
    const wi = w[i] > 0 ? w[i] / total : 0;
    if (wi === 0) continue;
    const take = wi < a - acc ? wi : a - acc;
    sum += take * J[i];
    acc += take;
  }
  return acc > 0 ? sum / acc : J[order[0]];
};

/** Weighted mean of J over w (the weights need not sum to 1). */
export function weightedMean(w: Float64Array, J: Float64Array, n: number): number {
  let s = 0, t = 0;
  for (let i = 0; i < n; i++) { const x = w[i] > 0 ? w[i] : 0; s += x * J[i]; t += x; }
  return t > 0 ? s / t : 0;
}

/** V(c) = lambda * CVaR + (1 - lambda) * mean (02 section 7.4). */
export function blendValue(cv: number, mean: number, lambda: number): number {
  return lambda * cv + (1 - lambda) * mean;
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

/** Points a unit of softmax temperature spans: at tau 0.6 a plan 40 points worse keeps e^-1.7 of the odds. */
export const VALUE_SCALE = 40;
/** Near-tie band: within 2% of the best, never narrower than 2% of TIE_FLOOR points. */
export const TIE_SHARE = 0.02;
export const TIE_FLOOR = 25;
/** Plan hold: keep the running plan while it is within this many points (plus 5%) of the best. */
export const HOLD_POINTS = 6;
export const HOLD_SHARE = 0.05;
/** Stall pressure: points per unit of Tempo.pressure for a committing plan. */
export const STALL_ATTACK = 8;
/** Fictitious play iterations for the god's near-tie mix. */
export const MIX_ITERS = 64;
const MAX_TIE = 8;

interface SelMem { running: string; chosenFrame: number; lastFrame: number; gifts: GiftBudget; used: boolean }
const mems: SelMem[] = [];

function memOf(slot: number, frame: number): SelMem {
  let m = mems[slot];
  if (m === undefined) {
    m = { running: '', chosenFrame: -1, lastFrame: -1, gifts: createGiftBudget(), used: false };
    mems[slot] = m;
  }
  if (frame < m.lastFrame) clear(m);
  m.lastFrame = frame;
  return m;
}

function clear(m: SelMem): void {
  m.running = ''; m.chosenFrame = -1; m.lastFrame = -1; m.gifts.reset(); m.used = false;
}

/** Clears per-slot selection memory (every slot when `slot` is omitted). */
export function resetSelect(slot?: number): void {
  if (slot === undefined) { for (const m of mems) if (m !== undefined) clear(m); return; }
  const m = mems[slot];
  if (m !== undefined) clear(m);
}

/** Name of the plan selectPlan last chose for `slot`, '' none (used for the continuity term). */
export function runningPlanName(slot: number): string {
  const m = mems[slot];
  return m === undefined ? '' : m.running;
}

/**
 * Gift regime (02 section 6.4): the brain calls this when it has scored the opponent's choice,
 * with the value of their best option and of the one they took (both from their side, expected
 * value, never realized damage). The difference is what they gave away.
 */
export function noteGift(slot: number, vBestOpp: number, vChosen: number): void {
  const m = mems[slot];
  memOf(slot, m === undefined ? -1 : m.lastFrame).gifts.add(vBestOpp, vChosen);
}

export function giftAllowance(slot: number): number {
  const m = mems[slot];
  return m === undefined ? 0 : m.gifts.allowance();
}

const eff = new Float64Array(256);
const alive = new Uint8Array(256);
const tieIdx = new Int32Array(MAX_TIE);
const mixM = new Float64Array(MAX_TIE * 64);
const mixOut = new Float64Array(MAX_TIE);

function clamp01(x: number): number { return x > 1 ? 1 : x > 0 ? x : 0; }

function finish(out: SearchResult, best: PlanInstance | null, value: number, scored: readonly Scored[], vetoed: number): void {
  out.best = best; out.value = value; out.scored = scored; out.vetoed = vetoed; out.secondPly = false;
}

export const selectPlan: SelectPlanFn = (v: DecisionView, scored: readonly Scored[], out: SearchResult): void => {
  const frame = v.p.frame;
  const slot = v.slot;
  const mem = memOf(slot, frame);
  const n = scored.length < eff.length ? scored.length : eff.length;
  if (n === 0) { finish(out, null, 0, scored, 0); return; }

  // Tier 2: a Final Smash sure in every sample.
  for (let i = 0; i < n; i++) {
    if (scored[i].plan.family === 'finalSmash' && (sureOf(scored[i]) & SURE_FS) !== 0) {
      commit(mem, scored[i].plan, frame);
      finish(out, scored[i].plan, scored[i].value, scored, 0);
      return;
    }
  }

  // Tier 3: certain-loss veto, only when an alternative exists.
  let anySafe = false;
  for (let i = 0; i < n; i++) if (!scored[i].certainLoss) { anySafe = true; break; }
  let vetoed = 0;
  for (let i = 0; i < n; i++) {
    const veto = anySafe && scored[i].certainLoss;
    alive[i] = veto ? 0 : 1;
    if (veto) vetoed++;
  }

  // Tier 4: a spike or kill route that KOs in every sample and brings us back.
  let sureKill = -1;
  for (let i = 0; i < n; i++) {
    if (alive[i] === 0) continue;
    const s = scored[i];
    if ((s.plan.flags & (PF_KILL | PF_SPIKE)) === 0 || (sureOf(s) & SURE_KILL) === 0) continue;
    if (sureKill < 0 || s.value > scored[sureKill].value) sureKill = i;
  }
  if (sureKill >= 0) {
    commit(mem, scored[sureKill].plan, frame);
    finish(out, scored[sureKill].plan, scored[sureKill].value, scored, vetoed);
    return;
  }

  // Tier 5: value plus the stall pressure term.
  const pressure = clamp01(v.tempo.pressure());
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (alive[i] === 0) { eff[i] = -Infinity; continue; }
    const s = scored[i];
    let e = s.value;
    if ((s.plan.flags & PF_ATTACK) !== 0) e += pressure * STALL_ATTACK;
    eff[i] = e;
    if (best < 0 || e > eff[best]) best = i;
  }

  // Gift regime: an exploitative plan whose worst case sits below the safe value by at most the
  // accumulated gifts may be ranked by its expected value instead.
  let exploit = false;
  if (v.level.giftBudget) {
    const allowance = mem.gifts.allowance();
    if (allowance > 0) {
      let vSafe = -Infinity;
      for (let i = 0; i < n; i++) if (alive[i] !== 0 && scored[i].cvar > vSafe) vSafe = scored[i].cvar;
      let xb = -1, xv = eff[best];
      for (let i = 0; i < n; i++) {
        if (alive[i] === 0) continue;
        const s = scored[i];
        if (s.cvar >= vSafe || s.cvar < vSafe - allowance) continue;
        const e = eff[i] - s.value + s.mean;
        if (e > xv) { xv = e; xb = i; }
      }
      if (xb >= 0) {
        mem.gifts.add(scored[xb].cvar, vSafe);
        best = xb;
        exploit = true;
      }
    }
  }

  let pick = best;
  if (!exploit) {
    const tau = v.level.tau;
    if (tau > 0) {
      // Seeded softmax over every surviving candidate.
      let total = 0;
      const eb = eff[best];
      for (let i = 0; i < n; i++) {
        if (alive[i] === 0) continue;
        const p = expDet((eff[i] - eb) / (VALUE_SCALE * tau));
        total += p;
      }
      let x = u01(v.seed, slot, frame, STREAM.softmax) * total;
      pick = best;
      for (let i = 0; i < n; i++) {
        if (alive[i] === 0) continue;
        const p = expDet((eff[i] - eb) / (VALUE_SCALE * tau));
        if (x < p) { pick = i; break; }
        x -= p;
      }
    } else if (v.level.god) {
      pick = godTieBreak(v, scored, n, best, slot, frame);
    }

    // Plan hold: keep the running plan against small value changes inside the hold time.
    if (mem.running !== '' && scored[pick].plan.name !== mem.running && frame - mem.chosenFrame < v.level.planHold) {
      const eb = eff[pick];
      const margin = HOLD_POINTS + HOLD_SHARE * Math.abs(eb);
      for (let i = 0; i < n; i++) {
        if (alive[i] === 0 || scored[i].plan.name !== mem.running) continue;
        if (eff[i] >= eb - margin) pick = i;
        break;
      }
    }
  }

  commit(mem, scored[pick].plan, frame);
  finish(out, scored[pick].plan, eff[pick], scored, vetoed);
};

function commit(mem: SelMem, p: PlanInstance, frame: number): void {
  if (p.name !== mem.running) { mem.running = p.name; mem.chosenFrame = frame; }
  mem.used = true;
}

/**
 * Near-ties within 2% of the best are mixed by fictitious play over their rollout payoffs (rows
 * are the tied plans, columns the shared samples), then one is drawn from the mix with a seeded
 * uniform. Falls back to the best when the samples do not line up.
 */
function godTieBreak(v: DecisionView, scored: readonly Scored[], n: number, best: number, slot: number, frame: number): number {
  const eb = eff[best];
  const band = TIE_SHARE * (Math.abs(eb) > TIE_FLOOR ? Math.abs(eb) : TIE_FLOOR);
  let rows = 0;
  const cols = scored[best].n;
  if (cols <= 0 || cols > 64) return best;
  for (let i = 0; i < n && rows < MAX_TIE; i++) {
    if (alive[i] === 0 || eb - eff[i] > band || scored[i].n !== cols) continue;
    tieIdx[rows++] = i;
  }
  if (rows < 2) return best;
  for (let r = 0; r < rows; r++) {
    const J = scored[tieIdx[r]].J;
    for (let c = 0; c < cols; c++) mixM[r * cols + c] = J[c];
  }
  const seed = (v.seed + Math.imul(frame, 0x9e3779b1) + slot) >>> 0;
  fictitiousPlay(mixM, rows, cols, MIX_ITERS, seed, mixOut);
  let x = u01(v.seed, slot, frame, STREAM.mix);
  for (let r = 0; r < rows; r++) {
    if (x < mixOut[r]) return tieIdx[r];
    x -= mixOut[r];
  }
  return tieIdx[rows - 1];
}
