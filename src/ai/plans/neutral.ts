/**
 * Neutral plan families (docs/CPU_PLAN.md W2.4; cpu-guide 02 sections 5, 6.7, 8).
 *
 * Grounded neutral: wait, walk, dash, approach to a spacing, dash dance, empty hops, bait probes
 * (dash in and back, shield probe, a shot meant to be shielded), pokes and tilts (plain and
 * spaced), smashes and charged smashes, grab and dash grab, projectiles at the profile's holds,
 * short-hop, full-hop, fast-fall and retreating aerials, platform drop and jump, shield, spot
 * dodge, rolls, grounded specials, and whiff punishes. Out of shield: grab, up smash, up
 * special, jump aerials from the oos role, rolls, spot dodge, hold. Airborne: drift and fast
 * fall, each aerial, double jump (plus aerials), air dodges, specials. Multi-opponent
 * positioning: one side, centre, retreat to a platform or the ledge when sandwiched, and
 * disengage when two converge. Also respawn and Final Smash.
 *
 * Every move comes from the profile (tags, roles, classes by DIRECT_MOVES position); no move id is
 * written here. Families prefilter by reach: an attack that cannot connect inside its horizon is
 * not offered. The target is always `view.p.oppI` (the targeter's pick); a teammate target yields
 * movement only.
 */
import type { FighterState, MoveId } from '../../core/types';
import { CHARACTER_DEFS } from '../../characters/registry';
import type { DecisionView, MoveAiInfo, PlanCtx, PlanFamily, PlanFamilyId, PlanInstance, Situation } from '../contracts';
import { PF_ATTACK, PF_BAIT, PF_INTR, PF_MOVE, PF_PROJ, PF_STALE, PF_TAIL } from '../contracts';
import {
  C_AIRDODGE, C_DIRAD, C_FS, C_ROLL_B, C_ROLL_F, C_SPOT, CODE_MOVE, codeOf, D, framesToConnect, G, hopProgram,
  isAirOnly, J, K_APPROACH, K_BAIT, K_COMMIT, K_HOLD, K_RETREAT, L, liveOpponents, MC_AERIAL,
  MC_DASHATK, MC_SMASH, MC_SPECIAL, moveClass, moveSlot, normalSlot, O_DODGE, O_FF, op, Plan, PlanPool, press,
  R, REL_B, REL_H, REL_T, runState, safeDir, SH, softPlatformUnder, SP, stageGeo, stageOfState, targetIndex,
  travelFrames, U, WK, nameFor, nameNum, attackMoves, canAirDodge, isOffstage, type Program, type StageGeo,
} from './script';
import type { Intent } from '../contracts';

// ---------------------------------------------------------------------------------------------
// Priorities (higher first; generateCandidates sorts and caps)
// ---------------------------------------------------------------------------------------------

const PR_PUNISH = 58;
const PR_MULTI = 55;
const PR_OOS = 52;
const PR_INRANGE = 40;
const PR_GRAB = 38;
const PR_SPACED = 34;
const PR_SHOT = 32;
const PR_AERIAL = 30;
const PR_APPROACH = 28;
const PR_BAIT = 24;
const PR_MOVE = 20;
const PR_DEFEND = 18;
const PR_WAIT = 10;

const GROUND_SITS: readonly Situation[] = ['neutral', 'advantage', 'disadvantage'];
const AIR_SITS: readonly Situation[] = ['airborne', 'neutral', 'advantage', 'disadvantage', 'bothOffstage'];

// ---------------------------------------------------------------------------------------------
// Per-view scratch
// ---------------------------------------------------------------------------------------------

interface Nv {
  me: FighterState; tg: FighterState | null; ti: number; slot: number;
  dx: number; adx: number; dy: number; dir: number; g: StageGeo; vHalf: number;
  grounded: boolean; free: boolean; air: boolean; frame: number;
}
const NV: Nv = {
  me: null as unknown as FighterState, tg: null, ti: -1, slot: 0, dx: 0, adx: 0, dy: 0, dir: 1,
  g: null as unknown as StageGeo, vHalf: 13, grounded: false, free: false, air: false, frame: 0,
};

function nv(v: DecisionView): Nv {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  NV.me = me; NV.slot = v.slot; NV.frame = s.frame;
  NV.g = stageGeo(stageOfState(s));
  NV.ti = targetIndex(v);
  NV.tg = NV.ti >= 0 ? s.fighters[NV.ti] : null;
  if (NV.tg !== null) {
    NV.dx = NV.tg.x - me.x; NV.adx = Math.abs(NV.dx); NV.dy = NV.tg.y - me.y;
    NV.dir = NV.dx > 0.5 ? 1 : NV.dx < -0.5 ? -1 : me.facing;
  } else {
    NV.dx = 0; NV.adx = 1e9; NV.dy = 0; NV.dir = me.facing;
  }
  NV.vHalf = v.opp.physics.hurtbox.w / 2;
  const a = me.action;
  NV.grounded = me.onGround && me.hitstun === 0 && me.hitlag === 0
    && (a === 'idle' || a === 'walk' || a === 'dash' || a === 'run' || a === 'turn' || a === 'crouch' || a === 'land');
  NV.air = !me.onGround && me.hitstun === 0 && (a === 'air' || a === 'attack');
  NV.free = NV.grounded || (NV.air && a === 'air');
  return NV;
}

function add(out: PlanInstance[], p: Plan, n: Nv): void {
  p.target = n.ti;
  out.push(p);
}

// ---------------------------------------------------------------------------------------------
// Scripts with memory
// ---------------------------------------------------------------------------------------------

const FIRE_NONE = 0;
const FIRE_MOVE = 1;
const FIRE_GRAB = 2;
const FIRE_SHIELD = 3;

/** Fire mode per plan, kept in plan.data as a number. */
function fireOf(p: Plan): number { return typeof p.data === 'number' ? p.data : FIRE_NONE; }

/** Prepare: ctx.param = the stop x, `plan.param` px short of the target on our side, kept on the stage. */
function prepSpot(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const g = stageGeo(ctx.stage);
  const ti = targetIndex(v);
  const tx = ti >= 0 ? s.fighters[ti].x : g.cx;
  const side = me.x <= tx ? -1 : 1;
  let x = tx + side * p.param;
  if (x < g.left + 8) x = g.left + 8;
  if (x > g.right - 8) x = g.right - 8;
  ctx.param = x;
}

/** Prepare for absolute spots: ctx.param = plan.param as is. */
function prepAbs(p: Plan, v: DecisionView, ctx: PlanCtx): void { ctx.param = p.param; }

/**
 * Move to ctx.param (dash when far, walk the last stretch, brake by the skid distance), then do
 * the plan's fire action once (plan.data): nothing, its move toward the target, a grab, a shield.
 * The fire happens on arrival or when only the move's startup is left in the horizon.
 */
function goFire(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const rs = runState(p, ctx);
  const fire = fireOf(p);
  const T = ctx.dir > 0 ? R : L;
  if (rs.r[0] === 1) {
    if (fire === FIRE_SHIELD) out.held = SH;
    return;
  }
  const d = ctx.param - self.x;
  const ad = Math.abs(d);
  const toward = d > 0 ? R : L;
  const fr = 0.22;
  const skid = self.onGround ? (self.vx * self.vx) / (2 * fr) : 0;
  // A grab from a dash slides with the dash, so it fires on the spot rather than a skid early.
  const lead = fire === FIRE_GRAB ? 0 : skid;
  const arrived = ad <= 4 || (ad <= lead + 3 && Math.sign(self.vx) === Math.sign(d)) || (d * self.vx < 0 && ad < 12 && fire === FIRE_GRAB);
  const late = fire !== FIRE_NONE && t >= p.horizon - (p.move !== null && ctx.me.moves[p.move] !== undefined ? ctx.me.moves[p.move].startup : 8) - 4;
  if (!arrived && !late) {
    if (!self.onGround) { out.held = toward; return; }
    out.held = ad > 28 ? safeDir(toward, self) : safeDir(toward, self) | WK;
    return;
  }
  if (fire === FIRE_NONE) return;
  if (!self.onGround && fire !== FIRE_MOVE) return;
  // A ground move never fires in the air (its code would start an aerial instead, off a platform
  // or the stage edge the approach walked over).
  if (!self.onGround && p.move !== null && CHARACTER_DEFS[self.charId].moves[p.move]?.groundOnly === true) return;
  rs.r[0] = 1;
  if (fire === FIRE_MOVE) { out.held = T; out.direct = p.moveCode; }
  else if (fire === FIRE_GRAB) out.held = T | press(G, self);
  else if (fire === FIRE_SHIELD) out.held = SH;
}

