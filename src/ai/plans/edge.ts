/**
 * Ledge trapping and edgeguarding plans (docs/CPU_PLAN.md W2.6; cpu-guide 02 sections 9.6 and 10,
 * research 05 sections 1, 3 and 6), plus the plumbing the defense plans share: pooled state copies,
 * a rollout runner with per-fighter drivers, recovery policies and canGetBack.
 *
 * Nothing here names a move. Tools come from the profile's roles and tags, frame data and hitboxes
 * from MoveDef, and every claim a plan makes (this trap covers the climb at the invulnerability end,
 * this hog outlasts the recovery, this aerial still gets back) comes from running the sim on pooled
 * copies of the perceived state. Today's ledge rules shape the tools: a hanger is reached only by
 * moves with `hitsLedge` or by shots low enough for the hang hurtbox 2 px under the lip, the climb
 * is a button (Jump), a hang never times out, and grabs 1 to LEDGE_MAX_REGRABS refresh the
 * invulnerability while later ones do not.
 *
 * Script format. Plans carry their inputs as data (`ScriptData`, a `kind` plus numbers) that an
 * interpreter turns into an Intent; `LocalPlan.script` calls the interpreter. LocalPlan implements
 * PlanInstance directly and keeps the plans/script.ts context contract (see "script adapter").
 * Registration: the module registers EDGE_FAMILIES with plans/index.ts registerFamilies at the end;
 * index.ts never imports this module, so there is no cycle.
 *
 * Timing convention: `ctx.frame` is the frame number of the state the input is computed from (the
 * state before stepGame). Absolute fire frames in ScriptData use the same convention.
 *
 * Multiple opponents: the target is `v.p.oppI` (never a teammate). An edgeguard is dropped when a
 * second opponent threatens us on the stage; when a teammate is already guarding, we take the
 * stage side or the ledge instead of doubling offstage.
 */
import type {
  CanGetBackFn, CharacterAiProfile, DecisionView, Intent, PlanCtx, PlanFamily, PlanFamilyId, PlanInstance,
} from '../contracts';
import { ACTION_CLASS_COUNT, PF_ATTACK, PF_EG, PF_INTR, PF_PROJ, PF_SPIKE, PF_TAIL } from '../contracts';
import { TUNING } from '../../core/constants';
import { Btn, DIRECT_CODES } from '../../core/types';
import type { FighterState, GameState, InputFrame, MoveDef, MoveId, Rect, StageDef } from '../../core/types';
import { CHARACTER_DEFS } from '../../characters/registry';
import { grabKitOf } from '../../characters/common/grabkit';
import { STAGE_DEFS } from '../../stages/registry';
import { cloneGameState, stepGame } from '../../sim/index';
import { isLedgeAction } from '../../sim/ledge';
import { isLowHit } from '../../sim/dodge';
import { fighterHurtbox, sameTeam, type SimFighter } from '../../sim/state';
import { stageGeo } from '../charprofile/probeHit';
import { RECOVER_DX_BIN, RECOVER_DX_BINS, recoverBoxIndex } from '../charprofile/probeMotion';
import { getAiProfile } from '../charprofile/derive';
import { AC_JUMP, AC_LEDGE_ATTACK, AC_NONE, AC_OUT, AC_ROLL_TO, AC_STAND, makeContext, newContext } from '../model/predictor';
import { registerFamilies } from './index';

// ---------------------------------------------------------------------------------------------
// Bits, codes, geometry
// ---------------------------------------------------------------------------------------------

export const BL = Btn.Left;
export const BR = Btn.Right;
export const BU = Btn.Up;
export const BD = Btn.Down;
export const BJ = Btn.Jump;
export const BA = Btn.Attack;
export const BSH = Btn.Shield;
export const BG = Btn.Grab;
export const BWK = Btn.Walk;

export function dirBit(d: number): number { return d > 0 ? BR : BL; }

const CODES = DIRECT_CODES as readonly string[];
/** DIRECT_CODES code (index + 1) of a move or command; 0 when it has none. */
export function codeOf(id: string): number { return CODES.indexOf(id) + 1; }
export const C_LEDGE_JUMP = codeOf('ledgeJump');
export const C_DIRAD = codeOf('dirAirDodge');
export const C_FOOTSTOOL = codeOf('footstool');
export const C_GETUP_ATK = codeOf('getupAttack');
export const C_SPOT = codeOf('spotDodge');

/** Large slack: on the ground, on a ledge, or respawning. */
export const SLACK_INF = 999;

/** Main platform geometry: its top (walk line), underside, corners and the blast rect. */
export interface Geo { top: number; bot: number; left: number; right: number; center: number; mainIndex: number; blast: Rect }
const geoCache = new Map<string, Geo>();

export function geoOf(stageId: string): Geo {
  let g = geoCache.get(stageId);
  if (g === undefined) {
    const stage = STAGE_DEFS[stageId];
    const sg = stageGeo(stage);
    g = { top: sg.top, bot: sg.top + sg.main.h, left: sg.left, right: sg.right, center: sg.center, mainIndex: sg.mainIndex,
      blast: stage.blast };
    geoCache.set(stageId, g);
  }
  return g;
}

/** Px beyond the nearer corner, 0 over or under the stage. */
export function outDist(x: number, g: Geo): number { return x < g.left ? g.left - x : x > g.right ? x - g.right : 0; }
/** -1 for the left half, 1 for the right. */
export function sideOf(x: number, g: Geo): number { return x < g.center ? -1 : 1; }
export function cornerX(side: number, g: Geo): number { return side < 0 ? g.left : g.right; }
export function underStage(x: number, y: number, g: Geo): boolean { return y > g.bot && x > g.left - 20 && x < g.right + 20; }
/** Way home for a recovery: toward the centre, except from under the stage (out past the nearer corner first). */
export function homeDir(x: number, y: number, g: Geo): number {
  if (underStage(x, y, g)) return x < g.center ? -1 : 1;
  return x < g.center ? 1 : -1;
}
export function isGone(f: FighterState): boolean { return f.action === 'dead' || f.action === 'respawn'; }

/** Airborne off the stage (past a corner, or below the stage top), not on a ledge. */
export function offstage(f: FighterState, g: Geo): boolean {
  if (f.onGround || isLedgeAction(f.action) || isGone(f)) return false;
  // Parked on the lip: the solid-side push lands it every frame, so it counts as standing.
  if (Math.abs(f.y - g.top) < 0.5 && f.vy === 0 && f.x > g.left - 14 && f.x < g.right + 14) return false;
  return f.x < g.left - 2 || f.x > g.right + 2 || f.y > g.top + 2;
}

/** A foe of fighter index `me`: alive, another fighter, not a teammate. */
export function isFoe(s: GameState, me: number, i: number): boolean {
  if (i === me || i < 0 || i >= s.fighters.length) return false;
  const o = s.fighters[i];
  if (isGone(o) || o.stocks <= 0) return false;
  return !sameTeam(s, s.fighters[me].slot, o.slot);
}
export function isMate(s: GameState, me: number, i: number): boolean {
  if (i === me || i < 0 || i >= s.fighters.length) return false;
  const o = s.fighters[i];
  if (isGone(o)) return false;
  return sameTeam(s, s.fighters[me].slot, o.slot);
}

/** A direction bit that never becomes the second tap of a roll (the sim's tap timer). */
export function safeDir(bit: number, self: FighterState): number {
  if ((self.inputHeld & bit) !== 0 || !self.onGround) return bit;
  const d = bit === BR ? 1 : -1;
  if (self.dirTapDir === d && self.dirTapAge + 1 <= TUNING.input.rollTapWindow + 1) return 0;
  return bit;
}

/** `bit` as a fresh press: held this frame only if it was not held on the previous one. */
export function tap(bit: number, self: FighterState): number { return (self.inputHeld & bit) === 0 ? bit : 0; }

/** Grounded and free to start something new. */
export function groundFree(f: FighterState): boolean {
  const a = f.action;
  return f.onGround && f.hitlag === 0 && (a === 'idle' || a === 'walk' || a === 'crouch' || a === 'dash' || a === 'run' || a === 'turn');
}

// ---------------------------------------------------------------------------------------------
// Pooled state copies
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
let fPrim: string[] = [];
let fObj: string[] = [];
let fObjSub: string[][] = [];
let gPrim: string[] = [];
let gObj: string[] = [];
let gObjSub: string[][] = [];
let keysLearned = false;

/** Field lists read off a live state once; `stats` stays per copy, `activeThrow` is shared def data. */
function learnKeys(src: GameState): void {
  const f = src.fighters[0] as unknown as Rec;
  fPrim = []; fObj = []; fObjSub = [];
  const fk = Object.keys(f);
  for (let i = 0; i < fk.length; i++) {
    const k = fk[i];
    const v = f[k];
    if (k === 'stats') continue;
    if (k !== 'activeThrow' && v !== null && typeof v === 'object') { fObj.push(k); fObjSub.push(Object.keys(v as Rec)); }
    else fPrim.push(k);
  }
  gPrim = []; gObj = []; gObjSub = [];
  const s = src as unknown as Rec;
  const gk = Object.keys(s);
  for (let i = 0; i < gk.length; i++) {
    const k = gk[i];
    if (k === 'fighters' || k === 'projectiles' || k === 'events' || k === 'config') continue;
    const v = s[k];
    if (v !== null && typeof v === 'object') { gObj.push(k); gObjSub.push(Object.keys(v as Rec)); }
    else gPrim.push(k);
  }
  keysLearned = true;
}

/** Copies `src` into the pooled `dst` (made by cloneGameState of a state of the same match). */
export function copyStateInto(src: GameState, dst: GameState): void {
  if (!keysLearned) learnKeys(src);
  const s = src as unknown as Rec;
  const d = dst as unknown as Rec;
  for (let i = 0; i < gPrim.length; i++) { const k = gPrim[i]; d[k] = s[k]; }
  for (let i = 0; i < gObj.length; i++) {
    const so = s[gObj[i]] as Rec;
    const dobj = d[gObj[i]] as Rec;
    const sub = gObjSub[i];
    for (let j = 0; j < sub.length; j++) dobj[sub[j]] = so[sub[j]];
  }
  dst.config = src.config;
  dst.events.length = 0;
  const sf = src.fighters;
  const df = dst.fighters;
  for (let i = 0; i < sf.length; i++) {
    const a = sf[i] as unknown as Rec;
    const b = df[i] as unknown as Rec;
    for (let j = 0; j < fPrim.length; j++) { const k = fPrim[j]; b[k] = a[k]; }
    for (let j = 0; j < fObj.length; j++) {
      const so = a[fObj[j]] as Rec;
      const dobj = b[fObj[j]] as Rec;
      const sub = fObjSub[j];
      for (let q = 0; q < sub.length; q++) dobj[sub[q]] = so[sub[q]];
    }
  }
  const sp = src.projectiles;
  const dp = dst.projectiles;
  for (let i = 0; i < sp.length; i++) {
    if (i >= dp.length) {
      dp.push({ id: 0, owner: 0, defId: '', x: 0, y: 0, vx: 0, vy: 0, facing: 1, age: 0, hitSlots: 0, alive: false, power: 1,
        scale: 1, returned: false, charge: 0 });
    }
    const a = sp[i];
    const b = dp[i];
    b.id = a.id; b.owner = a.owner; b.defId = a.defId; b.x = a.x; b.y = a.y; b.vx = a.vx; b.vy = a.vy;
    b.facing = a.facing; b.age = a.age; b.hitSlots = a.hitSlots; b.alive = a.alive; b.power = a.power; b.scale = a.scale;
    b.returned = a.returned; b.charge = a.charge ?? 0;
  }
  for (let i = sp.length; i < dp.length; i++) dp[i].alive = false;
}

const WORK: GameState[] = [];
/** Pooled scratch state number `i`, shaped like `like`. */
export function workState(i: number, like: GameState): GameState {
  let w = WORK[i];
  if (w === undefined || w.fighters.length !== like.fighters.length) {
    w = cloneGameState(like);
    WORK[i] = w;
  }
  copyStateInto(like, w);
  return w;
}
/** Work slots: 0 to 3 for canGetBack callers, 4 and up here and in defense.ts. */
export const W_EXACT = 4;
export const W_TRAJ = 5;
export const W_EVAL = 6;
export const W_ARR = 7;
export const W_DEF = 8;

