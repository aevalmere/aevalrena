/**
 * Rollouts (02 sections 7.1, 7.2, 7.6; 15 for three and four players).
 *
 * For each candidate plan, for each sample of (hidden-frame hypothesis, joint reply), clone the
 * perceived state, run the plan against the replies for the common window W, and score the end
 * with the style weights. W is one number per decision: 45 frames, 60 when any candidate is a kill
 * or spike plan; a plan shorter than W is padded with the neutral continuation (stand, or recover
 * when off the stage), so no plan collects terms another cannot.
 *
 * Joint replies. Every live enemy replies, not only the target: the target plays the sample's
 * primary reply, every other enemy a reply drawn from the same weighted set by a stratified,
 * seeded rotation (so across the K samples each secondary enemy's replies follow the weights).
 * Teammates and everyone out of play keep holding what they held. The outcome sums damage and KO
 * terms over every enemy and prices being caught between or among several (outcome.ts).
 *
 * Hypotheses. A hypothesis "the target started X `ago` frames ago" is applied once per decision:
 * the perceived state is stepped `ago` frames with the target pressing X and everyone else holding,
 * then everyone but the target (and the target's new shots) is put back as perceived. A hypothesis
 * under which the target would already have touched us is inconsistent with what we know of our
 * own fighter and falls back to the perceived state.
 *
 * Samples. The (hypothesis, primary reply) cells are ranked by joint weight; every candidate uses
 * the same top K cells (common samples, so values compare), K = the budget divided by candidates
 * times W, at least 1 and at most MAX_SAMPLES. Candidates run in the given (priority) order; when
 * the budget cannot pay for a candidate's K rollouts it and every later candidate are left out.
 *
 * Budget. Counted in sim steps (every stepGame call, the hypothesis steps included), never time.
 * A rollout is only started when the steps it needs fit: `steps <= budget` always holds, except the
 * single-rollout floor when the budget is below one window, which returns static scores and 0 steps.
 *
 * Nothing here mutates `v.p.state`; all stepping happens on pooled copies. Deterministic: the only
 * randomness is u01 keyed on (seed, slot, frame).
 */
import type { FighterState, GameState, InputFrame, ProjectileState, StageDef } from '../../core/types';
import { Btn, DIRECT_CODES } from '../../core/types';
import { STAGE_DEFS } from '../../stages/registry';
import { cloneGameState, stepGame } from '../../sim';
import { isLedgeAction } from '../../sim/ledge';
import { sameTeam } from '../../sim/state';
import type {
  ComboTable, DecisionView, Hypothesis, Intent, Outcome, PlanCtx, PlanInstance, ReplyModel, RunRolloutsFn, Scored,
  Spot, StarterId,
} from '../contracts';
import { PF_ATTACK, PF_INTR, PF_KILL, PF_PROJ, PF_SPIKE, PF_STALE } from '../contracts';
import { STREAM, u01 } from '../rng';
import {
  CONTINUITY_POINTS, CYCLE_COST, MAX_FIGHTERS, STALE_COST, SURE_FS, SURE_KILL, finishOutcome, homeSign, newOutcome,
  newTally, offstage, resetTally, scoreOutcome, spotOf, stageInfo, type OutcomeCtx, type ScoredExtra, type StageInfo,
} from './outcome';
import { blendValue, cvar, runningPlanName, weightedMean } from './select';
import type { ReplySets } from '../model/replies';

/** Common window, frames (02 section 7.2). */
export const WINDOW = 45;
/** Common window when any candidate is a kill or spike plan. */
export const WINDOW_KILL = 60;
/** Longest window a payoff hint may stretch to (the kill window). */
export const WINDOW_MAX = 60;
/** Frames past a declared payoff the window still runs (the launch or the landing shows). */
export const PAYOFF_SLACK = 6;
/** Samples per candidate at most (the Scored arrays' capacity). */
export const MAX_SAMPLES = 64;
/** Hypotheses kept at most (02 section 3: 4 to 6). */
export const MAX_HYP = 6;
/** Frames a hypothesis may reach back. */
const MAX_AGO = 30;

let windowNeutral = WINDOW;
let windowKill = WINDOW_KILL;
/**
 * Sets the common windows for later calls (W3.1): `w` for every decision, `wKill` when any
 * candidate is a kill or spike plan. The brain shortens the neutral window (a long neutral
 * continuation after short plans drowned their differences in the harness); the defaults are
 * WINDOW and WINDOW_KILL.
 */
export function setRolloutWindows(w: number, wKill: number): void {
  windowNeutral = w > 0 ? Math.floor(w) : WINDOW;
  windowKill = wKill > 0 ? Math.floor(wKill) : WINDOW_KILL;
}

// ---------------------------------------------------------------------------------------------
// Pooled state copy (ported from aevalmere.ts copyGameStateInto)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
let fPrim: string[] = [];
let fObj: string[] = [];
let fObjSub: string[][] = [];
let gPrim: string[] = [];
let gObj: string[] = [];
let gObjSub: string[][] = [];
let keysLearned = false;

/**
 * Learns the field lists from a live state once. `stats` is not copied (results bookkeeping the sim
 * never branches on; a scratch state keeps its own so a simulated future never reaches the real
 * one). `activeThrow` is immutable def data, shared by reference.
 */
