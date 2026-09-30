/**
 * Humanizer (03 sections 2.1, 2.2 and 4; 02 section 14.1): the level's human errors, injected on
 * purpose, so a degraded tier loses the way a person does (late, missed, second-best) and never
 * the way a broken robot does (random presses, walking off the stage).
 *
 * Stage order per frame (02 section 14.1, 03 section 4): reflexes, plan, pre-buffered follow-up,
 * humanizer, guard, emit. The humanizer only ever delays or drops what the plan asked for; it
 * never invents a press. The guard that runs after it (executor.ts) enforces the mechanical
 * invariants and is the only place an accident (a double-tap roll) may slip through, gated by
 * `guardAccident` below at the level's `accidentTolerance`.
 *
 * What it does:
 * - reactionDelay: R = max(floor, round(R_base + S_eff + b * H + 2 stress + refractory - alert + SD z)),
 *   z from rng.skewNormal keyed on the event, so one event always gets one delay.
 * - apply: timing jitter as a real offset of the emitted press (never before the decision frame),
 *   lapses as a dropped press noticed and repeated `notice` frames later, a wrong-direction delay on
 *   quick reversals, mash gating at the level's rate. Windows at least `noJitterWidth` wide get no
 *   jitter (advanced and up), only the lapse.
 * - decisionError: the rank 2 to 3 pick at `errorRate` (never from a veto set: the caller removes
 *   vetoed plans before asking).
 * - softmaxPick: decision temperature, T = tau * (best - median) over near-best plans.
 * - baitCommit, recognizes, jitterInterval: bait weakness, recognition gaps and varied wake-up,
 *   ledge and recovery timings (03 section 4).
 *
 * The god tier gets the identity everywhere (no delay beyond its perception age, no jitter, no
 * lapse, no error). Deterministic: every draw is rng.u01 or rng.skewNormal keyed on (seed, slot,
 * frame, stream, k). No Math.exp, Math.pow or Math.log.
 */
import type { CreateHumanizerFn, Humanizer, Intent, LevelVector, ReactionDelayFn, Stimulus } from './contracts';
import { Btn } from '../core/types';
import { expDet } from './model/gating';
import { STREAM, bernoulli, skewNormal, u01 } from './rng';

// ---------------------------------------------------------------------------------------------
// Reaction (03 section 2.1)
// ---------------------------------------------------------------------------------------------

/** p_cue at or above this fully primes the cue (S_eff = 0). */
const CUE_PRIME = 0.6;
/** Stress adds up to this many frames. */
const STRESS_FRAMES = 2;
/** Psychological refractory period, frames. */
const PRP_WINDOW = 9;
/** Hick bits are clamped here (64 options). */
const MAX_BITS = 6;

/** Per-slot memory for the refractory term and the per-event cache. Slots 0..7. */
const MAX_SLOTS = 8;
const CACHE_N = 4;
const lastReactFrame = new Int32Array(MAX_SLOTS).fill(-100000);
const cacheKey = new Float64Array(MAX_SLOTS * CACHE_N).fill(NaN);
const cacheFrame = new Int32Array(MAX_SLOTS * CACHE_N).fill(-1);
const cacheVal = new Int32Array(MAX_SLOTS * CACHE_N);
const cacheNext = new Int32Array(MAX_SLOTS);

/** Clears the refractory memory and event cache of one slot, or of all slots. */
export function resetReactionMemory(slot?: number): void {
  for (let s = 0; s < MAX_SLOTS; s++) {
    if (slot !== undefined && s !== slot) continue;
    lastReactFrame[s] = -100000;
    cacheNext[s] = 0;
    for (let i = 0; i < CACHE_N; i++) { cacheKey[s * CACHE_N + i] = NaN; cacheFrame[s * CACHE_N + i] = -1; }
  }
}

/** Sub-key for the event: bounded so k * 16 stays a small integer inside the hash. */
function eventK(key: number): number {
  return (key >>> 0) & 0xfffff;
}

/**
 * The reaction draw with no refractory term and no memory: the part of R that depends on the
 * stimulus and the level only. Exposed for the unit checks and for callers that want an estimate.
 */
