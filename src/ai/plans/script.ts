/**
 * Plan scripts: the input program format and the stepper (docs/CPU_PLAN.md W2.4, cpu-guide 02
 * section 5).
 *
 * A plan is an input program. Its `script(t, self, ctx, out)` reads only the fighter it drives
 * (the real one or a rollout copy) and the plan context, and writes an Intent (held bits, a direct
 * code, mash bits). The same function drives the rollouts and the real controller, so what was
 * evaluated is what gets pressed.
 *
 * Program format. Most families are a static `Program`: a list of `Op`s, each active on script
 * frames [from, to). An op holds bits for its span, taps bits on its first frame (a fresh press,
 * skipped when the bit is still held from the previous frame), sends a direct code on its first
 * frame, and may carry option flags (fast fall once falling, only in the air, only on the ground).
 * Direction bits in an op are relative and resolved against the context when the op runs:
 * REL_T toward the target, REL_B away from it, REL_H toward the stage centre, REL_O toward the
 * nearer blast line. Code CODE_MOVE sends the plan's own move. A plan with a program needs no code.
 * Families whose inputs depend on where the fighter is (approach to a spot, combo links, the
 * passive route) supply a script function instead and keep per-run registers in a RunState.
 *
 * Context contract (what the brain and the rollout do with a chosen plan):
 * 1. At plan start call `preparePlanCtx(plan, view, frame, ctx)`. It fills every PlanCtx field
 *    from the view: `dir` toward the target (`view.p.oppI`, chosen by the targeter), `home`
 *    toward the stage centre, `edgeX` the ledge corner on the target's side, `fireAt` the frame
 *    a timed hit should land (defaults to `frame`), `param` the plan's param, `startFrame` and
 *    `frame`, `me` and `stage`. Plans built here may then override fields in their own prepare
 *    hook (an approach writes its stop x into `param`, a combo writes the hit frame into
 *    `fireAt` and the per-link sides into `param`). PlanCtx has no target field, so the target
 *    reaches a script only through these numbers, fixed at plan start.
 * 2. Each frame set `ctx.frame` to `state.frame` of the state the script reads (the state whose
 *    step the input feeds) and call `plan.script(t, self, ctx, out)`, where `t` counts script
 *    frames and advances only on frames the fighter is not in hitlag.
 * 3. `pressed` and `released` are derived from `held` and the previous output frame by the
 *    executor; `toInputFrame` here does the same for rollouts and tests.
 * `PlanRunner` bundles the three steps for a single fighter.
 *
 * Scripts read `ctx.param`, never `plan.param`: a pooled instance may be regenerated with new
 * numbers while it is still running, but the context was fixed when it started.
 */
import { Btn, DIRECT_CODES, DIRECT_MOVES, MAX_PLAYERS } from '../../core/types';
import type { FighterState, GameState, InputFrame, MoveId, StageDef, ThrowId } from '../../core/types';
import { TUNING } from '../../core/constants';
import { STAGE_DEFS } from '../../stages/registry';
import { CHARACTER_DEFS } from '../../characters/registry';
import { sameTeam } from '../../sim/state';
import type {
  CharacterAiProfile, DecisionView, Intent, MoveAiInfo, PlanCtx, PlanFamilyId, PlanInstance,
} from '../contracts';
import { PF_TAIL } from '../contracts';

// ---------------------------------------------------------------------------------------------
// Codes and bits
// ---------------------------------------------------------------------------------------------

const CODES = DIRECT_CODES as readonly string[];
const CODE_CACHE = new Map<string, number>();

/** DIRECT_CODES code (index + 1) of a move, throw or command; 0 when it has none. */
export function codeOf(id: string): number {
  let c = CODE_CACHE.get(id);
  if (c === undefined) { c = CODES.indexOf(id) + 1; CODE_CACHE.set(id, c); }
  return c;
}

export const C_SPOT = codeOf('spotDodge');
export const C_ROLL_F = codeOf('rollForward');
export const C_ROLL_B = codeOf('rollBack');
export const C_AIRDODGE = codeOf('airDodge');
export const C_DIRAD = codeOf('dirAirDodge');
export const C_PUMMEL = codeOf('pummel');
export const C_FS = codeOf('finalSmash');

