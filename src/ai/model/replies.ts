/**
 * Opponent reply models for the rollouts (02 section 7.1; ported from aevalmere.ts `oppStep`,
 * `fixedModels`, `classModel`, `pickModels`, made generic: every reach, move and code comes from
 * the replier's CharacterAiProfile, never from a character's move names).
 *
 * A reply is a fixed policy run for the opponent inside a rollout: `step(t, self, other, ctx, out)`
 * with `self` the replier's fighter in the rollout state, `other` the CPU's fighter and `t` frames
 * since the rollout began. It writes an Intent (held bits and a direct code); `pressed` is derived
 * by whoever turns intents into InputFrames, so a policy that wants a fresh press drops the bit for
 * a frame first. At t = 0 no reply assumes any button was held before (nothing reads the perceived
 * snapshot's inputs); from t = 1 on `self.inputHeld` is the reply's own previous output.
 *
 * The set for a decision: the fixed hypotheses for the replier's situation (neutral: hold, fastest
 * attack, shield then grab, jump, roll toward and away, spot dodge, move in, move out; at the ledge
 * the five ledge options; launched the tech options or the escape set; downed the getup options;
 * off the stage four recovery variants), plus the predictor's top classes, weighted by its
 * confidence and its recent hit rate and capped so at least 25% of the weight stays on the fixed
 * set. The set is cut to the level's `optionsCap` (heaviest first) and renormalized.
 *
 * Several opponents: `buildReplySets` builds one set per other fighter. The primary target and the
 * next most relevant opponent get full sets, any further opponent a single "continue" reply, and
 * every teammate the teammate reply ("continue current input": a teammate is assumed to follow
 * its own current plan). `sampleJoint` draws one reply per set by weight, `jointAt` enumerates the
 * joint outcomes in mixed radix, `jointWeight` gives a joint outcome's weight.
 *
 * Deterministic: no randomness in the set; sampleJoint uses rng.u01. Allocation-free after the
 * first call per output array and per profile (pools and kit tables are cached).
 */
import type { CharacterAiProfile, DecisionView, Intent, ObsContext, PlanCtx, ReplyModel, BuildRepliesFn,
  LevelVector } from '../contracts';
import { ACTION_CLASS_COUNT } from '../contracts';
import type { FighterState, GameState, MoveId, StageDef } from '../../core/types';
import { Btn, DIRECT_CODES, DIRECT_MOVES } from '../../core/types';
import { CHARACTER_DEFS } from '../../characters/registry';
import { STAGE_DEFS } from '../../stages/registry';
import { isLedgeAction } from '../../sim/ledge';
import { sameTeam, type SimFighter } from '../../sim/state';
import { stageGeo, type StageGeo } from '../charprofile/probeHit';
import { getAiProfile } from '../charprofile/derive';
import { STREAM, u01 } from '../rng';
import {
  AC_AD, AC_GETUP_ATTACK, AC_GRAB, AC_IN, AC_JUMP, AC_LEDGE_ATTACK, AC_OUT, AC_ROLL_AWAY, AC_ROLL_TO, AC_SHIELD,
  AC_SPOT, AC_STAND, SIT_DOWN, SIT_LAUNCHED, SIT_LEDGE, SIT_OFF, SIT_SHIELD, makeContext, type PredictorBank,
} from './predictor';

// ---------------------------------------------------------------------------------------------
// Reply kinds
// ---------------------------------------------------------------------------------------------

export const RK = {
  /** Keeps doing what it visibly does (walks on, keeps shielding, keeps hanging), presses nothing new. */
  CONT: 0,
  /** Shields (air dodges in the air), then grabs out of shield. */
  DEF: 1,
  /** Closes and hits with its fastest reaching option. */
  ATK: 2,
  /** Off the stage: recovers (mid variant). */
  REC: 3,
  L_UP: 4, L_ATK: 5, L_ROLL: 6, L_JUMP: 7,
  /** Launched onto the stage: no tech, tech in place, tech roll toward, tech roll away. */
  T_NONE: 8, T_IN: 9, T_TO: 10, T_AWAY: 11,
  /** Air dodges out of hitstun as soon as it ends. */
  ESC: 12,
  D_UP: 13, D_ATK: 14, D_TO: 15, D_AWAY: 16,
  R_TO: 17, R_AWAY: 18,
  /** Uses one move (its direct code is `arg`): closes in and fires in reach. */
  USE: 19,
  GRAB: 20, SPOT: 21, JUMP: 22, AD: 23, IN: 24, OUT: 25,
  /** Recovery variants: early double jump, low (up special saved for last), air dodge onto the ledge. */
  REC_E: 26, REC_L: 27, REC_AD: 28,
  /** Teammate: continues its current input. */
  TEAM: 29,
} as const;

export const REPLY_NAMES: readonly string[] = ['continue', 'defend', 'attack', 'recover', 'ledgeClimb', 'ledgeAttack',
  'ledgeRoll', 'ledgeJump', 'noTech', 'techInPlace', 'techToward', 'techAway', 'escape', 'getUp', 'getUpAttack',
  'getUpRollToward', 'getUpRollAway', 'rollToward', 'rollAway', 'use', 'grab', 'spotDodge', 'jump', 'airDodge',
  'moveIn', 'moveOut', 'recoverEarly', 'recoverLow', 'recoverDodge', 'teammate'];