export function reactionSample(st: Stimulus, level: LevelVector, seed: number, slot: number, refractory = 0): number {
  if (level.god) return level.reactFloor > 0 ? level.reactFloor : level.perceptionAge;
  const pc = st.pCue > 0 ? (st.pCue >= CUE_PRIME ? 1 : st.pCue / CUE_PRIME) : 0;
  const sEff = level.surprise * (1 - pc);
  const bits = st.bits > 0 ? (st.bits > MAX_BITS ? MAX_BITS : st.bits) : 0;
  const stress = st.stress > 0 ? (st.stress > 1 ? 1 : st.stress) : 0;
  const z = skewNormal(seed, slot, st.frame, STREAM.reaction, eventK(st.key));
  const raw = level.reactBase + sEff + level.hickB * bits + STRESS_FRAMES * stress + refractory
    - (st.alert ? 1 : 0) + level.reactSd * z;
  const r = Math.round(raw);
  return r > level.reactFloor ? r : level.reactFloor;
}

/**
 * Frames between a stimulus and the first frame the CPU may respond to it. The same (slot, key,
 * frame) always returns the same value (the event is sampled once). A second, different event
 * within 9 frames of the last one pays the refractory cost `(9 - delta) * kPrp`.
 */
export const reactionDelay: ReactionDelayFn = (st, level, seed, slot) => {
  if (level.god) return reactionSample(st, level, seed, slot);
  const s = slot >= 0 && slot < MAX_SLOTS ? slot : 0;
  for (let i = 0; i < CACHE_N; i++) {
    const j = s * CACHE_N + i;
    if (cacheKey[j] === st.key && cacheFrame[j] === st.frame) return cacheVal[j];
  }
  const delta = st.frame - lastReactFrame[s];
  const refractory = delta > 0 && delta < PRP_WINDOW ? (PRP_WINDOW - delta) * level.kPrp : 0;
  const r = reactionSample(st, level, seed, slot, refractory);
  if (st.frame > lastReactFrame[s]) lastReactFrame[s] = st.frame;
  const j = s * CACHE_N + cacheNext[s];
  cacheKey[j] = st.key; cacheFrame[j] = st.frame; cacheVal[j] = r;
  cacheNext[s] = (cacheNext[s] + 1) % CACHE_N;
  return r;
};

// ---------------------------------------------------------------------------------------------
// Execution (03 section 2.2)
// ---------------------------------------------------------------------------------------------

/** N(0, 1) by Irwin-Hall (12 uniforms), keyed like every other draw. */
function normal01(seed: number, slot: number, frame: number, stream: number, k: number): number {
  let sum = 0;
  const base = k * 16;
  for (let i = 0; i < 12; i++) sum += u01(seed, slot, frame, stream, base + i);
  return sum - 6;
}

/** sigma_eff = sqrt(sigma_j^2 + 1/12), stress widening it by up to 35%. */
export function sigmaEff(level: LevelVector, stress = 0): number {
  if (level.god || !(level.sigmaJ > 0)) return 0;
  const s = stress > 0 ? (stress > 1 ? 1 : stress) : 0;
  return Math.sqrt(level.sigmaJ * level.sigmaJ + 1 / 12) * (1 + 0.35 * s);
}

/**
 * Signed timing offset in frames for one press (negative = early), round(N(0, sigma_eff)). Windows
 * at least `noJitterWidth` wide get 0. `k` separates presses on the same frame. apply() clamps the
 * negative side to the decision frame; a caller that schedules ahead (the executor's pre-buffer)
 * can use the full signed value.
 */
export function timingOffset(level: LevelVector, seed: number, slot: number, frame: number,
  windowWidth: number, k = 0, stress = 0): number {
  if (level.god) return 0;
  if (windowWidth >= level.noJitterWidth) return 0;
  const sd = sigmaEff(level, stress);
  if (!(sd > 0)) return 0;
  return Math.round(sd * normal01(seed, slot, frame, STREAM.jitter, k));
}

/** True when this press is dropped (a lapse); stress doubles the rate at most. */
export function lapsed(level: LevelVector, seed: number, slot: number, frame: number, k = 0, stress = 0): boolean {
  if (level.god) return false;
  const s = stress > 0 ? (stress > 1 ? 1 : stress) : 0;
  return bernoulli(level.lapse * (1 + s), seed, slot, frame, STREAM.lapse, k);
}

/**
 * Timing SD for an input timed off a long known interval (waiting out a 30-frame climb):
 * sqrt(sigma_j^2 + (k_W * interval)^2), Weber's law.
 */
export function intervalSigma(level: LevelVector, interval: number): number {
  if (level.god) return 0;
  const w = level.kWeber * (interval > 0 ? interval : 0);
  return Math.sqrt(level.sigmaJ * level.sigmaJ + w * w);
}

/**
 * A varied timing for wake-up, ledge and recovery choices: `base` plus a Weber-scaled Gaussian
 * offset, never below `min`. God returns `base` (its variety comes from the mixed strategy).
 */