/** Dash dance: away for `half` frames then toward (danceIn), or the reverse (danceOut). */
function danceFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const half = ctx.param;
  const T = ctx.dir > 0 ? R : L;
  const B = ctx.dir > 0 ? L : R;
  const first = p.kind === K_APPROACH ? B : T;
  const second = first === T ? B : T;
  out.held = safeDir(t < half ? first : second, self);
}

/** Dash in for ctx.param frames, then dash back out (a bait probe). */
function dashInBackFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const T = ctx.dir > 0 ? R : L;
  const B = ctx.dir > 0 ? L : R;
  out.held = safeDir(t < ctx.param ? T : B, self);
}

/** Roll toward (kind approach) or away from the target, choosing forward or back by facing. */
function rollFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  if (t !== 0) return;
  const want = p.kind === K_APPROACH ? ctx.dir : -ctx.dir;
  out.direct = self.facing === want ? C_ROLL_F : C_ROLL_B;
}

/** Charged smash: the code on frame 0, the charge key held ctx.param frames. */
function chargeFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const slot = p.move === null ? 0 : moveSlot(p.move);
  const key = slot === 1 ? U : slot === 2 ? D : ctx.dir > 0 ? R : L;
  if (t === 0) out.direct = p.moveCode;
  if (t < ctx.param + 1) out.held = key;
}

/** Projectile with a hold: code on frame 0, Special held ctx.param frames, facing the target. */
function shotFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  if (t === 0) { out.direct = p.moveCode; if (self.facing !== ctx.dir) out.held = ctx.dir > 0 ? R : L; }
  if (t < ctx.param) out.held |= SP;
}

/** Jump toward the soft platform x in ctx.param with a full hop, drifting to it, no fast fall. */
function platformJumpFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  if (t === 0) out.held = press(J, self);
  else if (t < 5) out.held = J;
  const d = ctx.param - self.x;
  if (t >= 1 && Math.abs(d) > 4) out.held |= d > 0 ? R : L;
}

/** Run to the ledge on the nearer side and drop onto it (hold toward the stage once past the corner). */
function ledgeRetreatFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const g = stageGeo(ctx.stage);
  const edgeX = ctx.param;
  const outBit = edgeX < g.cx ? L : R;
  const inBit = edgeX < g.cx ? R : L;
  if (self.onGround) { if (Math.abs(self.x - edgeX) > 0.5) out.held = safeDir(outBit, self); }
  else out.held = inBit;
}

// ---------------------------------------------------------------------------------------------
// Static programs
// ---------------------------------------------------------------------------------------------

const P_WAIT: Program = [];
const P_WALK_IN: Program = [op(0, 99, REL_T | WK)];
const P_WALK_OUT: Program = [op(0, 99, REL_B | WK)];
const P_DASH_IN: Program = [op(0, 99, REL_T)];
const P_DASH_OUT: Program = [op(0, 99, REL_B)];
const P_EMPTY_SH_IN = hopProgram(1, 99, REL_T, true, false);
const P_EMPTY_SH_OUT = hopProgram(1, 99, REL_B, true, false);
const P_EMPTY_FH = hopProgram(4, 99, 0, false, false);
const P_NOW: Program = [op(0, 1, REL_T, 0, CODE_MOVE)];
const P_NOW_STILL: Program = [op(0, 1, 0, 0, CODE_MOVE)];
const P_GRAB: Program = [op(0, 1, 0, G)];
const P_SHIELD: Program = [op(0, 99, SH)];
const P_SPOT: Program = [op(0, 1, 0, 0, C_SPOT)];
const P_PLAT_DROP: Program = [op(0, 1, 0, D)];

// Out of shield.
const P_OOS_GRAB: Program = [op(0, 1, SH, G)];
const P_OOS_CODE: Program = [op(0, 1, SH, 0, CODE_MOVE)];
const P_OOS_HOLD: Program = [op(0, 99, SH)];
function oosHop(drift: number): Program {
  return [op(0, 1, SH, J), op(1, 90, drift), op(2, 3, 0, 0, CODE_MOVE), op(2, 90, 0, 0, 0, O_FF)];
}
const P_OOS_HOP_T = oosHop(REL_T);
const P_OOS_HOP_B = oosHop(REL_B);

// Airborne.
const P_DRIFT_N: Program = [];
const P_DRIFT_T: Program = [op(0, 99, REL_T)];
const P_DRIFT_B: Program = [op(0, 99, REL_B)];
const P_FF: Program = [op(0, 99, 0, 0, 0, O_FF)];
const P_FF_T: Program = [op(0, 99, REL_T), op(0, 99, 0, 0, 0, O_FF)];
const P_FF_B: Program = [op(0, 99, REL_B), op(0, 99, 0, 0, 0, O_FF)];
function airAerialProgram(drift: number, ff: boolean): Program {
  const o = [op(0, 1, 0, 0, CODE_MOVE), op(0, 99, drift)];
  if (ff) o.push(op(0, 99, 0, 0, 0, O_FF));
  return o;
}
const P_AIR_T = airAerialProgram(REL_T, false);
const P_AIR_T_FF = airAerialProgram(REL_T, true);
const P_AIR_B_FF = airAerialProgram(REL_B, true);
function djProgram(drift: number, withMove: boolean): Program {
  const o = [op(0, 1, 0, J), op(0, 99, drift)];
  if (withMove) o.push(op(3, 4, 0, 0, CODE_MOVE));
  return o;
}
const P_DJ_T = djProgram(REL_T, false);
const P_DJ_B = djProgram(REL_B, false);
const P_DJ_N = djProgram(0, false);
const P_DJ_T_MOVE = djProgram(REL_T, true);
const P_AD_T: Program = [op(0, 1, 0, 0, C_DIRAD, O_DODGE), op(0, 99, REL_T)];
const P_AD_B: Program = [op(0, 1, 0, 0, C_DIRAD, O_DODGE), op(0, 99, REL_B)];
const P_AD_H: Program = [op(0, 1, U, 0, C_DIRAD, O_DODGE), op(0, 99, REL_H)];
const P_AD_N: Program = [op(0, 1, 0, 0, C_AIRDODGE, O_DODGE)];
const P_AIR_SPEC_T: Program = [op(0, 1, 0, 0, CODE_MOVE), op(0, 99, REL_T)];
const P_AIR_SPEC_H: Program = [op(0, 1, 0, 0, CODE_MOVE), op(0, 99, REL_H)];

// Respawn and Final Smash.
const P_RESPAWN_DROP: Program = [op(0, 1, 0, D)];
const P_FINAL: Program = [op(0, 1, 0, 0, C_FS)];

// Hop aerial programs by timing, built per aerial slot on first use.
const HOP_CACHE = new Map<number, Program>();
function hopFor(hold: number, atk: number, drift: number, ff: boolean): Program {
  const key = hold * 1000000 + atk * 10000 + (drift === REL_T ? 1 : drift === REL_B ? 2 : 0) * 10 + (ff ? 1 : 0);
  let p = HOP_CACHE.get(key);
  if (p === undefined) { p = hopProgram(hold, atk, drift, ff, true); HOP_CACHE.set(key, p); }
  return p;
}

/** Frame (after the jump press) an aerial is sent on a short hop: the down aerial waits for the rise. */
function shAttackFrame(m: MoveAiInfo, isDownAerial: boolean): number { return isDownAerial ? 4 : 1; }

// ---------------------------------------------------------------------------------------------
// Family helpers
// ---------------------------------------------------------------------------------------------

/** A move plan whose first active frame fits the horizon from here. */
function reachable(v: DecisionView, n: Nv, id: MoveId, horizon: number): number {
  if (n.tg === null) return Infinity;
  const f = framesToConnect(v.me, id, n.adx, n.dy, n.vHalf);
  return f <= horizon ? f : Infinity;
}

function tipSpacing(m: MoveAiInfo, vHalf: number): number {
  return Math.max(4, Math.max(m.reach.front, m.reach.back) + vHalf - 6);
}