// ---------------------------------------------------------------------------------------------
// Rollout runner
// ---------------------------------------------------------------------------------------------

/** One fighter's input source inside a rollout. `out` arrives cleared. */
export interface Driver { step(t: number, f: FighterState, s: GameState, out: Intent): void }

/** What happened in a rollout, per fighter index (up to 4 fighters). */
export class Watch {
  n = 0;
  /** hits[a * 4 + v]: hits by a on v. */
  readonly hits = new Int32Array(16);
  readonly firstHit = new Int32Array(16);
  readonly dmg = new Float64Array(4);
  readonly ledgeAt = new Int32Array(4);
  readonly landAt = new Int32Array(4);
  readonly koAt = new Int32Array(4);
  readonly stoolAt = new Int32Array(16);
  ko = 0;
  fail = false;
  frames = 0;
  reset(n: number): void {
    this.n = n; this.ko = 0; this.fail = false; this.frames = 0;
    this.hits.fill(0); this.firstHit.fill(-1); this.dmg.fill(0); this.stoolAt.fill(-1);
    this.ledgeAt.fill(-1); this.landAt.fill(-1); this.koAt.fill(-1);
  }
}

/** Stop modes for `simulate`. */
export const STOP_NONE = 0;
/** Stop when the watched fighter reaches a ledge or the ground, or is KO'd. */
export const STOP_SAFE = 1;
/** STOP_SAFE, and also fail early when the watched fighter has nothing left that rises. */
export const STOP_RECOVER = 2;

/** Optional per-step hook (trajectory recording). */
export interface StepHook { after(k: number, s: GameState): void }

const INPUTS: InputFrame[] = [];
for (let i = 0; i < 4; i++) INPUTS.push({ held: 0, pressed: 0, released: 0, direct: 0 });
const PREV = new Int32Array(4);
const TT = new Int32Array(4);
const WAS_GONE = new Uint8Array(4);
const SCR: Intent = { held: 0, direct: 0, mash: 0 };
const IDX_OF_SLOT = new Int32Array(16);

function hopeless(f: SimFighter, g: Geo, upbCode: number): boolean {
  if (f.onGround || isLedgeAction(f.action)) return false;
  if (f.jumpsLeft > 0 || f.vy <= 0 || f.action === 'attack' || f.action === 'airDodge' || f.hitstun > 0) return false;
  const upb = upbCode > 0 && f.action !== 'airHelpless';
  if (upb || !f.airDodgeUsed) return false;
  return f.y > g.top + 40 && outDist(f.x, g) > 0;
}

/**
 * Steps `s` for up to `frames` frames. drivers[i] null = no input. Pressed and released bits come
 * from held against the previous frame, starting from each fighter's last held input.
 */
export function simulate(s: GameState, frames: number, drivers: readonly (Driver | null)[], w: Watch,
  stopIdx = -1, stopMode = STOP_NONE, upbCode = 0, hook: StepHook | null = null): number {
  const fs = s.fighters;
  const n = fs.length;
  const g = geoOf(s.stageId);
  w.reset(n);
  for (let i = 0; i < 16; i++) IDX_OF_SLOT[i] = -1;
  for (let i = 0; i < n; i++) {
    PREV[i] = fs[i].inputHeld; TT[i] = 0; WAS_GONE[i] = isGone(fs[i]) ? 1 : 0;
    if (fs[i].slot >= 0 && fs[i].slot < 16) IDX_OF_SLOT[fs[i].slot] = i;
  }
  let k = 0;
  for (; k < frames; k++) {
    for (let i = 0; i < n; i++) {
      const inp = INPUTS[i];
      const d = i < drivers.length ? drivers[i] : null;
      SCR.held = 0; SCR.direct = 0; SCR.mash = 0;
      if (d !== null) d.step(TT[i], fs[i], s, SCR);
      const held = SCR.held | SCR.mash;
      inp.held = held; inp.pressed = held & ~PREV[i]; inp.released = PREV[i] & ~held; inp.direct = SCR.direct;
      PREV[i] = held;
      if (fs[i].hitlag === 0) TT[i]++;
    }
    stepGame(s, INPUTS);
    const ev = s.events;
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if (x.type === 'hit') {
        const a = x.attacker >= 0 && x.attacker < 16 ? IDX_OF_SLOT[x.attacker] : -1;
        const v = x.victim >= 0 && x.victim < 16 ? IDX_OF_SLOT[x.victim] : -1;
        if (v >= 0) w.dmg[v] += x.damage;
        if (a >= 0 && v >= 0) { const q = a * 4 + v; w.hits[q]++; if (w.firstHit[q] < 0) w.firstHit[q] = k; }
      } else if (x.type === 'ko') {
        const v = x.slot >= 0 && x.slot < 16 ? IDX_OF_SLOT[x.slot] : -1;
        if (v >= 0 && (w.ko & (1 << v)) === 0) { w.ko |= 1 << v; w.koAt[v] = k; }
      } else if (x.type === 'footstool') {
        const a = IDX_OF_SLOT[x.attacker];
        const v = IDX_OF_SLOT[x.victim];
        if (a >= 0 && v >= 0 && w.stoolAt[a * 4 + v] < 0) w.stoolAt[a * 4 + v] = k;
      }
    }
    for (let i = 0; i < n; i++) {
      const f = fs[i];
      if (isGone(f)) {
        if (WAS_GONE[i] === 0 && (w.ko & (1 << i)) === 0) { w.ko |= 1 << i; w.koAt[i] = k; }
        continue;
      }
      if (w.ledgeAt[i] < 0 && (f.action === 'ledgeHang' || f.action === 'ledgeGrab')) w.ledgeAt[i] = k;
      if (w.landAt[i] < 0 && f.onGround) w.landAt[i] = k;
    }
    if (hook !== null) hook.after(k, s);
    if (stopIdx >= 0 && stopMode !== STOP_NONE) {
      if ((w.ko & (1 << stopIdx)) !== 0 || w.ledgeAt[stopIdx] >= 0 || w.landAt[stopIdx] >= 0) { k++; break; }
      if (stopMode === STOP_RECOVER && hopeless(fs[stopIdx] as SimFighter, g, upbCode)) { w.fail = true; k++; break; }
    }
  }
  w.frames = k;
  return k;
}

// ---------------------------------------------------------------------------------------------
// Recovery policies (the victim model of canGetBack, edgeguard hypotheses, and our own routes)
// ---------------------------------------------------------------------------------------------

export const DODGE_NONE = 0;
export const DODGE_UP = 1;
export const DODGE_TOWARD = 2;
export const DODGE_DOWN = 3;
export const HOLD_TOWARD = 0;
export const HOLD_NEUTRAL = 1;
export const HOLD_AWAY = 2;

/**
 * A recovery as a state-reactive policy. Depths are feet px below the main platform top: jump
 * when falling past `jumpDepth`, up special past `upbDepth` (after the jumps, or first when
 * `upbFirst`), an air dodge toward the ledge when within `dodgeDx` px of the corner and near
 * ledge height. `delay` frames of drift before any commit; `hold` for the first `holdFrames`.
 */
export interface RecoverPolicy { name: string; jumpDepth: number; upbDepth: number; dodge: number; dodgeDx: number;
  delay: number; hold: number; holdFrames: number; upbFirst: boolean }

export function makePolicy(name: string, jumpDepth: number, upbDepth: number, dodge = DODGE_NONE, dodgeDx = 0,
  delay = 0, hold = HOLD_TOWARD, holdFrames = 0, upbFirst = false): RecoverPolicy {
  return { name, jumpDepth, upbDepth, dodge, dodgeDx, delay, hold, holdFrames, upbFirst };
}
export function copyPolicy(src: RecoverPolicy, dst: RecoverPolicy): RecoverPolicy {
  dst.name = src.name; dst.jumpDepth = src.jumpDepth; dst.upbDepth = src.upbDepth; dst.dodge = src.dodge;
  dst.dodgeDx = src.dodgeDx; dst.delay = src.delay; dst.hold = src.hold; dst.holdFrames = src.holdFrames;
  dst.upbFirst = src.upbFirst;
  return dst;
}

/** The recovery move's direct code from the profile (roles.recovery), 0 when it has none. */
export function recoveryCode(prof: CharacterAiProfile): number {
  const r = prof.roles.recovery;
  for (let i = 0; i < r.length; i++) { const c = codeOf(r[i]); if (c > 0) return c; }
  return 0;
}

/** True when the up special (recovery move) can still be used this airtime. */
export function upbAvailable(f: FighterState, prof: CharacterAiProfile): boolean {
  if (f.action === 'airHelpless') return false;
  if (f.action === 'attack' && f.moveId !== null && prof.roles.recovery.indexOf(f.moveId) >= 0) return false;
  return prof.roles.recovery.length > 0;
}

/** One frame of `p` for `f`. `t` counts frames since the policy started. */
export function recoverIntent(p: RecoverPolicy, t: number, f: FighterState, g: Geo, upbCode: number, out: Intent): void {
  if (f.onGround || isLedgeAction(f.action) || isGone(f)) return;
  const home = homeDir(f.x, f.y, g);
  const hb = dirBit(home);
  let held = hb;
  if (t < p.holdFrames) held = p.hold === HOLD_NEUTRAL ? 0 : p.hold === HOLD_AWAY ? dirBit(-home) : hb;
  if (f.hitlag > 0 || (f.action === 'hitstun' && f.hitstun > 0)) { out.held = held; return; }
  if (f.action === 'tumble') {
    // A press ends tumble without spending anything; Grab does nothing else in the air.
    if (f.hitstun <= 0) held |= BG;
    out.held = held;
    return;
  }
  if (f.action !== 'air' || t < p.delay) { out.held = held; return; }
  const sf = f as SimFighter;
  const depth = f.y - g.top;
  const od = outDist(f.x, g);
  if (underStage(f.x, f.y, g)) {
    if (f.jumpsLeft > 0 && f.vy > 1 && f.y > g.bot + 90) held |= BJ;
    out.held = held;
    return;
  }
  if (p.upbFirst && upbCode > 0 && f.vy > 0 && depth >= p.upbDepth) {
    out.direct = upbCode; out.held = hb | BU; return;
  }
  if (f.jumpsLeft > 0 && f.vy > -0.5 && depth > p.jumpDepth) { out.held = held | BJ; return; }
  if (p.dodge !== DODGE_NONE && !sf.airDodgeUsed && f.jumpsLeft === 0 && od <= p.dodgeDx && depth > -40 && depth < 70
    && f.vy >= 0) {
    out.direct = C_DIRAD;
    out.held = hb | (p.dodge === DODGE_UP ? BU : p.dodge === DODGE_DOWN ? BD : 0);
    return;
  }
  if (upbCode > 0 && f.jumpsLeft === 0 && f.vy > 0 && depth > p.upbDepth) { out.direct = upbCode; out.held = hb | BU; return; }
  out.held = held;
}

/** Drives one fighter with a recovery policy. */
export class PolicyDriver implements Driver {
  pol: RecoverPolicy = makePolicy('', 0, 40);
  code = 0;
  set(pol: RecoverPolicy, code: number): this { this.pol = pol; this.code = code; return this; }
  step(t: number, f: FighterState, s: GameState, out: Intent): void {
    recoverIntent(this.pol, t, f, geoOf(s.stageId), this.code, out);
  }
}

/** The victim scripts of canGetBack's exact check. */
const CGB_POLICIES: readonly RecoverPolicy[] = [
  makePolicy('cgbMid', 0, 40),
  makePolicy('cgbEarly', -1000, 0),
  makePolicy('cgbLow', 40, 90),
  makePolicy('cgbDeep', 70, 120),
  makePolicy('cgbDodgeUp', -40, 60, DODGE_UP, 130),
  makePolicy('cgbDodge', 20, 60, DODGE_TOWARD, 130),
  makePolicy('cgbUpbNow', -1000, -1000, DODGE_NONE, 0, 0, HOLD_TOWARD, 0, true),
];

