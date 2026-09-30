/**
 * Passive and half-passive opponents (docs/CPU_PLAN.md W2.9; cpu-guide 02 section 13).
 *
 * Detection (13.1). `passiveKind(view)` keeps a small per-CPU tracker of what the target visibly
 * does: time spent standing, shielding, airborne, rolling or attacking (weights decaying over
 * about 240 frames), jump and roll starts, and the last visible edge (an action the fighter chose,
 * or a turn). Forced states (hitstun, tumble, grabbed, ledge, downed, dead, respawn) are not
 * sampled, so the route's own throws do not wake the classification up. Kinds:
 * - stationary: no visible edge for 60 frames, no attack for 120, standing most of the time;
 * - shieldOnly: shield most of the time, no attacks;
 * - jumpOnly: repeated jumps, airborne much of the time, no attacks;
 * - rollOnly: repeated rolls, no attacks;
 * - loop: no attacks for 120 frames and one other action dominating (taunt loops and the like).
 * Nothing is read from the opponent's inputs; only the perceived state.
 *
 * The route (13.2), sized to the 100-frame respawn platform (RESPAWN_PLATFORM_FRAMES): a victim
 * that presses nothing does not recover, so the plan puts it past the ledge with a throw and lets
 * it fall. The family `passiveRoute` is a candidate like any other, evaluated by the search, and
 * only offered while `passiveKind` is not 'none'. Phases, each a short plan re-generated on the
 * next decision:
 * - grab: move to grab range on our side of the target and grab once it can be grabbed (after its
 *   invulnerability, busy frames, or at the predicted landing frame when it is airborne);
 * - throw: in a grab hold, each throw is run on a pooled copy against a victim that presses
 *   nothing, and the throw that KOs first (else hangs it on the ledge, else leaves it nearest a
 *   ledge) is chosen; from mid stage that is the carry throw toward the nearer ledge, near the
 *   ledge the one that sends the victim off;
 * - ledge: a hanging victim is spiked with a short-hop air move that reaches the hanger (hop
 *   timing, fast fall and stand-off chosen by rollouts on a pooled copy, the soonest KO that
 *   lands us back on the stage, timed to connect as its ledge invulnerability ends); without
 *   such a move, a ground move that reaches the ledge pokes it off instead;
 * - wait: while the victim falls, is dead or sits on the respawn platform, stand at the grab
 *   spot next to where it will land.
 * `PASSIVE_TARGET_FRAMES` is the frame budget of 13.3 with this sim's platform time.
 */
import { RESPAWN_PLATFORM_FRAMES } from '../../core/constants';
import type { FighterState, GameState, InputFrame, MoveId, ThrowId } from '../../core/types';
import { cloneGameState, stepGame } from '../../sim/index';
import type { SimFighter } from '../../sim/state';
import { CHARACTER_DEFS } from '../../characters/registry';
import { place } from '../charprofile/probeHit';
import { MOVE_SLOT } from '../charprofile/tags';
import { copyGameStateInto } from '../aevalmere';
import type { DecisionView, Intent, PassiveKind, PassiveKindFn, PlanCtx, PlanFamily, PlanInstance, Situation } from '../contracts';
import { PF_ATTACK, PF_INTR, PF_TAIL } from '../contracts';
import { invulnFrames } from '../perception';
import { LP_NONE, newLandingSet, predictLanding, suspendedInAir } from './advantage';
import {
  codeOf, D, G, hitsLedge, isAirOnly, J, K_APPROACH, K_COMMIT, K_HOLD, L, nameFor, Plan, PlanPool, PlanRunner, press, R, runState,
  safeDir, stageGeo, stageOfState, targetIndex, throwList, WK,
} from './script';

// ---------------------------------------------------------------------------------------------
// Frame budget (13.3)
// ---------------------------------------------------------------------------------------------