export const L = Btn.Left;
export const R = Btn.Right;
export const U = Btn.Up;
export const D = Btn.Down;
export const J = Btn.Jump;
export const A = Btn.Attack;
export const SP = Btn.Special;
export const SH = Btn.Shield;
export const G = Btn.Grab;
export const WK = Btn.Walk;

/** Relative direction bits, resolved per frame from the context. */
export const REL_T = 1 << 24;
export const REL_B = 1 << 25;
export const REL_H = 1 << 26;
export const REL_O = 1 << 27;
const REL_ALL = REL_T | REL_B | REL_H | REL_O;

/** Op code meaning "the plan's own move". */
export const CODE_MOVE = -1;

/** Op option flags. */
export const O_FF = 1;          // fast fall (fresh Down) once falling, after `from`
export const O_AIR = 2;         // only while airborne
export const O_GROUND = 4;      // only while grounded
export const O_DODGE = 8;       // the code is an air dodge: only when one is left

function dirBit(d: number): number { return d > 0 ? R : L; }

/** Resolves relative bits in `bits` against the context. */
export function resolveBits(bits: number, self: FighterState, ctx: PlanCtx): number {
  if ((bits & REL_ALL) === 0) return bits;
  let out = bits & ~REL_ALL;
  if ((bits & REL_T) !== 0) out |= dirBit(ctx.dir);
  if ((bits & REL_B) !== 0) out |= dirBit(-ctx.dir);
  if ((bits & REL_H) !== 0) out |= dirBit(ctx.home);
  if ((bits & REL_O) !== 0) out |= dirBit(self.x >= stageGeo(ctx.stage).cx ? 1 : -1);
  return out;
}

/** A fresh press of `bit`: 0 while it is still held from the previous input frame. */
export function press(bit: number, self: FighterState): number {
  return (self.inputHeld & bit) === 0 ? bit : 0;
}

/**
 * Holds a horizontal direction without making it the second tap of a double tap: a new press
 * waits while the sim's tap timer would read it as a roll.
 */
export function safeDir(bit: number, self: FighterState): number {
  if (bit === 0 || (self.inputHeld & bit) !== 0 || !self.onGround) return bit;
  const d = bit === R ? 1 : -1;
  if (self.dirTapDir === d && self.dirTapAge + 1 <= TUNING.input.rollTapWindow + 1) return 0;
  return bit;
}

export function clearIntent(out: Intent): Intent {
  out.held = 0; out.direct = 0; out.mash = 0;
  return out;
}

/** Intent to an InputFrame, deriving pressed and released from the previous held bits. */
export function toInputFrame(intent: Intent, prevHeld: number, out: InputFrame): InputFrame {
  const held = intent.held | intent.mash;
  out.held = held;
  out.pressed = (held & ~prevHeld) | intent.mash;
  out.released = prevHeld & ~held;
  out.direct = intent.direct;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stage geometry
// ---------------------------------------------------------------------------------------------

export interface StageGeo { left: number; right: number; top: number; bottom: number; cx: number; halfW: number;
  /** Pass-through platforms as [left, right, y] triples. */
  soft: Float64Array; softCount: number }
const GEO_CACHE = new Map<StageDef, StageGeo>();

export function stageGeo(stage: StageDef): StageGeo {
  let g = GEO_CACHE.get(stage);
  if (g !== undefined) return g;
  let best = -1;
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (!p.solid) continue;
    if (best < 0 || p.w > stage.platforms[best].w) best = i;
  }
  if (best < 0) best = 0;
  const m = stage.platforms[best];
  const soft: number[] = [];
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (p.solid) continue;
    soft.push(p.x, p.x + p.w, p.y);
  }
  g = { left: m.x, right: m.x + m.w, top: m.y, bottom: m.y + m.h, cx: m.x + m.w / 2, halfW: m.w / 2,
    soft: Float64Array.from(soft), softCount: soft.length / 3 };
  GEO_CACHE.set(stage, g);
  return g;
}