// ---------------------------------------------------------------------------------------------
// canGetBack (02 section 10.1): recoverBox table, exact rollouts for close calls
// ---------------------------------------------------------------------------------------------

/** Table margins inside this band (px) are settled by rollouts. */
const EXACT_BAND = 40;

/** Launched, mid-move, or moving fast: the at-rest table does not apply. */
function hotState(f: SimFighter): boolean {
  return f.hitlag > 0 || f.hitstun > 0 || f.action === 'tumble' || f.action === 'airDodge' || f.action === 'attack'
    || f.action === 'footstooled' || f.vy > 3.3 || f.vy < -3.3 || f.vx > 2.6 || f.vx < -2.6;
}

/** Spare depth (px) from the recoverBox table: deepest reachable start minus the current depth. */
export function tableMargin(f: FighterState, prof: CharacterAiProfile, g: Geo): number {
  const sf = f as SimFighter;
  const def = CHARACTER_DEFS[f.charId];
  const jumps = def.jumps;
  const u = upbAvailable(f, prof) ? 1 : 0;
  const d = sf.airDodgeUsed ? 0 : 1;
  const dx = outDist(f.x, g);
  let depth = f.y - g.top;
  if (dx === 0 && f.y > g.bot) depth += Math.min(f.x - g.left, g.right - f.x) + 20;
  const box = prof.recovery.recoverBox;
  const bf = dx / RECOVER_DX_BIN;
  if (bf > RECOVER_DX_BINS) return -(Math.max(0, depth) + 60);
  let b0 = Math.floor(bf);
  let frac = bf - b0;
  if (b0 >= RECOVER_DX_BINS - 1) { b0 = RECOVER_DX_BINS - 1; frac = 0; }
  const v0 = box[recoverBoxIndex(f.jumpsLeft, u, d, b0, jumps)];
  const v1 = b0 + 1 < RECOVER_DX_BINS ? box[recoverBoxIndex(f.jumpsLeft, u, d, b0 + 1, jumps)] : v0;
  let max: number;
  if (v0 < 0 || v1 < 0) max = frac < 0.5 ? v0 : v1;
  else max = v0 + (v1 - v0) * frac;
  if (max < 0) return -(Math.max(0, depth) + 60);
  return max - depth;
}

const CGB_DRIVERS: (Driver | null)[] = [null, null, null, null];
const CGB_POL = new PolicyDriver();
const CGB_WATCH = new Watch();

function exactGetBack(s: GameState, who: number, prof: CharacterAiProfile, work: GameState): boolean {
  const code = recoveryCode(prof);
  for (let p = 0; p < CGB_POLICIES.length; p++) {
    copyStateInto(s, work);
    for (let i = 0; i < 4; i++) CGB_DRIVERS[i] = null;
    CGB_DRIVERS[who] = CGB_POL.set(CGB_POLICIES[p], code);
    simulate(work, 360, CGB_DRIVERS, CGB_WATCH, who, STOP_RECOVER, code);
    const w = CGB_WATCH;
    if ((w.ko & (1 << who)) === 0 && !w.fail && (w.ledgeAt[who] >= 0 || w.landAt[who] >= 0)) return true;
  }
  return false;
}

/**
 * Px of spare depth for fighter `who` to get back (negative = none). On the ground, on a ledge or
 * respawning: SLACK_INF. Clear table answers (margin beyond 40 px, at rest) come from the
 * profile's recoverBox; close calls and launched or moving fighters run the victim's recovery
 * scripts forward in `work` (a cloneGameState of this match) with every other fighter idle.
 */
export const canGetBack: CanGetBackFn = (s, who, prof, work) => {
  const f = s.fighters[who] as SimFighter;
  if (f.action === 'dead') return -SLACK_INF;
  if (f.action === 'respawn' || f.onGround || isLedgeAction(f.action)) return SLACK_INF;
  const g = geoOf(s.stageId);
  const hot = hotState(f);
  if (!offstage(f, g) && !hot) return SLACK_INF;
  const margin = offstage(f, g) ? tableMargin(f, prof, g) : SLACK_INF;
  if (!hot && (margin > EXACT_BAND || margin < -EXACT_BAND)) return margin;
  const ok = exactGetBack(s, who, prof, work);
  if (ok) return margin >= SLACK_INF ? SLACK_INF : Math.max(1, margin);
  return Math.min(-1, margin >= SLACK_INF ? -1 : margin);
};

/** canGetBack without rollouts (table only), for ranking many rollout ends cheaply. */
export function quickGetBack(f: FighterState, prof: CharacterAiProfile, g: Geo): number {
  if (f.action === 'dead') return -SLACK_INF;
  if (f.action === 'respawn' || f.onGround || isLedgeAction(f.action) || !offstage(f, g)) return SLACK_INF;
  return tableMargin(f, prof, g);
}

// ---------------------------------------------------------------------------------------------
// Local plans: data scripts and a pool (script adapter)
// ---------------------------------------------------------------------------------------------

/**
 * Plan inputs as data. `kind` picks the interpreter branch; the other fields are its numbers.
 * Positions are world px, frames are absolute (ctx.frame convention above).
 */
export interface ScriptData {
  kind: number; code: number; code2: number; btn: number;
  x: number; x2: number; face: number;
  fireAt: number; fireAt2: number;
  a: number; b: number; c: number;
  upb: number; pol: RecoverPolicy;
}
export function newScriptData(): ScriptData {
  return { kind: 0, code: 0, code2: 0, btn: 0, x: 0, x2: 0, face: 1, fireAt: 0, fireAt2: 0, a: 0, b: 0, c: 0, upb: 0,
    pol: makePolicy('', 0, 40) };
}
export function copyScriptData(src: ScriptData, dst: ScriptData): void {
  dst.kind = src.kind; dst.code = src.code; dst.code2 = src.code2; dst.btn = src.btn; dst.x = src.x; dst.x2 = src.x2;
  dst.face = src.face; dst.fireAt = src.fireAt; dst.fireAt2 = src.fireAt2; dst.a = src.a; dst.b = src.b; dst.c = src.c;
  dst.upb = src.upb; copyPolicy(src.pol, dst.pol);
}

export type Interp = (d: ScriptData, t: number, self: FighterState, ctx: PlanCtx, out: Intent) => void;

/** A plan instance whose script is ScriptData run by an interpreter. */
export class LocalPlan implements PlanInstance {
  family: PlanFamilyId = 'wait';
  name = '';
  move: MoveId | null = null;
  param = 0;
  minFrames = 1;
  horizon = 60;
  flags = 0;
  bonus = 0;
  priority = 0;
  /** Ledge trap: option x timing bits this plan was shown to hit (LT_BIT). */
  mask = 0;
  /** Own estimate of the plan's worth, for ranking inside a family. */
  value = 0;
  readonly d: ScriptData = newScriptData();
  interp: Interp = noInterp;
  readonly script: (t: number, self: FighterState, ctx: PlanCtx, out: Intent) => void;
  constructor() {
    // script adapter: the contract's script(t, self, ctx, out) runs the local data format. It
    // follows the context contract of plans/script.ts (ctx.frame is the frame of the state the
    // input is computed from, t advances outside hitlag only). Absolute fire frames in the data
    // are why these plans do not read ctx.fireAt; tails recover through the interpreter, not
    // script.ts tailRecover.
    this.script = (t, self, ctx, out) => {
      out.held = 0; out.direct = 0; out.mash = 0;
      this.interp(this.d, t, self, ctx, out);
    };
  }
}
function noInterp(): void { /* no input */ }

/**
 * Ring pool of plans. An instance stays untouched for POOL_SIZE later takes, which outlasts any
 * plan the brain can still be running (families cache their plans between refreshes).
 */
export class PlanPool {
  private readonly items: LocalPlan[] = [];
  private next = 0;
  take(interp: Interp, family: PlanFamilyId): LocalPlan {
    if (this.items.length < POOL_SIZE) this.items.push(new LocalPlan());
    const p = this.items[this.next % this.items.length];
    this.next = (this.next + 1) % POOL_SIZE;
    p.family = family; p.name = ''; p.move = null; p.param = 0; p.minFrames = 1; p.horizon = 60; p.flags = 0;
    p.bonus = 0; p.priority = 0; p.mask = 0; p.value = 0; p.interp = interp;
    const d = p.d;
    d.kind = 0; d.code = 0; d.code2 = 0; d.btn = 0; d.x = 0; d.x2 = 0; d.face = 1; d.fireAt = 0; d.fireAt2 = 0;
    d.a = 0; d.b = 0; d.c = 0; d.upb = 0;
    return p;
  }
}
const POOL_SIZE = 512;

/** Drives a fighter with a LocalPlan (or any PlanInstance) the way the brain will. */
export class PlanDriver implements Driver {
  plan: PlanInstance | null = null;
  readonly ctx: PlanCtx;
  constructor(me: CharacterAiProfile, stage: StageDef) {
    this.ctx = { dir: 1, home: 1, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0, me, stage };
  }
  set(plan: PlanInstance, me: CharacterAiProfile, s: GameState): this {
    this.plan = plan;
    this.ctx.me = me;
    this.ctx.stage = STAGE_DEFS[s.stageId];
    this.ctx.startFrame = s.frame;
    this.ctx.param = plan.param;
    return this;
  }
  step(t: number, f: FighterState, s: GameState, out: Intent): void {
    if (this.plan === null) return;
    this.ctx.frame = s.frame;
    this.plan.script(t, f, this.ctx, out);
  }
}

/** Drives a fighter straight from ScriptData (no plan object needed). */
export class DataDriver implements Driver {
  readonly d: ScriptData = newScriptData();
  interp: Interp = noInterp;
  readonly ctx: PlanCtx;
  constructor() {
    this.ctx = { dir: 1, home: 1, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0,
      me: null as unknown as CharacterAiProfile, stage: null as unknown as StageDef };
  }
  set(src: ScriptData, interp: Interp, me: CharacterAiProfile, s: GameState): this {
    copyScriptData(src, this.d);
    this.interp = interp;
    this.ctx.me = me;
    this.ctx.stage = STAGE_DEFS[s.stageId];
    this.ctx.startFrame = s.frame;
    return this;
  }
  step(t: number, f: FighterState, s: GameState, out: Intent): void {
    this.ctx.frame = s.frame;
    this.interp(this.d, t, f, this.ctx, out);
  }
}

// ---------------------------------------------------------------------------------------------
// Edge scripts (the interpreter)
// ---------------------------------------------------------------------------------------------

/** Walk or run to x on the ground, facing `face`, then optionally stand in shield (a = 1), and at fireAt send code / btn. */
export const K_TRAP = 1;
/** Stand at x, short hop at fireAt, send the aerial (code) at fireAt2, fast fall before it. */
export const K_TRAPAIR = 2;
/** Hog: run off the corner at x (face = outward) and snap the ledge; at hang frame a leave by option b. */
export const K_HOG = 3;
/** Offstage: run to the corner at x, jump at it, drift to x2, aerial code at fireAt (code2 at fireAt2), then recover. */
export const K_AERIAL = 4;

export const HOG_STAY = 0;
export const HOG_CLIMB = 1;
export const HOG_ROLL = 2;
export const HOG_DROP_AERIAL = 3;
export const HOG_JUMP = 4;

const RUN_FROM = 40;
const TAIL_POL = makePolicy('tail', 10, 40);

/** Ground approach to x facing `face`; true once there, turned and free. */
export function groundTo(self: FighterState, x: number, face: number, out: Intent): boolean {
  const dx = x - self.x;
  if (!self.onGround) { out.held = dx > 2 ? BR : dx < -2 ? BL : 0; return false; }
  if (dx > 3 || dx < -3) {
    const b = safeDir(dx > 0 ? BR : BL, self);
    out.held = dx > RUN_FROM || dx < -RUN_FROM ? b : (b === 0 ? 0 : b | BWK);
    return false;
  }
  if (self.facing !== face) { const b = safeDir(dirBit(face), self); out.held = b === 0 ? 0 : b | BWK; return false; }
  return true;
}

function fireOnce(d: ScriptData, self: FighterState, out: Intent): void {
  if (d.btn !== 0) out.held |= tap(d.btn, self);
  if (d.code !== 0) out.direct = d.code;
}