/** Frames a KO'd fighter stays dead before the platform appears (sim/match.ts DEAD_FRAMES). */
export const DEAD_FRAMES = 60;
/** First stock from the spawn positions: approach, grab, throw off, fall (13.2 step 1). */
export const ROUTE_FIRST_STOCK = 330;
/** A later stock from the platform drop: fall, grab on landing, carry throw, chase, grab, throw to the ledge, spike (13.2 step 2). */
export const ROUTE_LATER_STOCK = 320;
/** Open-loop frame budget to take `stocks` stocks from a passive victim. */
export function passiveTargetFrames(stocks: number): number {
  if (stocks <= 0) return 0;
  return ROUTE_FIRST_STOCK + (stocks - 1) * (DEAD_FRAMES + RESPAWN_PLATFORM_FRAMES + ROUTE_LATER_STOCK);
}
/** Three stocks: 330 + 2 * (60 + 100 + 320) = 1,290 frames. */
export const PASSIVE_TARGET_FRAMES = passiveTargetFrames(3);

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

const C_IDLE = 0;
const C_SHIELD = 1;
const C_AIR = 2;
const C_ROLL = 3;
const C_ATTACK = 4;
const C_OTHER = 5;
const CATS = 6;

/** Decay horizon of the tracker weights, frames. */
const DECAY = 240;
/** Frames of samples needed before a kind is reported. */
const MIN_SEEN = 45;

interface Tracker {
  target: number; last: number; w: Float64Array; jumps: number; rolls: number;
  lastAction: string; lastFacing: number; lastEdge: number; lastAttack: number; kind: PassiveKind;
  /** The current airborne period began with a jump (falling alone is not a choice). */
  jumped: boolean;
}
const TRACKERS: Tracker[] = [];

function trackerOf(slot: number): Tracker {
  let t = TRACKERS[slot];
  if (t === undefined) {
    t = { target: -1, last: -1, w: new Float64Array(CATS), jumps: 0, rolls: 0, lastAction: '', lastFacing: 0,
      lastEdge: 0, lastAttack: 0, kind: 'none', jumped: false };
    TRACKERS[slot] = t;
  }
  return t;
}

function resetTracker(t: Tracker, target: number, v: DecisionView, f: FighterState, frame: number): void {
  t.target = target; t.last = frame; t.w.fill(0); t.jumps = 0; t.rolls = 0;
  t.lastAction = f.action; t.lastFacing = f.facing;
  t.lastEdge = frame - Math.max(0, v.p.framesSinceEdge);
  t.lastAttack = frame - Math.max(0, v.p.framesSinceAttack);
  t.kind = 'none'; t.jumped = false;
}

/** Forced states: not the fighter's choice, not sampled. */
function forced(f: FighterState): boolean {
  switch (f.action) {
    case 'hitstun': case 'tumble': case 'grabbed': case 'ledgeHang': case 'ledgeGrab': case 'downed':
    case 'dead': case 'respawn': case 'tech': case 'techRoll': case 'shieldBreak': case 'finalSmashVictim':
      return true;
    default:
      return f.hitlag > 0 || f.hitstun > 0;
  }
}

function categoryOf(f: FighterState, jumped: boolean): number {
  switch (f.action) {
    case 'idle': case 'land': case 'crouch': return C_IDLE;
    case 'shield': case 'shieldStun': return C_SHIELD;
    case 'jumpsquat': return C_AIR;
    case 'air': return jumped ? C_AIR : C_IDLE;
    case 'roll': return C_ROLL;
    case 'attack': case 'grab': case 'grabHold': case 'pummel': case 'throw': return C_ATTACK;
    default: return C_OTHER;
  }
}

/** Grounded actions a jump can start from. */
function groundedChoice(a: string): boolean {
  switch (a) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'land': case 'shield':
      return true;
    default:
      return false;
  }
}

/** Actions a fighter only enters by choice (a visible input edge). */
function chosen(a: string): boolean {
  switch (a) {
    case 'walk': case 'dash': case 'run': case 'turn': case 'jumpsquat': case 'shield': case 'roll': case 'spotDodge':
    case 'attack': case 'grab': case 'airDodge': case 'crouch':
      return true;
    default:
      return false;
  }
}

