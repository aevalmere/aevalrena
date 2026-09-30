/**
 * Tempo (02 sections 6.8, 7.6, 12.4): the engagement clock and stall pressure, the staleness of
 * recently used commitments, the cycle detector, and the per-level decision cadence and step budget.
 *
 * Engagement clock: frames since the last engagement. It resets when the two fighters are within
 * 90 px with neither in hitstun, or when a hit of 8% or more lands on either; a chip from range
 * (under 8%) does not reset it. Pressure p = clamp((clock - T0) / T0, 0, 1) with
 * T0 = style.stallT0 * (1 - 0.8 * passivity); a damage rate under RATE_FLOOR over the last 20 s
 * raises p to at least 0.5. Effects are continuous (approachMul, lambdaShift, projectileStaleMul,
 * shotBandNow). Balanced level 5 never plays for a timeout: the pressure keeps rising.
 *
 * Staleness: each use of a named commitment adds 1; the total decays 0.9 per 12 elapsed frames
 * (not per decision), so the same cost means the same thing against any opponent.
 *
 * Cycles: the last 12 (plan name, distance bucket, damage) tuples; a period 1 to 4 loop repeated
 * three times with no damage in it sets cycle() and a penalty on the names in it, decaying over
 * 120 frames.
 *
 * Deterministic and allocation-free per frame after a name is first seen (one Map entry per name).
 */
import type { CreateTempoFn, LevelVector, StyleVector, Tempo } from './contracts';
import type { FighterState, GameState } from '../core/types';

/** Contact distance that counts as engagement, px. */
export const CLOSE_R = 90;
/** A hit of at least this many percent counts as engagement. */
export const CHIP_MAX = 8;
/** Damage-rate window, frames (20 s). */
const RATE_WINDOW = 1200;
const RATE_BUCKET = 60;
const RATE_BUCKETS = RATE_WINDOW / RATE_BUCKET;
/** Total damage (both fighters) under this over the last 20 s counts as a stall. */
export const RATE_FLOOR = 3;
/** Staleness decay: 0.9 per this many frames. */
const STALE_PERIOD = 12;
const STALE_BASE = 0.9;
/** Cycle ring length and penalty decay. */
const RING = 12;
const CYCLE_DECAY = 120;
const CYCLE_PENALTY = 1.5;
/** Distance buckets for the cycle tuple, px. */
const DIST_EDGES: readonly number[] = [60, 120, 200, 320];
/** Passivity is an EMA of "the opponent did nothing this frame" with this rate. */
const PASSIVE_RATE = 1 / 240;

/** 0.9^(1/12) by bisection on r^12 = 0.9 (no Math.pow). */
const STALE_STEP = ((): number => {
  let lo = 0.9, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    let p = 1;
    for (let k = 0; k < STALE_PERIOD; k++) p *= mid;
    if (p > STALE_BASE) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
})();

/** r^n for integer n >= 0 by squaring. */
function powInt(r: number, n: number): number {
  let out = 1, b = r, e = n;
  while (e > 0) { if ((e & 1) === 1) out *= b; b *= b; e >>= 1; }
  return out;
}

/** Staleness factor after `dt` frames: 0.9^(dt / 12). */
export function staleDecay(dt: number): number {
  return dt > 0 ? powInt(STALE_STEP, Math.floor(dt)) : 1;
}

function inHitstun(f: FighterState): boolean {
  return f.hitstun > 0 || f.action === 'hitstun' || f.action === 'tumble';
}

function alive(f: FighterState): boolean {
  return f.action !== 'dead' && f.stocks > 0;
}

function distBucket(d: number): number {
  let b = 0;
  while (b < DIST_EDGES.length && d > DIST_EDGES[b]) b++;
  return b;
}

/** Tempo with the hooks the brain and the unit checks use beyond the frozen interface. */
export interface TempoExt extends Tempo {
  /** Opponent passivity 0..1 from perception (02 section 13); overrides the built-in estimate while >= 0. */
  setPassivity(p: number): void;
  passivity(): number;
  /** Current T0 in frames. */
  t0(): number;
  /** Cycle penalty on a plan name (0 when it is not in a detected loop). */
  cyclePenalty(name: string): number;
  /** Damage over the last 20 s, both fighters. */
  recentDamage(): number;
  /** Uses of the same special off the stage since last touching it (the five-special rule). */
  offstageSpecials(name: string): number;
}