/** Stable pool variant per move: its DIRECT_CODES code times 16 plus the sub-variant. */
function variantOf(id: MoveId, sub: number): number {
  return codeOf(id) * 16 + sub;
}

function family(id: PlanFamilyId, situations: readonly Situation[], gen: (v: DecisionView, out: PlanInstance[]) => void): PlanFamily {
  return { id, situations, generate: gen };
}

// ---------------------------------------------------------------------------------------------
// Grounded movement: wait, walk, dash, approach, dash dance, empty hops, bait probes
// ---------------------------------------------------------------------------------------------

const poolMove = new PlanPool();

const WAIT_FAMILY = family('wait', ['neutral', 'advantage', 'disadvantage', 'airborne', 'oos', 'bothOffstage'], (v, out) => {
  const n = nv(v);
  const p = poolMove.get(n.slot, 0).set('wait', 'wait', null, 1, 12, PF_INTR | PF_MOVE, PR_WAIT, K_HOLD);
  p.prog = P_WAIT; p.fn = null; p.prep = null;
  add(out, p, n);
});

function preferredSpacing(v: DecisionView): number {
  const sm = v.style.spacingMul;
  const mul = sm === 'adaptive' ? 1.1 : (sm[0] + sm[1]) / 2;
  let reach = 0;
  const roles = v.me.roles.neutral;
  for (let i = 0; i < roles.length; i++) {
    const m = v.me.moves[roles[i]];
    if (m !== undefined && m.maxDamage > 0 && !isAirOnly(v.me.charId, roles[i]) && m.tags.indexOf('projectile') < 0) {
      reach = Math.max(reach, m.reach.front);
    }
  }
  if (reach === 0) reach = 40;
  const hold = v.me.overrides?.spacingMul;
  return (hold !== undefined ? hold : mul) * reach;
}

const WALK_FAMILY = family('walk', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null) return;
  let p = poolMove.get(n.slot, 1).set('walk', 'walkIn', null, 1, 16, PF_INTR | PF_MOVE, PR_MOVE, K_APPROACH);
  p.prog = P_WALK_IN; p.fn = null; p.prep = null; add(out, p, n);
  p = poolMove.get(n.slot, 2).set('walk', 'walkOut', null, 1, 16, PF_INTR | PF_MOVE, PR_MOVE, K_RETREAT);
  p.prog = P_WALK_OUT; p.fn = null; p.prep = null; add(out, p, n);
  // Walk to the preferred spacing (just outside the target's reach, inside ours).
  const sp = preferredSpacing(v);
  if (Math.abs(n.adx - sp) > 12) {
    p = poolMove.get(n.slot, 3).set('walk', 'walkSpace', null, 1, 30, PF_INTR | PF_MOVE, PR_MOVE + 2,
      n.adx > sp ? K_APPROACH : K_RETREAT);
    p.prog = null; p.fn = goFire; p.prep = prepSpot; p.data = FIRE_NONE; p.param = sp; add(out, p, n);
  }
});

const DASH_FAMILY = family('dash', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null) return;
  let p = poolMove.get(n.slot, 4).set('dash', 'dashIn', null, 1, 16, PF_INTR, PR_MOVE, K_APPROACH);
  p.prog = P_DASH_IN; p.fn = null; p.prep = null; add(out, p, n);
  p = poolMove.get(n.slot, 5).set('dash', 'dashOut', null, 1, 16, PF_INTR | PF_MOVE, PR_MOVE, K_RETREAT);
  p.prog = P_DASH_OUT; p.fn = null; p.prep = null; add(out, p, n);
  // Approach: dash, then walk, to the preferred spacing.
  const sp = preferredSpacing(v);
  if (n.adx > sp + 20) {
    const h = Math.min(90, travelFrames(v.me, n.adx - sp) + 12);
    p = poolMove.get(n.slot, 6).set('dash', 'approach', null, 1, h, PF_INTR | PF_MOVE, PR_APPROACH, K_APPROACH);
    p.prog = null; p.fn = goFire; p.prep = prepSpot; p.data = FIRE_NONE; p.param = sp; add(out, p, n);
  }
});

const DASH_DANCE_FAMILY = family('dashDance', ['neutral'], (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null) return;
  const half = Math.max(3, Math.min(8, Math.round(v.me.physics.dashFrames / 2)));
  let p = poolMove.get(n.slot, 7).set('dashDance', 'danceIn', null, half + 2, half * 2 + 6, PF_INTR | PF_MOVE, PR_MOVE, K_APPROACH);
  p.prog = null; p.fn = danceFn; p.prep = null; p.param = half; add(out, p, n);
  p = poolMove.get(n.slot, 8).set('dashDance', 'danceOut', null, half + 2, half * 2 + 6, PF_INTR | PF_MOVE, PR_MOVE, K_RETREAT);
  p.prog = null; p.fn = danceFn; p.prep = null; p.param = half; add(out, p, n);
});

const EMPTY_HOP_FAMILY = family('emptyHop', ['neutral'], (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null) return;
  let p = poolMove.get(n.slot, 9).set('emptyHop', 'emptyHopIn', null, 3, 26, PF_TAIL | PF_BAIT, PR_BAIT, K_BAIT);
  p.prog = P_EMPTY_SH_IN; p.fn = null; p.prep = null; add(out, p, n);
  p = poolMove.get(n.slot, 10).set('emptyHop', 'emptyHopOut', null, 3, 26, PF_MOVE | PF_TAIL | PF_BAIT, PR_BAIT, K_BAIT);
  p.prog = P_EMPTY_SH_OUT; p.fn = null; p.prep = null; add(out, p, n);
  p = poolMove.get(n.slot, 11).set('emptyHop', 'fullHop', null, 5, 30, PF_TAIL | PF_BAIT, PR_BAIT - 2, K_BAIT);
  p.prog = P_EMPTY_FH; p.fn = null; p.prep = null; add(out, p, n);
});