function observe(t: Tracker, f: FighterState, frame: number): void {
  const dt = Math.min(30, frame - t.last);
  t.last = frame;
  if (dt <= 0) return;
  const a = f.action;
  const changed = a !== t.lastAction;
  if (f.onGround) t.jumped = false;
  if (changed && (a === 'jumpsquat' || (a === 'air' && f.vy < 0 && groundedChoice(t.lastAction)))) {
    if (!t.jumped) t.jumps += 1;
    t.jumped = true;
  }
  if (!forced(f)) {
    const keep = dt >= DECAY ? 0 : 1 - dt / DECAY;
    for (let c = 0; c < CATS; c++) t.w[c] *= keep;
    t.jumps *= keep; t.rolls *= keep;
    const cat = categoryOf(f, t.jumped);
    t.w[cat] += dt;
    if (changed && a === 'roll') t.rolls += 1;
    if ((changed && chosen(a)) || (f.facing !== t.lastFacing && f.onGround)) t.lastEdge = frame;
    if (cat === C_ATTACK) t.lastAttack = frame;
  }
  t.lastAction = a; t.lastFacing = f.facing;
}

function classify(t: Tracker, f: FighterState, frame: number): PassiveKind {
  // A hang is a forced state for the tracker (no samples while it lasts), so a fighter that hangs
  // and never lets go kept whatever kind it had before, often 'none', and the ledge routes were
  // never offered: the god fired shots at a ledge hanger for 2,600 frames (eval bf, stationary).
  // A hang held past HANG_PASSIVE frames with no attack is passive by itself.
  if (f.action === 'ledgeHang' && f.actionFrame >= HANG_PASSIVE && frame - t.lastAttack >= 120) return 'stationary';
  const w = t.w;
  let total = 0;
  for (let c = 0; c < CATS; c++) total += w[c];
  if (total < MIN_SEEN) {
    // Too few own samples: the perceived history (edges and attacks since the tracker started
    // from the perception's counters) decides the plain stationary case.
    if (frame - t.lastEdge >= 60 && frame - t.lastAttack >= 120 && f.onGround && !forced(f)
      && categoryOf(f, t.jumped) === C_IDLE) return 'stationary';
    return t.kind;
  }
  const sinceAttack = frame - t.lastAttack;
  if (sinceAttack < 120 || w[C_ATTACK] > 0.04 * total) return 'none';
  if (w[C_SHIELD] >= 0.6 * total) return 'shieldOnly';
  if (t.jumps >= 1.5 && w[C_AIR] >= 0.4 * total) return 'jumpOnly';
  if (t.rolls >= 1.5 && w[C_ROLL] >= 0.2 * total) return 'rollOnly';
  if (frame - t.lastEdge >= 60 && w[C_IDLE] >= 0.8 * total) return 'stationary';
  let top = 0;
  for (let c = 0; c < CATS; c++) if (w[c] > top) top = w[c];
  if (top >= 0.6 * total) return 'loop';
  return 'none';
}

/** Frames a ledge hang lasts before the hanger counts as passive (a climb, roll or jump comes well before). */
const HANG_PASSIVE = 90;

/** Passive kind of the view's target (see the file comment). Deterministic per slot. */
export const passiveKind: PassiveKindFn = (v) => {
  const ti = targetIndex(v);
  const s = v.p.state;
  const t = trackerOf(v.slot);
  if (ti < 0) { t.kind = 'none'; return 'none'; }
  const f = s.fighters[ti];
  const frame = s.frame;
  if (t.target !== ti || frame < t.last) resetTracker(t, ti, v, f, frame);
  if (frame > t.last) observe(t, f, frame);
  else if (frame === t.last && t.w[0] + t.w[1] + t.w[2] + t.w[3] + t.w[4] + t.w[5] === 0) observe(t, f, frame);
  t.kind = classify(t, f, frame);
  return t.kind;
};

/** Clears every tracker (a new match). */
export function resetPassive(): void {
  for (let i = 0; i < TRACKERS.length; i++) if (TRACKERS[i] !== undefined) TRACKERS[i].target = -1;
}

// ---------------------------------------------------------------------------------------------
// Route script
// ---------------------------------------------------------------------------------------------

const F_NONE = 0;
const F_GRAB = 1;
const F_MOVE = 2;
const F_THROW = 3;

/**
 * Route step. ctx.param is the stop x, ctx.dir the facing wanted when firing, ctx.fireAt the
 * earliest fire frame; plan.data the fire mode (F_*). Registers: r0 = fired.
 * Moves to the stop x (dash, walk the last stretch, brake by the skid), turns to ctx.dir, then
 * fires once: a grab, the plan's move, or (in a grab hold) the throw code in plan.moveCode.
 */
/** Px nearer the victim than a route's spot that still count as arrived. */
const ROUTE_NEAR_SLACK = 24;

function routeFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const rs = runState(p, ctx);
  const mode = typeof p.data === 'number' ? p.data : F_NONE;
  if (rs.r[0] === 1) return;
  if (mode === F_THROW) {
    if (self.action === 'grabHold') { out.direct = p.moveCode; rs.r[0] = 1; }
    return;
  }
  if (!self.onGround) return;
  const d = ctx.param - self.x;
  const ad = Math.abs(d);
  const toward = d > 0 ? R : L;
  const skid = (self.vx * self.vx) / (2 * 0.22);
  const moving = self.action === 'dash' || self.action === 'run';
  // A few px nearer the victim than the spot is still in reach: stepping back to it would turn us
  // away and the turn-back walk overshoots again (a grab route oscillated next to a shield).
  // Grab routes only: a move route's spot is its measured spacing (a ledge poke at the lip).
  const nearer = mode === F_GRAB && ctx.dir !== 0 && Math.sign(d) === -ctx.dir && ad <= ROUTE_NEAR_SLACK;
  const arrived = ad <= 4 || nearer || (ad <= skid + 3 && Math.sign(self.vx) === Math.sign(d));
  if (!arrived) {
    out.held = ad > 28 ? safeDir(toward, self) : safeDir(toward, self) | WK;
    return;
  }
  const face = ctx.dir > 0 ? R : L;
  if (mode === F_NONE) {
    if (!moving && self.facing !== ctx.dir && self.action === 'idle') out.held = face | WK;
    return;
  }
  if (ctx.frame < ctx.fireAt) {
    if (self.facing !== ctx.dir && self.action === 'idle') out.held = face | WK;
    return;
  }
  if (self.facing !== ctx.dir && !moving) {
    if (self.action === 'idle') out.held = face | WK;
    return;
  }
  rs.r[0] = 1;
  if (mode === F_GRAB) out.held = press(G, self);
  else { out.direct = p.moveCode; }
}

function prepRoute(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const r = ROUTE_CTX.get(p);
  if (r === undefined) return;
  ctx.param = r.x; ctx.dir = r.dir; ctx.fireAt = r.fireAt;
}
interface RouteCtx { x: number; dir: number; fireAt: number }
const ROUTE_CTX = new WeakMap<Plan, RouteCtx>();

function routeCtx(p: Plan, x: number, dir: number, fireAt: number): void {
  let r = ROUTE_CTX.get(p);
  if (r === undefined) { r = { x: 0, dir: 1, fireAt: 0 }; ROUTE_CTX.set(p, r); }
  r.x = x; r.dir = dir; r.fireAt = fireAt;
}

// ---------------------------------------------------------------------------------------------
// Throw choice by simulation (victim presses nothing)
// ---------------------------------------------------------------------------------------------

let scratch: GameState | null = null;
const INPUTS: InputFrame[] = [];
function inputsFor(n: number): InputFrame[] {
  while (INPUTS.length < n) INPUTS.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  for (let i = 0; i < n; i++) { const f = INPUTS[i]; f.held = 0; f.pressed = 0; f.released = 0; f.direct = 0; }
  return INPUTS;
}

/** Frames a throw is followed on the copy. */
const THROW_SIM = 260;

/** Score of a throw against a victim that presses nothing: KO soonest, then ledge hang, then nearest the ledge. */
function throwScore(v: DecisionView, id: ThrowId): number {
  const s0 = v.p.state;
  if (scratch === null || scratch.fighters.length !== s0.fighters.length) scratch = cloneGameState(s0);
  copyGameStateInto(s0, scratch);
  const s = scratch;
  const meI = v.p.meI;
  const ti = v.p.oppI;
  const tSlot = s.fighters[ti].slot;
  const g = stageGeo(stageOfState(s));
  const code = codeOf(id);
  for (let k = 0; k < THROW_SIM; k++) {
    const inp = inputsFor(s.fighters.length);
    if (k === 0) inp[meI].direct = code;
    stepGame(s, inp);
    for (let e = 0; e < s.events.length; e++) {
      const ev = s.events[e];
      if (ev.type === 'ko' && ev.slot === tSlot) return 10000 - k;
    }
    const f = s.fighters[ti];
    if (f.action === 'ledgeHang') return 3000 - k;
    if (k > 40 && f.onGround && f.hitstun === 0 && f.action !== 'land') {
      return 1000 - Math.min(Math.abs(f.x - g.left), Math.abs(g.right - f.x));
    }
  }
  const f = s.fighters[ti];
  return 1000 - Math.min(Math.abs(f.x - g.left), Math.abs(g.right - f.x));
}