interface StaleEntry { v: number; f: number; id: number; pen: number; penF: number; off: number }

class TempoImpl implements TempoExt {
  private readonly style: StyleVector;
  private frame = 0;
  private lastEngage = 0;
  private started = false;
  private pctMe = 0; private pctOpp = 0; private stMe = 0; private stOpp = 0;
  private passive = 0;
  private passiveOverride = -1;
  private readonly buckets = new Float64Array(RATE_BUCKETS);
  private bucketIdx = 0;
  private bucketStart = 0;
  private dmgTotal = 0;
  private framesSeen = 0;
  private dist = 0;
  private meOffstage = false;
  // Staleness and cycles
  private readonly names = new Map<string, StaleEntry>();
  private nextId = 1;
  private readonly ringName = new Int32Array(RING);
  private readonly ringDist = new Int32Array(RING);
  private readonly ringDmg = new Uint8Array(RING);
  private ringN = 0;
  private ringHead = 0;           // next write index
  private dmgSinceUse = false;
  private cycleFlag = false;
  private cycleFrame = -100000;
  private readonly byId: StaleEntry[] = [];

  constructor(style: StyleVector) { this.style = style; }

  reset(): void {
    this.frame = 0; this.lastEngage = 0; this.started = false; this.passive = 0; this.passiveOverride = -1;
    this.buckets.fill(0); this.bucketIdx = 0; this.bucketStart = 0; this.dmgTotal = 0; this.framesSeen = 0;
    this.names.clear(); this.byId.length = 0; this.nextId = 1; this.ringN = 0; this.ringHead = 0;
    this.dmgSinceUse = false; this.cycleFlag = false; this.cycleFrame = -100000; this.meOffstage = false;
  }

  update(s: GameState, meI: number, oppI: number): void {
    const me = s.fighters[meI];
    const op = s.fighters[oppI];
    const frame = s.frame;
    if (!this.started) {
      this.started = true;
      this.lastEngage = frame;
      this.bucketStart = frame;
      this.pctMe = me.percent; this.pctOpp = op.percent; this.stMe = me.stocks; this.stOpp = op.stocks;
    }
    this.frame = frame;
    this.framesSeen++;
    // Damage this frame (a stock change resets the percent baseline; a heal is not damage).
    let dMe = me.stocks === this.stMe ? me.percent - this.pctMe : 0;
    let dOp = op.stocks === this.stOpp ? op.percent - this.pctOpp : 0;
    if (dMe < 0) dMe = 0;
    if (dOp < 0) dOp = 0;
    const stockChange = me.stocks !== this.stMe || op.stocks !== this.stOpp;
    this.pctMe = me.percent; this.pctOpp = op.percent; this.stMe = me.stocks; this.stOpp = op.stocks;
    if (dMe > 0 || dOp > 0 || stockChange) this.dmgSinceUse = true;

    // Rate buckets
    while (frame - this.bucketStart >= RATE_BUCKET) {
      this.bucketIdx = (this.bucketIdx + 1) % RATE_BUCKETS;
      this.dmgTotal -= this.buckets[this.bucketIdx];
      this.buckets[this.bucketIdx] = 0;
      this.bucketStart += RATE_BUCKET;
    }
    this.buckets[this.bucketIdx] += dMe + dOp;
    this.dmgTotal += dMe + dOp;

    // Engagement
    const dx = op.x - me.x, dy = op.y - me.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    this.dist = dist;
    const bothIn = alive(me) && alive(op) && op.action !== 'respawn' && me.action !== 'respawn';
    if ((bothIn && dist <= CLOSE_R && !inHitstun(me) && !inHitstun(op)) || dMe >= CHIP_MAX || dOp >= CHIP_MAX
      || stockChange) {
      this.lastEngage = frame;
    }

    // Built-in passivity estimate: the opponent standing, shielding or waiting, not attacking.
    const idle = op.action === 'idle' || op.action === 'shield' || op.action === 'crouch' || op.action === 'ledgeHang'
      || (op.action === 'walk' && Math.abs(op.vx) < 0.5);
    this.passive += ((idle ? 1 : 0) - this.passive) * PASSIVE_RATE;

    // Off-stage special count resets on touching the stage or a ledge.
    const grounded = me.onGround || me.action === 'ledgeHang' || me.action === 'ledgeGrab';
    if (grounded && this.meOffstage) {
      for (let i = 0; i < this.byId.length; i++) this.byId[i].off = 0;
    }
    this.meOffstage = !grounded && !me.onGround;
  }