const BAIT_FAMILY = family('baitProbe', ['neutral'], (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null) return;
  // Dash in then back: offered just outside the target's threat range.
  const k = Math.max(3, Math.min(10, v.me.physics.dashFrames - 2));
  let p = poolMove.get(n.slot, 12).set('baitProbe', 'dashInBack', null, k + 2, k * 2 + 10, PF_BAIT, PR_BAIT, K_BAIT);
  p.prog = null; p.fn = dashInBackFn; p.prep = null; p.param = k; add(out, p, n);
  // Shield probe: walk to just outside the target's reach and put the shield up.
  const sp = preferredSpacing(v) + 8;
  if (n.adx > sp + 8) {
    p = poolMove.get(n.slot, 13).set('baitProbe', 'shieldProbe', null, 6, 36, PF_BAIT | PF_INTR, PR_BAIT, K_BAIT);
    p.prog = null; p.fn = goFire; p.prep = prepSpot; p.data = FIRE_SHIELD; p.param = sp; add(out, p, n);
  }
  // A shot meant to be shielded from long range (a tap of the fastest projectile).
  const shots = v.me.shots;
  if (shots.length > 0 && n.adx > 120) {
    let best = shots[0];
    for (let i = 1; i < shots.length; i++) if (shots[i].castFrames(0) < best.castFrames(0)) best = shots[i];
    if (best.range(0) + n.vHalf >= n.adx * 0.8) {
      p = poolMove.get(n.slot, 14).set('baitProbe', 'shotProbe', best.moveId, 2, best.totalFrames(0) + 6,
        PF_ATTACK | PF_PROJ | PF_BAIT, PR_BAIT, K_BAIT);
      p.prog = null; p.fn = shotFn; p.prep = null; p.param = 0; add(out, p, n);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Grounded attacks: pokes, tilts, dash attack, smashes, charged smashes, specials, whiff punish
// ---------------------------------------------------------------------------------------------

const poolAtk = new PlanPool();

function attackFamilyOf(v: DecisionView, id: MoveId): PlanFamilyId {
  const c = moveClass(id);
  const m = v.me.moves[id];
  if (c === MC_SMASH) return 'smash';
  if (c === MC_SPECIAL) return m.tags.indexOf('projectile') >= 0 ? 'projectile' : 'special';
  if (c === MC_AERIAL) return 'shAerial';
  if (m.tags.indexOf('poke') >= 0) return 'poke';
  return c === MC_DASHATK ? 'poke' : 'tilt';
}

/**
 * One generator for poke, tilt, smash and special: in range now, or spaced (move to the tip
 * then fire). `fam` selects which move class this family object emits.
 */
function groundAttackFamily(fam: PlanFamilyId): PlanFamily {
  return family(fam, GROUND_SITS, (v, out) => {
    const n = nv(v);
    if (!n.grounded || n.tg === null) return;
    const ids = attackMoves(v.me);
    // A hanger is reached only by moves with hitsLedge (sim/hits.ts): offer those alone, walked to
    // the lip, at every level whose vocabulary has the family (03: an L1 player still pokes a
    // hanger with a down tilt; the timed traps are the ledgeTrap family from L3).
    const hanging = n.tg.action === 'ledgeHang' || n.tg.action === 'ledgeGrab';
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const c = moveClass(id);
      if (c === MC_AERIAL || c === MC_SPECIAL && v.me.moves[id].tags.indexOf('projectile') >= 0) continue;
      if (isAirOnly(v.me.charId, id)) continue;
      if (attackFamilyOf(v, id) !== fam) continue;
      const m = v.me.moves[id];
      if (hanging) {
        const md = CHARACTER_DEFS[n.me.charId].moves[id];
        if (md === undefined || md.hitsLedge !== true || c === MC_DASHATK) continue;
        // From the main stage only: the lip is at the target's height, a soft platform is not.
        if (n.me.y < n.g.top - 4) continue;
        const sp = Math.max(4, Math.min(m.reach.front, 24));
        const h = Math.min(90, travelFrames(v.me, Math.max(0, n.adx - sp)) + m.total + 6);
        const p = poolAtk.get(n.slot, variantOf(id, 4)).set(fam, nameFor('', id, 'Ledge'), id, 2, h, PF_ATTACK, PR_PUNISH, K_COMMIT);
        p.prog = null; p.fn = goFire; p.prep = prepSpot; p.data = FIRE_MOVE; p.param = sp; add(out, p, n);
        continue;
      }
      const horizon = m.total + 6;
      if (c === MC_DASHATK) {
        // Dash attack: dash toward, the move once in range.
        const f = reachable(v, n, id, 40);
        if (f === Infinity) continue;
        const k = Math.max(1, Math.min(20, f - m.startup));
        const p = poolAtk.get(n.slot, variantOf(id, 0)).set(fam, 'dashAttack', id, 2, k + horizon, PF_ATTACK, PR_SPACED, K_COMMIT);
        p.prog = null; p.fn = dashAttackFn; p.prep = null; p.param = k; add(out, p, n);
        continue;
      }
      const reach = Math.max(m.reach.front, m.reach.back) + n.vHalf;
      const upOk = n.dy >= -(m.reach.up + 4) && n.dy <= m.reach.down + 30;
      if (n.adx <= reach && upOk) {
        const p = poolAtk.get(n.slot, variantOf(id, 0)).set(fam, id, id, 2, horizon, PF_ATTACK, PR_INRANGE, K_COMMIT);
        p.prog = moveSlot(id) === 1 || moveSlot(id) === 2 ? P_NOW_STILL : P_NOW; p.fn = null; p.prep = null; add(out, p, n);
      } else if (upOk) {
        const f = reachable(v, n, id, 45);
        if (f !== Infinity) {
          const sp = tipSpacing(m, n.vHalf);
          const h = Math.min(60, travelFrames(v.me, n.adx - sp) + horizon);
          const p = poolAtk.get(n.slot, variantOf(id, 1)).set(fam, nameFor('', id, 'Spaced'), id, 2, h, PF_ATTACK, PR_SPACED, K_COMMIT);
          p.prog = null; p.fn = goFire; p.prep = prepSpot; p.data = FIRE_MOVE; p.param = sp; add(out, p, n);
        }
      }
    }
  });
}

/** Dash toward for ctx.param frames, then the dash attack. */
function dashAttackFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const T = ctx.dir > 0 ? R : L;
  if (t < ctx.param) { out.held = safeDir(T, self); return; }
  if (t === ctx.param) { out.held = T; out.direct = p.moveCode; }
}

const CHARGED_FAMILY = family('chargedSmash', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null) return;
  const ids = attackMoves(v.me);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const m = v.me.moves[id];
    if (moveClass(id) !== MC_SMASH || !m.chargeable) continue;
    const reach = Math.max(m.reach.front, m.reach.back) + n.vHalf;
    if (n.adx > reach + 30) continue;
    // Charge toward the target's committed frame when it is busy, else a fixed 13.
    const busy = Math.max(0, v.aff.oppBusy);
    const want = busy > m.startup ? Math.min(60, busy - m.startup) : 13;
    const p = poolAtk.get(n.slot, variantOf(id, 2)).set('chargedSmash', nameFor('', id, 'Charged'), id, want + 2, want + m.total + 4,
      PF_ATTACK, PR_SPACED - 2, K_COMMIT);
    p.prog = null; p.fn = chargeFn; p.prep = null; p.param = want; add(out, p, n);
  }
});

const GRAB_FAMILY = family('grab', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null || n.tg.y < n.me.y - 30) return;
  const gr = v.me.grab.standing;
  if (n.adx <= gr.reach + n.vHalf) {
    const p = poolAtk.get(n.slot, 1).set('grab', 'grab', null, 2, gr.total + 2, PF_ATTACK, PR_GRAB + 4, K_COMMIT);
    p.prog = P_GRAB; p.fn = null; p.prep = null; add(out, p, n);
  }
});

const DASH_GRAB_FAMILY = family('dashGrab', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null || n.tg.y < n.me.y - 30) return;
  const gr = v.me.grab.dash;
  if (n.adx > 260) return;
  const sp = Math.max(6, gr.reach + n.vHalf - 8);
  const h = Math.min(90, travelFrames(v.me, n.adx - sp) + gr.total + 4);
  const p = poolAtk.get(n.slot, 2).set('dashGrab', 'dashGrab', null, 4, h, PF_ATTACK, PR_GRAB, K_COMMIT);
  p.prog = null; p.fn = goFire; p.prep = prepSpot; p.data = FIRE_GRAB; p.param = sp; add(out, p, n);
});

const PROJECTILE_FAMILY = family('projectile', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!(n.grounded || n.air) || n.tg === null) return;
  const shots = v.me.shots;
  const holds = v.me.overrides?.preferredHolds ?? [0, 15, 30, 45, 60];
  const fine = v.level.god || v.level.s >= 0.75;
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i];
    const m = v.me.moves[sh.moveId];
    if (m === undefined || moveClass(sh.moveId) !== MC_SPECIAL) continue;
    if (!n.grounded && isAirOnly(v.me.charId, sh.moveId)) continue;
    for (let k = 0; k < holds.length; k++) {
      const h = holds[k];
      if (!m.chargeable && h > 0) continue;
      if (!fine && h !== 0 && h !== holds[holds.length - 1]) continue;
      if (sh.range(h) + n.vHalf < n.adx) continue;
      if (Math.abs(n.dy) > sh.radius(h) + 40) continue;
      const p = poolAtk.get(n.slot, variantOf(sh.moveId, 3 + k)).set('projectile', h === 0 ? sh.defId : nameNum(sh.defId, h),
        sh.moveId, 2, sh.totalFrames(h) + 6, PF_ATTACK | PF_PROJ, PR_SHOT, K_COMMIT);
      p.prog = null; p.fn = shotFn; p.prep = null; p.param = h; add(out, p, n);
    }
  }
});