// ---------------------------------------------------------------------------------------------
// Ledge spike: a short-hop air attack that reaches the hanger, tuned by rollouts
// ---------------------------------------------------------------------------------------------

/** Hop timing of a spike variant: the move `atk` frames after the jump press, fast fall or not. */
interface SpikeData { atk: number; ff: boolean; drift: boolean }

/**
 * Walks to ctx.param facing ctx.dir; from ctx.fireAt on (once arrived and standing) short hops,
 * sends the plan's move `atk` frames after the jump press and fast falls after it when `ff`;
 * with `drift` it drifts toward ctx.dir (off the edge) until the move and back toward the stage
 * after it.
 * Registers: r0 hop started, r1 hop frame.
 */
function spikeFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const rs = runState(p, ctx);
  const d = p.data as SpikeData;
  if (rs.r[0] === 0) {
    if (!self.onGround) return;
    const dx = ctx.param - self.x;
    const ad = Math.abs(dx);
    const toward = dx > 0 ? R : L;
    if (ad > 3) { out.held = ad > 28 ? safeDir(toward, self) : safeDir(toward, self) | WK; return; }
    if (self.action === 'dash' || self.action === 'run' || (self.action === 'walk' && Math.abs(self.vx) > 0.3)) return;
    if (self.facing !== ctx.dir) { if (self.action === 'idle') out.held = (ctx.dir > 0 ? R : L) | WK; return; }
    if (ctx.frame < ctx.fireAt || self.action !== 'idle' || Math.abs(self.vx) > 0.05) return;
    rs.r[0] = 1; rs.r[1] = ctx.frame;
    out.held = press(J, self);
    return;
  }
  const rel = ctx.frame - rs.r[1];
  if (d.drift && rel >= 1) out.held |= (rel <= d.atk) === (ctx.dir > 0) ? R : L;
  if (rel === d.atk) out.direct = p.moveCode;
  if (d.ff && rel > d.atk && !self.onGround && self.vy > 0 && !self.fastFalling) out.held |= press(D, self);
}

interface SpikeChoice { move: MoveId; x: number; hitAt: number; data: SpikeData }
interface SpikeCache { hangStart: number; target: number; found: boolean; choice: SpikeChoice }
const SPIKE_CACHE: SpikeCache[] = [];
const SPIKE_ATK = [18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38];
const SPIKE_OFF = [4, 12];
const SPIKE_FRAMES = 140;
const spikeRunner: { r: PlanRunner | null } = { r: null };
const SPIKE_VARIANT = new Plan();
const SPIKE_IN: InputFrame[] = [];

/**
 * Best spike on a ledge hanger for a passive victim: every variant (hop timing, fast fall, stand
 * offset from the edge) runs on a pooled copy from a standing start at its spot, with the
 * victim's ledge invulnerability cleared, and the variant that KOs soonest while we land back on
 * the stage wins. Cached per ledge grab. Null when the character has no air move that reaches a
 * hanger or no variant KOs.
 */