function learnKeys(src: GameState): void {
  const f = src.fighters[0] as unknown as Rec;
  fPrim = []; fObj = []; fObjSub = [];
  for (const k of Object.keys(f)) {
    const val = f[k];
    if (k === 'stats') continue;
    if (k !== 'activeThrow' && val !== null && typeof val === 'object') { fObj.push(k); fObjSub.push(Object.keys(val as Rec)); }
    else fPrim.push(k);
  }
  gPrim = []; gObj = []; gObjSub = [];
  const s = src as unknown as Rec;
  for (const k of Object.keys(s)) {
    if (k === 'fighters' || k === 'projectiles' || k === 'events' || k === 'config') continue;
    const val = s[k];
    if (val !== null && typeof val === 'object') { gObj.push(k); gObjSub.push(Object.keys(val as Rec)); }
    else gPrim.push(k);
  }
  keysLearned = true;
}

function copyFighterInto(src: FighterState, dst: FighterState): void {
  const s = src as unknown as Rec;
  const d = dst as unknown as Rec;
  for (let i = 0; i < fPrim.length; i++) { const k = fPrim[i]; d[k] = s[k]; }
  for (let i = 0; i < fObj.length; i++) {
    const so = s[fObj[i]] as Rec;
    const dd = d[fObj[i]] as Rec;
    const sub = fObjSub[i];
    for (let j = 0; j < sub.length; j++) dd[sub[j]] = so[sub[j]];
  }
}

function copyProjectileInto(s: ProjectileState, d: ProjectileState): void {
  d.id = s.id; d.owner = s.owner; d.defId = s.defId;
  d.x = s.x; d.y = s.y; d.vx = s.vx; d.vy = s.vy;
  d.facing = s.facing; d.age = s.age; d.hitSlots = s.hitSlots; d.alive = s.alive;
  d.power = s.power; d.scale = s.scale; d.returned = s.returned; d.charge = s.charge ?? 0;
  d.spawnX = s.spawnX ?? s.x; d.spawnY = s.spawnY ?? s.y;
}

function projectileAt(dp: ProjectileState[], i: number): ProjectileState {
  while (dp.length <= i) {
    dp.push({ id: 0, owner: 0, defId: '', x: 0, y: 0, vx: 0, vy: 0, facing: 1, age: 0, hitSlots: 0,
      alive: false, power: 1, scale: 1, returned: false, charge: 0 });
  }
  return dp[i];
}

/**
 * Copies `src` into the pooled `dst` without allocating once the pool has grown. Projectile slots
 * past the source's are kept and marked dead; the sim skips dead slots.
 */
export function copyStateInto(src: GameState, dst: GameState): void {
  if (!keysLearned) learnKeys(src);
  const s = src as unknown as Rec;
  const d = dst as unknown as Rec;
  for (let i = 0; i < gPrim.length; i++) { const k = gPrim[i]; d[k] = s[k]; }
  for (let i = 0; i < gObj.length; i++) {
    const so = s[gObj[i]] as Rec;
    const dd = d[gObj[i]] as Rec;
    const sub = gObjSub[i];
    for (let j = 0; j < sub.length; j++) dd[sub[j]] = so[sub[j]];
  }
  dst.config = src.config;
  dst.events.length = 0;
  const sf = src.fighters, df = dst.fighters;
  if (df.length !== sf.length) {
    const fresh = cloneGameState(src).fighters;
    df.length = 0;
    for (let i = 0; i < fresh.length; i++) df.push(fresh[i]);
  }
  for (let i = 0; i < sf.length; i++) copyFighterInto(sf[i], df[i]);
  const sp = src.projectiles, dp = dst.projectiles;
  for (let i = 0; i < sp.length; i++) copyProjectileInto(sp[i], projectileAt(dp, i));
  for (let i = sp.length; i < dp.length; i++) dp[i].alive = false;
}

// ---------------------------------------------------------------------------------------------
// Pools and scratch
// ---------------------------------------------------------------------------------------------

let work: GameState | null = null;
let scratch: GameState | null = null;
const hypStates: (GameState | null)[] = [];
for (let i = 0; i < MAX_HYP; i++) hypStates.push(null);

function pooled(p: GameState | null, like: GameState): GameState {
  if (p === null || p.fighters.length !== like.fighters.length) return cloneGameState(like);
  return p;
}

const inputs: InputFrame[] = [];
for (let i = 0; i < MAX_FIGHTERS; i++) inputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });
const prevHeld = new Int32Array(MAX_FIGHTERS);
const tOf = new Int32Array(MAX_FIGHTERS);
const intent: Intent = { held: 0, direct: 0, mash: 0 };
const lastHeld = new Int32Array(MAX_FIGHTERS);
const side = new Uint8Array(MAX_FIGHTERS);
const enemyList = new Int32Array(MAX_FIGHTERS);
/**
 * Enemies seen standing still in the air (plans/advantage.ts suspendedInAir, on the raw delayed
 * snapshot): the rollouts keep them where they were seen until something hits them, instead of
 * letting them fall into a trap they have shown they will not fall into.
 */
const pinOn = new Uint8Array(MAX_FIGHTERS);
const pinX = new Float64Array(MAX_FIGHTERS);
const pinY = new Float64Array(MAX_FIGHTERS);
const pinLive = new Uint8Array(MAX_FIGHTERS);
const rot = new Float64Array(MAX_FIGHTERS);