/** Whiff punish: the target is in endlag (or the affordance says a punish exists). */
const PUNISH_FAMILY = family('poke', ['neutral', 'advantage'], (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null) return;
  const tg = n.tg;
  let left = 0;
  if (tg.action === 'attack' && tg.moveId !== null && tg.hitlag === 0) {
    const om = v.opp.moves[tg.moveId];
    if (om !== undefined && tg.actionFrame > om.activeEnd) left = om.total - tg.actionFrame;
  } else if (tg.action === 'land' || tg.action === 'roll' || tg.action === 'spotDodge') {
    left = Math.max(0, v.aff.oppBusy);
  }
  if (v.aff.whiffPunish > 0) left = Math.max(left, v.aff.whiffPunish);
  if (left <= 0) return;
  const ids = attackMoves(v.me);
  let emitted = 0;
  for (let i = 0; i < ids.length && emitted < 3; i++) {
    const id = ids[i];
    const c = moveClass(id);
    if (c === MC_SPECIAL && v.me.moves[id].tags.indexOf('projectile') >= 0) continue;
    const f = framesToConnect(v.me, id, n.adx, n.dy, n.vHalf);
    if (!(f <= left)) continue;
    const m = v.me.moves[id];
    const fam = c === MC_AERIAL ? 'shAerial' : attackFamilyOf(v, id);
    const sp = tipSpacing(m, n.vHalf);
    if (c === MC_AERIAL) {
      const p = poolAtk.get(n.slot, variantOf(id, 10)).set(fam, nameFor('punish', id, ''), id, 3, m.total + 12, PF_ATTACK | PF_TAIL, PR_PUNISH, K_COMMIT);
      p.prog = hopFor(1, shAttackFrame(m, normalSlot4(id)), REL_T, true); p.fn = null; p.prep = null; add(out, p, n);
    } else {
      const p = poolAtk.get(n.slot, variantOf(id, 10)).set(fam, nameFor('punish', id, ''), id, 2,
        Math.min(60, travelFrames(v.me, n.adx - sp) + m.total + 4), PF_ATTACK, PR_PUNISH, K_COMMIT);
      p.prog = null; p.fn = goFire; p.prep = prepSpot; p.data = FIRE_MOVE; p.param = sp; add(out, p, n);
    }
    emitted++;
  }
  const gr = v.me.grab.dash;
  if (travelFrames(v.me, n.adx - gr.reach - n.vHalf) + gr.active[0] <= left && tg.onGround) {
    const p = poolAtk.get(n.slot, 3).set('dashGrab', 'punishGrab', null, 4, 60, PF_ATTACK, PR_PUNISH, K_COMMIT);
    p.prog = null; p.fn = goFire; p.prep = prepSpot; p.data = FIRE_GRAB; p.param = Math.max(6, gr.reach + n.vHalf - 8); add(out, p, n);
  }
});

/** True for the down aerial (the fifth aerial slot). */
function normalSlot4(id: MoveId): boolean {
  return moveClass(id) === MC_AERIAL && normalSlot(id) === 4;
}

// ---------------------------------------------------------------------------------------------
// Hop aerials
// ---------------------------------------------------------------------------------------------

const poolHop = new PlanPool();

function hopFamily(fam: PlanFamilyId): PlanFamily {
  return family(fam, GROUND_SITS, (v, out) => {
    const n = nv(v);
    if (!n.grounded || n.tg === null) return;
    const ids = attackMoves(v.me);
    const facingT = n.me.facing === n.dir;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (moveClass(id) !== MC_AERIAL) continue;
      const m = v.me.moves[id];
      const down = normalSlot4(id);
      const frontHit = m.reach.front > 0;
      const backHit = m.reach.back > m.reach.front;
      const f = framesToConnect(v.me, id, n.adx, n.dy, n.vHalf);
      if (fam === 'shAerial' && frontHit && f <= 30) {
        const p = poolHop.get(n.slot, variantOf(id, 0)).set('shAerial', nameFor('sh', id, ''), id, 3, 34, PF_ATTACK | PF_TAIL, PR_AERIAL, K_COMMIT);
        p.prog = hopFor(1, shAttackFrame(m, down), REL_T, false); p.fn = null; p.prep = null; add(out, p, n);
      }
      if (fam === 'fastFallAerial' && frontHit && f <= 30) {
        const p = poolHop.get(n.slot, variantOf(id, 1)).set('fastFallAerial', nameFor('sh', id, 'Ff'), id, 3, 30, PF_ATTACK | PF_TAIL, PR_AERIAL, K_COMMIT);
        p.prog = hopFor(1, shAttackFrame(m, down), REL_T, true); p.fn = null; p.prep = null; add(out, p, n);
      }
      if (fam === 'retreatAerial' && ((backHit && !facingT) || (frontHit && facingT)) && n.adx < 140) {
        const p = poolHop.get(n.slot, variantOf(id, 2)).set('retreatAerial', nameFor('sh', id, 'Retreat'), id, 3, 32,
          PF_ATTACK | PF_TAIL, PR_AERIAL - 2, K_RETREAT);
        p.prog = hopFor(1, shAttackFrame(m, down), REL_B, true); p.fn = null; p.prep = null; add(out, p, n);
      }
      if (fam === 'fhAerial' && frontHit && framesToConnect(v.me, id, n.adx, n.dy - 50, n.vHalf) <= 40) {
        const p = poolHop.get(n.slot, variantOf(id, 3)).set('fhAerial', nameFor('fh', id, ''), id, 6, 40, PF_ATTACK | PF_TAIL, PR_AERIAL - 1, K_COMMIT);
        p.prog = hopFor(4, 6, REL_T, false); p.fn = null; p.prep = null; add(out, p, n);
        if (m.reach.up > 60 && n.dy < -40) {
          const q = poolHop.get(n.slot, variantOf(id, 4)).set('fhAerial', nameFor('fh', id, 'Late'), id, 12, 40, PF_ATTACK | PF_TAIL, PR_AERIAL - 1, K_COMMIT);
          q.prog = hopFor(4, 12, REL_T, false); q.fn = null; q.prep = null; add(out, q, n);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Platforms, shield, dodges, grounded specials
// ---------------------------------------------------------------------------------------------

const poolDef = new PlanPool();
/** Value points added to a platform drop toward a target below (see PLATFORM_FAMILY). */
const DROP_BONUS = 3;

const PLATFORM_FAMILY = family('platform', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded) return;
  if (softPlatformUnder(n.me, n.g) >= 0) {
    const p = poolDef.get(n.slot, 0).set('platform', 'platformDrop', null, 2, 22, PF_TAIL, PR_MOVE, K_HOLD);
    p.prog = P_PLAT_DROP; p.fn = null; p.prep = null;
    // The way down to a target below is through the platform: ranked and valued as an approach
    // (a drop scored like walking to the edge and falling, so it rarely won; aitest q).
    if (n.tg !== null && n.dy > 30 && n.adx < 160) { p.priority = PR_APPROACH; p.kind = K_APPROACH; p.bonus = DROP_BONUS; }
    add(out, p, n);
  }
  // Jump to the nearest soft platform above within a full hop.
  let best = -1; let bd = 1e9;
  for (let i = 0; i < n.g.softCount; i++) {
    const l = n.g.soft[i * 3]; const r = n.g.soft[i * 3 + 1]; const y = n.g.soft[i * 3 + 2];
    const rise = n.me.y - y;
    if (rise <= 4 || rise > v.me.recovery.rise.fullHop - 4) continue;
    const cx = Math.max(l + 10, Math.min(r - 10, n.me.x));
    const d = Math.abs(cx - n.me.x);
    if (d < bd && d < 120) { bd = d; best = i; }
  }
  if (best >= 0) {
    const l = n.g.soft[best * 3]; const r = n.g.soft[best * 3 + 1];
    const p = poolDef.get(n.slot, 1).set('platform', 'platformJump', null, 5, 40, PF_TAIL | PF_MOVE, PR_MOVE, K_RETREAT);
    p.prog = null; p.fn = platformJumpFn; p.prep = prepAbs; p.param = Math.max(l + 12, Math.min(r - 12, n.me.x)); add(out, p, n);
  }
});

const SHIELD_FAMILY = family('shield', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded && n.me.action !== 'shield') return;
  let p = poolDef.get(n.slot, 2).set('shield', 'shield', null, 3, 18, PF_INTR, PR_DEFEND, K_HOLD);
  p.prog = P_SHIELD; p.fn = null; p.prep = null; add(out, p, n);
  p = poolDef.get(n.slot, 3).set('shield', 'shieldShort', null, 3, 8, PF_INTR, PR_DEFEND - 1, K_HOLD);
  p.prog = P_SHIELD; p.fn = null; p.prep = null; add(out, p, n);
});

const SPOT_FAMILY = family('spotDodge', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded) return;
  const p = poolDef.get(n.slot, 4).set('spotDodge', 'spotDodge', null, 2, 26, PF_STALE, PR_DEFEND, K_HOLD);
  p.prog = P_SPOT; p.fn = null; p.prep = null; add(out, p, n);
});