function ledgeSpike(v: DecisionView, ti: number, side: number, edge: number): SpikeChoice | null {
  const s0 = v.p.state;
  const tg = s0.fighters[ti];
  const hangStart = s0.frame - tg.actionFrame;
  let c = SPIKE_CACHE[v.slot];
  if (c === undefined) {
    c = { hangStart: -1, target: -1, found: false, choice: { move: MOVE_SLOT.jab, x: 0, hitAt: 0, data: { atk: 0, ff: false, drift: false } } };
    SPIKE_CACHE[v.slot] = c;
  }
  if (c.hangStart === hangStart && c.target === ti) return c.found ? c.choice : null;
  c.hangStart = hangStart; c.target = ti; c.found = false;
  let move: MoveId | null = null;
  for (const id in v.me.moves) {
    const m = v.me.moves[id as MoveId];
    if (m === undefined || m.maxDamage <= 0 || !isAirOnly(v.me.charId, id as MoveId) || !hitsLedge(v.me.charId, id as MoveId)) continue;
    if (move === null || m.tags.indexOf('spike') >= 0) move = id as MoveId;
  }
  if (move === null) return null;
  if (spikeRunner.r === null) spikeRunner.r = new PlanRunner(v.me, stageOfState(s0));
  const runner = spikeRunner.r;
  const g = stageGeo(stageOfState(s0));
  const def = CHARACTER_DEFS[v.me.charId];
  const meI = v.p.meI;
  const tSlot = tg.slot;
  const meSlot = s0.fighters[meI].slot;
  let bestKo = Infinity; let bestWalk = Infinity;
  for (let oi = 0; oi < SPIKE_OFF.length; oi++) {
    const x = edge - side * SPIKE_OFF[oi];
    for (let ai = 0; ai < SPIKE_ATK.length; ai++) {
      for (let f = 0; f < 2; f++) {
        if (scratch === null || scratch.fighters.length !== s0.fighters.length) scratch = cloneGameState(s0);
        copyGameStateInto(s0, scratch);
        const s = scratch;
        const me = s.fighters[meI] as SimFighter;
        place(me, def, x, g.top, true);
        me.facing = side > 0 ? 1 : -1; me.inputHeld = 0;
        const vic = s.fighters[ti] as SimFighter;
        vic.invuln = 0;
        const plan = SPIKE_VARIANT.set('passiveRoute', 'spikeProbe', move, 2, SPIKE_FRAMES, PF_ATTACK | PF_TAIL, 0, K_COMMIT);
        plan.prog = null; plan.fn = spikeFn; plan.prep = null;
        plan.data = SPIKE_PROBE_DATA; SPIKE_PROBE_DATA.atk = SPIKE_ATK[ai];
        SPIKE_PROBE_DATA.ff = (f & 1) === 1; SPIKE_PROBE_DATA.drift = (f & 2) === 2;
        runner.plan = plan; runner.t = 0; runner.prevHeld = 0;
        const ctx = runner.ctx;
        ctx.me = v.me; ctx.stage = stageOfState(s); ctx.param = x; ctx.dir = side; ctx.fireAt = s.frame;
        ctx.startFrame = s.frame; ctx.frame = s.frame; ctx.home = -side; ctx.edgeX = edge;
        let hitAt = -1; let ko = -1; let lost = false;
        for (let k = 0; k < SPIKE_FRAMES; k++) {
          while (SPIKE_IN.length < s.fighters.length) SPIKE_IN.push({ held: 0, pressed: 0, released: 0, direct: 0 });
          for (let i = 0; i < s.fighters.length; i++) { const q = SPIKE_IN[i]; q.held = 0; q.pressed = 0; q.released = 0; q.direct = 0; }
          runner.step(s, meI, SPIKE_IN[meI]);
          stepGame(s, SPIKE_IN);
          for (let e = 0; e < s.events.length; e++) {
            const ev = s.events[e];
            if (ev.type === 'hit' && ev.attacker === meSlot && ev.victim === tSlot && hitAt < 0) hitAt = k;
            if (ev.type === 'ko' && ev.slot === tSlot) ko = k;
            if (ev.type === 'ko' && ev.slot === meSlot) lost = true;
          }
          if (lost || (hitAt < 0 && k > 70)) break;
          if (ko >= 0 && s.fighters[meI].onGround) break;
        }
        const safe = !lost && s.fighters[meI].onGround && s.fighters[meI].x >= g.left && s.fighters[meI].x <= g.right;
        const walk = Math.abs(x - s0.fighters[meI].x);
        if (ko < 0 || !safe || hitAt < 0 || ko > bestKo || (ko === bestKo && walk >= bestWalk)) continue;
        bestKo = ko; bestWalk = walk;
        c.found = true;
        c.choice.move = move; c.choice.x = x; c.choice.hitAt = hitAt;
        c.choice.data = { atk: SPIKE_ATK[ai], ff: (f & 1) === 1, drift: (f & 2) === 2 };
      }
    }
  }
  return c.found ? c.choice : null;
}
const SPIKE_PROBE_DATA: SpikeData = { atk: 0, ff: false, drift: false };

// ---------------------------------------------------------------------------------------------
// Family
// ---------------------------------------------------------------------------------------------