  setPassivity(p: number): void { this.passiveOverride = p >= 0 ? (p > 1 ? 1 : p) : -1; }
  passivity(): number { return this.passiveOverride >= 0 ? this.passiveOverride : this.passive; }
  t0(): number { return this.style.stallT0 * (1 - 0.8 * this.passivity()); }
  recentDamage(): number { return this.dmgTotal; }

  clock(): number { return this.frame - this.lastEngage; }

  pressure(): number {
    const T0 = this.t0();
    let p = T0 > 0 ? (this.clock() - T0) / T0 : 1;
    p = p > 1 ? 1 : p > 0 ? p : 0;
    if (this.framesSeen >= RATE_WINDOW && this.dmgTotal < RATE_FLOOR && p < 0.5) p = 0.5;
    return p;
  }

  private entry(name: string): StaleEntry {
    let e = this.names.get(name);
    if (e === undefined) {
      e = { v: 0, f: this.frame, id: this.nextId++, pen: 0, penF: -100000, off: 0 };
      this.names.set(name, e);
      this.byId.push(e);
    }
    return e;
  }

  stale(name: string): number {
    const e = this.names.get(name);
    if (e === undefined) return 0;
    return e.v * staleDecay(this.frame - e.f);
  }

  used(name: string, frame: number): void {
    const e = this.entry(name);
    e.v = e.v * staleDecay(frame - e.f) + 1;
    e.f = frame;
    if (this.meOffstage) e.off++;
    // Close the previous tuple's outcome and push this one.
    if (this.ringN > 0) this.ringDmg[(this.ringHead + RING - 1) % RING] = this.dmgSinceUse ? 1 : 0;
    this.ringName[this.ringHead] = e.id;
    this.ringDist[this.ringHead] = distBucket(this.dist);
    this.ringDmg[this.ringHead] = 0;
    this.ringHead = (this.ringHead + 1) % RING;
    if (this.ringN < RING) this.ringN++;
    this.dmgSinceUse = false;
    this.detect(frame);
  }

  /** Tuple i back from the newest (0 = newest). */
  private at(i: number): number { return (this.ringHead + RING - 1 - i) % RING; }

  private detect(frame: number): void {
    // The newest tuple's outcome is still open; look at the closed ones plus the newest's name.
    for (let k = 1; k <= 4; k++) {
      const need = 3 * k;
      if (this.ringN < need) break;
      let ok = true;
      for (let i = 0; i < need - k && ok; i++) {
        const a = this.at(i), b = this.at(i + k);
        if (this.ringName[a] !== this.ringName[b] || this.ringDist[a] !== this.ringDist[b]) ok = false;
      }
      for (let i = 1; i < need && ok; i++) if (this.ringDmg[this.at(i)] !== 0) ok = false;
      if (!ok) continue;
      this.cycleFlag = true;
      this.cycleFrame = frame;
      for (let i = 0; i < k; i++) {
        const id = this.ringName[this.at(i)];
        const e = this.byId[id - 1];
        if (e !== undefined) { e.pen = e.pen * this.penDecay(frame - e.penF) + CYCLE_PENALTY * 3; e.penF = frame; }
      }
      return;
    }
  }

  private penDecay(dt: number): number {
    return dt >= CYCLE_DECAY ? 0 : dt > 0 ? 1 - dt / CYCLE_DECAY : 1;
  }