const ROLL_FAMILY = family('roll', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded || n.tg === null) return;
  let p = poolDef.get(n.slot, 5).set('roll', 'rollIn', null, 2, 28, PF_STALE, PR_DEFEND, K_APPROACH);
  p.prog = null; p.fn = rollFn; p.prep = null; add(out, p, n);
  p = poolDef.get(n.slot, 6).set('roll', 'rollOut', null, 2, 28, PF_MOVE | PF_STALE, PR_DEFEND, K_RETREAT);
  p.prog = null; p.fn = rollFn; p.prep = null; add(out, p, n);
});

const SPECIAL_FAMILY = groundAttackFamily('special');

// ---------------------------------------------------------------------------------------------
// Out of shield
// ---------------------------------------------------------------------------------------------

const poolOos = new PlanPool();

const OOS_FAMILY = family('oos', ['oos', 'neutral', 'advantage', 'disadvantage'], (v, out) => {
  const n = nv(v);
  const a = n.me.action;
  if (a !== 'shield' && a !== 'shieldStun') return;
  let p = poolOos.get(n.slot, 0).set('oos', 'oosHold', null, 1, 6, PF_INTR, PR_OOS - 4, K_HOLD);
  p.prog = P_OOS_HOLD; p.fn = null; p.prep = null; add(out, p, n);
  if (n.tg === null) return;
  if (n.adx <= v.me.grab.standing.reach + n.vHalf + 4) {
    p = poolOos.get(n.slot, 1).set('oos', 'oosGrab', null, 2, v.me.grab.standing.total + 2, PF_ATTACK, PR_OOS, K_COMMIT);
    p.prog = P_OOS_GRAB; p.fn = null; p.prep = null; add(out, p, n);
  }
  const ids = attackMoves(v.me);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const c = moveClass(id);
    const m = v.me.moves[id];
    const reach = Math.max(m.reach.front, m.reach.back) + n.vHalf;
    const upSmash = c === MC_SMASH && moveSlot(id) === 1;
    const upSpecial = c === MC_SPECIAL && moveSlot(id) === 2;
    if ((upSmash || upSpecial) && n.adx <= reach + 4 && n.dy >= -(m.reach.up + 4)) {
      p = poolOos.get(n.slot, 2 + variantOf(id, 0)).set('oos', nameFor('oos', id, ''), id, 2, m.total + 4,
        PF_ATTACK | (upSpecial ? PF_TAIL : 0), PR_OOS, K_COMMIT);
      p.prog = P_OOS_CODE; p.fn = null; p.prep = null; add(out, p, n);
    }
    if (c === MC_AERIAL && v.me.roles.oos.indexOf(id) >= 0 && n.adx <= reach + 20) {
      const back = m.reach.back > m.reach.front;
      p = poolOos.get(n.slot, 2 + variantOf(id, 1)).set('oos', nameFor('oos', id, ''), id, 3, 32, PF_ATTACK | PF_TAIL, PR_OOS, K_COMMIT);
      p.prog = back ? P_OOS_HOP_B : P_OOS_HOP_T; p.fn = null; p.prep = null; add(out, p, n);
    }
  }
  p = poolOos.get(n.slot, 3).set('oos', 'oosRollOut', null, 2, 28, PF_STALE | PF_MOVE, PR_OOS - 6, K_RETREAT);
  p.prog = null; p.fn = rollFn; p.prep = null; add(out, p, n);
  p = poolOos.get(n.slot, 4).set('oos', 'oosRollIn', null, 2, 28, PF_STALE, PR_OOS - 6, K_APPROACH);
  p.prog = null; p.fn = rollFn; p.prep = null; add(out, p, n);
  p = poolOos.get(n.slot, 5).set('oos', 'oosSpotDodge', null, 2, 26, PF_STALE, PR_OOS - 6, K_HOLD);
  p.prog = P_SPOT; p.fn = null; p.prep = null; add(out, p, n);
});

// ---------------------------------------------------------------------------------------------
// Airborne
// ---------------------------------------------------------------------------------------------

const poolAir = new PlanPool();

const DRIFT_FAMILY = family('drift', AIR_SITS, (v, out) => {
  const n = nv(v);
  if (!n.air || n.me.action !== 'air') return;
  const list: [string, Program, number][] = DRIFT_LIST;
  for (let i = 0; i < list.length; i++) {
    const [name, prog, kind] = list[i];
    const p = poolAir.get(n.slot, i).set('drift', name, null, 1, 20, PF_INTR | PF_TAIL | (kind === K_RETREAT ? PF_MOVE : 0), PR_MOVE, kind);
    p.prog = prog; p.fn = null; p.prep = null; add(out, p, n);
  }
});
const DRIFT_LIST: [string, Program, number][] = [
  ['drift', P_DRIFT_N, K_HOLD], ['driftIn', P_DRIFT_T, K_APPROACH], ['driftOut', P_DRIFT_B, K_RETREAT],
  ['fastFall', P_FF, K_HOLD], ['fastFallIn', P_FF_T, K_APPROACH], ['fastFallOut', P_FF_B, K_RETREAT],
];

const AIR_AERIAL_FAMILY = family('airAerial', AIR_SITS, (v, out) => {
  const n = nv(v);
  if (!n.air || n.me.action !== 'air') return;
  const ids = attackMoves(v.me);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (moveClass(id) !== MC_AERIAL) continue;
    const m = v.me.moves[id];
    // Target below, past the move's reach: fall onto it (fast fall, drift over it) and fire the
    // move timed on the gap, rather than swinging now into the air above it. Ranked with the
    // punishes so the landing family's escapes (priority 60 to 76) do not crowd it out of the
    // prefilter.
    if (n.tg !== null && n.dy > m.reach.down + 8 && m.reach.down > 0 && n.adx <= m.reach.front + n.vHalf + 60) {
      const g = CHARACTER_DEFS[n.me.charId].gravity;
      const fall = Math.max(0, n.dy - m.reach.down);
      const tFall = g > 0 ? Math.ceil(Math.sqrt((2 * fall) / g)) : 30;
      const pay = Math.min(60, tFall + m.startup + 4);
      const q = poolAir.get(n.slot, 10 + variantOf(id, 3)).set('airAerial', nameFor('', id, 'Drop'), id, 3, pay + m.total,
        PF_ATTACK | PF_TAIL, PR_PUNISH, K_COMMIT);
      // The window stretch (payoffAt) is for human tiers: the god's shared-budget decisions with
      // three gods on four fighters went from 26 to 37 ms summed p99 with it (perf.4p gate 36).
      q.prog = null; q.fn = dropAerialFn; q.prep = prepDrop; q.payoffAt = v.level.god ? undefined : pay; add(out, q, n);
    }
    if (n.tg !== null) {
      const ahead = (n.dx * n.me.facing) >= 0;
      const hitsSide = ahead ? m.reach.front > 0 : m.reach.back > 0;
      const reach = (ahead ? m.reach.front : m.reach.back) + n.vHalf + 30;
      const vert = n.dy < 0 ? -n.dy <= m.reach.up + 30 : n.dy <= m.reach.down + 60;
      if (!hitsSide || n.adx > reach + 40 || !vert) continue;
    }
    let p = poolAir.get(n.slot, 10 + variantOf(id, 0)).set('airAerial', id, id, 2, 30, PF_ATTACK | PF_TAIL, PR_AERIAL, K_COMMIT);
    p.prog = P_AIR_T; p.fn = null; p.prep = null; add(out, p, n);
    p = poolAir.get(n.slot, 10 + variantOf(id, 1)).set('airAerial', nameFor('', id, 'Ff'), id, 2, 28, PF_ATTACK | PF_TAIL, PR_AERIAL, K_COMMIT);
    p.prog = P_AIR_T_FF; p.fn = null; p.prep = null; add(out, p, n);
    p = poolAir.get(n.slot, 10 + variantOf(id, 2)).set('airAerial', nameFor('', id, 'Out'), id, 2, 30, PF_ATTACK | PF_TAIL, PR_AERIAL - 2, K_RETREAT);
    p.prog = P_AIR_B_FF; p.fn = null; p.prep = null; add(out, p, n);
  }
});