export const edgeInterp: Interp = (d, t, self, ctx, out) => {
  const g = geoOf(ctx.stage.id);
  switch (d.kind) {
    case K_TRAP: {
      if (ctx.frame >= d.fireAt) {
        if (ctx.frame <= d.fireAt + 3 && groundFree(self)) fireOnce(d, self, out);
        return;
      }
      const there = groundTo(self, d.x, d.face, out);
      if (there && d.a === 1 && ctx.frame < d.fireAt - 3) out.held |= BSH;
      return;
    }
    case K_TRAPAIR: {
      if (self.onGround) {
        if (ctx.frame < d.fireAt) { groundTo(self, d.x, d.face, out); return; }
        if (ctx.frame <= d.fireAt + 2 && groundFree(self)) out.held = tap(BJ, self);
        return;
      }
      if (self.action === 'air' && ctx.frame >= d.fireAt2 && ctx.frame <= d.fireAt2 + 3) out.direct = d.code;
      else if (self.action === 'air' && ctx.frame < d.fireAt2 && self.vy > 0 && !self.fastFalling) out.held = tap(BD, self);
      if (ctx.frame > d.fireAt2 + 40 && offstage(self, g)) recoverIntent(TAIL_POL, t, self, g, d.upb, out);
      return;
    }
    case K_HOG: {
      const sf = self as SimFighter;
      if (self.action === 'ledgeHang') {
        if (d.b === HOG_STAY || self.actionFrame < d.a) return;
        if (d.b === HOG_CLIMB) out.held = tap(BJ, self);
        else if (d.b === HOG_ROLL) out.held = tap(BSH, self);
        else if (d.b === HOG_DROP_AERIAL) out.held = BD;
        else if (d.b === HOG_JUMP) out.direct = C_LEDGE_JUMP;
        return;
      }
      if (isLedgeAction(self.action)) return;
      if (self.onGround) {
        // Out to the corner, then off it; running keeps the fall short of the snap region.
        const past = (self.x - d.x) * d.face;
        if (past < -1) { const b = safeDir(dirBit(d.face), self); out.held = past < -RUN_FROM ? b : (b === 0 ? 0 : b | BWK); }
        else out.held = dirBit(d.face);
        return;
      }
      if (sf.ledgeRegrabs === 0) { out.held = dirBit(-d.face); return; }   // walked off: turn back and snap
      // Dropped from the hog: the aerial c frames after the drop, then recover.
      if (d.b === HOG_DROP_AERIAL && self.action === 'air' && sf.ledgeCooldown > 0 && 12 - sf.ledgeCooldown >= d.c) {
        out.direct = d.code;
        return;
      }
      if (self.action === 'air' && sf.ledgeCooldown > 0) return;
      recoverIntent(TAIL_POL, t, self, g, d.upb, out);
      return;
    }
    case K_AERIAL: {
      if (self.action === 'ledgeHang') {
        // From the ledge: drop (down), the aerials follow in the air.
        if (ctx.frame < d.fireAt) out.held = BD;
        return;
      }
      if (self.onGround) {
        const past = (self.x - d.x) * d.face;
        if (past < -8) { const b = safeDir(dirBit(d.face), self); out.held = b; return; }
        if (groundFree(self) || self.action === 'jumpsquat') out.held = (self.action === 'jumpsquat' ? BJ : tap(BJ, self)) | dirBit(d.face);
        return;
      }
      const dx = d.x2 - self.x;
      out.held = dx > 4 ? BR : dx < -4 ? BL : 0;
      if (self.action === 'air') {
        if (d.code !== 0 && ctx.frame >= d.fireAt && ctx.frame <= d.fireAt + 2) { out.direct = d.code; return; }
        if (d.code2 !== 0 && ctx.frame >= d.fireAt2 && ctx.frame <= d.fireAt2 + 2) { out.direct = d.code2; return; }
        if (d.a > 0 && ctx.frame >= d.fireAt && ctx.frame <= d.fireAt + d.a) { out.direct = C_FOOTSTOOL; return; }
      }
      const end = (d.code2 !== 0 ? d.fireAt2 : d.fireAt) + d.b;
      if (ctx.frame > end && offstage(self, g)) {
        out.held = 0;
        recoverIntent(TAIL_POL, t, self, g, d.upb, out);
      }
      return;
    }
    default:
      return;
  }
};

// ---------------------------------------------------------------------------------------------
// Tools: what a character can put where, read from the profile and MoveDef
// ---------------------------------------------------------------------------------------------

export const TK_MELEE = 0;
export const TK_SHOT = 1;
export const TK_GRAB = 2;
export const TK_AIR = 3;

export interface Tool { id: MoveId | null; md: MoveDef | null; kind: number; code: number; btn: number;
  startup: number; total: number; dmg: number; hitsLedge: boolean; spike: boolean }

interface ToolSet { ground: Tool[]; shots: Tool[]; air: Tool[]; spikes: Tool[]; grab: Tool | null; ledgeAir: Tool[] }
const toolCache = new Map<string, Map<string, ToolSet>>();

function moveStartup(md: MoveDef): number {
  let s = 1e9;
  for (let i = 0; i < md.hitboxes.length; i++) if (md.hitboxes[i].start < s) s = md.hitboxes[i].start;
  const pr = md.projectiles;
  if (pr !== undefined) for (let i = 0; i < pr.length; i++) if (pr[i].spawnFrame >= 0 && pr[i].spawnFrame < s) s = pr[i].spawnFrame;
  return s >= 1e9 ? -1 : s;
}
function movesSideways(md: MoveDef): boolean {
  const v = md.velocity;
  if (v === undefined) return false;
  for (let i = 0; i < v.length; i++) if (v[i].vx !== undefined && v[i].vx !== 0) return true;
  return false;
}
function maxDamage(md: MoveDef): number {
  let m = 0;
  for (let i = 0; i < md.hitboxes.length; i++) if (md.hitboxes[i].damage > m) m = md.hitboxes[i].damage;
  const pr = md.projectiles;
  if (pr !== undefined) for (let i = 0; i < pr.length; i++) if (pr[i].damage > m) m = pr[i].damage;
  return m;
}

/** Tool lists for a character on a stage: ground melee, shots, aerials, spikes, the grab. */
export function toolsOf(prof: CharacterAiProfile, stageId: string): ToolSet {
  let byStage = toolCache.get(prof.charId);
  if (byStage === undefined) { byStage = new Map(); toolCache.set(prof.charId, byStage); }
  const hit = byStage.get(stageId);
  if (hit !== undefined) return hit;
  const def = CHARACTER_DEFS[prof.charId];
  const set: ToolSet = { ground: [], shots: [], air: [], spikes: [], grab: null, ledgeAir: [] };
  const seen = new Set<MoveId>();
  const lists = [prof.roles.ledgeTrap, prof.roles.edgeguard, prof.roles.techChase, prof.roles.kill];
  for (let l = 0; l < lists.length; l++) {
    for (let i = 0; i < lists[l].length; i++) {
      const id = lists[l][i];
      if (seen.has(id)) continue;
      seen.add(id);
      const md = def.moves[id];
      const info = prof.moves[id];
      const code = codeOf(id);
      if (md === undefined || info === undefined || code === 0) continue;
      const st = moveStartup(md);
      if (st < 0) continue;
      const spike = info.tags.indexOf('spike') >= 0;
      const tool: Tool = { id, md, kind: TK_MELEE, code, btn: 0, startup: st, total: md.totalFrames, dmg: maxDamage(md),
        hitsLedge: md.hitsLedge === true, spike };
      const aerial = md.airOnly === true || md.landingLag !== undefined;
      const hasShot = md.projectiles !== undefined && md.projectiles.length > 0 && info.tags.indexOf('projectile') >= 0;
      if (aerial) {
        tool.kind = TK_AIR;
        set.air.push(tool);
        if (spike) set.spikes.push(tool);
        if (tool.hitsLedge) set.ledgeAir.push(tool);
      } else if (hasShot) {
        tool.kind = TK_SHOT;
        set.shots.push(tool);
      } else if (md.hitboxes.length > 0 && !movesSideways(md)) {
        set.ground.push(tool);
      }
    }
  }
  const kit = grabKitOf(def);
  set.grab = { id: null, md: null, kind: TK_GRAB, code: 0, btn: BG, startup: kit.stand.start, total: kit.stand.totalFrames,
    dmg: 3, hitsLedge: false, spike: false };
  byStage.set(stageId, set);
  return set;
}

// ---------------------------------------------------------------------------------------------
// Trajectories: a target's future under one input hypothesis, and cover search over them
// ---------------------------------------------------------------------------------------------

const TMAX = 160;
const TF_HITTABLE = 1;
const TF_HANG = 2;
const TF_DODGE = 4;
const TF_AIR = 8;
const TF_GRABBABLE = 16;

/** A recorded future of one fighter: hurtbox and flags after each step. */
export class Traj {
  n = 0;
  end = 0;
  grab = -1;
  land = -1;
  dies = false;
  weight = 1;
  bits = 0;
  opt = 0;
  h = 0;
  readonly x0 = new Float32Array(TMAX);
  readonly y0 = new Float32Array(TMAX);
  readonly x1 = new Float32Array(TMAX);
  readonly y1 = new Float32Array(TMAX);
  readonly cx = new Float32Array(TMAX);
  readonly feet = new Float32Array(TMAX);
  readonly fl = new Uint8Array(TMAX);
}

const HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };

class TrajHook implements StepHook {
  tr: Traj = new Traj();
  idx = 0;
  stopAtGrab = false;
  wasHanging = false;
  after(k: number, s: GameState): void {
    const f = s.fighters[this.idx] as SimFighter;
    const tr = this.tr;
    if (k >= TMAX) return;
    tr.n = k + 1;
    fighterHurtbox(f, CHARACTER_DEFS[f.charId], HURT);
    tr.x0[k] = HURT.x; tr.y0[k] = HURT.y; tr.x1[k] = HURT.x + HURT.w; tr.y1[k] = HURT.y + HURT.h;
    tr.cx[k] = f.x; tr.feet[k] = f.y;
    const gone = isGone(f) || f.action === 'finalSmash' || f.action === 'finalSmashVictim';
    let fl = 0;
    if (!gone && f.invuln <= 0) fl |= TF_HITTABLE;
    const hang = f.action === 'ledgeHang' || f.action === 'ledgeGrab';
    if (hang) fl |= TF_HANG;
    if (f.highDodge > 0) fl |= TF_DODGE;
    if (!f.onGround) fl |= TF_AIR;
    if ((fl & TF_HITTABLE) !== 0 && f.onGround && !isLedgeAction(f.action) && f.highDodge <= 0 && f.action !== 'grabbed')
      fl |= TF_GRABBABLE;
    tr.fl[k] = fl;
    if (gone && !tr.dies) { tr.dies = true; tr.end = Math.min(tr.end, k); }
    if (hang && !this.wasHanging && tr.grab < 0) {
      tr.grab = k;
      if (this.stopAtGrab) tr.end = Math.min(tr.end, k);
    }
    if (!hang) this.wasHanging = false;
    if (f.onGround && tr.land < 0) tr.land = k;
  }
}
const TRAJ_HOOK = new TrajHook();
const TRAJ_WATCH = new Watch();
const TRAJ_DRIVERS: (Driver | null)[] = [null, null, null, null];

/** Moves fighter `i` of a scratch state far from the action so it cannot touch the target. */
function park(s: GameState, i: number, awayFromX: number): void {
  const g = geoOf(s.stageId);
  const f = s.fighters[i] as SimFighter;
  const side = sideOf(awayFromX, g);
  f.x = cornerX(-side, g) + side * 30;
  f.y = g.top; f.prevY = g.top; f.vx = 0; f.vy = 0; f.onGround = true;
  f.action = 'idle'; f.actionFrame = 0; f.moveId = null; f.charging = false;
  f.hitstun = 0; f.hitlag = 0; f.kbSpeed = 0; f.ledge = -1; f.fastFalling = false;
}