function newCtx(): PlanCtx {
  return { dir: 1, home: 1, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0,
    me: null as unknown as PlanCtx['me'], stage: null as unknown as StageDef };
}
const planCtx = newCtx();
const replyCtx: PlanCtx[] = [];
for (let i = 0; i < MAX_FIGHTERS; i++) replyCtx.push(newCtx());

const tally = newTally();
const outcome: Outcome = newOutcome();
const octx: OutcomeCtx = {
  meI: 0, targetI: 0, side, me: null as unknown as OutcomeCtx['me'], si: { minX: 0, maxX: 0, topY: 0, botY: 0, cx: 0 },
  blast: { x: 0, y: 0, w: 0, h: 0 }, basePct: 0, baseStocks: 0, spacing: 50, pressure: 0, repetition: 0, continuity: 0,
};

// Cells: (hypothesis, primary reply) pairs ranked by joint weight.
const MAX_CELLS = MAX_HYP * 32;
const cellH = new Int32Array(MAX_CELLS);
const cellR = new Int32Array(MAX_CELLS);
const cellW = new Float64Array(MAX_CELLS);
const hypW = new Float64Array(MAX_HYP);
const hypValid = new Uint8Array(MAX_HYP);
const hypPrepped = new Uint8Array(MAX_HYP);
let replyW: Float64Array = new Float64Array(32);
let replyCum: Float64Array = new Float64Array(32);
/** Reply index per (sample, fighter), -1 = continue. */
const sampleReply = new Int32Array(MAX_SAMPLES * MAX_FIGHTERS);
/** Reply list each fighter plays from this decision (null = keeps holding its input). */
const fRep: (readonly ReplyModel[] | null)[] = [];
const fN = new Int32Array(MAX_FIGHTERS);
/** Cumulative normalized weights of each secondary enemy's list. */
const fCum: Float64Array[] = [];
for (let i = 0; i < MAX_FIGHTERS; i++) { fRep.push(null); fCum.push(new Float64Array(32)); }
const EMPTY_REPLIES: readonly ReplyModel[] = [];
const hypList: Hypothesis[] = [];
const NONE_HYP: Hypothesis = { kind: 'none', move: null, ago: 0, dir: 0, weight: 1 };

/** Scored record with the sure-tier flags select.ts reads. */
class ScoredRec implements Scored, ScoredExtra {
  plan: PlanInstance;
  w = new Float64Array(MAX_SAMPLES);
  J = new Float64Array(MAX_SAMPLES);
  n = 0; cvar = 0; mean = 0; value = 0; stockLossWeight = 0; certainLoss = false;
  sure = 0; hitShare = 0;
  constructor(p: PlanInstance) { this.plan = p; }
}

/** What the last runRollouts call did, for the harness and the timing gate. */
export interface RolloutStats { steps: number; prepSteps: number; window: number; samples: number; candidates: number;
  scored: number; cells: number; enemies: number; budget: number; static: boolean }
const stats: RolloutStats = { steps: 0, prepSteps: 0, window: 0, samples: 0, candidates: 0, scored: 0, cells: 0,
  enemies: 0, budget: 0, static: false };
export function lastRolloutStats(): Readonly<RolloutStats> { return stats; }

// ---------------------------------------------------------------------------------------------
// Combo-table kill confirm, memoized per table (the table may build lazily)
// ---------------------------------------------------------------------------------------------

const confirmMemo = new WeakMap<ComboTable, Map<number, boolean>>();
const starterIds = new Map<string, number>();
const SPOT_INDEX: Record<Spot, number> = { center: 0, ledge: 1, offstage: 2 };