/** Prepare a drop aerial: ctx.param = the target's y, ctx.fireAt = its x (both at the decision). */
function prepDrop(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const ti = targetIndex(v);
  const s = v.p.state;
  const t = ti >= 0 ? s.fighters[ti] : s.fighters[v.p.meI];
  ctx.param = t.y; ctx.fireAt = t.x;
}

/**
 * Drop aerial: drift over the target's x, fast fall once falling, and press the move when its
 * hitbox will reach the target's top within its startup (gap to the target minus the move's
 * downward reach, against the fall speed).
 */
function dropAerialFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const rs = runState(p, ctx);
  if (rs.r[0] === 1 || self.onGround) return;
  const dx = ctx.fireAt - self.x;
  out.held = Math.abs(dx) > 4 ? (dx > 0 ? R : L) : 0;
  if (self.vy > 0 && !self.fastFalling && (self.vy > 0.5 || t > 1)) out.held |= D;
  const m = p.move !== null ? ctx.me.moves[p.move] : undefined;
  if (m === undefined || self.action !== 'air') return;
  const gap = ctx.param - self.y - m.reach.down;
  const vy = self.vy > 0 ? self.vy : 0;
  if (gap <= vy * (m.startup + 1) + 6) {
    rs.r[0] = 1;
    out.held &= ~D;
    out.direct = p.moveCode;
  }
}

const DJ_FAMILY = family('doubleJump', AIR_SITS, (v, out) => {
  const n = nv(v);
  if (!n.air || n.me.action !== 'air' || n.me.jumpsLeft <= 0) return;
  let p = poolAir.get(n.slot, 6).set('doubleJump', 'jumpIn', null, 3, 26, PF_TAIL, PR_MOVE, K_APPROACH);
  p.prog = P_DJ_T; p.fn = null; p.prep = null; add(out, p, n);
  p = poolAir.get(n.slot, 7).set('doubleJump', 'jumpOut', null, 3, 26, PF_TAIL | PF_MOVE, PR_MOVE, K_RETREAT);
  p.prog = P_DJ_B; p.fn = null; p.prep = null; add(out, p, n);
  p = poolAir.get(n.slot, 8).set('doubleJump', 'jumpUp', null, 3, 26, PF_TAIL, PR_MOVE, K_HOLD);
  p.prog = P_DJ_N; p.fn = null; p.prep = null; add(out, p, n);
  if (n.tg === null) return;
  const ids = attackMoves(v.me);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (moveClass(id) !== MC_AERIAL) continue;
    const m = v.me.moves[id];
    if (m.reach.front <= 0 && m.reach.up < 60) continue;
    if (n.adx > m.reach.front + n.vHalf + 90 || n.dy > 60) continue;
    p = poolAir.get(n.slot, 10 + variantOf(id, 3)).set('doubleJump', nameFor('jump', id, ''), id, 4, 32, PF_ATTACK | PF_TAIL, PR_AERIAL - 1, K_COMMIT);
    p.prog = P_DJ_T_MOVE; p.fn = null; p.prep = null; add(out, p, n);
  }
});

const AIR_DODGE_FAMILY = family('airDodge', AIR_SITS, (v, out) => {
  const n = nv(v);
  if (!n.air || n.me.action !== 'air' || !canAirDodge(n.me)) return;
  const list: [string, Program, number][] = AD_LIST;
  for (let i = 0; i < list.length; i++) {
    const [name, prog, kind] = list[i];
    const p = poolAir.get(n.slot, 20 + i).set('airDodge', name, null, 2, 34, PF_TAIL | PF_STALE, PR_DEFEND, kind);
    p.prog = prog; p.fn = null; p.prep = null; add(out, p, n);
  }
});
const AD_LIST: [string, Program, number][] = [
  ['airDodgeIn', P_AD_T, K_APPROACH], ['airDodgeOut', P_AD_B, K_RETREAT], ['airDodgeHome', P_AD_H, K_RETREAT],
  ['airDodge', P_AD_N, K_HOLD],
];

const AIR_SPECIAL_FAMILY = family('special', AIR_SITS, (v, out) => {
  const n = nv(v);
  if (!n.air || n.me.action !== 'air') return;
  const ids = attackMoves(v.me);
  const off = isOffstage(n.me, n.g);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (moveClass(id) !== MC_SPECIAL) continue;
    const m = v.me.moves[id];
    const recovery = v.me.roles.recovery.indexOf(id) >= 0;
    if (!recovery && n.tg !== null && n.adx > Math.max(m.reach.front, m.reach.back) + n.vHalf + 40) continue;
    if (recovery && !off && (n.tg === null || n.dy > 0 || n.adx > m.reach.front + n.vHalf + 20)) continue;
    const p = poolAir.get(n.slot, 30 + variantOf(id, 0)).set('special', nameFor('air', id, ''), id, 2, m.total + 4,
      PF_ATTACK | PF_TAIL | (m.tags.indexOf('projectile') >= 0 ? PF_PROJ : 0), PR_AERIAL - 3, K_COMMIT);
    p.prog = recovery && off ? P_AIR_SPEC_H : P_AIR_SPEC_T; p.fn = null; p.prep = null; add(out, p, n);
  }
});

// ---------------------------------------------------------------------------------------------
// Multi-opponent positioning (ids 'dash' and 'platform' in the vocabulary; names pos*)
// ---------------------------------------------------------------------------------------------

const poolPos = new PlanPool();
const OPP = new Int32Array(8);

/** Gap kept outside the opponents' span when taking one side. */
const SIDE_GAP = 44;
/** Two opponents on either side within this many px: sandwiched (fallback without the team block). */
const SANDWICH = 150;
/** Two opponents within this many px and closing: converge. */
const CONVERGE = 190;
/** sandwichRisk at or above this counts as sandwiched. */
const SANDWICH_RISK = 0.3;

interface Spread { n: number; minX: number; maxX: number; left: number; right: number; closing: number; cx: number }
const SPREAD: Spread = { n: 0, minX: 0, maxX: 0, left: 0, right: 0, closing: 0, cx: 0 };

function spreadOf(v: DecisionView): Spread {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const k = liveOpponents(s, v.p.meI, OPP);
  SPREAD.n = k; SPREAD.minX = 1e9; SPREAD.maxX = -1e9; SPREAD.left = 0; SPREAD.right = 0; SPREAD.closing = 0; SPREAD.cx = 0;
  for (let i = 0; i < k; i++) {
    const f = s.fighters[OPP[i]];
    if (f.x < SPREAD.minX) SPREAD.minX = f.x;
    if (f.x > SPREAD.maxX) SPREAD.maxX = f.x;
    const d = f.x - me.x;
    SPREAD.cx += f.x / k;
    if (d < 0 && -d < SANDWICH) SPREAD.left++;
    if (d > 0 && d < SANDWICH) SPREAD.right++;
    const toward = d > 0 ? -f.vx : f.vx;
    if (Math.abs(d) < CONVERGE && (toward > 0.5 || Math.abs(d) < 90)) SPREAD.closing++;
  }
  return SPREAD;
}

/** The several-opponent block of the affordances (affordances.ts TeamAffordances), or null. */
interface TeamRead { n: number; sandwich: boolean; sandwichRisk: number; threatSide: number;
  oneSideX: number; oneSided: boolean; freeX: number; freeY: number }
function teamOf(v: DecisionView): TeamRead | null {
  const t = (v.aff as { team?: TeamRead }).team;
  return t !== undefined && t !== null && typeof t.oneSideX === 'number' ? t : null;
}

/**
 * Prepare for "one side": keep the side we are already on when it still fits (hysteresis), else
 * the team block's one-side spot, else the nearer spot just outside the opponents' span.
 * ctx.param = stop x; ctx.dir faces the opponents.
 */
function prepOneSide(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const sp = spreadOf(v);
  const me = v.p.state.fighters[v.p.meI];
  const g = stageGeo(ctx.stage);
  const lo = g.left + 12; const hi = g.right - 12;
  const xr = Math.min(hi, sp.maxX + SIDE_GAP);
  const xl = Math.max(lo, sp.minX - SIDE_GAP);
  const rOk = xr > sp.maxX + 8;
  const lOk = xl < sp.minX - 8;
  let x: number;
  if (me.x > sp.maxX && rOk) x = Math.max(xr, Math.min(me.x, hi));
  else if (me.x < sp.minX && lOk) x = Math.min(xl, Math.max(me.x, lo));
  else {
    const t = teamOf(v);
    if (t !== null && Number.isFinite(t.oneSideX)) x = t.oneSideX;
    else if (rOk && lOk) x = Math.abs(xr - me.x) <= Math.abs(xl - me.x) ? xr : xl;
    else x = rOk ? xr : lOk ? xl : g.cx;
  }
  ctx.param = x;
  ctx.dir = sp.cx > x ? 1 : -1;
}