export function stageOfState(s: GameState): StageDef { return STAGE_DEFS[s.stageId]; }

/** Off the main platform's x span, or below its top while airborne. */
export function isOffstage(f: FighterState, g: StageGeo): boolean {
  if (f.onGround) return false;
  return f.x < g.left || f.x > g.right || f.y > g.top + 4;
}

/** Index of the soft platform the fighter stands on, -1 none. */
export function softPlatformUnder(f: FighterState, g: StageGeo): number {
  if (!f.onGround) return -1;
  for (let i = 0; i < g.softCount; i++) {
    const y = g.soft[i * 3 + 2];
    if (Math.abs(f.y - y) < 1 && f.x >= g.soft[i * 3] && f.x <= g.soft[i * 3 + 1]) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Move classes (by position in DIRECT_MOVES, so no move id is spelled out)
// ---------------------------------------------------------------------------------------------

export const MC_NORMAL = 0;      // jab and tilts
export const MC_DASHATK = 1;
export const MC_SMASH = 2;
export const MC_AERIAL = 3;
export const MC_SPECIAL = 4;
export const MC_OTHER = 5;

const DM = DIRECT_MOVES as readonly string[];
/** DIRECT_MOVES layout: 4 normals, dash attack, 3 smashes (forward, up, down), 5 aerials, 4 specials. */
export function moveClass(id: MoveId): number {
  const i = DM.indexOf(id);
  if (i < 0) return MC_OTHER;
  if (i < 4) return MC_NORMAL;
  if (i === 4) return MC_DASHATK;
  if (i < 8) return MC_SMASH;
  if (i < 13) return MC_AERIAL;
  return MC_SPECIAL;
}
/** 0 forward, 1 up, 2 down for smashes; 0 neutral, 1 side, 2 up, 3 down for specials; -1 otherwise. */
export function moveSlot(id: MoveId): number {
  const i = DM.indexOf(id);
  if (i >= 5 && i < 8) return i - 5;
  if (i >= 13 && i < 17) return i - 13;
  return -1;
}
/** 0 jab, 1 forward tilt, 2 up tilt, 3 down tilt for normals; 0 n, 1 f, 2 b, 3 u, 4 d for aerials. */
export function normalSlot(id: MoveId): number {
  const i = DM.indexOf(id);
  if (i >= 0 && i < 4) return i;
  if (i >= 8 && i < 13) return i - 8;
  return -1;
}

/** Moves of a profile that deal damage, in DIRECT_MOVES order (stable across calls). */
const MOVE_LIST_CACHE = new WeakMap<CharacterAiProfile, MoveId[]>();
export function attackMoves(p: CharacterAiProfile): readonly MoveId[] {
  let l = MOVE_LIST_CACHE.get(p);
  if (l !== undefined) return l;
  l = [];
  for (let i = 0; i < DM.length; i++) {
    const id = DM[i] as MoveId;
    const m = p.moves[id];
    if (m !== undefined && m.maxDamage > 0) l.push(id);
  }
  MOVE_LIST_CACHE.set(p, l);
  return l;
}

/** Throws of a profile in a stable order. */
const THROW_CACHE = new WeakMap<CharacterAiProfile, ThrowId[]>();
export function throwList(p: CharacterAiProfile): readonly ThrowId[] {
  let l = THROW_CACHE.get(p);
  if (l === undefined) { l = (Object.keys(p.grab.throws) as ThrowId[]).slice().sort(); THROW_CACHE.set(p, l); }
  return l;
}

/** True when the move's hitboxes reach a ledge hanger (down attacks). */
export function hitsLedge(charId: string, id: MoveId): boolean {
  const def = CHARACTER_DEFS[charId];
  return def !== undefined && def.moves[id] !== undefined && def.moves[id].hitsLedge === true;
}

export function isAirOnly(charId: string, id: MoveId): boolean {
  const def = CHARACTER_DEFS[charId];
  return def !== undefined && def.moves[id] !== undefined && def.moves[id].airOnly === true;
}

// ---------------------------------------------------------------------------------------------
// Reach and travel estimates (cheap, closed form; the rollouts decide)
// ---------------------------------------------------------------------------------------------

/** Ground frames to cover `dist` px: dash then run. */
export function travelFrames(p: CharacterAiProfile, dist: number): number {
  if (dist <= 0) return 0;
  const ph = p.physics;
  const dashCover = ph.dash * ph.dashFrames;
  if (dist <= dashCover) return Math.ceil(dist / ph.dash);
  return ph.dashFrames + Math.ceil((dist - dashCover) / Math.max(0.5, ph.run));
}

/** Horizontal reach of a move toward a target `dx` ahead (dx >= 0), including half the victim hurtbox. */
export function frontReach(m: MoveAiInfo, victimHalfW: number): number {
  return Math.max(m.reach.front, m.reach.back) + victimHalfW;
}

/**
 * Frames until `m` can first connect on a target |dx| px away, |dy| px above (dy < 0 above),
 * grounded start: travel to reach, jump squat for aerials, startup. Infinity when out of height.
 */
export function framesToConnect(p: CharacterAiProfile, id: MoveId, adx: number, dy: number, victimHalfW: number): number {
  const m = p.moves[id];
  if (m === undefined || m.maxDamage <= 0) return Infinity;
  const aerial = isAirOnly(p.charId, id);
  const up = aerial ? m.reach.up + p.recovery.rise.fullHop : m.reach.up;
  if (dy < 0 && -dy > up + 8) return Infinity;
  const gap = adx - frontReach(m, victimHalfW);
  const tr = travelFrames(p, gap);
  return tr + m.startup + (aerial ? p.physics.jumpSquat + 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------------------------

export interface Op { from: number; to: number; hold: number; tap: number; code: number; opt: number }
export type Program = readonly Op[];

export function op(from: number, to: number, hold: number, tap = 0, code = 0, opt = 0): Op {
  return { from, to, hold, tap, code, opt };
}

/** Runs a program on script frame `t`. `moveCode` is the plan's own move code. */
export function runProgram(prog: Program, t: number, self: FighterState, ctx: PlanCtx, moveCode: number, out: Intent): void {
  for (let i = 0; i < prog.length; i++) {
    const o = prog[i];
    if (t < o.from || t >= o.to) continue;
    if ((o.opt & O_AIR) !== 0 && self.onGround) continue;
    if ((o.opt & O_GROUND) !== 0 && !self.onGround) continue;
    if (o.hold !== 0) {
      const b = resolveBits(o.hold, self, ctx);
      out.held |= self.onGround ? (b & ~(L | R)) | safeDir(b & (L | R), self) : b;
    }
    if (t === o.from) {
      if (o.tap !== 0) out.held |= press(resolveBits(o.tap, self, ctx), self);
      if (o.code !== 0) {
        const c = o.code === CODE_MOVE ? moveCode : o.code;
        if ((o.opt & O_DODGE) === 0 || canAirDodge(self)) out.direct = c;
      }
    }
    if ((o.opt & O_FF) !== 0 && t > o.from && !self.onGround && self.vy > 0 && !self.fastFalling
      && (self.action === 'air' || self.action === 'attack')) out.held |= press(D, self);
  }
}

/** One air dodge per airborne period (sim-private flag read when present). */
export function canAirDodge(f: FighterState): boolean {
  if (f.onGround) return false;
  const used = (f as FighterState & { airDodgeUsed?: boolean }).airDodgeUsed;
  return used !== true;
}

// Program builders shared by the families.

/** Short hop (Jump held 1 frame) or full hop (held `hold` frames), drift, the move on frame `atk`. */
export function hopProgram(hold: number, atk: number, drift: number, ff: boolean, withMove: boolean): Program {
  const ops: Op[] = [op(0, 1, 0, J), op(1, hold, J), op(1, 90, drift)];
  if (withMove) ops.push(op(atk, atk + 1, 0, 0, CODE_MOVE));
  if (ff) ops.push(op(atk, 90, 0, 0, 0, O_FF));
  return ops;
}

/** Grounded move: the code on frame 0, holding `hold` (a direction or charge key) for `len` frames. */
export function groundProgram(hold: number, len: number): Program {
  return len > 0 ? [op(0, 1, 0, 0, CODE_MOVE), op(0, len, hold)] : [op(0, 1, 0, 0, CODE_MOVE)];
}

// ---------------------------------------------------------------------------------------------
// Plan names (cached so a regenerated plan allocates no string)
// ---------------------------------------------------------------------------------------------

const NAMES = new Map<string, Map<string, Map<string, string>>>();

/** a + b + c, cached. */
export function nameFor(a: string, b: string, c: string): string {
  let m1 = NAMES.get(a);
  if (m1 === undefined) { m1 = new Map(); NAMES.set(a, m1); }
  let m2 = m1.get(b);
  if (m2 === undefined) { m2 = new Map(); m1.set(b, m2); }
  let s = m2.get(c);
  if (s === undefined) { s = a + b + c; m2.set(c, s); }
  return s;
}

const NUM_NAMES = new Map<string, string[]>();
/** a + n for a small non-negative integer n, cached. */
export function nameNum(a: string, n: number): string {
  let arr = NUM_NAMES.get(a);
  if (arr === undefined) { arr = []; NUM_NAMES.set(a, arr); }
  const k = n | 0;
  let s = arr[k];
  if (s === undefined) { s = a + k; arr[k] = s; }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Plan instances
// ---------------------------------------------------------------------------------------------

/** Private plan kind used by the style filters. */
export const K_HOLD = 0;
export const K_APPROACH = 1;
export const K_RETREAT = 2;
export const K_COMMIT = 3;
export const K_BAIT = 4;

export type ScriptFn = (plan: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent) => void;
export type PrepareFn = (plan: Plan, v: DecisionView, ctx: PlanCtx) => void;

/**
 * The PlanInstance every family here builds. Instances are pooled per slot and per variant, so
 * `generate` allocates nothing after warm-up; what a script reads while it runs is either fixed
 * per variant (program, move, links) or copied into the context at plan start.
 */
export class Plan implements PlanInstance {
  family: PlanFamilyId = 'wait';
  name = '';
  move: MoveId | null = null;
  param = 0;
  minFrames = 1;
  horizon = 16;
  flags = 0;
  bonus = 0;
  priority = 0;
  /** K_* for the style filters. */
  kind = K_HOLD;
  /** Target index (fighters[]) the plan was generated against. */
  target = -1;
  prog: Program | null = null;
  fn: ScriptFn | null = null;
  prep: PrepareFn | null = null;
  moveCode = 0;
  /** Variant data a script function may read (links, codes). Fixed per variant. */
  data: unknown = null;
  /** Recovery policy for tail plans: the up special code, 0 none. */
  tailCode = 0;
  /** PlanInstance.payoffAt; cleared by set(). */
  payoffAt: number | undefined = undefined;

  set(family: PlanFamilyId, name: string, move: MoveId | null, min: number, horizon: number, flags: number,
    priority: number, kind: number): this {
    this.family = family; this.name = name; this.move = move; this.minFrames = min; this.horizon = horizon;
    this.flags = flags; this.priority = priority; this.kind = kind; this.bonus = 0; this.param = 0;
    this.payoffAt = undefined;
    this.moveCode = move === null ? 0 : codeOf(move);
    return this;
  }

  script(t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
    out.held = 0; out.direct = 0; out.mash = 0;
    if (this.fn !== null) this.fn(this, t, self, ctx, out);
    else if (this.prog !== null) runProgram(this.prog, t, self, ctx, this.moveCode, out);
    if ((this.flags & PF_TAIL) !== 0 && t >= this.minFrames) tailRecover(self, ctx, this.tailCode, out);
  }
}

/** Per-slot pools of plans, one array per family module, indexed by a stable variant number. */
export class PlanPool {
  private readonly bySlot: Plan[][] = [];
  constructor() { for (let i = 0; i < MAX_PLAYERS; i++) this.bySlot.push([]); }
  get(slot: number, variant: number): Plan {
    const arr = this.bySlot[slot < 0 || slot >= MAX_PLAYERS ? 0 : slot];
    let p = arr[variant];
    if (p === undefined) {
      while (arr.length < variant) arr.push(new Plan());
      p = new Plan();
      arr[variant] = p;
    }
    return p;
  }
}

/** Keyed pool for plans tied to an object (a combo route): one Plan per slot per key. */
export class KeyedPlanPool<K extends object> {
  private readonly map = new WeakMap<K, Plan[]>();
  get(slot: number, key: K): Plan {
    let arr = this.map.get(key);
    if (arr === undefined) { arr = []; this.map.set(key, arr); }
    let p = arr[slot];
    if (p === undefined) { p = new Plan(); arr[slot] = p; }
    return p;
  }
}

// ---------------------------------------------------------------------------------------------
// Run state: per-context registers for scripts that need memory
// ---------------------------------------------------------------------------------------------

export interface RunState { plan: PlanInstance | null; start: number; last: number; r: Float64Array }
const RUN = new WeakMap<PlanCtx, RunState>();

/**
 * Registers for the plan running on `ctx`. They reset (to 0) when the plan changes, when the
 * script is called on the plan's start frame, or when the frame goes backwards (a new rollout
 * on the same context). `fresh` in r[7] is 1 on the call that reset them.
 */
export function runState(plan: PlanInstance, ctx: PlanCtx): RunState {
  let rs = RUN.get(ctx);
  if (rs === undefined) { rs = { plan: null, start: -1, last: -1, r: new Float64Array(8) }; RUN.set(ctx, rs); }
  if (rs.plan !== plan || rs.start !== ctx.startFrame || ctx.frame < rs.last
    || (ctx.frame === ctx.startFrame && rs.last !== ctx.frame)) {
    rs.plan = plan; rs.start = ctx.startFrame; rs.r.fill(0); rs.r[7] = 1;
  } else {
    rs.r[7] = 0;
  }
  rs.last = ctx.frame;
  return rs;
}

// ---------------------------------------------------------------------------------------------
// Views, targets, teams
// ---------------------------------------------------------------------------------------------

export function isAlive(f: FighterState): boolean {
  return f.stocks > 0 && f.action !== 'dead';
}

/** True when fighters[i] is an opponent of fighters[meI] (not self, not a teammate). */
export function isOpponent(s: GameState, meI: number, i: number): boolean {
  if (i === meI || i < 0 || i >= s.fighters.length) return false;
  return !sameTeam(s, s.fighters[meI].slot, s.fighters[i].slot);
}

/** Fills `out` with fighters[] indices of live opponents; returns the count. */
export function liveOpponents(s: GameState, meI: number, out: Int32Array): number {
  let n = 0;
  for (let i = 0; i < s.fighters.length && n < out.length; i++) {
    if (isOpponent(s, meI, i) && isAlive(s.fighters[i])) out[n++] = i;
  }
  return n;
}

/** The target chosen by the targeter, or -1 when it is not a live opponent (never aim at a teammate). */
export function targetIndex(v: DecisionView): number {
  const s = v.p.state;
  const t = v.p.oppI;
  if (!isOpponent(s, v.p.meI, t)) return -1;
  return t;
}

/** Actionable now or on the next frame for a grounded or aerial plan. */
export function actionable(f: FighterState): boolean {
  if (f.hitlag > 0 || f.hitstun > 0) return false;
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'air':
      return true;
    case 'land':
      return true;
    case 'attack': case 'jumpsquat':
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Context preparation
// ---------------------------------------------------------------------------------------------

/**
 * Fills `ctx` for `plan` started on `frame` from the view (see the file comment). Plans built by
 * these modules may override fields in their prepare hook.
 */
export function preparePlanCtx(plan: PlanInstance, v: DecisionView, frame: number, ctx: PlanCtx): PlanCtx {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const stage = stageOfState(s);
  const g = stageGeo(stage);
  const ti = targetIndex(v);
  // A target that is dead or on the respawn platform is not a direction to go: its x can be past
  // the blast zone (a god air-dodged "toward" a KOed target off the stage and lost the stock).
  const ta = ti >= 0 ? s.fighters[ti].action : 'dead';
  const tx = ti >= 0 && ta !== 'dead' && ta !== 'respawn' ? s.fighters[ti].x : g.cx;
  ctx.dir = tx > me.x + 0.5 ? 1 : tx < me.x - 0.5 ? -1 : me.facing;
  ctx.home = me.x < g.cx ? 1 : -1;
  ctx.edgeX = tx >= g.cx ? g.right : g.left;
  ctx.fireAt = frame;
  ctx.param = plan.param;
  ctx.startFrame = frame;
  ctx.frame = frame;
  ctx.me = v.me;
  ctx.stage = stage;
  ctx.target = ti;
  if (plan instanceof Plan && plan.prep !== null) plan.prep(plan, v, ctx);
  return ctx;
}

export function newPlanCtx(me: CharacterAiProfile, stage: StageDef): PlanCtx {
  return { dir: 1, home: 1, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0, me, stage };
}

// ---------------------------------------------------------------------------------------------
// Tail recovery (a plan that ends airborne off the stage heads home)
// ---------------------------------------------------------------------------------------------

/**
 * Minimal recovery for tail plans once their own inputs are done: hold home, double jump when
 * falling below the stage top, up special (`code`, or the profile's first recovery move) when
 * out of jumps. The full recovery game lives in plans/defense.ts.
 */
export function tailRecover(self: FighterState, ctx: PlanCtx, code: number, out: Intent): void {
  if (self.onGround || self.action === 'ledgeHang' || self.action === 'ledgeGrab') return;
  const g = stageGeo(ctx.stage);
  if (!isOffstage(self, g)) return;
  if (self.action !== 'air') return;
  const home = self.x < g.cx ? R : L;
  out.held = (out.held & ~(L | R)) | home;
  const below = self.y - g.top;
  const under = self.x > g.left - 8 && self.x < g.right + 8 && self.y > g.top + 4;
  if (under) {
    if (self.jumpsLeft > 0 && self.vy > 1 && self.y > g.bottom + 90) out.held |= press(J, self);
    return;
  }
  if (self.jumpsLeft > 0 && self.vy > -0.5 && below > -5) { out.held |= press(J, self); return; }
  if (self.jumpsLeft === 0 && self.vy > 0 && below > 15) {
    let c = code;
    if (c === 0 && ctx.me.roles.recovery.length > 0) c = codeOf(ctx.me.roles.recovery[0]);
    if (c !== 0 && (self.inputHeld & SP) === 0) out.direct = c;
  }
}

// ---------------------------------------------------------------------------------------------
// Runner: a plan to InputFrames each frame (tests, rollouts)
// ---------------------------------------------------------------------------------------------

/**
 * Steps one plan for one fighter: tracks `t` (advancing only outside hitlag), the context frame
 * and the previous held bits, and converts the intent to an InputFrame.
 */
export class PlanRunner {
  plan: PlanInstance | null = null;
  t = 0;
  prevHeld = 0;
  readonly ctx: PlanCtx;
  readonly intent: Intent = { held: 0, direct: 0, mash: 0 };
  constructor(me: CharacterAiProfile, stage: StageDef) { this.ctx = newPlanCtx(me, stage); }

  start(plan: PlanInstance, v: DecisionView): void {
    this.plan = plan;
    this.t = 0;
    preparePlanCtx(plan, v, v.p.state.frame, this.ctx);
  }

  /** Input for fighters[meI] on the step after `s`. */
  step(s: GameState, meI: number, out: InputFrame): InputFrame {
    const self = s.fighters[meI];
    if (this.plan === null) { clearIntent(this.intent); }
    else {
      this.ctx.frame = s.frame;
      this.plan.script(this.t, self, this.ctx, this.intent);
      if (self.hitlag === 0) this.t++;
    }
    toInputFrame(this.intent, this.prevHeld, out);
    this.prevHeld = out.held;
    return out;
  }

  done(): boolean { return this.plan === null || this.t >= this.plan.horizon; }
}