function killConfirm(table: ComboTable, starter: StarterId, percent: number, spot: Spot): boolean {
  let memo = confirmMemo.get(table);
  if (memo === undefined) { memo = new Map(); confirmMemo.set(table, memo); }
  let si = starterIds.get(starter);
  if (si === undefined) { si = starterIds.size; starterIds.set(starter, si); }
  const b = table.bracketOf(percent);
  const key = (si * 64 + b) * 4 + SPOT_INDEX[spot];
  let r = memo.get(key);
  if (r === undefined) { r = table.killConfirm(starter, b, spot); memo.set(key, r); }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

function dirBit(d: number): number { return d > 0 ? Btn.Right : d < 0 ? Btn.Left : 0; }

/** Writes an input frame for fighter i from `intent`, deriving pressed and released. */
function setInput(i: number, held: number, direct: number): void {
  const inp = inputs[i];
  const prev = prevHeld[i];
  inp.held = held; inp.pressed = held & ~prev; inp.released = prev & ~held; inp.direct = direct;
  prevHeld[i] = held;
}

function holdInput(i: number, held: number): void {
  const inp = inputs[i];
  inp.held = held; inp.pressed = 0; inp.released = 0; inp.direct = 0;
  prevHeld[i] = held;
}

/**
 * Neutral continuation after a plan's horizon: stand; off the stage, drift home, jump when falling
 * below the stage top with a jump left, then the up special (Up + Special) when out of jumps.
 */
function neutralStep(f: FighterState, si: StageInfo, prev: number, out: Intent): void {
  out.held = 0; out.direct = 0; out.mash = 0;
  if (f.onGround || isLedgeAction(f.action) || !offstage(f, si)) return;
  const home = homeSign(f.x, f.y, si);
  let held = dirBit(home);
  if (f.vy > 0 && f.y > si.topY - 30 && f.action !== 'airHelpless') {
    if (f.jumpsLeft > 0) { if ((prev & Btn.Jump) === 0) held |= Btn.Jump; }
    else if (f.y > si.topY + 20 && (prev & Btn.Special) === 0) held |= Btn.Up | Btn.Special;
  }
  out.held = held;
}

/** The hypothesis as the target's input on its k-th hidden frame. */
function hypInput(h: Hypothesis, k: number, out: Intent): void {
  out.held = 0; out.direct = 0; out.mash = 0;
  const d = dirBit(h.dir);
  switch (h.kind) {
    case 'move': {
      if (k === 0) {
        const code = h.move === null ? -1 : (DIRECT_CODES as readonly string[]).indexOf(h.move);
        if (code >= 0) out.direct = code + 1; else out.held = Btn.Attack;
      }
      out.held |= d;
      return;
    }
    case 'shield': out.held = Btn.Shield; return;
    case 'spotDodge': out.held = k === 0 ? Btn.Dodge : 0; return;
    case 'roll': out.held = d | (k === 0 ? Btn.Dodge : 0); return;
    case 'airDodge': out.held = d | (k === 0 ? Btn.Dodge : 0); return;
    case 'jump': out.held = d | (k === 0 ? Btn.Jump : 0); return;
    default: return;
  }
}

// ---------------------------------------------------------------------------------------------
// Hypothesis preparation
// ---------------------------------------------------------------------------------------------

/**
 * Builds hypStates[h] from `base`: steps `ago` frames on the scratch with the target acting out
 * the hypothesis, then copies the target (and its new shots) back into a copy of the base.
 * Returns the steps used; marks the hypothesis invalid when it would already have touched us.
 */
function prepHypothesis(h: number, hyp: Hypothesis, base: GameState, meI: number, tgt: number): number {
  const ago = hyp.ago < 0 ? 0 : hyp.ago > MAX_AGO ? MAX_AGO : Math.floor(hyp.ago);
  hypPrepped[h] = 1;
  if (hyp.kind === 'none' || ago === 0) { hypValid[h] = 0; return 0; }
  scratch = pooled(scratch, base);
  copyStateInto(base, scratch);
  const fs = scratch.fighters;
  const nf = fs.length;
  for (let i = 0; i < nf; i++) prevHeld[i] = fs[i].inputHeld;
  const meSlot = fs[meI].slot, tSlot = fs[tgt].slot;
  let ok = true;
  let steps = 0;
  for (let k = 0; k < ago && ok; k++) {
    for (let i = 0; i < nf; i++) {
      if (i === tgt) { hypInput(hyp, k, intent); setInput(i, intent.held, intent.direct); }
      else holdInput(i, fs[i].inputHeld);
    }
    stepGame(scratch, inputs);
    steps++;
    const ev = scratch.events;
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if ((x.type === 'hit' || x.type === 'grab' || x.type === 'throw') && (x.victim === meSlot || x.attacker === tSlot)) ok = false;
      else if (x.type === 'shieldHit' && x.victim === meSlot) ok = false;
      else if (x.type === 'ko' && x.slot === tSlot) ok = false;
    }
    if (scratch.finished) ok = false;
  }
  const t = fs[tgt] as FighterState & { grabPartner?: number };
  if (t.grabPartner !== undefined && t.grabPartner >= 0) ok = false;
  if (!ok) { hypValid[h] = 0; return steps; }
  const dst = pooled(hypStates[h], base);
  hypStates[h] = dst;
  copyStateInto(base, dst);
  copyFighterInto(fs[tgt], dst.fighters[tgt]);
  // The target's shots fired during the hidden frames.
  let np = base.projectiles.length;
  const sp = scratch.projectiles;
  for (let i = 0; i < sp.length; i++) {
    const p = sp[i];
    if (!p.alive || p.owner !== tSlot || p.id < base.nextProjectileId) continue;
    copyProjectileInto(p, projectileAt(dst.projectiles, np));
    np++;
  }
  dst.nextProjectileId = scratch.nextProjectileId;
  hypValid[h] = 1;
  return steps;
}

// ---------------------------------------------------------------------------------------------
// One rollout
// ---------------------------------------------------------------------------------------------

function clamp01(x: number): number { return x > 1 ? 1 : x > 0 ? x : 0; }

/**
 * Runs `plan` from `src` for W frames against the sample's replies, fills `tally` and `outcome`.
 * Returns the steps used.
 */