export function jitterInterval(level: LevelVector, seed: number, slot: number, frame: number, base: number,
  min = 0, k = 0): number {
  if (level.god) return base;
  const v = Math.round(base + intervalSigma(level, base) * normal01(seed, slot, frame, STREAM.wake, k));
  return v > min ? v : min;
}

/**
 * Probability that a press aimed at the centre of a `w`-frame window lands in it, from the same
 * discrete offsets apply() and timingOffset() draw: (1 - lapse) * P(|round(N(0, sigma_eff))| within
 * the window). For the synthetic window checks against the 03 section 2.2 table.
 */
export function windowSuccessRate(level: LevelVector, w: number, seed: number, slot: number, n: number): number {
  let hit = 0;
  const half = w / 2;
  for (let i = 0; i < n; i++) {
    if (lapsed(level, seed, slot, i, 0)) continue;
    const d = timingOffset(level, seed, slot, i, w, 0);
    // The window covers frames c - half .. c + half - 1 around its centre frame c (w frames).
    if (d >= -half && d < half) hit++;
  }
  return hit / n;
}

// ---------------------------------------------------------------------------------------------
// Decision quality (03 section 2.3, 4)
// ---------------------------------------------------------------------------------------------

/** Error rate with stress: x(1 + 0.5 s). */
function errorRateOf(level: LevelVector, stress: number): number {
  const s = stress > 0 ? (stress > 1 ? 1 : stress) : 0;
  return level.errorRate * (1 + 0.5 * s);
}

/** Bait weakness: true = this CPU commits to a punish on a bait (empty hop, shield poke, intangible roll). */
export function baitCommit(level: LevelVector, seed: number, slot: number, frame: number, k = 0): boolean {
  if (level.god) return false;
  return bernoulli(level.baitWeakness, seed, slot, frame, STREAM.bait, k);
}

/** Recognition gap: false = this unusual move class (multi-hit, command grab, invulnerable startup) is misread. */
export function recognizes(level: LevelVector, seed: number, slot: number, frame: number, k = 0): boolean {
  if (level.god) return true;
  return bernoulli(level.recognition, seed, slot, frame, STREAM.opening, 1000 + k);
}

/**
 * Guard hook (03 section 4): the executor's guard asks this before blocking an accidental roll
 * from a double tap. True = let this one through. Only levels 1 to 3 have a non-zero tolerance;
 * god and world's best return false always.
 */
export function guardAccident(level: LevelVector, seed: number, slot: number, frame: number): boolean {
  if (level.god || !(level.accidentTolerance > 0)) return false;
  return bernoulli(level.accidentTolerance, seed, slot, frame, STREAM.error, 7);
}

/** Scratch for softmaxPick (sorted copy for the median). */
let sortScratch = new Float64Array(64);
let weightScratch = new Float64Array(64);

/**
 * Decision temperature: picks an index among the first `n` values (higher is better) by softmax
 * with T = tau * (best - median). Values more than 8 T under the best get no weight. tau 0 (god),
 * a single candidate or a zero spread returns the argmax (lowest index on ties). Negative infinity
 * or NaN values are never picked unless all are.
 */