const PR_ROUTE = 94;
/** Stand-off from the ledge corner while the victim flies past it, px. */
const EDGE_WAIT = 12;
const pool = new PlanPool();
const LANDING = newLandingSet();
const SITS: readonly Situation[] = ['neutral', 'advantage', 'grabHold', 'airborne', 'disadvantage'];

/** Grab spacing (feet to feet) for a standing grab on this victim. */
function grabGap(v: DecisionView): number {
  return Math.max(6, v.me.grab.standing.reach + v.opp.physics.hurtbox.w / 2 - 10);
}

function clampStage(x: number, v: DecisionView): number {
  const g = stageGeo(stageOfState(v.p.state));
  return x < g.left + 6 ? g.left + 6 : x > g.right - 6 ? g.right - 6 : x;
}

/**
 * A ground move that reaches a ledge hanger: the fastest one that kills from the ledge at the
 * victim's percent, else the one with the most damage (the farthest launch), fastest on ties.
 * Null when the character has none.
 */
function ledgePoke(v: DecisionView, pct: number): MoveId | null {
  let best: MoveId | null = null;
  let bk = false; let bd = -1; let bs = Infinity;
  const pick = (id: MoveId): void => {
    const m = v.me.moves[id];
    if (m === undefined || m.maxDamage <= 0 || isAirOnly(v.me.charId, id) || !hitsLedge(v.me.charId, id)) return;
    const kp = m.killPct.ledge;
    const kills = Number.isFinite(kp) && pct + m.maxDamage >= kp;
    const better = kills !== bk ? kills
      : kills ? m.startup < bs : m.maxDamage > bd || (m.maxDamage === bd && m.startup < bs);
    if (best === null || better) { best = id; bk = kills; bd = m.maxDamage; bs = m.startup; }
  };
  const lt = v.me.roles.ledgeTrap;
  for (let i = 0; i < lt.length; i++) pick(lt[i]);
  if (best === null) for (const id in v.me.moves) pick(id as MoveId);
  return best;
}

function emit(out: PlanInstance[], p: Plan, ti: number): void { p.target = ti; out.push(p); }