/** Records fighter `tgt`'s future under `drv` for up to `frames` frames, with `park` (-1 = none) moved away. */
export function recordTraj(src: GameState, tgt: number, parkIdx: number, drv: Driver | null, frames: number,
  stopAtGrab: boolean, tr: Traj): void {
  const w = workState(W_TRAJ, src);
  if (parkIdx >= 0) park(w, parkIdx, src.fighters[tgt].x);
  for (let i = 0; i < 4; i++) TRAJ_DRIVERS[i] = null;
  TRAJ_DRIVERS[tgt] = drv;
  tr.n = 0; tr.end = Math.min(frames, TMAX); tr.grab = -1; tr.land = -1; tr.dies = false;
  const f = src.fighters[tgt];
  TRAJ_HOOK.tr = tr; TRAJ_HOOK.idx = tgt; TRAJ_HOOK.stopAtGrab = stopAtGrab;
  TRAJ_HOOK.wasHanging = f.action === 'ledgeHang' || f.action === 'ledgeGrab';
  simulate(w, Math.min(frames, TMAX), TRAJ_DRIVERS, TRAJ_WATCH, -1, STOP_NONE, 0, TRAJ_HOOK);
  if (tr.end > tr.n) tr.end = tr.n;
}

function circleRect(cx: number, cy: number, r: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const nx = cx < x0 ? x0 : cx > x1 ? x1 : cx;
  const ny = cy < y0 ? y0 : cy > y1 ? y1 : cy;
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

const LOW_PROBE = { y: 0 } as FighterState;

/**
 * First trajectory index at which `tool`, pressed at input index F by a fighter standing at
 * (mx, my) facing `face`, touches the target while it can be hit; -1 when it never does.
 */
export function toolHitIdx(tool: Tool, charId: string, mx: number, my: number, face: number, F: number, tr: Traj): number {
  if (tool.kind === TK_GRAB) {
    const box = grabKitOf(CHARACTER_DEFS[charId]).stand;
    for (let k = box.start; k <= box.end; k++) {
      const i = F + k;
      if (i >= tr.end) break;
      if ((tr.fl[i] & TF_GRABBABLE) === 0) continue;
      if (circleRect(mx + box.x * face, my + box.y, box.r, tr.x0[i], tr.y0[i], tr.x1[i], tr.y1[i])) return i;
    }
    return -1;
  }
  const md = tool.md;
  if (md === null) return -1;
  let best = -1;
  if (tool.kind === TK_SHOT) {
    const pr = md.projectiles;
    if (pr === undefined) return -1;
    for (let p = 0; p < pr.length; p++) {
      const pd = pr[p];
      if (pd.spawnFrame < 0) continue;
      let x = mx + pd.x * face;
      let y = my + pd.y;
      let vx = pd.vx * face;
      let vy = pd.vy;
      const i0 = F + pd.spawnFrame;
      for (let a = 0; a < pd.lifetime; a++) {
        if (pd.returnFrame !== undefined && a === pd.returnFrame) vx = -vx;
        x += vx; y += vy; vy += pd.gravity;
        const i = i0 + a;
        if (i >= tr.end) break;
        if (best >= 0 && i >= best) break;
        const fl = tr.fl[i];
        if ((fl & TF_HITTABLE) === 0) continue;
        if ((fl & TF_DODGE) !== 0) { LOW_PROBE.y = tr.feet[i]; if (!isLowHit(LOW_PROBE, y, pd.low, null, true)) continue; }
        if (circleRect(x, y, pd.r, tr.x0[i], tr.y0[i], tr.x1[i], tr.y1[i])) { best = i; break; }
      }
    }
    return best;
  }
  const hbs = md.hitboxes;
  for (let h = 0; h < hbs.length; h++) {
    const hb = hbs[h];
    if (hb.grab !== undefined) continue;
    const cx = mx + hb.x * face;
    const cy = my + hb.y;
    for (let k = hb.start; k <= hb.end; k++) {
      const i = F + k;
      if (i >= tr.end) break;
      if (best >= 0 && i >= best) break;
      const fl = tr.fl[i];
      if ((fl & TF_HITTABLE) === 0) continue;
      if ((fl & TF_HANG) !== 0 && md.hitsLedge !== true) continue;
      if ((fl & TF_DODGE) !== 0) { LOW_PROBE.y = tr.feet[i]; if (!isLowHit(LOW_PROBE, cy, hb.low, tool.id, true)) continue; }
      if (circleRect(cx, cy, hb.r, tr.x0[i], tr.y0[i], tr.x1[i], tr.y1[i])) { best = i; break; }
    }
  }
  return best;
}

/** Last active trajectory index of `tool` pressed at F (its last hitbox frame or shot age). */
function toolLastIdx(tool: Tool, F: number): number {
  if (tool.md === null) return F + tool.startup + 1;
  let e = 0;
  for (let i = 0; i < tool.md.hitboxes.length; i++) if (tool.md.hitboxes[i].end > e) e = tool.md.hitboxes[i].end;
  return F + e;
}

// ---------------------------------------------------------------------------------------------
// Approach: when we can be at a spot, turned, and free
// ---------------------------------------------------------------------------------------------

const ARR_DRV = new DataDriver();
const ARR_D = newScriptData();
const ARR_WATCH = new Watch();
const ARR_DRIVERS: (Driver | null)[] = [null, null, null, null];
class ArrHook implements StepHook {
  me = 0; x = 0; face = 1; at = -1; ax = 0;
  after(k: number, s: GameState): void {
    if (this.at >= 0) return;
    const f = s.fighters[this.me];
    if (f.onGround && Math.abs(f.x - this.x) <= 4 && f.facing === this.face && (f.action === 'idle' || f.action === 'walk'
      || f.action === 'crouch')) { this.at = k + 1; this.ax = f.x; }
  }
}
const ARR_HOOK = new ArrHook();

/** Input index from which we stand at x facing `face` (and the x reached), or -1 within `maxF`. */
export function arrival(src: GameState, me: number, prof: CharacterAiProfile, x: number, face: number, maxF: number): number {
  const f = src.fighters[me];
  if (groundFree(f) && Math.abs(f.x - x) <= 4 && f.facing === face) { ARR_HOOK.ax = f.x; return 0; }
  const w = workState(W_ARR, src);
  ARR_D.kind = K_TRAP; ARR_D.x = x; ARR_D.face = face; ARR_D.fireAt = 1e9; ARR_D.a = 0; ARR_D.code = 0; ARR_D.btn = 0;
  for (let i = 0; i < 4; i++) ARR_DRIVERS[i] = null;
  ARR_DRIVERS[me] = ARR_DRV.set(ARR_D, edgeInterp, prof, src);
  ARR_HOOK.me = me; ARR_HOOK.x = x; ARR_HOOK.face = face; ARR_HOOK.at = -1;
  simulate(w, maxF, ARR_DRIVERS, ARR_WATCH, -1, STOP_NONE, 0, ARR_HOOK);
  return ARR_HOOK.at;
}
export function arrivalX(): number { return ARR_HOOK.ax; }

// ---------------------------------------------------------------------------------------------
// Per-slot memory
// ---------------------------------------------------------------------------------------------

class FamCache { key = -1; at = -1e9; readonly plans: LocalPlan[] = []; }

class EdgeMem {
  config: unknown = null;
  lastFrame = -1;
  readonly pool = new PlanPool();
  readonly lt = new FamCache();
  readonly pg = new FamCache();
  readonly hog = new FamCache();
  readonly off = new FamCache();
  // analysis for the current frame
  frame = -1;
  me = -1;
  tgt = -1;
  ok = false;
  threat = false;
  mate = 0;
}
const MEMS: EdgeMem[] = [];
function memFor(v: DecisionView): EdgeMem {
  let m = MEMS[v.slot];
  if (m === undefined) { m = new EdgeMem(); MEMS[v.slot] = m; }
  const s = v.p.state;
  if (m.config !== s.config || s.frame < m.lastFrame) {
    m.config = s.config;
    m.lt.key = -1; m.pg.key = -1; m.hog.key = -1; m.off.key = -1;
    m.frame = -1;
  }
  m.lastFrame = s.frame;
  return m;
}

/** Teammate guard states. */
const MATE_NONE = 0;
const MATE_OFFSTAGE = 1;
const MATE_LEDGE = 2;
const MATE_EDGE = 3;

/** A second foe (not the target) close enough on the stage to hit us during an edgeguard. */
function secondThreat(s: GameState, me: number, tgt: number, g: Geo): boolean {
  const m = s.fighters[me];
  for (let i = 0; i < s.fighters.length; i++) {
    if (i === tgt || !isFoe(s, me, i)) continue;
    const o = s.fighters[i];
    if (offstage(o, g) || isLedgeAction(o.action) || o.hitstun > 0 || o.action === 'tumble' || o.action === 'downed') continue;
    const dx = o.x - m.x;
    const dy = o.y - m.y;
    if (dx < 120 && dx > -120 && dy < 90 && dy > -90) return true;
  }
  return false;
}

/** What a teammate is doing about the target's recovery. */
function mateGuard(s: GameState, me: number, tgt: number, g: Geo): number {
  const t = s.fighters[tgt];
  const side = sideOf(t.x, g);
  const ledgeIdx = g.mainIndex * 2 + (side < 0 ? 0 : 1);
  let res = MATE_NONE;
  for (let i = 0; i < s.fighters.length; i++) {
    if (!isMate(s, me, i)) continue;
    const o = s.fighters[i];
    if (o.ledge === ledgeIdx) return MATE_LEDGE;
    if (offstage(o, g) && Math.abs(o.x - t.x) < 160 && Math.abs(o.y - t.y) < 160) res = MATE_OFFSTAGE;
    else if (res === MATE_NONE && o.onGround && Math.abs(o.x - cornerX(side, g)) < 60) res = MATE_EDGE;
  }
  return res;
}

/** Shared per-frame read: who we guard, and whether we may. */
function analyze(v: DecisionView, m: EdgeMem): void {
  const s = v.p.state;
  if (m.frame === s.frame && m.me === v.p.meI && m.tgt === v.p.oppI) return;
  m.frame = s.frame; m.me = v.p.meI; m.tgt = v.p.oppI;
  m.ok = false;
  const me = v.p.meI;
  const tgt = v.p.oppI;
  if (!isFoe(s, me, tgt)) return;
  const f = s.fighters[me];
  if (isGone(f) || f.hitstun > 0 || f.action === 'tumble' || f.action === 'grabbed' || f.action === 'grabHold'
    || f.action === 'downed' || f.action === 'shieldBreak') return;
  const g = geoOf(s.stageId);
  m.threat = secondThreat(s, me, tgt, g);
  m.mate = mateGuard(s, me, tgt, g);
  m.ok = true;
}

/** Profile of any fighter in the state (the view carries only us and the target). */
export function profileOf(v: DecisionView, i: number): CharacterAiProfile {
  const s = v.p.state;
  if (i === v.p.meI) return v.me;
  if (i === v.p.oppI) return v.opp;
  return getAiProfile(s.fighters[i].charId, s.stageId);
}

function emitCached(c: FamCache, out: PlanInstance[]): void {
  for (let i = 0; i < c.plans.length; i++) out.push(c.plans[i]);
}

/** Internal step allowance for one refresh of a family, from the level's search budget. */
function stepAllowance(v: DecisionView): number {
  if (v.level.stepBudget <= 0) return 0;
  const k = v.genScale !== undefined && v.genScale > 0 && v.genScale < 1 ? v.genScale : 1;
  return Math.floor(v.level.stepBudget * 4 * k);
}

// ---------------------------------------------------------------------------------------------
// Ledge trap (02 section 9.6): coverage over six options x three timings
// ---------------------------------------------------------------------------------------------

export const O_WAIT = 0;
export const O_CLIMB = 1;
export const O_ATTACK = 2;
export const O_ROLL = 3;
export const O_JUMP = 4;
export const O_DROP = 5;
export const OPT_COUNT = 6;
export const OPT_NAMES: readonly string[] = ['wait', 'climb', 'attack', 'roll', 'jump', 'drop'];
/** Timing index: 0 early (at once), 1 as the hang invulnerability ends, 2 late. */
export const H_EARLY = 0;
export const H_MID = 1;
export const H_LATE = 2;
export function ltBit(o: number, h: number): number { return 1 << (o * 3 + h); }
function optMask(o: number): number { return 7 << (o * 3); }
function popcount(x: number): number { let n = 0; while (x !== 0) { x &= x - 1; n++; } return n; }

/** The hanger's option at input frame h (relative to now). */
export class OptionDriver implements Driver {
  opt = O_WAIT;
  h = 0;
  set(opt: number, h: number): this { this.opt = opt; this.h = h; return this; }
  step(t: number, f: FighterState, _s: GameState, out: Intent): void {
    if (t < this.h) return;
    const first = t === this.h;
    switch (this.opt) {
      case O_CLIMB: if (first) out.held = BJ; break;
      case O_ATTACK: if (first) out.held = BA; break;
      case O_ROLL: if (first) out.held = BSH; break;
      case O_JUMP: if (first) out.direct = C_LEDGE_JUMP; else if (!f.onGround) out.held = dirBit(f.facing); break;
      case O_DROP: if (first) out.held = BD; break;
      default: break;
    }
  }
}

const LT_H = 90;
const TRAJS: Traj[] = [];
for (let i = 0; i < 24; i++) TRAJS.push(new Traj());
const OPT_DRV = new OptionDriver();
const PROBS = new Float64Array(ACTION_CLASS_COUNT);
const OBS = newContext();
const P_OPT = new Float64Array(OPT_COUNT);
const OPT_CLASS: readonly number[] = [AC_NONE, AC_STAND, AC_LEDGE_ATTACK, AC_ROLL_TO, AC_JUMP, AC_OUT];

/** Option probabilities: the predictor's read, smoothed half toward uniform. */
function optionPrior(v: DecisionView): void {
  let conf = 0;
  let sum = 0;
  try {
    makeContext(v.p.state, v.p.meI, v.p.oppI, v.p.state.frame, OBS);
    conf = v.pred.predict(OBS, PROBS);
    for (let o = 0; o < OPT_COUNT; o++) sum += PROBS[OPT_CLASS[o]];
  } catch (err) {
    void err;   // a stub predictor: fall back to uniform
    conf = 0;
  }
  for (let o = 0; o < OPT_COUNT; o++) {
    const u = 1 / OPT_COUNT;
    const q = sum > 0 ? PROBS[OPT_CLASS[o]] / sum : u;
    const k = conf > 0 ? 0.5 * Math.min(1, conf) : 0;
    P_OPT[o] = (1 - k) * u + k * q;
  }
}

interface Cand { tool: Tool | null; x: number; face: number; F: number; F2: number; mask: number; score: number;
  kind: number; first: number; ok: boolean }
function newCand(): Cand { return { tool: null, x: 0, face: 1, F: 0, F2: 0, mask: 0, score: -1, kind: 0, first: 0, ok: false }; }
function copyCand(a: Cand, b: Cand): void {
  b.tool = a.tool; b.x = a.x; b.face = a.face; b.F = a.F; b.F2 = a.F2; b.mask = a.mask; b.score = a.score; b.kind = a.kind;
  b.first = a.first; b.ok = a.ok;
}
const BEST_ALL = newCand();
const BEST_OPT: Cand[] = [];
for (let i = 0; i < OPT_COUNT; i++) BEST_OPT.push(newCand());
const CUR = newCand();

function trapScore(mask: number, lambda: number): number {
  let min = 1;
  let mean = 0;
  for (let o = 0; o < OPT_COUNT; o++) {
    const c = popcount(mask & optMask(o)) / 3;
    if (c < min) min = c;
    mean += P_OPT[o] * c;
  }
  return lambda * min + (1 - lambda) * mean;
}

function considerTrap(c: Cand, lambda: number): void {
  if (c.mask === 0) return;
  const pc = popcount(c.mask);
  c.score = trapScore(c.mask, lambda) + 0.002 * pc - 0.00001 * c.F;
  if (!BEST_ALL.ok || c.score > BEST_ALL.score) { copyCand(c, BEST_ALL); BEST_ALL.ok = true; }
  for (let o = 0; o < OPT_COUNT; o++) {
    const co = popcount(c.mask & optMask(o));
    if (co === 0) continue;
    const b = BEST_OPT[o];
    const bo = b.ok ? popcount(b.mask & optMask(o)) : 0;
    if (!b.ok || co > bo || (co === bo && c.score > b.score)) { copyCand(c, b); b.ok = true; }
  }
}

const VER_DRV = new DataDriver();
const VER_DRIVERS: (Driver | null)[] = [null, null, null, null];
const VER_WATCH = new Watch();

/** Runs our plan data against the hanger's option (opt, h); true when we land a hit on it. */
function verifyVsOption(src: GameState, me: number, tgt: number, prof: CharacterAiProfile, d: ScriptData,
  opt: number, h: number): boolean {
  const w = workState(W_EVAL, src);
  for (let i = 0; i < 4; i++) VER_DRIVERS[i] = null;
  VER_DRIVERS[me] = VER_DRV.set(d, edgeInterp, prof, src);
  VER_DRIVERS[tgt] = OPT_DRV.set(opt, h);
  simulate(w, LT_H, VER_DRIVERS, VER_WATCH);
  return VER_WATCH.hits[me * 4 + tgt] > 0 && (VER_WATCH.ko & (1 << me)) === 0;
}

const TMP_D = newScriptData();
function trapData(c: Cand, now: number, upb: number, d: ScriptData): void {
  const tool = c.tool;
  d.kind = c.kind === TK_AIR ? K_TRAPAIR : K_TRAP;
  d.x = c.x; d.face = c.face; d.fireAt = now + c.F; d.fireAt2 = now + c.F2;
  d.code = tool === null ? 0 : tool.code; d.btn = tool === null ? 0 : tool.btn; d.a = 0; d.upb = upb;
}

/** Committed ledge option of a fighter that just left the hang, or -1. */
function committedOption(f: FighterState, g: Geo): number {
  if (f.action === 'ledgeClimb') return O_CLIMB;
  if (f.action === 'ledgeRoll') return O_ROLL;
  const sf = f as SimFighter;
  const near = Math.abs(f.x - cornerX(sideOf(f.x, g), g)) < 22;
  if (f.action === 'attack' && f.onGround && near && f.actionFrame < 24) return O_ATTACK;
  if (!f.onGround && sf.ledgeCooldown > 0 && near) return f.vy < 0 ? O_JUMP : O_DROP;
  return -1;
}

function genLedgeTrap(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  analyze(v, m);
  if (!m.ok || m.threat) return;
  const s = v.p.state;
  const me = v.p.meI;
  const tgt = v.p.oppI;
  const f = s.fighters[me];
  const t = s.fighters[tgt];
  const g = geoOf(s.stageId);
  if (!f.onGround || offstage(f, g)) return;
  const hanging = t.action === 'ledgeHang' || t.action === 'ledgeGrab';
  const committed = hanging ? -1 : committedOption(t, g);
  if (!hanging && committed < 0) return;
  // A teammate already on this ledge side: we stay back and cover the stage.
  const now = s.frame;
  const start = hanging ? now - t.actionFrame : now - t.actionFrame - 1000;
  const key = tgt * 1e7 + start + (committed + 1) * 1e6;
  const c = m.lt;
  if (c.key === key && now - c.at < 12) { emitCached(c, out); return; }
  c.key = key; c.at = now; c.plans.length = 0;

  const budget = stepAllowance(v);
  const side = sideOf(t.x, g);
  const corner = cornerX(side, g);
  const face = side;
  const tools = toolsOf(v.me, s.stageId);
  const upb = recoveryCode(v.me);
  let steps = 0;

  // 1. The hanger's futures.
  let nTraj = 0;
  const L = hanging ? t.invuln : 0;
  const hs0 = 0;
  const hs1 = L > 4 ? L - 1 : 10;
  const hs2 = (L > 4 ? L : 10) + 16;
  if (hanging) {
    const opts = budget >= 1500 ? OPT_COUNT : 3;
    for (let o = 0; o < opts; o++) {
      const nh = o === O_WAIT ? 1 : 3;
      for (let hi = 0; hi < nh; hi++) {
        const tr = TRAJS[nTraj++];
        const h = hi === 0 ? hs0 : hi === 1 ? hs1 : hs2;
        recordTraj(s, tgt, me, OPT_DRV.set(o, h), LT_H, false, tr);
        steps += LT_H;
        tr.opt = o; tr.h = h; tr.weight = 1;
        tr.bits = o === O_WAIT ? optMask(O_WAIT) : ltBit(o, hi);
      }
    }
  } else {
    const tr = TRAJS[nTraj++];
    recordTraj(s, tgt, me, null, LT_H, false, tr);
    steps += LT_H;
    tr.opt = committed; tr.h = 0; tr.weight = 1; tr.bits = optMask(committed);
  }

  // 2. Ground tools at spots along the stage from the corner.
  optionPrior(v);
  const lambda = v.style.lambda;
  BEST_ALL.ok = false;
  for (let o = 0; o < OPT_COUNT; o++) BEST_OPT[o].ok = false;
  const spotStep = budget >= 1500 ? 6 : 12;
  const ground = tools.ground;
  for (let sp = 2; sp <= 74; sp += spotStep) {
    const x = corner - face * sp;
    const A = arrival(s, me, v.me, x, face, 70);
    steps += 70;
    if (A < 0) continue;
    const ax = arrivalX();
    for (let ti = -1; ti < ground.length + tools.shots.length; ti++) {
      const tool = ti < 0 ? tools.grab : ti < ground.length ? ground[ti] : tools.shots[ti - ground.length];
      if (tool === null) continue;
      for (let F = A; F < LT_H - tool.startup; F++) {
        let mask = 0;
        let first = 1e9;
        for (let j = 0; j < nTraj; j++) {
          const idx = toolHitIdx(tool, f.charId, ax, g.top, face, F, TRAJS[j]);
          if (idx >= 0) { mask |= TRAJS[j].bits; if (idx < first) first = idx; }
        }
        if (mask === 0) continue;
        CUR.tool = tool; CUR.x = x; CUR.face = face; CUR.F = F; CUR.F2 = 0; CUR.mask = mask; CUR.kind = tool.kind;
        CUR.first = first; CUR.ok = true;
        considerTrap(CUR, lambda);
      }
    }
  }

  // 3. Aerials that reach a hanger (hitsLedge), hopped at the lip: checked by rollouts only.
  if (hanging && budget >= 1500 && tools.ledgeAir.length > 0) {
    const tool = tools.ledgeAir[0];
    const def = CHARACTER_DEFS[f.charId];
    const x = corner - face * 3;
    const A = arrival(s, me, v.me, x, face, 70);
    steps += 70;
    if (A >= 0) {
      const lead = def.jumpSquat + 3 + tool.startup;
      for (let dl = -2; dl <= 4; dl += 3) {
        const F = Math.max(A, L + 1 - lead + dl);
        CUR.tool = tool; CUR.x = x; CUR.face = face; CUR.F = F; CUR.F2 = F + def.jumpSquat + 3; CUR.kind = TK_AIR;
        CUR.mask = 0; CUR.first = F + lead; CUR.ok = true;
        trapData(CUR, now, upb, TMP_D);
        for (let o = 0; o < OPT_COUNT; o++) {
          if (steps > budget * 2) break;
          const h = o === O_WAIT ? hs0 : hs1;
          if (verifyVsOption(s, me, tgt, v.me, TMP_D, o, h)) CUR.mask |= o === O_WAIT ? optMask(O_WAIT) : ltBit(o, H_MID);
          steps += LT_H;
        }
        considerTrap(CUR, lambda);
      }
    }
  }

  // 4. Emit the best overall and the best per option, verified by rollouts where the budget allows.
  const verify = budget >= 1500;
  pushTrap(v, m, BEST_ALL, true, hanging, now, upb, verify, hs0, hs1, hs2, out);
  for (let o = 0; o < OPT_COUNT; o++) {
    const b = BEST_OPT[o];
    if (!b.ok || (BEST_ALL.ok && sameCand(b, BEST_ALL))) continue;
    let dup = false;
    for (let q = 0; q < o; q++) if (BEST_OPT[q].ok && sameCand(BEST_OPT[q], b)) dup = true;
    if (dup) continue;
    pushTrap(v, m, b, false, hanging, now, upb, verify, hs0, hs1, hs2, out);
  }
  // A shield stance at the landing spots: covers climb and attack by blocking, the rest by reaction.
  if (hanging && c.plans.length < 8) {
    const p = m.pool.take(edgeInterp, 'ledgeTrap');
    p.name = 'trap:shieldStance';
    p.d.kind = K_TRAP; p.d.x = corner - face * 24; p.d.face = face; p.d.fireAt = now + 1e6; p.d.a = 1;
    p.flags = PF_INTR; p.minFrames = 1; p.horizon = 40; p.bonus = 0.5; p.priority = 40; p.value = 0.1;
    c.plans.push(p);
    out.push(p);
  }
}

function sameCand(a: Cand, b: Cand): boolean { return a.tool === b.tool && a.x === b.x && a.F === b.F && a.kind === b.kind; }

function pushTrap(v: DecisionView, m: EdgeMem, cand: Cand, best: boolean, hanging: boolean, now: number, upb: number,
  verify: boolean, hs0: number, hs1: number, hs2: number, out: PlanInstance[]): void {
  if (!cand.ok || cand.tool === null) return;
  const s = v.p.state;
  const p = m.pool.take(edgeInterp, 'ledgeTrap');
  trapData(cand, now, upb, p.d);
  let mask = cand.mask;
  if (verify && cand.kind !== TK_AIR) {
    if (hanging) {
      for (let o = 0; o < OPT_COUNT; o++) {
        for (let hi = 0; hi < 3; hi++) {
          const bit = ltBit(o, hi);
          if ((mask & bit) === 0) continue;
          const h = hi === 0 ? hs0 : hi === 1 ? hs1 : hs2;
          if (o === O_WAIT) {
            if (!verifyVsOption(s, v.p.meI, v.p.oppI, v.me, p.d, O_WAIT, 0)) mask &= ~optMask(O_WAIT);
            break;
          }
          if (!verifyVsOption(s, v.p.meI, v.p.oppI, v.me, p.d, o, h)) mask &= ~bit;
        }
      }
    } else {
      const w = workState(W_EVAL, s);
      for (let i = 0; i < 4; i++) VER_DRIVERS[i] = null;
      VER_DRIVERS[v.p.meI] = VER_DRV.set(p.d, edgeInterp, v.me, s);
      simulate(w, LT_H, VER_DRIVERS, VER_WATCH);
      if (VER_WATCH.hits[v.p.meI * 4 + v.p.oppI] === 0) mask = 0;
    }
  }
  if (mask === 0) return;
  const tool = cand.tool;
  p.mask = mask;
  p.move = tool.id;
  p.value = trapScore(mask, v.style.lambda);
  let lead = 'all';
  if (!best) {
    let bo = 0;
    let bc = -1;
    for (let o = 0; o < OPT_COUNT; o++) { const cc = popcount(mask & optMask(o)); if (cc > bc) { bc = cc; bo = o; } }
    lead = OPT_NAMES[bo];
  }
  p.name = `${hanging ? 'trap' : 'react'}:${lead}:${tool.id === null ? 'grab' : tool.id}`;
  p.flags = PF_ATTACK | PF_INTR | (tool.kind === TK_SHOT ? PF_PROJ : 0) | (tool.kind === TK_AIR ? PF_TAIL : 0);
  p.minFrames = 1;
  p.horizon = Math.min(LT_H, (p.d.kind === K_TRAPAIR ? cand.F2 : cand.F) + tool.total + 4);
  p.bonus = (hanging ? 2 : 6) + 6 * p.value;
  p.priority = hanging ? (best ? 62 : 58) : 75;
  const c = m.lt;
  c.plans.push(p);
  out.push(p);
}

// ---------------------------------------------------------------------------------------------
// Recovery hypotheses for the target (edgeguard side)
// ---------------------------------------------------------------------------------------------

export const HYP_POLICIES: readonly RecoverPolicy[] = [
  makePolicy('hypMid', 0, 40),
  makePolicy('hypEarly', -1000, 0),
  makePolicy('hypLow', 40, 95),
  makePolicy('hypDodge', -40, 60, DODGE_UP, 120),
];
const HYP_W: readonly number[] = [0.4, 0.2, 0.2, 0.2];
const HYP_TRAJ: Traj[] = [];
for (let i = 0; i < HYP_POLICIES.length; i++) HYP_TRAJ.push(new Traj());
const HYP_DRV = new PolicyDriver();

/** Can the target plausibly get back, and are we free to guard it. Returns the hypothesis count to use. */
function guardable(v: DecisionView, m: EdgeMem): number {
  analyze(v, m);
  if (!m.ok || m.threat) return 0;
  const s = v.p.state;
  const t = s.fighters[v.p.oppI];
  const g = geoOf(s.stageId);
  if (!offstage(t, g)) return 0;
  const cgb = canGetBack(s, v.p.oppI, v.opp, workState(W_EXACT, s));
  if (cgb < -EXACT_BAND) return 0;   // already gone: nothing to add
  return stepAllowance(v) >= 1500 ? HYP_POLICIES.length : 2;
}

function recordHyps(v: DecisionView, nh: number): void {
  const s = v.p.state;
  const code = recoveryCode(v.opp);
  for (let j = 0; j < nh; j++) {
    const tr = HYP_TRAJ[j];
    recordTraj(s, v.p.oppI, v.p.meI, HYP_DRV.set(HYP_POLICIES[j], code), 150, true, tr);
    tr.weight = HYP_W[j];
  }
}

// ---------------------------------------------------------------------------------------------
// Pre-grab hit and projectile wall (02 section 10.3): a hit that resolves before the grab frame N
// ---------------------------------------------------------------------------------------------

const PG_BEST = newCand();
const PG_SHOT = newCand();

function genPreGrab(v: DecisionView, out: PlanInstance[], family: PlanFamilyId): void {
  const m = memFor(v);
  const nh = guardable(v, m);
  if (nh === 0) return;
  const s = v.p.state;
  const me = v.p.meI;
  const f = s.fighters[me];
  const g = geoOf(s.stageId);
  if (!f.onGround || offstage(f, g)) return;
  const c = m.pg;
  const now = s.frame;
  const key = v.p.oppI;
  if (c.key === key && now - c.at < 6) {
    for (let i = 0; i < c.plans.length; i++) if (c.plans[i].family === family) out.push(c.plans[i]);
    return;
  }
  c.key = key; c.at = now; c.plans.length = 0;
  // Teammate on the ledge: the ledge is covered, the stage side is ours. Otherwise both fine.
  recordHyps(v, nh);
  const t = s.fighters[v.p.oppI];
  const side = sideOf(t.x, g);
  const corner = cornerX(side, g);
  const face = side;
  const tools = toolsOf(v.me, s.stageId);
  const upb = recoveryCode(v.me);
  // The grab frame under the likeliest hypothesis, and the spread over all.
  let nBest = -1;
  let wBest = -1;
  for (let j = 0; j < nh; j++) {
    const tr = HYP_TRAJ[j];
    const n = tr.grab >= 0 ? tr.grab : tr.land >= 0 ? tr.land : -1;
    if (n >= 0 && tr.weight > wBest) { wBest = tr.weight; nBest = n; }
  }
  if (nBest < 0) return;
  PG_BEST.ok = false; PG_SHOT.ok = false;
  for (let sp = 0; sp <= 60; sp += 6) {
    const x = corner - face * sp;
    const A = arrival(s, me, v.me, x, face, 60);
    if (A < 0) continue;
    const ax = arrivalX();
    const nTools = tools.ground.length + tools.shots.length;
    for (let ti = 0; ti < nTools; ti++) {
      const shot = ti >= tools.ground.length;
      const tool = shot ? tools.shots[ti - tools.ground.length] : tools.ground[ti];
      for (let F = A; F < nBest; F++) {
        let score = 0;
        let hitBest = -1;
        for (let j = 0; j < nh; j++) {
          const idx = toolHitIdx(tool, f.charId, ax, g.top, face, F, HYP_TRAJ[j]);
          if (idx >= 0) { score += HYP_TRAJ[j].weight; if (HYP_TRAJ[j].weight === wBest) hitBest = idx; }
        }
        if (score <= 0) continue;
        // Place the active span to end at N - 1 under the likeliest hypothesis.
        const last = toolLastIdx(tool, F);
        const off = last - (nBest - 1);
        score += hitBest >= 0 ? 0.05 - 0.002 * (off < 0 ? -off : off) : 0;
        const b = shot ? PG_SHOT : PG_BEST;
        if (!b.ok || score > b.score) {
          b.ok = true; b.tool = tool; b.x = x; b.face = face; b.F = F; b.F2 = 0; b.kind = tool.kind; b.score = score;
          b.mask = 0; b.first = hitBest;
        }
      }
    }
  }
  const verify = stepAllowance(v) >= 1500;
  for (let k = 0; k < 2; k++) {
    const b = k === 0 ? PG_BEST : PG_SHOT;
    if (!b.ok || b.tool === null) continue;
    const fam: PlanFamilyId = k === 0 ? 'preGrabHit' : 'projectileWall';
    const p = m.pool.take(edgeInterp, fam);
    trapData(b, now, upb, p.d);
    let score = b.score;
    if (verify) {
      score = 0;
      const code = recoveryCode(v.opp);
      for (let j = 0; j < nh; j++) {
        const w = workState(W_EVAL, s);
        for (let i = 0; i < 4; i++) VER_DRIVERS[i] = null;
        VER_DRIVERS[me] = VER_DRV.set(p.d, edgeInterp, v.me, s);
        VER_DRIVERS[v.p.oppI] = HYP_DRV.set(HYP_POLICIES[j], code);
        simulate(w, Math.min(150, b.F + b.tool.total + 30), VER_DRIVERS, VER_WATCH);
        if (VER_WATCH.hits[me * 4 + v.p.oppI] > 0) score += HYP_W[j];
      }
    }
    if (score <= 0) continue;
    p.move = b.tool.id;
    p.name = `${k === 0 ? 'preGrab' : 'wall'}:${b.tool.id === null ? 'grab' : b.tool.id}`;
    p.value = score;
    p.flags = PF_ATTACK | PF_INTR | (k === 1 ? PF_PROJ : 0);
    p.minFrames = 1;
    p.horizon = Math.min(120, b.F + b.tool.total + 4);
    p.bonus = 2 + 6 * score;
    p.priority = k === 0 ? 66 : 50;
    c.plans.push(p);
    if (fam === family) out.push(p);
  }
}

// ---------------------------------------------------------------------------------------------
// Offstage plans: hog, aerials, spikes, footstool (02 sections 10.2 to 10.4)
// ---------------------------------------------------------------------------------------------

const EVAL_DRV = new DataDriver();
const EVAL_DRIVERS: (Driver | null)[] = [null, null, null, null];
const EVAL_WATCH = new Watch();
/** Result of evalOffstage. */
const EV = { value: 0, safe: true, koAll: true, anyHit: false, hogFirst: true, koAny: false };

/**
 * Runs plan data `d` against each recovery hypothesis. Value per hypothesis: a KO 10, damage dealt
 * 0.15 per percent, damage taken -0.15, our own KO or a finish we cannot get back from -20.
 */
function evalOffstage(v: DecisionView, d: ScriptData, nh: number, frames: number, hog: boolean): void {
  const s = v.p.state;
  const me = v.p.meI;
  const tgt = v.p.oppI;
  const g = geoOf(s.stageId);
  const code = recoveryCode(v.opp);
  EV.value = 0; EV.safe = true; EV.koAll = true; EV.anyHit = false; EV.hogFirst = true; EV.koAny = false;
  for (let j = 0; j < nh; j++) {
    const w = workState(W_EVAL, s);
    for (let i = 0; i < 4; i++) EVAL_DRIVERS[i] = null;
    EVAL_DRIVERS[me] = EVAL_DRV.set(d, edgeInterp, v.me, s);
    EVAL_DRIVERS[tgt] = HYP_DRV.set(HYP_POLICIES[j], code);
    simulate(w, frames, EVAL_DRIVERS, EVAL_WATCH);
    const W = EVAL_WATCH;
    const tKo = (W.ko & (1 << tgt)) !== 0;
    const meKo = (W.ko & (1 << me)) !== 0;
    const meEnd = w.fighters[me];
    const back = !meKo && quickGetBack(meEnd, v.me, g) >= 0;
    let val = (tKo ? 10 : 0) + 0.15 * W.dmg[tgt] - 0.15 * W.dmg[me];
    if (!back) { val -= 20; EV.safe = false; }
    if (!tKo) EV.koAll = false; else EV.koAny = true;
    if (W.hits[me * 4 + tgt] > 0 || W.stoolAt[me * 4 + tgt] >= 0) EV.anyHit = true;
    if (hog && (W.ledgeAt[me] < 0 || (W.ledgeAt[tgt] >= 0 && W.ledgeAt[tgt] < W.ledgeAt[me]))) { EV.hogFirst = false; val -= 2; }
    EV.value += HYP_W[j] * val;
  }
}

const HOG_VARIANTS: readonly (readonly [number, number])[] = [
  [HOG_STAY, 0], [HOG_CLIMB, 30], [HOG_ROLL, 30], [HOG_JUMP, 30], [HOG_DROP_AERIAL, 14],
];
const HOG_NAMES: readonly string[] = ['stay', 'climb', 'roll', 'dropAerial', 'jump'];

function genHog(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  const nh = guardable(v, m);
  if (nh === 0) return;
  if (m.mate === MATE_LEDGE) return;
  const s = v.p.state;
  const me = v.p.meI;
  const f = s.fighters[me];
  const g = geoOf(s.stageId);
  const t = s.fighters[v.p.oppI];
  if (!f.onGround || offstage(f, g)) return;
  const side = sideOf(t.x, g);
  const ledgeIdx = g.mainIndex * 2 + (side < 0 ? 0 : 1);
  for (let i = 0; i < s.fighters.length; i++) if (s.fighters[i].ledge === ledgeIdx) return;
  const c = m.hog;
  const now = s.frame;
  if (c.key === v.p.oppI && now - c.at < 6) { emitCached(c, out); return; }
  c.key = v.p.oppI; c.at = now; c.plans.length = 0;
  const tools = toolsOf(v.me, s.stageId);
  const spike = tools.spikes.length > 0 ? tools.spikes[0] : null;
  const upb = recoveryCode(v.me);
  let stayOk = false;
  for (let k = 0; k < HOG_VARIANTS.length; k++) {
    const [opt, at] = HOG_VARIANTS[k];
    if (opt === HOG_DROP_AERIAL && spike === null) continue;
    TMP_D.kind = K_HOG; TMP_D.x = cornerX(side, g); TMP_D.face = side; TMP_D.a = at; TMP_D.b = opt; TMP_D.c = 2;
    TMP_D.code = opt === HOG_DROP_AERIAL && spike !== null ? spike.code : 0; TMP_D.upb = upb;
    evalOffstage(v, TMP_D, nh, 120, true);
    if (!EV.hogFirst || !EV.safe) continue;
    // Staying past the invulnerability is only offered when the recoverer never reaches us.
    if (opt === HOG_STAY) { if (!EV.koAll) continue; stayOk = true; }
    if (EV.value <= 0 && !stayOk) continue;
    const p = m.pool.take(edgeInterp, 'hog');
    copyScriptData(TMP_D, p.d);
    p.name = `hog:${HOG_NAMES[opt]}`;
    p.move = opt === HOG_DROP_AERIAL && spike !== null ? spike.id : null;
    p.value = EV.value;
    p.flags = PF_EG | PF_TAIL | (opt === HOG_DROP_AERIAL ? PF_ATTACK | PF_SPIKE : 0);
    p.minFrames = 6;
    p.horizon = 90;
    p.bonus = 2 + 0.5 * EV.value + (EV.koAll ? 6 : 0);
    p.priority = EV.koAll ? 82 : 70;
    c.plans.push(p);
    out.push(p);
  }
}

const OFF_TIMINGS: readonly number[] = [3, 8, 14];

/** Offstage aerials, spikes and the footstool: family picks which of the cached plans to emit. */
function genOffstage(v: DecisionView, out: PlanInstance[], family: PlanFamilyId): void {
  const m = memFor(v);
  const nh0 = guardable(v, m);
  if (nh0 === 0) return;
  // A teammate already off the stage or at the edge guarding: we do not double up offstage.
  if (m.mate !== MATE_NONE) return;
  const s = v.p.state;
  const me = v.p.meI;
  const f = s.fighters[me];
  const g = geoOf(s.stageId);
  const onLedge = f.action === 'ledgeHang';
  if (!onLedge && !(f.onGround && !offstage(f, g))) return;
  if (v.style.edgeguardWillingness <= 0) return;
  const c = m.off;
  const now = s.frame;
  if (c.key === v.p.oppI && now - c.at < 6) {
    for (let i = 0; i < c.plans.length; i++) if (c.plans[i].family === family) out.push(c.plans[i]);
    return;
  }
  c.key = v.p.oppI; c.at = now; c.plans.length = 0;
  // Own safety first: no offstage plan while we could not get back from the corner (bd).
  const budget = stepAllowance(v);
  const nh = budget >= 3000 ? nh0 : Math.min(2, nh0);
  recordHyps(v, nh);
  // Simulated steps so far (the hypotheses) against the allowance; evaluations stop at the cap.
  let spent = nh * 150;
  const t = s.fighters[v.p.oppI];
  const side = sideOf(t.x, g);
  const corner = cornerX(side, g);
  const tools = toolsOf(v.me, s.stageId);
  const upb = recoveryCode(v.me);
  const def = CHARACTER_DEFS[f.charId];
  // Takeoff frame: run to the corner and jump (from the ledge: the drop).
  const T0 = onLedge ? 1 : Math.max(0, arrivalToCorner(v, corner, side)) + def.jumpSquat + 1;
  // Where the likeliest recovery puts the target around our attack.
  const tr = HYP_TRAJ[0];
  const want = family;
  for (let a = 0; a < tools.air.length + 2; a++) {
    const foot = a === tools.air.length;
    const carry = a === tools.air.length + 1;
    let tool: Tool | null = null;
    let tool2: Tool | null = null;
    if (foot) { if (budget < 1500) continue; }
    else if (carry) {
      if (tools.spikes.length === 0) continue;
      for (let q = 0; q < tools.air.length; q++) if (!tools.air[q].spike) { tool = tools.air[q]; break; }
      tool2 = tools.spikes[0];
      if (tool === null) continue;
    } else tool = tools.air[a];
    const isSpike = carry || (tool !== null && tool.spike);
    const fam: PlanFamilyId = foot ? 'footstool' : isSpike ? 'spike' : 'offstageAerial';
    for (let ti = 0; ti < OFF_TIMINGS.length; ti++) {
      if (foot && ti > 0) break;
      const fire = now + T0 + OFF_TIMINGS[ti];
      const probe = Math.min(tr.n - 1, T0 + OFF_TIMINGS[ti] + (tool !== null ? tool.startup : 6));
      const tx = probe >= 0 ? tr.cx[probe] : t.x;
      const d = TMP_D;
      d.kind = K_AERIAL; d.x = corner; d.face = side; d.x2 = foot ? tx : tx - side * 6; d.upb = upb;
      d.code = foot ? 0 : tool !== null ? tool.code : 0;
      d.code2 = tool2 !== null ? tool2.code : 0;
      d.fireAt = foot ? now + T0 + 2 : fire;
      d.fireAt2 = tool2 !== null && tool !== null ? fire + tool.total + 1 : 0;
      d.a = foot ? 30 : 0;
      d.b = foot ? 32 : (tool2 !== null ? tool2.total : tool !== null ? tool.total : 30) + 2;
      if (spent + nh * 110 > budget) return;
      spent += nh * 110;
      evalOffstage(v, d, nh, 110, false);
      if (!EV.safe || !EV.anyHit || EV.value <= 0) continue;
      const p = m.pool.take(edgeInterp, fam);
      copyScriptData(d, p.d);
      p.move = tool !== null ? (tool2 !== null ? tool2.id : tool.id) : null;
      p.name = foot ? 'footstool' : carry && tool !== null && tool2 !== null ? `carry:${tool.id}:${tool2.id}`
        : `eg:${tool !== null ? tool.id : ''}:${OFF_TIMINGS[ti]}`;
      p.value = EV.value;
      p.flags = PF_EG | PF_TAIL | (foot ? 0 : PF_ATTACK) | (isSpike ? PF_SPIKE : 0);
      p.minFrames = Math.min(20, T0 + OFF_TIMINGS[ti]);
      p.horizon = 90;
      p.bonus = (1 + 0.5 * EV.value) * v.style.edgeguardWillingness + (isSpike && EV.koAll ? 8 : 0);
      p.priority = isSpike ? (EV.koAll ? 85 : 60) : foot ? 52 : 55;
      c.plans.push(p);
      if (fam === want) out.push(p);
    }
  }
}

const COR_D = newScriptData();
function arrivalToCorner(v: DecisionView, corner: number, side: number): number {
  const s = v.p.state;
  const f = s.fighters[v.p.meI];
  const dist = (corner - f.x) * side;
  const def = CHARACTER_DEFS[f.charId];
  if (dist <= 8) return 0;
  void COR_D;
  // Dash then run: about run speed after the first dash frames.
  return Math.ceil(dist / Math.max(1, def.runSpeed));
}

// ---------------------------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------------------------

function fam(id: PlanFamilyId, situations: PlanFamily['situations'], generate: PlanFamily['generate']): PlanFamily {
  return { id, situations, generate };
}
const SIT_GUARD: PlanFamily['situations'] = ['advantage', 'neutral', 'bothOffstage', 'airborne'];

/**
 * A teammate already guards this recovery (offstage, on the ledge or at the corner): hold the
 * stage side instead of doubling up. The spot is the team block's coverX when the view carries
 * TeamAffordances (affordances.ts), else a spot inset from the corner on the target's side.
 */
function genCover(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  analyze(v, m);
  if (!m.ok || m.threat || m.mate === MATE_NONE) return;
  const s = v.p.state;
  const f = s.fighters[v.p.meI];
  const t = s.fighters[v.p.oppI];
  const g = geoOf(s.stageId);
  if (!f.onGround || offstage(f, g)) return;
  if (!offstage(t, g) && !isLedgeAction(t.action)) return;
  const side = sideOf(t.x, g);
  const team = (v.aff as { team?: { coverX: number } } | undefined)?.team;
  let x = team !== undefined && Number.isFinite(team.coverX) ? team.coverX : cornerX(side, g) - side * 60;
  if (x < g.left + 20) x = g.left + 20;
  if (x > g.right - 20) x = g.right - 20;
  const p = m.pool.take(edgeInterp, 'ledgeTrap');
  p.d.kind = K_TRAP; p.d.x = x; p.d.face = side; p.d.fireAt = s.frame + 1e6; p.d.a = 0;
  p.name = 'cover:stage';
  p.flags = PF_INTR; p.minFrames = 4; p.horizon = 40; p.priority = 64; p.bonus = 3; p.value = 0.3;
  out.push(p);
}

export const EDGE_FAMILIES: readonly PlanFamily[] = [
  fam('ledgeTrap', ['advantage', 'neutral'], (v, out) => { genLedgeTrap(v, out); genCover(v, out); }),
  fam('preGrabHit', SIT_GUARD, (v, out) => genPreGrab(v, out, 'preGrabHit')),
  fam('hog', SIT_GUARD, genHog),
  fam('spike', ['advantage', 'neutral', 'bothOffstage', 'ledge'], (v, out) => genOffstage(v, out, 'spike')),
  fam('offstageAerial', SIT_GUARD, (v, out) => genOffstage(v, out, 'offstageAerial')),
  fam('footstool', SIT_GUARD, (v, out) => genOffstage(v, out, 'footstool')),
  fam('projectileWall', SIT_GUARD, (v, out) => genPreGrab(v, out, 'projectileWall')),
];

// Registration with plans/index.ts (it never imports this module, so there is no cycle).
registerFamilies(EDGE_FAMILIES);