export function softmaxPick(values: ArrayLike<number>, n: number, tau: number,
  seed: number, slot: number, frame: number, k = 0): number {
  let best = -1;
  for (let i = 0; i < n; i++) if (values[i] > -Infinity && (best < 0 || values[i] > values[best])) best = i;
  if (best < 0 || !(tau > 0) || n < 2) return best;
  if (sortScratch.length < n) { sortScratch = new Float64Array(n); weightScratch = new Float64Array(n); }
  let m = 0;
  for (let i = 0; i < n; i++) if (values[i] > -Infinity) sortScratch[m++] = values[i];
  // insertion sort of the finite values, ascending
  for (let i = 1; i < m; i++) {
    const x = sortScratch[i]; let j = i - 1;
    while (j >= 0 && sortScratch[j] > x) { sortScratch[j + 1] = sortScratch[j]; j--; }
    sortScratch[j + 1] = x;
  }
  const median = (m & 1) === 1 ? sortScratch[m >> 1] : (sortScratch[(m >> 1) - 1] + sortScratch[m >> 1]) / 2;
  const T = tau * (values[best] - median);
  if (!(T > 0)) return best;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = (values[i] - values[best]) / T;
    const w = values[i] > -Infinity && d > -8 ? expDet(d) : 0;
    weightScratch[i] = w; total += w;
  }
  let x = u01(seed, slot, frame, STREAM.softmax, k) * total;
  for (let i = 0; i < n; i++) {
    const w = weightScratch[i];
    if (!(w > 0)) continue;
    if (x < w) return i;
    x -= w;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The per-frame humanizer
// ---------------------------------------------------------------------------------------------

/** Buttons whose rising edge is a timed press. Directions are handled by the reversal rule. */
const PRESS_BITS = Btn.Jump | Btn.Attack | Btn.Special | Btn.Shield | Btn.Dodge | Btn.Grab
  | Btn.CUp | Btn.CDown | Btn.CLeft | Btn.CRight | Btn.Taunt;
const PRESS_LIST: readonly number[] = ((): number[] => {
  const out: number[] = [];
  for (let b = 0; b < 31; b++) if ((PRESS_BITS & (1 << b)) !== 0) out.push(1 << b);
  return out;
})();
const PRESS_COUNT = PRESS_LIST.length;
/** Ring size minus one for the intent history (a power of two above the largest shift). */
const HIST_MASK = 63;
const LR = Btn.Left | Btn.Right;
/** A reversal within this many frames of the last one may come out late (03 section 2.2). */
const REVERSAL_WINDOW = 8;
/** Frames a skipped press takes to be noticed and repeated: half a reaction, at least 4. */
function noticeFrames(level: LevelVector): number {
  const n = Math.round(level.reactBase / 2);
  return n > 4 ? n : 4;
}
const MAX_PENDING = 4;

/** Humanizer with the hooks the brain and the unit checks use beyond the frozen interface. */
export interface HumanizerExt extends Humanizer {
  /** Stress 0..1 (last stock, trailing, high percent): jitter x(1 + 0.35 s), lapse x(1 + s), error x(1 + 0.5 s). */
  setStress(s: number): void;
  /** Level used by mashAllowed before the first apply (apply records the level it is given). */
  setLevel(level: LevelVector): void;
  /** Presses currently held back (jitter or lapse). */
  pendingCount(): number;
}

class HumanizerImpl implements HumanizerExt {
  private readonly seed: number;
  private readonly slot: number;
  private level: LevelVector | null = null;
  private stress = 0;
  private prevHeld = 0;
  private prevDirect = 0;
  private lastReversal = -1000;
  private dirBlockUntil = -1;
  private lastMash = -1000;
  private readonly pBits = new Int32Array(MAX_PENDING);
  private readonly pDirect = new Int32Array(MAX_PENDING);
  private readonly pDue = new Int32Array(MAX_PENDING);
  private pN = 0;
  /** Intent press bits by frame (ring) and the current output shift of each press bit. */
  private readonly hist = new Int32Array(HIST_MASK + 1);
  private readonly shiftOf = new Int32Array(PRESS_COUNT);
  private lastFrame = -1;

  constructor(seed: number, slot: number) { this.seed = seed; this.slot = slot; }

  /** True when bit `b` was held in the intent at any of the `sh` frames before `frame` (its shifted span is still going out). */
  private spanBusy(b: number, frame: number, sh: number): boolean {
    for (let k = 1; k <= sh; k++) if ((this.hist[(frame - k) & HIST_MASK] & b) !== 0) return true;
    return false;
  }

  reset(): void {
    this.prevHeld = 0; this.prevDirect = 0; this.lastReversal = -1000; this.dirBlockUntil = -1;
    this.lastMash = -1000; this.pN = 0; this.stress = 0;
    this.hist.fill(0); this.shiftOf.fill(0);
  }

  setStress(s: number): void { this.stress = s > 0 ? (s > 1 ? 1 : s) : 0; }
  setLevel(level: LevelVector): void { this.level = level; }
  pendingCount(): number {
    let n = this.pN;
    for (let i = 0; i < PRESS_COUNT; i++) {
      const sh = this.shiftOf[i];
      if (sh > 0 && this.spanBusy(PRESS_LIST[i], this.lastFrame + 1, sh)) n++;
    }
    return n;
  }

  /** Holds a press back until `due`. When the queue is full the press goes out on time instead. */
  private push(bits: number, direct: number, due: number): void {
    if (this.pN >= MAX_PENDING) return;
    this.pBits[this.pN] = bits; this.pDirect[this.pN] = direct; this.pDue[this.pN] = due; this.pN++;
  }

  apply(intent: Intent, frame: number, windowWidth: number, level: LevelVector, out: Intent): void {
    this.level = level;
    if (level.god) {
      out.held = intent.held; out.direct = intent.direct; out.mash = intent.mash;
      this.prevHeld = intent.held; this.prevDirect = intent.direct;
      return;
    }
    const seed = this.seed, slot = this.slot;
    let held = intent.held;
    let direct = intent.direct;

    // New presses this frame: one timing draw and one lapse draw for the group. A held-back button
    // comes out late for its whole span (press and release shift together): a jump held 5 frames
    // for a full hop stays a 5-frame hold, so a late press does not turn it into a short hop, and a
    // late shield or charge keeps its length.
    this.lastFrame = frame;
    const ring = frame & HIST_MASK;
    this.hist[ring] = held & PRESS_BITS;
    const edges = held & ~this.prevHeld & PRESS_BITS;
    const newDirect = direct !== 0 && direct !== this.prevDirect ? direct : 0;
    if (edges !== 0 || newDirect !== 0) {
      let delay = timingOffset(level, seed, slot, frame, windowWidth, 0, this.stress);
      if (delay < 0) delay = 0;               // never before the decision frame
      if (lapsed(level, seed, slot, frame, 0, this.stress)) delay += noticeFrames(level);
      if (delay > HIST_MASK) delay = HIST_MASK;
      for (let i = 0; i < PRESS_COUNT; i++) {
        const b = PRESS_LIST[i];
        if ((edges & b) === 0) continue;
        // A new press of a bit still coming out from an earlier shifted span keeps that shift
        // (both spans stay in order); otherwise it takes this frame's draw.
        if (this.shiftOf[i] > 0 && this.spanBusy(b, frame, this.shiftOf[i])) continue;
        this.shiftOf[i] = delay;
      }
      if (delay > 0 && newDirect !== 0) this.push(0, newDirect, frame + delay);
    }
    let outPress = 0;
    for (let i = 0; i < PRESS_COUNT; i++) {
      const b = PRESS_LIST[i];
      const sh = this.shiftOf[i];
      if ((this.hist[(frame - sh) & HIST_MASK] & b) !== 0) outPress |= b;
    }
    held = (held & ~PRESS_BITS) | outPress;

    // Held-back direct codes: masked until due, then sent on the due frame.
    let dueDirect = 0;
    for (let i = 0; i < this.pN;) {
      if (this.pDue[i] > frame) {
        if (this.pDirect[i] !== 0 && this.pDirect[i] === direct) direct = 0;
        i++;
        continue;
      }
      if (this.pDirect[i] !== 0) dueDirect = this.pDirect[i];
      this.pN--;
      this.pBits[i] = this.pBits[this.pN]; this.pDirect[i] = this.pDirect[this.pN]; this.pDue[i] = this.pDue[this.pN];
    }
    if (dueDirect !== 0 && direct === 0) direct = dueDirect;

    // Wrong-direction error on a quick reversal: the new direction comes out 1 to 3 frames late
    // (neutral meanwhile, never the old direction, so the error cannot walk anyone off the stage).
    const lr = intent.held & LR;
    const prevLr = this.prevHeld & LR;
    if (lr !== 0 && prevLr !== 0 && lr !== prevLr) {
      if (frame - this.lastReversal < REVERSAL_WINDOW
        && bernoulli(errorRateOf(level, this.stress), seed, slot, frame, STREAM.error, 3)) {
        this.dirBlockUntil = frame + 1 + Math.floor(u01(seed, slot, frame, STREAM.error, 4) * 3);
      }
      this.lastReversal = frame;
    }
    if (frame < this.dirBlockUntil) held &= ~LR;

    out.held = held;
    out.direct = direct;
    out.mash = intent.mash !== 0 && this.mashAllowed(frame) ? intent.mash : 0;
    this.prevHeld = intent.held;
    this.prevDirect = intent.direct;
  }

  decisionError(level: LevelVector, frame: number): boolean {
    if (level.god) return false;
    return bernoulli(errorRateOf(level, this.stress), this.seed, this.slot, frame, STREAM.error, 0);
  }

  /** Consumes a mash slot: true at most once per `mashEvery` frames (none at levels with mashEvery 0). */
  mashAllowed(frame: number): boolean {
    const lv = this.level;
    if (lv === null) return false;
    const every = lv.mashEvery;
    if (!(every > 0)) return false;
    if (frame === this.lastMash) return true;
    if (frame - this.lastMash < every) return false;
    this.lastMash = frame;
    return true;
  }
}

/** One humanizer per CPU slot; `seed` is the match seed. */
export const createHumanizer: CreateHumanizerFn = (seed, slot) => new HumanizerImpl(seed, slot);

/** Same as createHumanizer with the extended hooks typed. */
export function createHumanizerExt(seed: number, slot: number): HumanizerExt {
  return new HumanizerImpl(seed, slot);
}

/** Frame stage order the humanizer is placed in (02 section 14.1, 03 section 4). */
export const STAGE_ORDER: readonly string[] = ['reflexes', 'plan', 'prebuffer', 'humanizer', 'guard', 'emit'];