const ROUTE_FAMILY: PlanFamily = { id: 'passiveRoute', situations: SITS, generate(v, out) {
  const kind = passiveKind(v);
  if (kind === 'none') return;
  const ti = targetIndex(v);
  if (ti < 0) return;
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const tg = s.fighters[ti];
  const g = stageGeo(stageOfState(s));
  const frame = s.frame;
  const gap = grabGap(v);

  // Throw from a grab hold.
  if (me.action === 'grabHold') {
    const ids = throwList(v.me);
    let best: ThrowId | null = null; let bs = -Infinity;
    for (let i = 0; i < ids.length; i++) {
      const sc = throwScore(v, ids[i]);
      if (sc > bs) { bs = sc; best = ids[i]; }
    }
    if (best === null) return;
    const p = pool.get(v.slot, 0).set('passiveRoute', nameFor('route', best, ''), null, 2,
      v.me.grab.throws[best].release + 8, PF_ATTACK, PR_ROUTE + 2, K_COMMIT);
    p.moveCode = codeOf(best); p.prog = null; p.fn = routeFn; p.prep = prepRoute; p.data = F_THROW;
    routeCtx(p, me.x, me.facing, frame);
    emit(out, p, ti);
    return;
  }
  if (!me.onGround || me.hitstun > 0 || me.hitlag > 0) return;
  if (me.action !== 'idle' && me.action !== 'walk' && me.action !== 'dash' && me.action !== 'run'
    && me.action !== 'turn' && me.action !== 'crouch' && me.action !== 'land') return;

  // Hanging on the ledge: poke it off when its ledge invulnerability ends.
  if (tg.action === 'ledgeHang') {
    const id = ledgePoke(v, tg.percent);
    const side = tg.x < g.cx ? -1 : 1;
    const edge = side < 0 ? g.left : g.right;
    const sp = ledgeSpike(v, ti, side, edge);
    if (sp !== null) {
      const p = pool.get(v.slot, 7).set('passiveRoute', nameFor('routeSpike', sp.move, ''), sp.move, 2, 150,
        PF_ATTACK | PF_INTR | PF_TAIL, PR_ROUTE + 1, K_COMMIT);
      p.prog = null; p.fn = spikeFn; p.prep = prepRoute; p.data = sp.data;
      routeCtx(p, sp.x, side, frame + Math.max(0, invulnFrames(tg) - sp.hitAt + 1));
      emit(out, p, ti);
      return;
    }
    if (id !== null) {
      const m = v.me.moves[id];
      const inset = Math.max(4, Math.min(20, m.reach.front - 4));
      const p = pool.get(v.slot, 1).set('passiveRoute', nameFor('routeLedge', id, ''), id, 2, 80, PF_ATTACK | PF_INTR,
        PR_ROUTE, K_COMMIT);
      p.prog = null; p.fn = routeFn; p.prep = prepRoute; p.data = F_MOVE;
      routeCtx(p, edge - side * inset, side, frame + Math.max(0, invulnFrames(tg) - m.startup + 1));
      emit(out, p, ti);
    } else {
      const p = pool.get(v.slot, 2).set('passiveRoute', 'routeLedgeWait', null, 1, 30, PF_INTR, PR_ROUTE - 4, K_HOLD);
      p.prog = null; p.fn = routeFn; p.prep = prepRoute; p.data = F_NONE;
      routeCtx(p, edge - side * 40, side, frame);
      emit(out, p, ti);
    }
    return;
  }

  // Dead or on the respawn platform: wait next to where it will land.
  if (tg.action === 'dead' || tg.action === 'respawn') {
    const rx = s.fighters[ti].action === 'dead' ? stageOfState(s).respawn.x : tg.x;
    const side = me.x <= rx ? -1 : 1;
    const p = pool.get(v.slot, 3).set('passiveRoute', 'routeSpawnWait', null, 1, 30, PF_INTR, PR_ROUTE, K_HOLD);
    p.prog = null; p.fn = routeFn; p.prep = prepRoute; p.data = F_NONE;
    routeCtx(p, clampStage(rx + side * gap, v), -side, frame);
    emit(out, p, ti);
    return;
  }

  // Airborne: grab the landing when it lands on the stage, else hold near the ledge it went past.
  if (!tg.onGround) {
    if (suspendedInAir(v, ti)) return;
    const n = predictLanding(v, ti, LANDING);
    const land = LANDING.items[LP_NONE];
    if (n > 0 && land.valid && land.x >= g.left && land.x <= g.right && land.t <= 120) {
      const side = me.x <= land.x ? -1 : 1;
      const gr = v.me.grab.standing;
      const fire = frame + Math.max(land.t - gr.active[0] + 1, invulnFrames(tg) - gr.active[0] + 1);
      const p = pool.get(v.slot, 4).set('passiveRoute', 'routeLandGrab', null, 1, Math.min(150, land.t + gr.total + 4),
        PF_ATTACK | PF_INTR, PR_ROUTE, K_APPROACH);
      p.prog = null; p.fn = routeFn; p.prep = prepRoute; p.data = F_GRAB;
      routeCtx(p, clampStage(land.x + side * gap, v), -side, fire);
      emit(out, p, ti);
      return;
    }
    const side = tg.x < g.cx ? -1 : 1;
    const p = pool.get(v.slot, 5).set('passiveRoute', 'routeEdgeWait', null, 1, 30, PF_INTR, PR_ROUTE - 2, K_HOLD);
    p.prog = null; p.fn = routeFn; p.prep = prepRoute; p.data = F_NONE;
    routeCtx(p, (side < 0 ? g.left : g.right) - side * EDGE_WAIT, side, frame);
    emit(out, p, ti);
    return;
  }

  // Standing: grab it from our side once it can be grabbed.
  const side = me.x <= tg.x ? -1 : 1;
  const gr = v.me.grab.standing;
  const wait = Math.max(invulnFrames(tg), tg.hitstun + tg.hitlag) - gr.active[0] + 1;
  const p = pool.get(v.slot, 6).set('passiveRoute', 'routeGrab', null, 1, 150, PF_ATTACK | PF_INTR, PR_ROUTE, K_APPROACH);
  p.prog = null; p.fn = routeFn; p.prep = prepRoute; p.data = F_GRAB;
  routeCtx(p, clampStage(tg.x + side * gap, v), -side, frame + Math.max(0, wait));
  emit(out, p, ti);
} };

/** The passive-route family (a candidate, not a script override). */
export const PASSIVE_FAMILIES: readonly PlanFamily[] = [ROUTE_FAMILY];