function rolloutOnce(v: DecisionView, plan: PlanInstance, src: GameState, sample: number, W: number,
  si: StageInfo): number {
  const st = work = pooled(work, src);
  copyStateInto(src, st);
  const fs = st.fighters;
  const nf = fs.length;
  const meI = v.p.meI;
  const table = v.me.comboTable;
  for (let i = 0; i < nf; i++) { prevHeld[i] = fs[i].inputHeld; tOf[i] = 0; lastHeld[i] = fs[i].inputHeld; pinLive[i] = pinOn[i]; }
  resetTally(tally);
  const meSlot = fs[meI].slot;
  let steps = 0;
  for (let t = 0; t < W; t++) {
    const m = fs[meI];
    const frame = st.frame;
    // Us: the plan, then the neutral continuation.
    if (m.hitlag > 0) holdInput(meI, lastHeld[meI]);
    else {
      planCtx.frame = frame;
      const tm = tOf[meI]++;
      if (tm < plan.horizon) plan.script(tm, m, planCtx, intent);
      else neutralStep(m, si, prevHeld[meI], intent);
      let held = intent.held;
      if (intent.mash !== 0 && (tm & 1) === 0) held |= intent.mash;
      setInput(meI, held, intent.direct);
      lastHeld[meI] = held;
    }
    // Everyone else.
    for (let i = 0; i < nf; i++) {
      if (i === meI) continue;
      const f = fs[i];
      const r = side[i] === 1 ? sampleReply[sample * MAX_FIGHTERS + i] : -1;
      if (r < 0 || f.hitlag > 0) { holdInput(i, r < 0 ? f.inputHeld : lastHeld[i]); continue; }
      const ctx = replyCtx[i];
      ctx.frame = frame;
      const tr = tOf[i]++;
      (fRep[i] as readonly ReplyModel[])[r].step(tr, f, m, ctx, intent);
      let held = intent.held;
      if (intent.mash !== 0 && (tr & 1) === 0) held |= intent.mash;
      setInput(i, held, intent.direct);
      lastHeld[i] = held;
    }
    for (let i = 0; i < nf; i++) {
      if (pinLive[i] === 0) continue;
      const f = fs[i];
      if (f.action !== 'air' || f.hitstun > 0 || f.hitlag > 0) { pinLive[i] = 0; continue; }
      f.x = pinX[i]; f.y = pinY[i]; f.vx = 0; f.vy = 0;
    }
    stepGame(st, inputs);
    steps++;
    const ev = st.events;
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if (x.type === 'hit') {
        const vi = indexOfSlot(fs, x.victim);
        if (x.attacker === meSlot && vi >= 0 && side[vi] === 1) {
          tally.dealt += x.damage;
          tally.dealtTo[vi] += x.damage;
          if (tally.hitFrame < 0) tally.hitFrame = t;
          // A starter whose table chain kills from the victim's bracket and spot.
          const mf = fs[meI] as FighterState & { activeThrowId?: string | null };
          const starter = mf.action === 'throw' && mf.activeThrowId !== undefined && mf.activeThrowId !== null
            && mf.activeThrowId !== 'custom' ? mf.activeThrowId : mf.action === 'attack' ? mf.moveId : null;
          if (starter !== null && tally.chainOn[vi] === 0) {
            const vf = fs[vi];
            if (killConfirm(table, starter as StarterId, vf.percent, spotOf(vf, si))) tally.chainOn[vi] = 1;
          }
        } else if (x.victim === meSlot) tally.taken += x.damage;
        else if (vi >= 0 && side[vi] === 2) tally.mateTaken += x.damage;
      } else if (x.type === 'ko') {
        const ki = indexOfSlot(fs, x.slot);
        if (x.slot === meSlot) tally.koMe++;
        else if (ki >= 0 && side[ki] === 1) { tally.koEnemy++; tally.koOf[ki]++; }
        else if (ki >= 0 && side[ki] === 2) tally.koMate++;
      } else if (x.type === 'grab') {
        const gi = indexOfSlot(fs, x.victim);
        if (x.attacker === meSlot && gi >= 0 && side[gi] === 1) tally.grabbed = true;
      } else if (x.type === 'finalSmash') {
        const fi = indexOfSlot(fs, x.victim);
        if (x.attacker === meSlot && fi >= 0 && side[fi] === 1) tally.fsCaught = true;
      }
    }
    if (st.finished) break;
  }
  finishOutcome(st, tally, octx, outcome);
  return steps;
}

function indexOfSlot(fs: readonly FighterState[], slot: number): number {
  for (let i = 0; i < fs.length; i++) if (fs[i].slot === slot) return i;
  return -1;
}

// ---------------------------------------------------------------------------------------------
// runRollouts
// ---------------------------------------------------------------------------------------------

/** Preferred ground spacing: the style multiple of our first neutral move's forward reach. */
function spacingOf(v: DecisionView): number {
  let reach = 50;
  const nm = v.me.roles.neutral;
  if (nm.length > 0) { const mv = v.me.moves[nm[0]]; if (mv !== undefined && mv.reach.front > 0) reach = mv.reach.front; }
  const sm = v.style.spacingMul;
  const mul = sm === 'adaptive' ? 1.1 : (sm[0] + sm[1]) / 2;
  return reach * mul;
}

function scoredAt(out: Scored[], i: number, p: PlanInstance): ScoredRec {
  const cur = out[i];
  if (cur instanceof ScoredRec) { cur.plan = p; return cur; }
  const s = new ScoredRec(p);
  if (i < out.length) out[i] = s; else out.push(s);
  return s;
}

export const runRollouts: RunRolloutsFn = (v: DecisionView, cands: readonly PlanInstance[], replies: readonly ReplyModel[],
  budget: number, out: Scored[]): number => rolloutCore(v, cands, replies, null, budget, out);