/** Names of the USE replies by direct code. */
const USE_NAMES: readonly string[] = ((): string[] => {
  const n: string[] = ['use'];
  for (let i = 0; i < DIRECT_CODES.length; i++) n.push(`use:${DIRECT_CODES[i]}`);
  return n;
})();

/** The replier's profile: the view's opponent or own profile when the character matches, else the cache. */
function profileFor(v: DecisionView, f: FighterState): CharacterAiProfile {
  if (f.charId === v.opp.charId) return v.opp;
  if (f.charId === v.me.charId) return v.me;
  return getAiProfile(f.charId, v.p.state.stageId);
}

/** Hard cap on replies per set, whatever the level says. */
export const REPLY_MAX = 12;
/** Share of the weight the fixed set always keeps (02 section 7.1). */
export const FIXED_FLOOR = 0.25;
/** Predictor classes considered. */
const PRED_TOPK = 3;

// ---------------------------------------------------------------------------------------------
// Codes and kit tables
// ---------------------------------------------------------------------------------------------

const CODES = DIRECT_CODES as readonly string[];
function codeOf(name: string): number { return CODES.indexOf(name) + 1; }
const C_SPOT = codeOf('spotDodge');
const C_ROLLF = codeOf('rollForward');
const C_ROLLB = codeOf('rollBack');
const C_DIRAD = codeOf('dirAirDodge');
const C_LATK = codeOf('ledgeAttack');
const C_LROLL = codeOf('ledgeRoll');
const C_LUP = codeOf('ledgeGetUp');
const C_LJUMP = codeOf('ledgeJump');
const C_GUATK = codeOf('getupAttack');
const C_TECH = codeOf('tech');

const L = Btn.Left, R = Btn.Right, U = Btn.Up, D = Btn.Down, J = Btn.Jump, A = Btn.Attack, SH = Btn.Shield,
  G = Btn.Grab;

interface KitMove { code: number; startup: number; front: number; back: number; up: number; down: number }
/** Per-profile table of what the reply scripts may use. */
interface Kit {
  ground: KitMove[];      // grounded pokes by startup
  antiAir: KitMove[];     // grounded anti-airs by startup
  air: KitMove[];         // aerials by startup
  grabReach: number;
  recoveryCode: number;
  /** Per direct code (index = code): reach used by USE, and whether aerial or a shot. */
  useReach: Float64Array; useAir: Uint8Array; useShot: Uint8Array; has: Uint8Array;
}
const kitCache = new WeakMap<CharacterAiProfile, Kit>();

function kitOf(p: CharacterAiProfile): Kit {
  let k = kitCache.get(p);
  if (k !== undefined) return k;
  const n = CODES.length + 1;
  k = { ground: [], antiAir: [], air: [], grabReach: p.grab.standing.reach, recoveryCode: 0,
    useReach: new Float64Array(n), useAir: new Uint8Array(n), useShot: new Uint8Array(n), has: new Uint8Array(n) };
  const shotMoves = new Set<string>();
  for (let i = 0; i < p.shots.length; i++) shotMoves.add(p.shots[i].moveId);
  const ids = Object.keys(p.moves) as MoveId[];
  for (let i = 0; i < ids.length; i++) {
    const m = p.moves[ids[i]];
    const code = CODES.indexOf(ids[i]) + 1;
    if (code <= 0 || code > DIRECT_MOVES.length) continue;
    if (m.tags.length === 0 && !(m.maxDamage > 0) && !shotMoves.has(ids[i])) continue;
    k.has[code] = 1;
    const aerial = m.landingLag > 0;
    const shot = shotMoves.has(ids[i]) && m.tags.indexOf('poke') < 0;
    k.useAir[code] = aerial ? 1 : 0;
    k.useShot[code] = shot ? 1 : 0;
    k.useReach[code] = m.reach.front;
    const km: KitMove = { code, startup: m.startup, front: m.reach.front, back: m.reach.back, up: m.reach.up, down: m.reach.down };
    const recovery = m.tags.indexOf('recovery') >= 0;
    if (aerial) { k.air.push(km); continue; }
    if (shot || recovery || m.chargeable || m.total > 45) continue;
    k.ground.push(km);
    if (m.tags.indexOf('antiAir') >= 0) k.antiAir.push(km);
  }
  const byStartup = (a: KitMove, b: KitMove): number => a.startup - b.startup || a.code - b.code;
  k.ground.sort(byStartup); k.antiAir.sort(byStartup); k.air.sort(byStartup);
  const rec = p.roles.recovery;
  for (let i = 0; i < rec.length && k.recoveryCode === 0; i++) {
    const c = CODES.indexOf(rec[i]) + 1;
    if (c > 0) k.recoveryCode = c;
  }
  kitCache.set(p, k);
  return k;
}