function prepCenter(p: Plan, v: DecisionView, ctx: PlanCtx): void { ctx.param = stageGeo(ctx.stage).cx; }

/** Prepare for the free spot on the main platform: ctx.param = the team block's freeX. */
function prepFree(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const t = teamOf(v);
  ctx.param = t !== null ? t.freeX : stageGeo(ctx.stage).cx;
}

/**
 * Prepare for the ledge retreat: ctx.param = the corner away from where the threat comes from
 * (team threatSide), else the side with fewer opponents close.
 */
function prepLedge(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const sp = spreadOf(v);
  const g = stageGeo(ctx.stage);
  const me = v.p.state.fighters[v.p.meI];
  const t = teamOf(v);
  if (t !== null && Math.abs(t.threatSide) > 0.1) { ctx.param = t.threatSide > 0 ? g.left : g.right; return; }
  ctx.param = sp.left < sp.right || (sp.left === sp.right && me.x < g.cx) ? g.left : g.right;
}

/** Disengage: dash away from the threat side (else the opponents' centroid); ctx.param = a stop x. */
function prepDisengage(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const sp = spreadOf(v);
  const me = v.p.state.fighters[v.p.meI];
  const g = stageGeo(ctx.stage);
  const t = teamOf(v);
  const away = t !== null && Math.abs(t.threatSide) > 0.1 ? (t.threatSide > 0 ? -1 : 1) : me.x >= sp.cx ? 1 : -1;
  let x = me.x + away * 140;
  if (x > g.right - 30 || x < g.left + 30) x = away > 0 ? g.left + 40 : g.right - 40;   // cornered: cross back over
  ctx.param = x;
}

const MULTI_FAMILY = family('dash', GROUND_SITS, (v, out) => {
  const n = nv(v);
  if (!n.grounded) return;
  const sp = spreadOf(v);
  if (sp.n < 2) return;
  const me = n.me;
  const t = teamOf(v);
  const oneSide = t !== null ? t.oneSided : me.x > sp.maxX + 8 || me.x < sp.minX - 8;
  const sandwiched = (sp.left > 0 && sp.right > 0) || (t !== null && (t.sandwich || t.sandwichRisk >= SANDWICH_RISK));
  let p = poolPos.get(n.slot, 0).set('dash', 'posOneSide', null, 1, 60, PF_INTR | PF_MOVE,
    oneSide ? PR_MOVE : PR_MULTI, K_HOLD);
  p.prog = null; p.fn = goFire; p.prep = prepOneSide; p.data = FIRE_NONE; add(out, p, n);
  if (Math.abs(me.x - n.g.cx) > 60) {
    p = poolPos.get(n.slot, 1).set('dash', 'posCenter', null, 1, 50, PF_INTR | PF_MOVE, PR_MULTI - 6, K_HOLD);
    p.prog = null; p.fn = goFire; p.prep = prepCenter; p.data = FIRE_NONE; add(out, p, n);
  }
  if (t !== null && Math.abs(t.freeY - n.g.top) < 1 && Math.abs(t.freeX - me.x) > 40) {
    p = poolPos.get(n.slot, 5).set('dash', 'posFree', null, 1, 50, PF_INTR | PF_MOVE, PR_MULTI - 4, K_RETREAT);
    p.prog = null; p.fn = goFire; p.prep = prepFree; p.data = FIRE_NONE; add(out, p, n);
  }
  if (sandwiched) {
    // A pass-through platform: the team block's free spot when it is one, else the nearest reachable.
    let plat = -1; let bd = 1e9;
    for (let i = 0; i < n.g.softCount; i++) {
      const l = n.g.soft[i * 3]; const r = n.g.soft[i * 3 + 1]; const y = n.g.soft[i * 3 + 2];
      const rise = me.y - y;
      if (rise <= 4 || rise > v.me.recovery.rise.fullHop - 4) continue;
      const free = t !== null && Math.abs(t.freeY - y) < 1 && t.freeX >= l && t.freeX <= r;
      const d = free ? -1 : Math.abs((l + r) / 2 - me.x);
      if (d < bd) { bd = d; plat = i; }
    }
    if (plat >= 0 && bd < 160) {
      const l = n.g.soft[plat * 3]; const r = n.g.soft[plat * 3 + 1];
      p = poolPos.get(n.slot, 2).set('platform', 'posPlatform', null, 5, 44, PF_TAIL | PF_MOVE, PR_MULTI + 4, K_RETREAT);
      p.prog = null; p.fn = platformJumpFn; p.prep = prepAbs; p.param = Math.max(l + 12, Math.min(r - 12, me.x)); add(out, p, n);
    }
    p = poolPos.get(n.slot, 3).set('dash', 'posLedge', null, 4, 70, PF_TAIL | PF_MOVE | PF_INTR, PR_MULTI + 2, K_RETREAT);
    p.prog = null; p.fn = ledgeRetreatFn; p.prep = prepLedge; add(out, p, n);
  }
  if (sp.closing >= 2) {
    p = poolPos.get(n.slot, 4).set('dash', 'posDisengage', null, 6, 40, PF_MOVE, PR_MULTI + 3, K_RETREAT);
    p.prog = null; p.fn = goFire; p.prep = prepDisengage; p.data = FIRE_NONE; add(out, p, n);
  }
});

// ---------------------------------------------------------------------------------------------
// Respawn and Final Smash
// ---------------------------------------------------------------------------------------------

const RESPAWN_FAMILY = family('respawn', ['respawn'], (v, out) => {
  const n = nv(v);
  if (n.me.action !== 'respawn') return;
  let p = poolMove.get(n.slot, 20).set('respawn', 'respawnDrop', null, 1, 20, 0, PR_MOVE, K_HOLD);
  p.prog = P_RESPAWN_DROP; p.fn = null; p.prep = null; add(out, p, n);
  p = poolMove.get(n.slot, 21).set('respawn', 'respawnWait', null, 1, 20, PF_INTR, PR_WAIT, K_HOLD);
  p.prog = P_WAIT; p.fn = null; p.prep = null; add(out, p, n);
});

const FINAL_FAMILY = family('finalSmash', ['neutral', 'advantage', 'finalSmash'], (v, out) => {
  const n = nv(v);
  const s = v.p.state;
  if (s.config.finalSmash !== true || n.me.fsMeter < 300 || !n.grounded || n.tg === null) return;
  const p = poolMove.get(n.slot, 22).set('finalSmash', 'finalSmash', null, 2, 24, PF_ATTACK, PR_PUNISH + 10, K_COMMIT);
  p.prog = P_FINAL; p.fn = null; p.prep = null; add(out, p, n);
});


/** Neutral, out-of-shield and airborne families, in registry order. */
export const NEUTRAL_FAMILIES: readonly PlanFamily[] = [
  PUNISH_FAMILY, MULTI_FAMILY, OOS_FAMILY,
  groundAttackFamily('poke'), groundAttackFamily('tilt'), groundAttackFamily('smash'), CHARGED_FAMILY, SPECIAL_FAMILY,
  GRAB_FAMILY, DASH_GRAB_FAMILY, PROJECTILE_FAMILY,
  hopFamily('shAerial'), hopFamily('fastFallAerial'), hopFamily('retreatAerial'), hopFamily('fhAerial'),
  WAIT_FAMILY, WALK_FAMILY, DASH_FAMILY, DASH_DANCE_FAMILY, EMPTY_HOP_FAMILY, BAIT_FAMILY,
  PLATFORM_FAMILY, SHIELD_FAMILY, SPOT_FAMILY, ROLL_FAMILY,
  DRIFT_FAMILY, AIR_AERIAL_FAMILY, DJ_FAMILY, AIR_DODGE_FAMILY, AIR_SPECIAL_FAMILY,
  RESPAWN_FAMILY, FINAL_FAMILY,
];