/**
 * Joint entry (02 section 15): every live enemy plays from its own reply set in `sets`
 * (model/replies.ts buildReplySets). The target's set forms the ranked cells with the hypotheses,
 * every other enemy draws from its own set by the stratified seeded rotation, and teammates (and
 * any fighter without a set) keep holding their current input ("continue"). Same budget and output
 * contract as runRollouts.
 */
export function runRolloutsJoint(v: DecisionView, cands: readonly PlanInstance[], sets: ReplySets, budget: number,
  out: Scored[]): number {
  return rolloutCore(v, cands, null, sets, budget, out);
}

function rolloutCore(v: DecisionView, cands: readonly PlanInstance[], flat: readonly ReplyModel[] | null,
  sets: ReplySets | null, budget: number, out: Scored[]): number {
  const base = v.p.state;
  const meI = v.p.meI;
  const tgt = v.p.oppI;
  const fs = base.fighters;
  const nf = fs.length < MAX_FIGHTERS ? fs.length : MAX_FIGHTERS;
  const frame = v.p.frame;
  const si = stageInfo(base.stageId);
  const stage = STAGE_DEFS[base.stageId];
  const me = fs[meI];
  const nC = cands.length;

  // Sides: 1 enemy (live), 2 teammate, 0 us or out of play.
  let nEnemy = 0;
  for (let i = 0; i < nf; i++) {
    side[i] = 0;
    if (i === meI) continue;
    if (sameTeam(base, me.slot, fs[i].slot)) { side[i] = 2; continue; }
    if (fs[i].stocks > 0 && fs[i].action !== 'dead') side[i] = 1;
  }
  // The target first, then the other enemies in index order.
  if (tgt >= 0 && tgt < nf && side[tgt] === 1) enemyList[nEnemy++] = tgt;
  for (let i = 0; i < nf; i++) if (side[i] === 1 && i !== tgt) enemyList[nEnemy++] = i;

  // Suspended enemies (see pinOn).
  {
    const d = (v.p as { delayed?: GameState | null }).delayed;
    for (let i = 0; i < nf; i++) {
      pinOn[i] = 0;
      if (side[i] !== 1 || d === undefined || d === null || i >= d.fighters.length) continue;
      const f = d.fighters[i];
      if (!f.onGround && f.action === 'air' && f.vy === 0 && f.vx === 0) { pinOn[i] = 1; pinX[i] = f.x; pinY[i] = f.y; }
    }
  }

  // Window.
  let W = windowNeutral;
  for (let c = 0; c < nC; c++) if ((cands[c].flags & (PF_KILL | PF_SPIKE)) !== 0) { W = windowKill; break; }
  // Plans whose payoff lands late (PlanInstance.payoffAt) stretch the window up to WINDOW_MAX while
  // the budget still pays one sample per candidate (docs/CPU_STRENGTH_LEDGER.md loop 6).
  {
    let want = 0;
    for (let c = 0; c < nC; c++) { const pa = cands[c].payoffAt; if (pa !== undefined && pa + PAYOFF_SLACK > want) want = pa + PAYOFF_SLACK; }
    if (want > W) {
      const afford = Math.floor(budget / (nC > 0 ? nC : 1));
      const to = want < WINDOW_MAX ? want : WINDOW_MAX;
      const w2 = to < afford ? to : afford;
      if (w2 > W) W = w2;
    }
  }

  // Outcome context shared by every rollout of this decision.
  octx.meI = meI; octx.targetI = nEnemy > 0 ? enemyList[0] : tgt; octx.me = v.me;
  octx.si = si; octx.blast = stage.blast;
  octx.basePct = me.percent; octx.baseStocks = me.stocks;
  octx.spacing = spacingOf(v);
  octx.pressure = clamp01(v.tempo.pressure());
  let lambda = v.style.lambda;
  if (v.stocksAhead >= 1 && base.config.timeLimitSec <= 0 && v.style.lambdaAheadMin > lambda) lambda = v.style.lambdaAheadMin;
  lambda = clamp01(lambda);
  const running = runningPlanName(v.slot);
  const cycling = v.tempo.cycle();

  stats.budget = budget; stats.window = W; stats.candidates = nC; stats.enemies = nEnemy;
  stats.prepSteps = 0; stats.steps = 0; stats.samples = 0; stats.scored = 0; stats.cells = 0; stats.static = false;

  // Static evaluation: no rollout fits (level 1, or a budget under one window).
  if (!(budget >= W) || nC === 0) {
    stats.static = true;
    resetTally(tally);
    for (let c = 0; c < nC; c++) {
      const p = cands[c];
      octx.repetition = repetitionOf(v, p, running, cycling);
      octx.continuity = p.name === running ? CONTINUITY_POINTS : 0;
      finishOutcome(base, tally, octx, outcome);
      const J = scoreOutcome(outcome, v.style.w);
      const s = scoredAt(out, c, p);
      s.n = 1; s.w[0] = 1; s.J[0] = J; s.cvar = J; s.mean = J; s.value = J + p.bonus;
      s.stockLossWeight = tally.lost ? 1 : 0; s.certainLoss = tally.lost; s.sure = 0; s.hitShare = 0;
    }
    out.length = nC;
    stats.scored = nC;
    return 0;
  }

  // Hypotheses (at most MAX_HYP, weights normalized; none given = one 'none').
  hypList.length = 0;
  let hw = 0;
  const hyps = v.p.hyps;
  for (let i = 0; i < hyps.length && hypList.length < MAX_HYP; i++) {
    if (hyps[i].weight > 0) { hypList.push(hyps[i]); hw += hyps[i].weight; }
  }
  if (hypList.length === 0) { hypList.push(NONE_HYP); hw = 1; }
  const nH = hypList.length;
  for (let h = 0; h < nH; h++) { hypW[h] = hypList[h].weight / hw; hypValid[h] = 0; hypPrepped[h] = 0; }

  // Reply list per fighter: the flat list for every enemy, or each enemy's own set.
  for (let i = 0; i < MAX_FIGHTERS; i++) { fRep[i] = null; fN[i] = 0; }
  if (sets !== null) {
    for (let c = 0; c < sets.count; c++) {
      const i = sets.fighter[c];
      if (i < 0 || i >= nf || side[i] !== 1 || sets.teammate[c] === 1) continue;
      const lst = sets.sets[c];
      fRep[i] = lst; fN[i] = sets.n[c] < lst.length ? sets.n[c] : lst.length;
    }
  } else if (flat !== null) {
    for (let i = 0; i < nf; i++) if (side[i] === 1) { fRep[i] = flat; fN[i] = flat.length; }
  }
  const primary = nEnemy > 0 ? enemyList[0] : -1;
  const primList = primary >= 0 ? fRep[primary] : null;
  const replies: readonly ReplyModel[] = primList !== null ? primList : EMPTY_REPLIES;
  // Replies (weights normalized; none given = one implicit "continue", index -1).
  const nR = primList !== null ? fN[primary] : 0;
  if (replyW.length < nR + 1) { replyW = new Float64Array(nR * 2 + 2); replyCum = new Float64Array(nR * 2 + 2); }
  let rw = 0;
  for (let r = 0; r < nR; r++) { const x = replies[r].weight > 0 ? replies[r].weight : 0; replyW[r] = x; rw += x; }
  const noReplies = !(rw > 0);
  if (!noReplies) {
    let cum = 0;
    for (let r = 0; r < nR; r++) { replyW[r] /= rw; cum += replyW[r]; replyCum[r] = cum; }
  }

  // Cells ranked by joint weight (stable: hypothesis then reply order on ties).
  let nCells = 0;
  const rCount = noReplies ? 1 : nR;
  for (let h = 0; h < nH; h++) {
    for (let r = 0; r < rCount && nCells < MAX_CELLS; r++) {
      const w = hypW[h] * (noReplies ? 1 : replyW[r]);
      if (!(w > 0)) continue;
      let k = nCells - 1;
      while (k >= 0 && cellW[k] < w) { cellH[k + 1] = cellH[k]; cellR[k + 1] = cellR[k]; cellW[k + 1] = cellW[k]; k--; }
      cellH[k + 1] = h; cellR[k + 1] = noReplies ? -1 : r; cellW[k + 1] = w;
      nCells++;
    }
  }
  if (nCells === 0) { cellH[0] = 0; cellR[0] = -1; cellW[0] = 1; nCells = 1; }
  stats.cells = nCells;

  // Samples per candidate, after the hypothesis steps the top cells need.
  const cap = nCells < MAX_SAMPLES ? nCells : MAX_SAMPLES;
  let K = Math.floor(budget / (nC * W));
  if (K > cap) K = cap;
  if (K < 1) K = 1;
  let prepNeed = 0;
  for (let h = 0; h < nH; h++) hypPrepped[h] = 0;
  for (let s = 0; s < K; s++) {
    const h = cellH[s];
    if (hypPrepped[h] === 0) { hypPrepped[h] = 1; const hy = hypList[h]; if (hy.kind !== 'none' && hy.ago > 0) prepNeed += hy.ago < MAX_AGO ? Math.floor(hy.ago) : MAX_AGO; }
  }
  let K2 = Math.floor((budget - prepNeed) / (nC * W));
  if (K2 > K) K2 = K;
  if (K2 < 1) K2 = 1;
  K = K2;
  // If the preparation leaves no room for one rollout, drop the hypotheses.
  const dropHyps = budget - prepNeed < K * W;
  for (let h = 0; h < nH; h++) hypPrepped[h] = 0;

  // Secondary enemies' replies per sample: stratified over each one's own reply weights with a
  // seeded rotation.
  for (let e = 1; e < nEnemy; e++) {
    const i = enemyList[e];
    rot[e] = u01(v.seed, v.slot, frame, STREAM.mix, 0x4000 + e);
    const lst = fRep[i];
    if (lst === null) continue;
    const n = fN[i];
    if (fCum[i].length < n + 1) fCum[i] = new Float64Array(n * 2 + 2);
    let tw = 0;
    for (let q = 0; q < n; q++) { const x = lst[q].weight; tw += x > 0 ? x : 0; }
    if (!(tw > 0)) { fN[i] = 0; continue; }
    let cum = 0;
    for (let q = 0; q < n; q++) { const x = lst[q].weight; cum += (x > 0 ? x : 0) / tw; fCum[i][q] = cum; }
  }
  for (let s = 0; s < K; s++) {
    for (let i = 0; i < nf; i++) sampleReply[s * MAX_FIGHTERS + i] = -1;
    if (nEnemy > 0) sampleReply[s * MAX_FIGHTERS + enemyList[0]] = cellR[s];
    for (let e = 1; e < nEnemy; e++) {
      const i = enemyList[e];
      const n = fRep[i] === null ? 0 : fN[i];
      let r = -1;
      if (n > 0) {
        let u = rot[e] + (s + 0.5) / K;
        if (u >= 1) u -= 1;
        r = n - 1;
        for (let q = 0; q < n; q++) if (u < fCum[i][q]) { r = q; break; }
      }
      sampleReply[s * MAX_FIGHTERS + i] = r;
    }
  }

  // Plan context (fixed at the decision) and reply contexts per enemy.
  const tf = nEnemy > 0 ? fs[enemyList[0]] : null;
  planCtx.dir = tf === null ? me.facing : tf.x > me.x ? 1 : tf.x < me.x ? -1 : me.facing;
  planCtx.home = homeSign(me.x, me.y, si);
  planCtx.edgeX = tf === null ? (me.x < si.cx ? si.minX : si.maxX) : (tf.x < si.cx ? si.minX : si.maxX);
  planCtx.fireAt = frame + (tf === null ? 0 : tf.invuln);
  planCtx.startFrame = frame; planCtx.frame = frame; planCtx.me = v.me; planCtx.stage = stage;
  for (let e = 0; e < nEnemy; e++) {
    const i = enemyList[e];
    const f = fs[i];
    const ctx = replyCtx[i];
    ctx.dir = me.x > f.x ? 1 : me.x < f.x ? -1 : f.facing;
    ctx.home = homeSign(f.x, f.y, si);
    ctx.edgeX = me.x < si.cx ? si.minX : si.maxX;
    ctx.fireAt = frame + me.invuln;
    ctx.param = 0;
    ctx.startFrame = frame; ctx.frame = frame; ctx.me = v.opp; ctx.stage = stage;
  }

  // Candidates in the given (priority) order.
  let used = 0;
  let nOut = 0;
  const w = v.style.w;
  for (let c = 0; c < nC; c++) {
    const p = cands[c];
    // Hypothesis steps still owed by the samples of this candidate.
    let owe = 0;
    if (!dropHyps) {
      for (let s = 0; s < K; s++) {
        const h = cellH[s];
        const hy = hypList[h];
        if (hypPrepped[h] === 0 && hy.kind !== 'none' && hy.ago > 0) owe += hy.ago < MAX_AGO ? Math.floor(hy.ago) : MAX_AGO;
      }
    }
    if (used + owe + K * W > budget) break;
    planCtx.param = p.param;
    octx.repetition = repetitionOf(v, p, running, cycling);
    octx.continuity = p.name === running && (p.flags & PF_INTR) !== 0 ? CONTINUITY_POINTS : 0;
    const s = scoredAt(out, nOut, p);
    let lossW = 0, hitW = 0, tw = 0;
    let fsAll = true, killAll = true;
    for (let k = 0; k < K; k++) {
      const h = cellH[k];
      let src = base;
      if (!dropHyps) {
        if (hypPrepped[h] === 0) {
          const ps = prepHypothesis(h, hypList[h], base, meI, octx.targetI);
          used += ps; stats.prepSteps += ps;
        }
        if (hypValid[h] === 1) src = hypStates[h] as GameState;
      }
      for (let e = 0; e < nEnemy; e++) {
        const i = enemyList[e];
        const r = sampleReply[k * MAX_FIGHTERS + i];
        replyCtx[i].param = r >= 0 ? (fRep[i] as readonly ReplyModel[])[r].arg : 0;
      }
      used += rolloutOnce(v, p, src, k, W, si);
      const J = scoreOutcome(outcome, w);
      const wk = cellW[k];
      s.w[k] = wk; s.J[k] = J;
      tw += wk;
      if (tally.lost) lossW += wk;
      if (outcome.hitLanded) hitW += wk;
      if (!tally.fsCaught) fsAll = false;
      if (!tally.killSure || tally.lost || !tally.home) killAll = false;
    }
    s.n = K;
    if (tw > 0) for (let k = 0; k < K; k++) s.w[k] /= tw;
    s.mean = weightedMean(s.w, s.J, K);
    s.cvar = cvar(s.w, s.J, K, v.style.alpha);
    s.stockLossWeight = tw > 0 ? lossW / tw : 0;
    s.certainLoss = s.stockLossWeight >= 0.5;
    s.hitShare = tw > 0 ? hitW / tw : 0;
    s.sure = (fsAll ? SURE_FS : 0) | (killAll ? SURE_KILL : 0);
    s.value = blendValue(s.cvar, s.mean, lambda) + p.bonus * ((p.flags & PF_ATTACK) !== 0 ? s.hitShare : 1);
    nOut++;
  }
  out.length = nOut;
  stats.steps = used; stats.samples = K; stats.scored = nOut;
  return used;
};

/** Staleness cost of a commitment (02 section 6.8) plus the cycle penalty when it repeats. */
function repetitionOf(v: DecisionView, p: PlanInstance, running: string, cycling: boolean): number {
  let r = 0;
  if ((p.flags & (PF_ATTACK | PF_STALE)) !== 0) {
    r += v.tempo.stale(p.name) * STALE_COST * ((p.flags & (PF_PROJ | PF_STALE)) !== 0 ? 2 : 1);
  }
  if (cycling && p.name === running) r += CYCLE_COST;
  return r;
}