const geoCache = new Map<string, StageGeo>();
function geoOf(stageId: string): StageGeo {
  let g = geoCache.get(stageId);
  if (g === undefined) {
    const st: StageDef | undefined = STAGE_DEFS[stageId];
    g = st !== undefined ? stageGeo(st) : { main: { x: -180, y: 0, w: 360, h: 24, solid: true, ledgeLeft: true, ledgeRight: true },
      mainIndex: 0, top: 0, left: -180, right: 180, center: 0 };
    geoCache.set(stageId, g);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Fighter reads (visible state only)
// ---------------------------------------------------------------------------------------------

function actionable(f: FighterState): boolean {
  if (f.hitlag > 0) return false;
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'air': case 'shield':
    case 'land':
      return true;
    case 'attack': {
      if (f.moveId === null) return false;
      const def = CHARACTER_DEFS[f.charId];
      const mv = def === undefined ? undefined : def.moves[f.moveId];
      return mv !== undefined && mv.iasa !== undefined && f.actionFrame >= mv.iasa;
    }
    default: return false;
  }
}

function launched(f: FighterState): boolean {
  return (f.action === 'hitstun' || f.action === 'tumble') && f.hitstun > 0;
}

function canAirDodge(f: FighterState): boolean { return !(f as SimFighter).airDodgeUsed; }

/** Off the stage: airborne, not on a ledge, and past a corner or below the top. */
export function offstageOf(f: FighterState, g: StageGeo): boolean {
  if (f.onGround || isLedgeAction(f.action)) return false;
  if (Math.abs(f.y - g.top) < 0.5 && f.vy === 0 && f.x > g.left - 14 && f.x < g.right + 14) return false;
  return f.x < g.left - 2 || f.x > g.right + 2 || f.y > g.top + 2;
}

function techCase(f: FighterState, g: StageGeo): boolean {
  return f.action === 'tumble' && f.x > g.left && f.x < g.right && f.y <= g.top + 2;
}

function faceIn(self: FighterState, other: FighterState): boolean {
  return (self.facing === 1) === (other.x > self.x);
}

/** A fresh press of `bit`: at t = 0 always, later only when the reply did not hold it last frame. */
function press(bit: number, t: number, self: FighterState): number {
  return t === 0 || (self.inputHeld & bit) === 0 ? bit : 0;
}

// ---------------------------------------------------------------------------------------------
// The policies
// ---------------------------------------------------------------------------------------------

/** Recovery policy for variant 0 early jump, 1 mid, 2 low, 3 air dodge to the ledge. */
const REC_JUMP_AT = [-30, -5, 25, -5];
const REC_US_AT = [-10, 15, 45, 20];
const UNDER_CLEAR = 20;

function recoverStep(t: number, self: FighterState, g: StageGeo, kit: Kit, variant: number, out: Intent): void {
  if (self.onGround || isLedgeAction(self.action)) return;
  const out0 = self.x < g.left ? g.left - self.x : self.x > g.right ? self.x - g.right : 0;
  if (out0 === 0 && self.y <= g.top) return;
  const under = self.y > g.top + g.main.h && self.x > g.left - UNDER_CLEAR && self.x < g.right + UNDER_CLEAR;
  const homeRight = under ? self.x >= g.center : self.x < g.center;
  out.held = homeRight ? R : L;
  if (self.action !== 'air') return;
  const below = self.y - g.top;
  if (under) {
    if (self.jumpsLeft > 0 && self.vy > 1 && self.y > g.top + g.main.h + 90) out.held |= press(J, t, self);
    return;
  }
  if (self.jumpsLeft > 0 && self.vy > -0.5 && below > REC_JUMP_AT[variant]) { out.held |= press(J, t, self); return; }
  if (variant === 3 && self.jumpsLeft === 0 && canAirDodge(self) && out0 < 70 && below > -20 && below < 40) {
    out.direct = C_DIRAD; out.held |= U;
    return;
  }
  if (self.jumpsLeft === 0 && self.vy > 0 && below > REC_US_AT[variant] && kit.recoveryCode > 0) {
    out.direct = kit.recoveryCode; out.held |= U;
  }
}

/** Closes and hits with the fastest reaching option (port of OM_ATK, generic). */
function attackStep(t: number, self: FighterState, other: FighterState, g: StageGeo, kit: Kit, out: Intent): void {
  const toMe = other.x < self.x ? L : R;
  const adx = Math.abs(other.x - self.x);
  const dy = other.y - self.y;
  if (!actionable(self)) return;
  if (self.onGround) {
    if (offstageOf(other, g) && adx < 110 && dy > -70 && self.action !== 'shield') { out.held = toMe | press(J, t, self); return; }
    if (other.action === 'shield' && adx < kit.grabReach + 13 && Math.abs(dy) < 30) {
      out.held = self.action === 'shield' ? SH | press(A, t, self) : press(G, t, self);
      return;
    }
    if (self.action === 'shield') return;       // drops the shield first
    if (dy < -40 && adx < 30) {
      for (let i = 0; i < kit.antiAir.length; i++) {
        const m = kit.antiAir[i];
        if (m.up >= -dy - 10) { out.direct = m.code; return; }
      }
    }
    const inFace = faceIn(self, other);
    for (let i = 0; i < kit.ground.length; i++) {
      const m = kit.ground[i];
      const reach = inFace ? m.front : m.back;
      if (reach <= 0 || adx > reach + 4) continue;
      if (dy < -(m.up + 10) || dy > m.down + 30) continue;
      out.direct = m.code;
      if (inFace) out.held = toMe;
      return;
    }
    out.held = toMe;
    return;
  }
  out.held = toMe;
  if (self.vy > 0 && adx < 18 && dy > 36 && dy < 66) { out.held |= press(J, t, self); return; }   // footstool
  const inFace = faceIn(self, other);
  for (let i = 0; i < kit.air.length; i++) {
    const m = kit.air[i];
    const reach = inFace ? m.front : m.back;
    const hReach = reach > 0 ? reach : (adx < 20 ? 20 : 0);
    if (adx > hReach + 6) continue;
    if (dy < 0 && -dy > m.up + 6) continue;
    if (dy > 0 && dy > m.down + 44) continue;
    out.direct = m.code;
    return;
  }
}

/** One named move (direct code `code`): closes in and fires in reach (port of OM_USE). */
function useStep(t: number, self: FighterState, other: FighterState, kit: Kit, code: number, out: Intent): void {
  if (!actionable(self)) return;
  const toMe = other.x < self.x ? L : R;
  const adx = Math.abs(other.x - self.x);
  const dy = other.y - self.y;
  if (kit.useShot[code] === 1) {
    if (faceIn(self, other) && adx < kit.useReach[code] + 60) out.direct = code; else out.held = toMe;
    return;
  }
  out.held = toMe;
  if (kit.useAir[code] === 1 && self.onGround) {
    if (adx < kit.useReach[code] + 50 && t < 30) out.held |= press(J, t, self);
    return;
  }
  if (adx <= kit.useReach[code] + 8 && Math.abs(dy) < 56) out.direct = code;
}

class Reply implements ReplyModel {
  kind = 0; arg = 0; weight = 0; name = '';
  /** Weight from the fixed set and from the predictor (weight = fixedW + predW). */
  fixedW = 0; predW = 0;
  kit: Kit | null = null;
  geo: StageGeo | null = null;
  /** Direction bits the replier was visibly moving with at build time (CONT). */
  contDir = 0; contShield = false;
  /** Teammate: held bits at build time. */
  teamHeld = 0;

  step(t: number, self: FighterState, other: FighterState, _ctx: PlanCtx, out: Intent): void {
    out.held = 0; out.direct = 0; out.mash = 0;
    const kit = this.kit, g = this.geo;
    if (kit === null || g === null) return;
    let kind = this.kind;
    if (self.action === 'dead' || self.action === 'respawn') return;
    const isRec = kind === RK.REC || kind === RK.REC_E || kind === RK.REC_L || kind === RK.REC_AD;
    if (!isRec && kind !== RK.CONT && kind !== RK.TEAM && offstageOf(self, g)) kind = RK.REC;
    const toMe = other.x < self.x ? L : R;
    const away = other.x < self.x ? R : L;
    const adx = Math.abs(other.x - self.x);
    const dy = other.y - self.y;
    switch (kind) {
      case RK.TEAM:
        out.held = t === 0 ? this.teamHeld & (L | R | U | D | SH) : self.inputHeld;
        return;
      case RK.CONT:
        if (offstageOf(self, g)) { recoverStep(t, self, g, kit, 1, out); return; }
        out.held = this.contDir | (this.contShield && self.action === 'shield' ? SH : 0);
        return;
      case RK.USE: useStep(t, self, other, kit, this.arg, out); return;
      case RK.ATK: attackStep(t, self, other, g, kit, out); return;
      case RK.GRAB:
        if (!actionable(self)) return;
        out.held = toMe;
        if (self.onGround && adx < kit.grabReach + 13 && Math.abs(dy) < 30) out.held |= press(G, t, self);
        return;
      case RK.SPOT:
        if (self.onGround && actionable(self) && (t === 0 || adx < 60)) out.direct = C_SPOT;
        return;
      case RK.JUMP:
        if (self.onGround) { out.held = actionable(self) && t < 5 ? J | toMe : toMe; return; }
        out.held = toMe;
        if (t === 0 && self.jumpsLeft > 0 && self.action === 'air') out.held |= J;
        return;
      case RK.AD:
        if (self.onGround) { if (t < 2 && actionable(self)) out.held = J; return; }
        out.held = away;
        if (self.action === 'air' && t < 12 && canAirDodge(self)) out.direct = C_DIRAD;
        return;
      case RK.IN: out.held = toMe; return;
      case RK.OUT: out.held = away; return;
      case RK.DEF:
        if (self.onGround) {
          out.held = SH;
          if (self.action === 'shield' && adx < kit.grabReach + 13 && Math.abs(dy) < 30 && other.invuln === 0) {
            out.held |= press(A, t, self);
          }
        } else if (t === 0 && actionable(self) && canAirDodge(self)) {
          out.direct = C_DIRAD; out.held = away;
        } else {
          out.held = away;
        }
        return;
      case RK.L_UP: if (self.action === 'ledgeHang' && t === 0) out.direct = C_LUP; return;
      case RK.L_ATK: if (self.action === 'ledgeHang' && t === 0) out.direct = C_LATK; return;
      case RK.L_ROLL: if (self.action === 'ledgeHang' && t === 0) out.direct = C_LROLL; return;
      case RK.L_JUMP: if (self.action === 'ledgeHang' && t === 0) out.direct = C_LJUMP; return;
      case RK.T_NONE: return;
      case RK.T_IN: case RK.T_TO: case RK.T_AWAY: {
        if (kind === RK.T_TO) out.held = toMe;
        else if (kind === RK.T_AWAY) out.held = away;
        // The press lands inside the 20-frame window before touchdown; the lockout ignores repeats.
        if ((self.action === 'tumble' || launched(self)) && self.vy > 0 && self.x > g.left && self.x < g.right) {
          const toLand = (g.top - self.y) / (self.vy > 0.5 ? self.vy : 0.5);
          if (toLand <= 12) out.direct = C_TECH;
        }
        return;
      }
      case RK.ESC:
        out.held = away;
        if (self.action === 'tumble' && self.hitstun <= 0 && canAirDodge(self)) out.direct = C_DIRAD;
        return;
      case RK.D_UP: if (self.action === 'downed' && (t & 1) === 0) out.held = U; return;
      case RK.D_ATK: if (self.action === 'downed') out.direct = C_GUATK; return;
      case RK.D_TO: if (self.action === 'downed' && (t & 1) === 0) out.held = toMe; return;
      case RK.D_AWAY: if (self.action === 'downed' && (t & 1) === 0) out.held = away; return;
      case RK.R_TO: case RK.R_AWAY:
        if (self.onGround && (actionable(self) || self.action === 'shieldStun')) {
          const toward = kind === RK.R_TO;
          out.direct = toward === faceIn(self, other) ? C_ROLLF : C_ROLLB;
        }
        return;
      case RK.REC: recoverStep(t, self, g, kit, 1, out); return;
      case RK.REC_E: recoverStep(t, self, g, kit, 0, out); return;
      case RK.REC_L: recoverStep(t, self, g, kit, 2, out); return;
      case RK.REC_AD: recoverStep(t, self, g, kit, 3, out); return;
      default: return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Building a set
// ---------------------------------------------------------------------------------------------

class Pool {
  readonly items: Reply[] = [];
  get(i: number): Reply {
    while (this.items.length <= i) this.items.push(new Reply());
    return this.items[i];
  }
}
const pools = new WeakMap<ReplyModel[], Pool>();
function poolFor(out: ReplyModel[]): Pool {
  let p = pools.get(out);
  if (p === undefined) { p = new Pool(); pools.set(out, p); }
  return p;
}

/** Working state of one build (module scratch; builds never overlap, the brain is single-threaded). */
let bPool: Pool = new Pool();
let bN = 0;
let bKit: Kit | null = null;
let bGeo: StageGeo | null = null;
let bContDir = 0;
let bContShield = false;
const predOut = new Float64Array(ACTION_CLASS_COUNT);
const ctxScratch: ObsContext = { sit: 0, dist: 0, ours: 0, last: -1, prev: -1, phase: 0, pctBucket: 0, zone: 0 };

function add(kind: number, arg: number, fixedW: number, predW: number): void {
  if (!(fixedW > 0) && !(predW > 0)) return;
  for (let i = 0; i < bN; i++) {
    const r = bPool.items[i];
    if (r.kind === kind && r.arg === arg) { r.fixedW += fixedW; r.predW += predW; return; }
  }
  const r = bPool.get(bN++);
  r.kind = kind; r.arg = arg; r.fixedW = fixedW > 0 ? fixedW : 0; r.predW = predW > 0 ? predW : 0;
  r.name = kind === RK.USE ? USE_NAMES[arg] : REPLY_NAMES[kind];
  r.kit = bKit; r.geo = bGeo; r.contDir = bContDir; r.contShield = bContShield; r.teamHeld = 0;
}

/** Situation bucket in the predictor's alphabet for the replier. */
function sitOf(o: FighterState, g: StageGeo): number {
  if (o.action === 'ledgeHang' || isLedgeAction(o.action)) return SIT_LEDGE;
  if (o.action === 'downed') return SIT_DOWN;
  if (launched(o) || o.action === 'tumble') return SIT_LAUNCHED;
  if (offstageOf(o, g)) return SIT_OFF;
  if (o.action === 'shield' || o.action === 'shieldStun') return SIT_SHIELD;
  return o.onGround ? 0 : 1;
}

/** Fixed hypotheses for the replier's situation; returns true when the situation is neutral. */
function fixedSet(o: FighterState, g: StageGeo, passivity: number): boolean {
  if (o.action === 'dead' || o.action === 'respawn' || o.stocks <= 0) { add(RK.CONT, 0, 1, 0); return false; }
  if (o.action === 'ledgeHang' || o.action === 'ledgeGrab') {
    add(RK.L_UP, 0, 0.25, 0); add(RK.L_ATK, 0, 0.2, 0); add(RK.L_ROLL, 0, 0.2, 0); add(RK.L_JUMP, 0, 0.2, 0);
    add(RK.CONT, 0, 0.15, 0);
    return false;
  }
  if (o.action === 'downed') {
    add(RK.D_UP, 0, 0.3, 0); add(RK.D_ATK, 0, 0.25, 0); add(RK.D_TO, 0, 0.2, 0); add(RK.D_AWAY, 0, 0.25, 0);
    return false;
  }
  if (launched(o) || o.action === 'tumble') {
    if (techCase(o, g)) {
      add(RK.T_NONE, 0, 0.2, 0); add(RK.T_IN, 0, 0.3, 0); add(RK.T_TO, 0, 0.25, 0); add(RK.T_AWAY, 0, 0.25, 0);
    } else {
      add(RK.CONT, 0, 0.35, 0); add(RK.ESC, 0, 0.35, 0); add(RK.ATK, 0, 0.3, 0);
    }
    return false;
  }
  if (offstageOf(o, g)) {
    add(RK.REC, 0, 0.55, 0); add(RK.REC_E, 0, 0.15, 0); add(RK.REC_L, 0, 0.15, 0); add(RK.REC_AD, 0, 0.15, 0);
    return false;
  }
  if (o.action === 'shield' || o.action === 'shieldStun') {
    add(RK.CONT, 0, 0.3, 0); add(RK.DEF, 0, 0.3, 0); add(RK.ATK, 0, 0.2, 0);
    add(RK.R_TO, 0, 0.1, 0); add(RK.R_AWAY, 0, 0.1, 0);
    return false;
  }
  // Neutral: a passive opponent is read as such (the hold reply takes the weight).
  const pas = passivity > 0 ? (passivity > 1 ? 1 : passivity) : 0;
  const act = 1 - pas;
  add(RK.CONT, 0, 0.2 * act + pas, 0);
  add(RK.ATK, 0, 0.25 * act, 0);
  add(RK.DEF, 0, 0.18 * act, 0);
  add(RK.JUMP, 0, 0.1 * act, 0);
  add(RK.R_TO, 0, 0.06 * act, 0);
  add(RK.R_AWAY, 0, 0.06 * act, 0);
  add(RK.SPOT, 0, 0.05 * act, 0);
  add(RK.IN, 0, 0.05 * act, 0);
  add(RK.OUT, 0, 0.05 * act, 0);
  return true;
}

/** Reply kind (and arg into `clsArg`) that plays out predicted class `cls` in situation `sit`. */
let clsArg = 0;
function classKind(cls: number, sit: number, tech: boolean, kit: Kit): number {
  clsArg = 0;
  if (sit === SIT_OFF) {
    if (cls === AC_JUMP) return RK.REC_E;
    if (cls === AC_AD) return RK.REC_AD;
    if (cls < DIRECT_MOVES.length && kit.recoveryCode === cls + 1) return RK.REC_L;
    return RK.REC;
  }
  if (sit === SIT_LAUNCHED && tech) {
    if (cls === AC_ROLL_TO) return RK.T_TO;
    if (cls === AC_ROLL_AWAY) return RK.T_AWAY;
    if (cls === AC_STAND) return RK.T_IN;
    return RK.T_NONE;
  }
  if (cls < DIRECT_MOVES.length) {
    if (sit === SIT_LAUNCHED) return RK.ATK;
    const code = cls + 1;                  // DIRECT_CODES starts with DIRECT_MOVES
    if (kit.has[code] !== 1) return RK.ATK;
    clsArg = code;
    return RK.USE;
  }
  switch (cls) {
    case AC_LEDGE_ATTACK: return RK.L_ATK;
    case AC_GETUP_ATTACK: return RK.D_ATK;
    case AC_GRAB: return sit === SIT_SHIELD ? RK.DEF : RK.GRAB;
    case AC_SHIELD: return RK.DEF;
    case AC_ROLL_TO: return sit === SIT_LEDGE ? RK.L_ROLL : sit === SIT_DOWN ? RK.D_TO : RK.R_TO;
    case AC_ROLL_AWAY: return sit === SIT_DOWN ? RK.D_AWAY : sit === SIT_LEDGE ? RK.L_ROLL : RK.R_AWAY;
    case AC_SPOT: return RK.SPOT;
    case AC_JUMP: return sit === SIT_LEDGE ? RK.L_JUMP : sit === SIT_LAUNCHED ? RK.CONT : RK.JUMP;
    case AC_AD: return sit === SIT_LAUNCHED ? RK.ESC : RK.AD;
    case AC_IN: return RK.IN;
    case AC_OUT: return sit === SIT_LEDGE ? RK.CONT : RK.OUT;
    case AC_STAND: return sit === SIT_LEDGE ? RK.L_UP : sit === SIT_DOWN ? RK.D_UP : RK.CONT;
    default: return RK.CONT;
  }
}

function isBank(p: unknown): p is PredictorBank {
  return typeof (p as PredictorBank).stats === 'function';
}

/** Cap from the level: optionsCap (Infinity = all) and REPLY_MAX. */
export function replyCap(level: LevelVector): number {
  const c = level.optionsCap;
  if (!(c >= 1)) return 1;
  return c > REPLY_MAX ? REPLY_MAX : Math.floor(c);
}

/** Predictor share this decision: mix cap x confidence x earned accuracy, never over 1 - FIXED_FLOOR. */
function predictorShare(v: DecisionView, conf: number): number {
  if (!v.level.learning.enabled) return 0;
  let acc = 0.5;
  if (isBank(v.pred)) {
    const s = v.pred.stats();
    if (s.recentN >= 10) acc = s.recent / s.recentN;
  }
  const earned = acc <= 0.25 ? 0 : acc >= 0.65 ? 1 : (acc - 0.25) / 0.4;
  let cap = v.style.predictorMixCap;
  if (cap > 1 - FIXED_FLOOR) cap = 1 - FIXED_FLOOR;
  const c = conf > 1 ? 1 : conf > 0 ? conf : 0;
  return cap * c * earned;
}

/**
 * Reply set against fighter `oppI` into `out`, returns the count. `usePred`: mix in the view's
 * predictor (true only for the fighter the predictor observes). `cap`: set size limit.
 */
export function buildRepliesFor(v: DecisionView, oppI: number, out: ReplyModel[], usePred: boolean, cap: number): number {
  const state = v.p.state;
  const o = state.fighters[oppI];
  bPool = poolFor(out);
  bN = 0;
  bKit = kitOf(profileFor(v, o));
  bGeo = geoOf(state.stageId);
  // Visible motion for the hold reply: its direction of travel, and a shield it is holding.
  bContDir = o.onGround && Math.abs(o.vx) > 0.3 ? (o.vx < 0 ? L : R) : 0;
  bContShield = o.action === 'shield';
  const neutral = fixedSet(o, bGeo, oppI === v.p.oppI ? v.p.passivity : 0);
  let fixedTotal = 0;
  for (let i = 0; i < bN; i++) fixedTotal += bPool.items[i].fixedW;
  for (let i = 0; i < bN; i++) bPool.items[i].fixedW /= fixedTotal > 0 ? fixedTotal : 1;

  const alive = o.action !== 'dead' && o.action !== 'respawn' && o.stocks > 0;
  if (usePred && alive && cap > 1) {
    makeContext(state, v.p.meI, oppI, v.p.frame, ctxScratch);
    const conf = v.pred.predict(ctxScratch, predOut);
    const share = predictorShare(v, conf);
    if (share > 0.01) {
      for (let i = 0; i < bN; i++) bPool.items[i].fixedW *= 1 - share;
      const sit = sitOf(o, bGeo);
      const tech = techCase(o, bGeo);
      // Top classes, highest probability first (lowest class on ties).
      let sumTop = 0;
      let p0 = -1, p1 = -1, p2 = -1;
      for (let r = 0; r < PRED_TOPK; r++) {
        let b = -1;
        for (let a = 0; a < ACTION_CLASS_COUNT; a++) {
          if (a === p0 || a === p1) continue;
          if (b < 0 || predOut[a] > predOut[b]) b = a;
        }
        if (b < 0 || !(predOut[b] > 0)) break;
        if (r === 0) p0 = b; else if (r === 1) p1 = b; else p2 = b;
        sumTop += predOut[b];
      }
      for (let r = 0; r < PRED_TOPK; r++) {
        const cls = r === 0 ? p0 : r === 1 ? p1 : p2;
        if (cls < 0) continue;
        const kind = classKind(cls, sit, tech, bKit);
        add(kind, clsArg, 0, share * predOut[cls] / (sumTop > 0 ? sumTop : 1));
      }
    }
  }
  for (let i = 0; i < bN; i++) { const r = bPool.items[i]; r.weight = r.fixedW + r.predW; }
  sortSet(bPool.items, bN);
  // Neutral: keep the attacking reply among the first two (movement is judged against those).
  if (neutral && bN > 2 && bPool.items[0].kind !== RK.ATK && bPool.items[1].kind !== RK.ATK) {
    for (let i = 2; i < bN; i++) {
      if (bPool.items[i].kind !== RK.ATK) continue;
      const tmp = bPool.items[1]; bPool.items[1] = bPool.items[i]; bPool.items[i] = tmp;
      break;
    }
  }
  const n = bN < cap ? bN : cap;
  normalizeFixedFloor(bPool.items, n);
  out.length = n;
  for (let i = 0; i < n; i++) out[i] = bPool.items[i];
  return n;
}

/** Heaviest first; ties by kind then arg, so the order is a pure function of the weights. */
function sortSet(items: Reply[], n: number): void {
  for (let i = 1; i < n; i++) {
    const x = items[i];
    let j = i - 1;
    while (j >= 0 && (items[j].weight < x.weight
      || (items[j].weight === x.weight && (items[j].kind > x.kind || (items[j].kind === x.kind && items[j].arg > x.arg))))) {
      items[j + 1] = items[j]; j--;
    }
    items[j + 1] = x;
  }
}

/** Renormalizes the kept replies to sum 1 with at least FIXED_FLOOR of it on the fixed set. */
function normalizeFixedFloor(items: Reply[], n: number): void {
  let fixed = 0, pred = 0;
  for (let i = 0; i < n; i++) { fixed += items[i].fixedW; pred += items[i].predW; }
  if (!(fixed > 0)) {
    // Every kept reply came from the predictor alone: give the heaviest kept one a fixed share.
    items[0].fixedW = FIXED_FLOOR; fixed = FIXED_FLOOR;
  }
  let predScale = 1;
  if (pred > 0 && fixed / (fixed + pred) < FIXED_FLOOR) predScale = fixed * (1 - FIXED_FLOOR) / (FIXED_FLOOR * pred);
  let total = 0;
  for (let i = 0; i < n; i++) { items[i].predW *= predScale; total += items[i].fixedW + items[i].predW; }
  for (let i = 0; i < n; i++) {
    const r = items[i];
    r.fixedW /= total; r.predW /= total; r.weight = r.fixedW + r.predW;
  }
}

/**
 * The reply set against the view's opponent (02 section 7.1) into `out`, heaviest first, weights
 * summing to 1, at most `optionsCap` (and REPLY_MAX) long. The objects are pooled per `out` array
 * and stay valid until the next call with the same array.
 */
export const buildReplies: BuildRepliesFn = (v, out) => buildRepliesFor(v, v.p.oppI, out, true, replyCap(v.level));

/** Share of a set's weight on the fixed hypotheses (at least FIXED_FLOOR by construction). */
export function fixedShare(set: readonly ReplyModel[], n: number): number {
  let f = 0, t = 0;
  for (let i = 0; i < n; i++) { const r = set[i] as Reply; t += r.weight; f += r.fixedW !== undefined ? r.fixedW : r.weight; }
  return t > 0 ? f / t : 0;
}

// ---------------------------------------------------------------------------------------------
// Several opponents and teammates (02 section 15)
// ---------------------------------------------------------------------------------------------

export interface ReplySets {
  /** Number of filled sets. */
  count: number;
  /** Fighter index each set replies for. */
  fighter: Int32Array;
  /** 1 = teammate set (a single teammate reply). */
  teammate: Uint8Array;
  /** Replies per set and their counts. */
  sets: ReplyModel[][];
  n: Int32Array;
}

/** Preallocated sets for up to `maxFighters` other fighters. */
export function createReplySets(maxFighters = 3): ReplySets {
  const sets: ReplyModel[][] = [];
  for (let i = 0; i < maxFighters; i++) sets.push([]);
  return { count: 0, fighter: new Int32Array(maxFighters), teammate: new Uint8Array(maxFighters), sets,
    n: new Int32Array(maxFighters) };
}

/** A single-reply set of `kind` for fighter `fi`. */
function singleSet(v: DecisionView, fi: number, out: ReplyModel[], kind: number): number {
  const state = v.p.state;
  bPool = poolFor(out);
  bN = 0;
  const f = state.fighters[fi];
  bKit = kitOf(profileFor(v, f));
  bGeo = geoOf(state.stageId);
  bContDir = f.onGround && Math.abs(f.vx) > 0.3 ? (f.vx < 0 ? L : R) : 0;
  bContShield = f.action === 'shield';
  add(kind, 0, 1, 0);
  const r = bPool.items[0];
  r.weight = 1;
  if (kind === RK.TEAM) r.teamHeld = f.inputHeld;
  out.length = 1;
  out[0] = r;
  return 1;
}

/**
 * One reply set per other fighter (02 section 15): the view's opponent with the predictor, every
 * other live opponent with the fixed set cut to half the cap (at least 2), a dead or out-of-stock
 * one "continue", every teammate the teammate reply. Returns the set count.
 *
 * The guide gives the full set to the nearest other opponent only and "continue" to the rest; in a
 * 1v3 a third opponent that only holds its input never attacks in a rollout, so the god chose
 * slow moves the third one punished (brain harness: 7 of 40 against three UI 4s with "continue",
 * 13 to 15 of 40 with a set each).
 */
export function buildReplySets(v: DecisionView, out: ReplySets): number {
  const state = v.p.state;
  const meI = v.p.meI;
  const me = state.fighters[meI];
  const cap = replyCap(v.level);
  const half = cap >> 1;
  const other = half > 2 ? half : (cap < 2 ? cap : 2);
  let c = 0;
  for (let i = 0; i < state.fighters.length && c < out.sets.length; i++) {
    if (i === meI) continue;
    const f = state.fighters[i];
    out.fighter[c] = i;
    if (sameTeam(state, me.slot, f.slot)) {
      out.teammate[c] = 1;
      out.n[c] = singleSet(v, i, out.sets[c], RK.TEAM);
    } else if (i === v.p.oppI) {
      out.teammate[c] = 0;
      out.n[c] = buildRepliesFor(v, i, out.sets[c], true, cap);
    } else if (f.action !== 'dead' && f.stocks > 0) {
      out.teammate[c] = 0;
      out.n[c] = buildRepliesFor(v, i, out.sets[c], false, other);
    } else {
      out.teammate[c] = 0;
      out.n[c] = singleSet(v, i, out.sets[c], RK.CONT);
    }
    c++;
  }
  out.count = c;
  return c;
}

/** Number of joint outcomes (product of the set sizes). */
export function jointCount(s: ReplySets): number {
  let n = 1;
  for (let i = 0; i < s.count; i++) n *= s.n[i] > 0 ? s.n[i] : 1;
  return n;
}

/** Joint outcome `j` (0 .. jointCount - 1) in mixed radix into `outIdx`; returns its weight. */
export function jointAt(s: ReplySets, j: number, outIdx: Int32Array): number {
  let w = 1, rest = j;
  for (let i = 0; i < s.count; i++) {
    const n = s.n[i] > 0 ? s.n[i] : 1;
    const k = rest % n;
    rest = (rest - k) / n;
    outIdx[i] = k;
    w *= s.n[i] > 0 ? s.sets[i][k].weight : 1;
  }
  return w;
}

/** Weight of the joint outcome in `idx` (product of the chosen replies' weights). */
export function jointWeight(s: ReplySets, idx: Int32Array): number {
  let w = 1;
  for (let i = 0; i < s.count; i++) if (s.n[i] > 0) w *= s.sets[i][idx[i]].weight;
  return w;
}

/**
 * Draws one reply per set by weight (rng stream `mix`, sub-key k * 8 + set), into `outIdx`;
 * returns the joint weight. Same arguments, same draw.
 */
export function sampleJoint(s: ReplySets, seed: number, slot: number, frame: number, k: number, outIdx: Int32Array): number {
  for (let i = 0; i < s.count; i++) {
    const n = s.n[i];
    if (n <= 1) { outIdx[i] = 0; continue; }
    let x = u01(seed, slot, frame, STREAM.mix, k * 8 + i);
    let pick = n - 1;
    for (let r = 0; r < n; r++) {
      const w = s.sets[i][r].weight;
      if (x < w) { pick = r; break; }
      x -= w;
    }
    outIdx[i] = pick;
  }
  return jointWeight(s, outIdx);
}

/**
 * Runs the chosen joint reply for every set at rollout frame `t`: fills `intents[i]` for the
 * fighter `s.fighter[i]` of `state`, against the CPU's fighter `meI`.
 */
export function stepJoint(s: ReplySets, idx: Int32Array, t: number, state: GameState, meI: number, ctx: PlanCtx,
  intents: Intent[]): void {
  const me = state.fighters[meI];
  for (let i = 0; i < s.count; i++) {
    const out = intents[i];
    if (s.n[i] <= 0) { out.held = 0; out.direct = 0; out.mash = 0; continue; }
    s.sets[i][idx[i]].step(t, state.fighters[s.fighter[i]], me, ctx, out);
  }
}

/** The teammate reply alone ("continue current input"), for callers that model allies one at a time. */
export function teammateReply(v: DecisionView, fighterI: number, out: ReplyModel[]): number {
  return singleSet(v, fighterI, out, RK.TEAM);
}