  cycle(): boolean {
    if (!this.cycleFlag) return false;
    if (this.frame - this.cycleFrame >= CYCLE_DECAY) { this.cycleFlag = false; return false; }
    return true;
  }

  cyclePenalty(name: string): number {
    const e = this.names.get(name);
    if (e === undefined) return 0;
    return e.pen * this.penDecay(this.frame - e.penF);
  }

  offstageSpecials(name: string): number {
    const e = this.names.get(name);
    return e === undefined ? 0 : e.off;
  }
}

/** One tempo per CPU slot. */
export const createTempo: CreateTempoFn = (style) => new TempoImpl(style);

/** Same as createTempo with the extended hooks typed. */
export function createTempoExt(style: StyleVector): TempoExt {
  return new TempoImpl(style);
}

// ---------------------------------------------------------------------------------------------
// Pressure effects (02 section 12.4), all continuous in p
// ---------------------------------------------------------------------------------------------

/** Approach weight multiplier: 1 + 3p. */
export function approachMul(p: number): number { return 1 + 3 * p; }
/** Lambda shift: -0.2p (callers clamp lambda at 0). */
export function lambdaShift(p: number): number { return -0.2 * p; }
/** Projectile staleness multiplier: 1 + p. */
export function projectileStaleMul(p: number): number { return 1 + p; }
/** Shot band with its upper end pulled toward the lower one by p: [lo, hi - p (hi - lo)]. */
export function shotBandNow(style: StyleVector, p: number, out: [number, number]): [number, number] {
  const lo = style.shotBand[0], hi = style.shotBand[1];
  out[0] = lo; out[1] = hi - p * (hi - lo);
  return out;
}
/** The five-special rule: never the same special more than five times off the stage without returning. */
export const OFFSTAGE_SPECIAL_MAX = 5;

// ---------------------------------------------------------------------------------------------
// Decision cadence and budget per level (02 section 7.6, 03 section 2.3)
// ---------------------------------------------------------------------------------------------

/** Frames before an interruptible plan is re-decided (god), and while recovering. */
export const REPLAN_INTR = 3;
export const REPLAN_RECOVERING = 6;
/** Opening ramp: this many steps for the first RAMP_FRAMES frames. */
export const RAMP_STEPS = 600;
export const RAMP_FRAMES = 240;

export interface CadenceInput {
  /** The running plan has finished (or there is none). */
  planEnded: boolean;
  /** The running plan may be interrupted. */
  interruptible: boolean;
  /** We are recovering (off the stage). */
  recovering: boolean;
  /** Frames the running plan has run. */
  runFrames: number;
  /** The opponent's perceived state visibly changed this frame (new move, action or projectile). */
  newEvent: boolean;
  /** Frames since the last decision. */
  sinceDecision: number;
}

/**
 * True when the brain should decide this frame (02 section 7.6): when the plan ended; when an
 * interruptible plan has run its replan interval; or on a new perceived event once the minimum
 * interval has passed. The interval is 3 frames (6 recovering) for god and max(3, planHold) for
 * the human tiers (03 section 2.3: 24 frames casual down to 10 world's best).
 */
export function shouldDecide(c: CadenceInput, level: LevelVector): boolean {
  if (c.planEnded) return true;
  const base = level.god ? (level.planHold > 0 ? level.planHold : REPLAN_INTR) : level.planHold;
  const every = c.recovering ? (base > REPLAN_RECOVERING ? base : REPLAN_RECOVERING) : (base > REPLAN_INTR ? base : REPLAN_INTR);
  if (!c.interruptible) return false;
  if (c.newEvent && c.sinceDecision >= REPLAN_INTR) return true;
  return c.runFrames >= every && c.sinceDecision >= every;
}

/** Step budget for a decision at `frame` (match frame): the level's budget, at most RAMP_STEPS before RAMP_FRAMES. */
export function stepBudgetAt(level: LevelVector, frame: number): number {
  const b = level.stepBudget;
  return frame < RAMP_FRAMES && b > RAMP_STEPS ? RAMP_STEPS : b;
}
