/**
 * Disadvantage plans (docs/CPU_PLAN.md W2.7; cpu-guide 02 section 11, research 05 sections 2, 4
 * and 5): recovery as a game against every opponent's covers, tech, getup, juggle escape and
 * landing, out of shield ranked by first active frame, survival spacing, and ledge options with the
 * stall kept inside the regrab limit.
 *
 * Nothing here names a move: tools come from the profile's roles, frame data from MoveAiInfo and
 * MoveDef, and every route value comes from running the sim on pooled copies of the perceived
 * state (plans/edge.ts supplies the runner, the recovery policies and the data-script format).
 *
 * Multiple opponents: recovery rollouts put every live opponent on a cover at once (joint covers),
 * so a route one foe cannot reach but another can is scored by the pair; each opponent that lands
 * a hit costs a little more, so between equal routes the one the fewest can cover wins. Nothing
 * here ever targets a teammate: the only fighters driven as covers are foes (isFoe).
 *
 * Timing convention as in edge.ts: `t` counts script frames (advancing outside hitlag only) and
 * `ctx.frame` is the frame of the state the input is computed from.
 */
import type {
  CharacterAiProfile, DecisionView, Intent, PlanCtx, PlanFamily, PlanFamilyId, PlanInstance, SolveRecoveryFn,
} from '../contracts';
import { PF_ATTACK, PF_INTR, PF_MOVE, PF_TAIL } from '../contracts';
import { LEDGE_MAX_REGRABS, SHIELD_MAX, TECH } from '../../core/constants';
import type { FighterState, GameState, MoveDef, MoveId, StageDef } from '../../core/types';
import { CHARACTER_DEFS } from '../../characters/registry';
import { grabKitOf } from '../../characters/common/grabkit';
import { STAGE_DEFS } from '../../stages/registry';
import { isLedgeAction } from '../../sim/ledge';
import type { SimFighter } from '../../sim/state';
import { STREAM, u01 } from '../rng';
import { fictitiousPlay } from '../search/mix';
import { preparePlanCtx } from './script';
import { registerFamilies } from './index';
import { MOVE_SLOT } from '../charprofile/tags';
import {
  BA, BD, BG, BJ, BL, BR, BSH, BU, C_DIRAD, C_LEDGE_JUMP, DODGE_TOWARD, DataDriver, HOG_STAY, HOLD_AWAY,
  HOLD_NEUTRAL, HOLD_TOWARD, K_HOG, K_TRAP, PlanPool, STOP_RECOVER, STOP_SAFE, TK_AIR, W_DEF, Watch, codeOf,
  cornerX, dirBit, edgeInterp, geoOf, groundFree, groundTo, isFoe, isGone, makePolicy, newScriptData, offstage,
  outDist, profileOf, quickGetBack, recoverIntent, recoveryCode, safeDir, sideOf, simulate, tap, toolsOf, workState,
} from './edge';
import type { Driver, Geo, Interp, LocalPlan, ScriptData, Tool } from './edge';

// ---------------------------------------------------------------------------------------------
// Script kinds (edge.ts uses 1 to 4)
// ---------------------------------------------------------------------------------------------

/** Offstage recovery by policy `pol` (edge.ts recoverIntent), up special `upb`. */
export const K_RECOVER = 11;
/** Tech: hold roll direction `face` (0 in place), press Shield when the landing is `a` frames or fewer away. */
export const K_TECH = 12;
/** Downed: at downTimer >= a, option b (GU_*), roll direction `face`. */
export const K_GETUP = 13;
/** Juggle escape and landing: mode b (L_*) from script frame a, drift `face`, move `code`, dodge bits `btn`, platform x, fast fall x2. */
export const K_LAND = 14;
/** Ledge option b (LO_*) at hang frame a (script frame), inward `face`, aerial `code`. */
export const K_LEDGE = 15;
/** Out of shield: mode b (OS_*), move `code`, aerial fire window up to script frame c. */
export const K_OOS = 16;

export const GU_STAND = 0;
export const GU_ATTACK = 1;
export const GU_ROLL = 2;

export const L_DRIFT = 0;
export const L_DJ = 1;
export const L_DODGE = 2;
export const L_AERIAL = 3;
export const L_PLAT = 4;

export const LO_WAIT = 0;
export const LO_CLIMB = 1;
export const LO_ATTACK = 2;
export const LO_ROLL = 3;
export const LO_JUMP = 4;
export const LO_DROPJUMP = 5;
export const LO_STALL = 6;

export const OS_HOLD = 0;
export const OS_DROP = 1;
export const OS_GRAB = 2;
export const OS_USMASH = 3;
export const OS_UPB = 4;
export const OS_JUMP = 5;

const TAIL = makePolicy('tail', 10, 40);
const C_USMASH = codeOf(MOVE_SLOT.upSmash);

/** Frames until a fall from `f` meets a platform top (ballistic, no drift), 99 when none within 40. */
export function landIn(f: FighterState, stage: StageDef, prof: CharacterAiProfile): number {
  let x = f.x;
  let y = f.y;
  let vx = f.vx;
  let vy = f.vy;
  const grav = prof.physics.gravity;
  const maxFall = f.fastFalling ? prof.physics.fastFall : prof.physics.maxFall;
  const ps = stage.platforms;
  for (let k = 1; k <= 40; k++) {
    const py = y;
    vy = vy + grav;
    if (vy > maxFall && f.hitstun <= 0) vy = maxFall;
    x += vx; y += vy;
    vx *= 0.98;
    if (vy <= 0) continue;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (py <= p.y + 0.5 && y >= p.y && x >= p.x && x <= p.x + p.w) return k;
    }
  }
  return 99;
}

export const defInterp: Interp = (d, t, self, ctx, out) => {
  const sf = self as SimFighter;
  switch (d.kind) {
    case K_RECOVER: {
      recoverIntent(d.pol, t, self, geoOf(ctx.stage.id), d.upb, out);
      return;
    }
    case K_TECH: {
      const tumbling = self.action === 'tumble' || (self.action === 'hitstun' && self.hitstun > 0);
      if (!tumbling || self.onGround) return;
      let held = d.face === 0 ? 0 : dirBit(d.face);
      if (sf.techLockout === 0 && sf.techWindow === 0 && landIn(self, ctx.stage, ctx.me) <= d.a) held |= tap(BSH, self);
      out.held = held;
      return;
    }
    case K_GETUP: {
      if (self.action !== 'downed' || sf.downTimer < d.a) return;
      const btn = d.b === GU_ATTACK ? BA : d.b === GU_ROLL ? dirBit(d.face) : BJ;
      out.held = tap(btn, self);
      return;
    }
    case K_LAND: {
      if (self.onGround || isLedgeAction(self.action) || isGone(self)) return;
      const g = geoOf(ctx.stage.id);
      let held = 0;
      if (d.b === L_PLAT) { const dx = d.x - self.x; held = dx > 4 ? BR : dx < -4 ? BL : 0; }
      else if (d.face !== 0) held = dirBit(d.face);
      if (self.hitstun > 0 || self.action === 'hitstun') { out.held = held; return; }
      if (self.action === 'tumble') {
        // Any fresh press but a tech button ends tumble; Grab does nothing else in the air.
        out.held = held | tap(BG, self);
        return;
      }
      if (self.action !== 'air') { out.held = held; return; }
      if (t >= d.a) {
        if (d.b === L_DJ && self.jumpsLeft > 0 && self.jumpsLeft === d.c) held |= tap(BJ, self);
        else if (d.b === L_DODGE && !sf.airDodgeUsed) {
          out.direct = C_DIRAD;
          out.held = (held & ~(BL | BR)) | d.btn;
          return;
        } else if (d.b === L_AERIAL && d.code !== 0 && t <= d.a + 6) out.direct = d.code;
      }
      if (d.x2 === 1 && self.vy > 0 && !self.fastFalling) held |= tap(BD, self);
      if (offstage(self, g) && (d.b !== L_DJ || t > d.a + 10) && self.y > g.top - 10) {
        recoverIntent(TAIL, t, self, g, d.upb, out);
        return;
      }
      out.held = held;
      return;
    }
    case K_LEDGE: {
      const g = geoOf(ctx.stage.id);
      if (self.action === 'ledgeHang') {
        if (t < d.a) return;
        switch (d.b) {
          case LO_CLIMB: out.held = tap(BJ, self); break;
          case LO_ATTACK: out.held = tap(BA, self); break;
          case LO_ROLL: out.held = tap(BSH, self); break;
          case LO_JUMP: out.direct = C_LEDGE_JUMP; break;
          case LO_DROPJUMP: case LO_STALL: out.held = BD; break;
          default: break;
        }
        return;
      }
      if (isLedgeAction(self.action) || self.onGround || isGone(self)) return;
      if (d.b === LO_STALL) {
        // Neutral stick regrabs the ledge once the drop cooldown runs out; fall back to a recovery when missed.
        if (self.y > g.top + 70 || sf.ledgeRegrabs >= LEDGE_MAX_REGRABS + 2) recoverIntent(TAIL, t, self, g, d.upb, out);
        return;
      }
      let held = dirBit(d.face);
      if (d.b === LO_DROPJUMP && self.action === 'air') {
        if (!self.airJumped && self.jumpsLeft > 0 && sf.ledgeCooldown <= 12 - d.c) held |= tap(BJ, self);
        else if (self.airJumped && d.code !== 0 && self.actionFrame >= 3 && self.actionFrame <= 6) out.direct = d.code;
      }
      if (self.action === 'air' && offstage(self, g) && self.vy > 0 && (d.b !== LO_DROPJUMP || self.airJumped || self.jumpsLeft === 0)) {
        recoverIntent(TAIL, t, self, g, d.upb, out);
        return;
      }
      out.held = held;
      return;
    }
    case K_OOS: {
      if (self.action === 'shield' || self.action === 'shieldStun') {
        if (d.b === OS_DROP) return;
        let held = BSH;
        const ready = self.action === 'shield' || sf.stateTimer <= 1;
        if (ready) {
          if (d.b === OS_GRAB) held |= tap(BA, self);
          else if (d.b === OS_USMASH) out.direct = d.code;
          else if (d.b === OS_UPB) { held |= BU; out.direct = d.code; }
          else if (d.b === OS_JUMP) held |= tap(BJ, self);
        }
        out.held = held;
        return;
      }
      if (d.b === OS_JUMP && self.action === 'air' && t <= d.c && d.code !== 0) out.direct = d.code;
      return;
    }
    default:
      edgeInterp(d, t, self, ctx, out);
  }
};

// ---------------------------------------------------------------------------------------------
// Per-slot memory
// ---------------------------------------------------------------------------------------------

class Cache { key = -1; at = -1e9; readonly plans: LocalPlan[] = []; }
class DefMem {
  config: unknown = null;
  lastFrame = -1;
  readonly pool = new PlanPool();
  readonly rec = new Cache();
  readonly ledge = new Cache();
  readonly tech = new Cache();
  readonly getup = new Cache();
  readonly land = new Cache();
  readonly oos = new Cache();
  readonly surv = new Cache();
  stock = -1;
  curRoute = '';
  prevRoute = '';
}
const MEMS: DefMem[] = [];
function memFor(v: DecisionView): DefMem {
  let m = MEMS[v.slot];
  if (m === undefined) { m = new DefMem(); MEMS[v.slot] = m; }
  const s = v.p.state;
  if (m.config !== s.config || s.frame < m.lastFrame) {
    m.config = s.config;
    m.rec.key = -1; m.ledge.key = -1; m.tech.key = -1; m.getup.key = -1; m.land.key = -1; m.oos.key = -1;
    m.surv.key = -1; m.stock = -1; m.curRoute = ''; m.prevRoute = '';
  }
  m.lastFrame = s.frame;
  const st = s.fighters[v.p.meI].stocks;
  if (st !== m.stock) {
    if (m.stock >= 0 && m.curRoute !== '') m.prevRoute = m.curRoute;
    m.stock = st;
    m.curRoute = '';
  }
  return m;
}

/** Cached plans for key `key` refreshed within `life` frames: re-emitted, true. */
function fromCache(c: Cache, key: number, now: number, life: number, out: PlanInstance[]): boolean {
  if (c.key === key && now - c.at < life && now >= c.at) {
    for (let i = 0; i < c.plans.length; i++) out.push(c.plans[i]);
    return true;
  }
  c.key = key; c.at = now; c.plans.length = 0;
  return false;
}

function stepAllowance(v: DecisionView): number {
  if (v.level.stepBudget <= 0) return 0;
  const k = v.genScale !== undefined && v.genScale > 0 && v.genScale < 1 ? v.genScale : 1;
  return Math.floor(v.level.stepBudget * 4 * k);
}

function emit(c: Cache, p: LocalPlan, out: PlanInstance[]): void {
  c.plans.push(p);
  out.push(p);
}

// ---------------------------------------------------------------------------------------------
// Recovery routes (02 section 11.3)
// ---------------------------------------------------------------------------------------------

/**
 * Route bases: [name, jumpDepth, upbDepth, dodge, dodgeDx, upbFirst]. Depths are feet px below the
 * stage top (edge.ts RecoverPolicy). dropRegrab lives in the ledge options.
 */
const ROUTE_BASES: readonly (readonly [string, number, number, number, number, boolean])[] = [
  ['highEarly', -1000, 0, 0, 0, false],
  ['highLate', 0, 40, 0, 0, false],
  ['lowSnap', 40, 100, 0, 0, false],
  ['airDodgeSnap', -40, 60, DODGE_TOWARD, 130, false],
  ['jumpThenUpB', 20, 60, 0, 0, false],
  ['upBThenJump', -1000, 40, 0, 0, true],
  ['landOnStage', -1000, -30, 0, 0, false],
];
const DELAYS: readonly number[] = [0, 6, 12, 18];
const HOLDS: readonly number[] = [HOLD_TOWARD, HOLD_NEUTRAL, HOLD_AWAY];
const HOLD_NAMES: readonly string[] = ['toward', 'neutral', 'away'];

const SELF_DRV = new DataDriver();
const SELF_D = newScriptData();
const SELF_WATCH = new Watch();
const SELF_DRIVERS: (Driver | null)[] = [null, null, null, null];

function routeData(d: ScriptData, b: number, delay: number, hold: number, upb: number): void {
  const r = ROUTE_BASES[b];
  d.kind = K_RECOVER; d.upb = upb;
  const p = d.pol;
  p.name = r[0]; p.jumpDepth = r[1]; p.upbDepth = r[2]; p.dodge = r[3]; p.dodgeDx = r[4]; p.upbFirst = r[5];
  p.delay = delay; p.hold = hold; p.holdFrames = hold === HOLD_TOWARD ? 0 : Math.max(6, delay);
}

/** Self-only rollout of route data (other fighters idle): the arrival frame, or -1 when it dies or fails. */
function selfRoute(v: DecisionView, d: ScriptData, upb: number): number {
  const s = v.p.state;
  const me = v.p.meI;
  const w = workState(W_DEF, s);
  for (let i = 0; i < 4; i++) SELF_DRIVERS[i] = null;
  SELF_DRIVERS[me] = SELF_DRV.set(d, defInterp, v.me, s);
  simulate(w, 200, SELF_DRIVERS, SELF_WATCH, me, STOP_RECOVER, upb);
  const W = SELF_WATCH;
  if ((W.ko & (1 << me)) !== 0 || W.fail) return -1;
  if (W.ledgeAt[me] >= 0) return W.ledgeAt[me];
  if (W.landAt[me] >= 0) return W.landAt[me];
  return -1;
}

/** Recovery needed: airborne off the stage (or tumbling there), not on a ledge. */
function needsRecovery(f: FighterState, g: Geo): boolean {
  if (f.onGround || isLedgeAction(f.action) || isGone(f) || f.action === 'grabbed') return false;
  return offstage(f, g) && (outDist(f.x, g) > 0 || f.y > g.top + 8);
}

const ARRIVALS = new Int32Array(128);

function genRecovery(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  const s = v.p.state;
  const me = v.p.meI;
  const f = s.fighters[me];
  const g = geoOf(s.stageId);
  if (!needsRecovery(f, g)) return;
  const now = s.frame;
  if (fromCache(m.rec, me, now, 8, out)) return;
  const upb = recoveryCode(v.me);
  const budget = stepAllowance(v);
  const maxRoutes = budget >= 1500 ? 16 : budget > 0 ? 6 : 2;
  const c = m.rec;

  if (f.action === 'airHelpless') {
    const p = m.pool.take(defInterp, 'recovery');
    routeData(p.d, 0, 0, HOLD_TOWARD, upb);
    p.name = 'rec:helpless'; p.flags = PF_INTR; p.minFrames = 1; p.horizon = 120; p.priority = 90; p.bonus = 4;
    emit(c, p, out);
    return;
  }

  // 1. Which bases get back at all (delay 0, toward), others idle.
  let steps = 0;
  let viableMask = 0;
  for (let b = 0; b < ROUTE_BASES.length; b++) {
    routeData(SELF_D, b, 0, HOLD_TOWARD, upb);
    const a = selfRoute(v, SELF_D, upb);
    steps += a >= 0 ? a : 120;
    if (a >= 0) viableMask |= 1 << b;
  }
  const routes = ROUTE_LIST;
  routes.length = 0;
  if (viableMask === 0) {
    // Nothing gets back alone: offer the bases anyway, the solver picks the least bad.
    for (let b = 0; b < ROUTE_BASES.length && routes.length < maxRoutes; b++) {
      const p = m.pool.take(defInterp, 'recovery');
      routeData(p.d, b, 0, HOLD_TOWARD, upb);
      p.name = `rec:${ROUTE_BASES[b][0]}:d0:toward`;
      routes.push(p);
    }
  } else {
    // 2. Variants of the viable bases: delay x hold, each checked alone; duplicates dropped.
    let nArr = 0;
    for (let di = 0; di < DELAYS.length; di++) {
      for (let hi = 0; hi < HOLDS.length; hi++) {
        for (let b = 0; b < ROUTE_BASES.length; b++) {
          if ((viableMask & (1 << b)) === 0 || routes.length >= maxRoutes) continue;
          if (di > 0 || hi > 0) {
            if (budget <= 0 || steps > budget * 0.4) continue;
          }
          routeData(SELF_D, b, DELAYS[di], HOLDS[hi], upb);
          const a = (di === 0 && hi === 0) ? -2 : selfRoute(v, SELF_D, upb);
          if (a === -1) { steps += 120; continue; }
          steps += a >= 0 ? a : 0;
          if (a >= 0) {
            let dup = false;
            for (let q = 0; q < nArr; q++) if (ARRIVALS[q] === a * 16 + b) dup = true;
            if (dup) continue;
            if (nArr < ARRIVALS.length) ARRIVALS[nArr++] = a * 16 + b;
          }
          const p = m.pool.take(defInterp, 'recovery');
          routeData(p.d, b, DELAYS[di], HOLDS[hi], upb);
          p.name = `rec:${ROUTE_BASES[b][0]}:d${DELAYS[di]}:${HOLD_NAMES[hi]}`;
          routes.push(p);
        }
      }
    }
  }
  for (let i = 0; i < routes.length; i++) {
    const p = routes[i];
    p.flags = PF_INTR | PF_MOVE;
    p.minFrames = Math.min(24, p.d.pol.delay + 4);
    p.horizon = 150;
    p.priority = 80;
    p.bonus = 2;
  }
  // 3. The game against the covers.
  const mix = routes.length > 1 ? solveRecovery(v, routes, v.seed ^ now) : ONE;
  let pick = 0;
  const u = u01(v.seed, v.slot, now, STREAM.route, 0);
  let acc = 0;
  for (let i = 0; i < routes.length; i++) { acc += mix[i]; if (u < acc) { pick = i; break; } }
  for (let i = 0; i < routes.length; i++) {
    const p = routes[i];
    p.value = mix[i];
    p.bonus = 2 + 8 * mix[i] + (i === pick ? 4 : 0);
    p.priority = i === pick ? 95 : 80 + Math.round(10 * mix[i]);
    emit(c, p, out);
  }
  if (routes.length > 0) m.curRoute = baseName(routes[pick].name);
}
const ROUTE_LIST: LocalPlan[] = [];
const ONE = new Float64Array([1]);

function baseName(name: string): string {
  const a = name.indexOf(':');
  const b = name.indexOf(':', a + 1);
  return a < 0 ? name : name.slice(a + 1, b < 0 ? undefined : b);
}

// ---------------------------------------------------------------------------------------------
// Covers: what an opponent can do about a recovery (driven reactively in rollouts)
// ---------------------------------------------------------------------------------------------

export const CV_IDLE = 0;
export const CV_HOG = 1;
export const CV_STANCE = 2;
export const CV_AERIAL = 3;

/** Ground moves a cover can throw at a recoverer: from the profile's roles, in startup order. */
interface Punisher { code: number; md: MoveDef; startup: number }
const PUNISHERS = new Map<string, Punisher[]>();
function punishersOf(prof: CharacterAiProfile): Punisher[] {
  let list = PUNISHERS.get(prof.charId);
  if (list !== undefined) return list;
  list = [];
  const def = CHARACTER_DEFS[prof.charId];
  const roles = [prof.roles.ledgeTrap, prof.roles.antiAir, prof.roles.kill, prof.roles.techChase, prof.roles.edgeguard];
  const seen = new Set<MoveId>();
  for (let l = 0; l < roles.length; l++) {
    for (let i = 0; i < roles[l].length; i++) {
      const id = roles[l][i];
      if (seen.has(id)) continue;
      seen.add(id);
      const md = def.moves[id];
      const code = codeOf(id);
      if (md === undefined || code === 0 || md.airOnly === true || md.landingLag !== undefined || md.hitboxes.length === 0) continue;
      if (md.velocity !== undefined && md.velocity.length > 0) continue;
      let st = 1e9;
      for (let h = 0; h < md.hitboxes.length; h++) if (md.hitboxes[h].start < st) st = md.hitboxes[h].start;
      list.push({ code, md, startup: st });
    }
  }
  list.sort((a, b) => a.startup - b.startup);
  PUNISHERS.set(prof.charId, list);
  return list;
}

function circleRect(cx: number, cy: number, r: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const nx = cx < x0 ? x0 : cx > x1 ? x1 : cx;
  const ny = cy < y0 ? y0 : cy > y1 ? y1 : cy;
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

/** Would `md`, started now by a fighter at (fx, fy) facing `face`, touch `r` on its predicted path? */
function connects(md: MoveDef, fx: number, fy: number, face: number, r: FighterState): boolean {
  const hang = isLedgeAction(r.action);
  if (hang && md.hitsLedge !== true) return false;
  const hb0 = CHARACTER_DEFS[r.charId].hurtbox;
  const still = r.onGround || hang;
  for (let h = 0; h < md.hitboxes.length; h++) {
    const hb = md.hitboxes[h];
    if (hb.grab !== undefined) continue;
    for (let k = hb.start; k <= hb.end; k++) {
      const rx = still ? r.x : r.x + r.vx * k;
      const ry = still ? r.y : r.y + r.vy * k;
      if (circleRect(fx + hb.x * face, fy + hb.y, hb.r, rx - hb0.w / 2, ry - hb0.h, rx + hb0.w / 2, ry)) return true;
    }
  }
  return false;
}

function bestAir(prof: CharacterAiProfile, stageId: string): Tool | null {
  const ts = toolsOf(prof, stageId);
  let best: Tool | null = null;
  let bs = -1;
  for (let i = 0; i < ts.air.length; i++) {
    const t = ts.air[i];
    if (t.kind !== TK_AIR) continue;
    const sc = t.dmg / (6 + t.startup) + (t.spike ? 0.3 : 0);
    if (sc > bs) { bs = sc; best = t; }
  }
  return best;
}

/** One opponent's cover, reacting to the recoverer with perfect reaction (a conservative model). */
export class CoverDriver implements Driver {
  mode = CV_IDLE;
  tgt = 0;
  side = 1;
  corner = 0;
  ground: Punisher[] = [];
  air: Tool | null = null;
  upb = 0;
  readonly hog = new DataDriver();
  private readonly hd = newScriptData();
  set(mode: number, tgt: number, prof: CharacterAiProfile, s: GameState): this {
    this.mode = mode; this.tgt = tgt;
    const g = geoOf(s.stageId);
    const r = s.fighters[tgt];
    this.side = sideOf(r.x, g);
    this.corner = cornerX(this.side, g);
    this.ground = punishersOf(prof);
    this.air = bestAir(prof, s.stageId);
    this.upb = recoveryCode(prof);
    if (mode === CV_HOG) {
      const d = this.hd;
      d.kind = K_HOG; d.x = this.corner; d.face = this.side; d.a = 0; d.b = HOG_STAY; d.c = 0; d.code = 0; d.upb = this.upb;
      this.hog.set(d, edgeInterp, prof, s);
    }
    return this;
  }
  step(t: number, f: FighterState, s: GameState, out: Intent): void {
    const r = s.fighters[this.tgt];
    const g = geoOf(s.stageId);
    switch (this.mode) {
      case CV_HOG: this.hog.step(t, f, s, out); return;
      case CV_STANCE: {
        if (!f.onGround) { if (offstage(f, g)) recoverIntent(TAIL, t, f, g, this.upb, out); return; }
        // Under the recoverer when it is over the stage, else at the corner.
        let spot = this.corner - this.side * 16;
        let face = this.side;
        if (outDist(r.x, g) === 0 && r.y < g.top - 4) {
          spot = r.x + r.vx * 10;
          if (spot < g.left + 10) spot = g.left + 10;
          if (spot > g.right - 10) spot = g.right - 10;
          face = r.x >= f.x ? 1 : -1;
        }
        groundTo(f, spot, face, out);
        if (!groundFree(f) || isGone(r) || r.invuln > 0 || r.onGround && r.action === 'idle') return;
        const ps = this.ground;
        for (let i = 0; i < ps.length; i++) {
          if (!connects(ps[i].md, f.x, f.y, f.facing, r)) continue;
          out.held = 0;
          out.direct = ps[i].code;
          return;
        }
        return;
      }
      case CV_AERIAL: {
        const tool = this.air;
        if (f.onGround) {
          const past = (f.x - this.corner) * this.side;
          if (past < -6) { out.held = safeDir(dirBit(this.side), f); return; }
          if (outDist(r.x, g) > 0 && outDist(r.x, g) < 170 && groundFree(f)) out.held = tap(BJ, f) | dirBit(this.side);
          else if (f.action === 'jumpsquat') out.held = BJ | dirBit(this.side);
          return;
        }
        if (f.action === 'air') {
          const dx = r.x - f.x;
          const dy = r.y - f.y;
          out.held = dx > 4 ? BR : dx < -4 ? BL : 0;
          if (tool !== null && t < 70 && dx < 36 && dx > -36 && dy < 40 && dy > -40 && r.invuln <= 0) { out.direct = tool.code; return; }
          if (t >= 40 && offstage(f, g)) recoverIntent(TAIL, t, f, g, this.upb, out);
        }
        return;
      }
      default:
        return;
    }
  }
}

const COVERS: CoverDriver[] = [];
for (let i = 0; i < 4; i++) COVERS.push(new CoverDriver());
const COVER_SETS: readonly (readonly number[])[] = [
  [CV_IDLE],
  [CV_IDLE, CV_HOG, CV_STANCE, CV_AERIAL],
  [CV_HOG, CV_STANCE, CV_AERIAL],
  [CV_HOG, CV_STANCE],
];

/** Plan driver for our route inside the solver: the context filled as the brain fills it. */
class RouteDriver implements Driver {
  plan: PlanInstance | null = null;
  readonly ctx: PlanCtx = { dir: 1, home: 1, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0,
    me: null as unknown as CharacterAiProfile, stage: null as unknown as StageDef };
  set(plan: PlanInstance, v: DecisionView): this {
    this.plan = plan;
    preparePlanCtx(plan, v, v.p.state.frame, this.ctx);
    return this;
  }
  step(t: number, f: FighterState, s: GameState, out: Intent): void {
    if (this.plan === null) return;
    this.ctx.frame = s.frame;
    if (t < this.plan.horizon) this.plan.script(t, f, this.ctx, out);
    else recoverIntent(TAIL, t, f, geoOf(s.stageId), recoveryCode(this.ctx.me), out);
  }
}
const ROUTE_DRV = new RouteDriver();
const SOLVE_DRIVERS: (Driver | null)[] = [null, null, null, null];
const SOLVE_WATCH = new Watch();
const TAIL_WATCH = new Watch();
/** Frames the covers keep playing after a landing on the stage. */
const LAND_TAIL = 24;
const FOES = new Int32Array(4);
const CHOICE = new Int32Array(4);
let payoff = new Float64Array(64);
const MIX_BY_N = new Map<number, Float64Array>();

/** Damage (percent) that zeroes a route's value when it still gets back. */
const DMG_CAP = 40;
const SOLVE_FRAMES = 150;

/** Payoff matrix of the last solve (rows x cols), for tests and debugging. */
export const lastSolve = { rows: 0, cols: 0, foes: 0, M: payoff };

/**
 * The mix over `routes` (our recovery plans from the current state): a payoff matrix of
 * 150-frame rollouts, one row per route and one column per joint cover (every live foe on one of
 * its covers at once), A = survived ? 1 - damageTaken / 40 : 0 (a landing on the stage keeps the
 * covers playing 24 more frames), less 0.02 for each foe that landed a hit; then 200 seeded iterations of fictitious play. Ties with the previous stock's route
 * are broken against it. Deterministic in (state, routes, seed).
 */
export const solveRecovery: SolveRecoveryFn = (v, routes, seed) => {
  const n = routes.length;
  let mix = MIX_BY_N.get(n);
  if (mix === undefined) { mix = new Float64Array(n); MIX_BY_N.set(n, mix); }
  if (n === 0) return mix;
  const s = v.p.state;
  const me = v.p.meI;
  let nf = 0;
  for (let i = 0; i < s.fighters.length && nf < 4; i++) if (isFoe(s, me, i)) FOES[nf++] = i;
  let set = COVER_SETS[Math.min(3, nf)];
  let cols = 1;
  for (let k = 0; k < nf; k++) cols *= set.length;
  // Budget: rollouts cost up to 150 frames each; shrink the cover sets first, then the rows.
  const budget = Math.max(stepAllowance(v), 600);
  const maxRoll = Math.max(n, Math.floor(budget * 1.5 / 100));
  if (n * cols > maxRoll && nf === 1) { set = COVER_SETS[2]; cols = set.length; }
  if (n * cols > maxRoll && nf >= 2) { set = COVER_SETS[3]; cols = 1; for (let k = 0; k < nf; k++) cols *= set.length; }
  const rowsEval = Math.max(1, Math.min(n, Math.floor(maxRoll / cols)));
  if (payoff.length < n * cols) payoff = new Float64Array(n * cols * 2);
  const M = payoff;
  const m = memFor(v);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < cols; c++) {
      if (r >= rowsEval) { M[r * cols + c] = 0; continue; }
      const w = workState(W_DEF, s);
      for (let i = 0; i < 4; i++) SOLVE_DRIVERS[i] = null;
      SOLVE_DRIVERS[me] = ROUTE_DRV.set(routes[r], v);
      let q = c;
      for (let k = 0; k < nf; k++) {
        CHOICE[k] = set[q % set.length];
        q = Math.floor(q / set.length);
        const fi = FOES[k];
        SOLVE_DRIVERS[fi] = CHOICE[k] === CV_IDLE ? null : COVERS[k].set(CHOICE[k], me, profileOf(v, fi), s);
      }
      simulate(w, SOLVE_FRAMES, SOLVE_DRIVERS, SOLVE_WATCH, me, STOP_SAFE);
      const W = SOLVE_WATCH;
      let dmgTaken = W.dmg[me];
      let ko = (W.ko & (1 << me)) !== 0;
      const ledge = W.ledgeAt[me] >= 0;
      const landed = !ledge && W.landAt[me] >= 0;
      let hitters = 0;
      for (let k = 0; k < nf; k++) if (W.hits[FOES[k] * 4 + me] > 0) hitters |= 1 << k;
      if (landed && !ko) {
        // A landing is only safe if the landing lag is: the covers get LAND_TAIL more frames.
        SOLVE_DRIVERS[me] = null;
        simulate(w, LAND_TAIL, SOLVE_DRIVERS, TAIL_WATCH);
        dmgTaken += TAIL_WATCH.dmg[me];
        if ((TAIL_WATCH.ko & (1 << me)) !== 0) ko = true;
        for (let k = 0; k < nf; k++) if (TAIL_WATCH.hits[FOES[k] * 4 + me] > 0) hitters |= 1 << k;
      }
      let val: number;
      const dmg = Math.min(1, dmgTaken / DMG_CAP);
      if (ko) val = 0;
      else if (ledge || landed) val = 1 - dmg;
      else val = quickGetBack(w.fighters[me], v.me, geoOf(s.stageId)) >= 0 ? 0.5 * (1 - dmg) : 0;
      if (val > 0) {
        for (let k = 0; k < nf; k++) if ((hitters & (1 << k)) !== 0) val -= 0.02;
        if (val < 0) val = 0;
      }
      M[r * cols + c] = val;
    }
    if (m.prevRoute !== '' && baseName(routes[r].name) === m.prevRoute) {
      for (let c = 0; c < cols; c++) M[r * cols + c] -= 1e-4;
    }
  }
  lastSolve.rows = n; lastSolve.cols = cols; lastSolve.foes = nf; lastSolve.M = M;
  fictitiousPlay(M, n, cols, 200, seed | 0, mix);
  return mix;
};

// ---------------------------------------------------------------------------------------------
// Tech (02 section 11.1)
// ---------------------------------------------------------------------------------------------

function genTech(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  const s = v.p.state;
  const f = s.fighters[v.p.meI];
  const tumbling = f.action === 'tumble' || (f.action === 'hitstun' && f.hitstun > 0);
  if (!tumbling || f.onGround) return;
  const now = s.frame;
  if (fromCache(m.tech, v.p.meI, now, 6, out)) return;
  const g = geoOf(s.stageId);
  const tgt = v.p.oppI;
  const tx = isFoe(s, v.p.meI, tgt) ? s.fighters[tgt].x : g.center;
  const away = tx > f.x ? -1 : 1;
  // Arm so the 20-frame window is centred on the predicted landing.
  const arm = Math.floor(TECH.window / 2) - 2;
  const dirs = [0, away, -away];
  const names = ['inPlace', 'rollAway', 'rollIn'];
  for (let i = 0; i < 3; i++) {
    const p = m.pool.take(defInterp, 'tech');
    p.d.kind = K_TECH; p.d.face = dirs[i]; p.d.a = arm;
    p.name = `tech:${names[i]}`;
    p.flags = PF_INTR;
    p.minFrames = 1;
    p.horizon = 60;
    // In place when they are far, away from their reach when close (the search refines this).
    const far = Math.abs(tx - f.x) > 90;
    p.priority = 85 + (far ? (i === 0 ? 3 : 0) : (i === 1 ? 3 : 0));
    p.bonus = 3;
    emit(m.tech, p, out);
  }
}

// ---------------------------------------------------------------------------------------------
// Getup from downed (02 section 11.1): options x a seeded wait n
// ---------------------------------------------------------------------------------------------

function genGetup(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  const s = v.p.state;
  const f = s.fighters[v.p.meI] as SimFighter;
  if (f.action !== 'downed') return;
  const now = s.frame;
  const downAt = now - f.downTimer;
  if (fromCache(m.getup, downAt, now, 1e9, out)) return;
  const g = geoOf(s.stageId);
  const tgt = v.p.oppI;
  const tx = isFoe(s, v.p.meI, tgt) ? s.fighters[tgt].x : g.center;
  const away = tx > f.x ? -1 : 1;
  // The wait is drawn once per knockdown, keyed on the frame it started (a fixed wakeup is a tell).
  const n = Math.floor(u01(v.seed, v.slot, downAt, STREAM.wake, 0) * 24);
  const opts: readonly (readonly [number, number, string])[] = [
    [GU_STAND, 0, 'stand'], [GU_ATTACK, 0, 'attack'], [GU_ROLL, away, 'rollAway'], [GU_ROLL, -away, 'rollIn'],
  ];
  for (let o = 0; o < opts.length; o++) {
    for (let w = 0; w < 2; w++) {
      const p = m.pool.take(defInterp, 'getup');
      p.d.kind = K_GETUP; p.d.b = opts[o][0]; p.d.face = opts[o][1]; p.d.a = w === 0 ? f.downTimer : f.downTimer + n;
      p.name = `getup:${opts[o][2]}:${w === 0 ? 'now' : 'wait'}`;
      p.flags = PF_INTR | (opts[o][0] === GU_ATTACK ? PF_ATTACK : 0);
      p.move = null;
      p.minFrames = 1;
      p.horizon = 40 + (w === 0 ? 0 : n);
      p.priority = 80 + (w === 1 ? 2 : 0);
      p.bonus = 1;
      emit(m.getup, p, out);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Juggle escape and landing (02 section 11.2)
// ---------------------------------------------------------------------------------------------

function landingMove(prof: CharacterAiProfile): MoveId | null {
  const lists = [prof.roles.landing, prof.roles.getOffMe];
  let best: MoveId | null = null;
  let bs = 1e9;
  for (let l = 0; l < lists.length; l++) {
    for (let i = 0; i < lists[l].length; i++) {
      const id = lists[l][i];
      const info = prof.moves[id];
      if (info === undefined || codeOf(id) === 0) continue;
      if (info.startup < bs) { bs = info.startup; best = id; }
    }
  }
  return best;
}

function genLanding(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  const s = v.p.state;
  const me = v.p.meI;
  const f = s.fighters[me] as SimFighter;
  const g = geoOf(s.stageId);
  if (f.onGround || isLedgeAction(f.action) || isGone(f)) return;
  if (f.action !== 'air' && f.action !== 'tumble' && !(f.action === 'hitstun')) return;
  // Only above the stage: offstage is the recovery family's game.
  if (outDist(f.x, g) > 0 || f.y > g.top) return;
  // Someone below or near threatening, or tumbling: otherwise neutral's air families cover it.
  let threatX = NaN;
  let bestD = 1e9;
  for (let i = 0; i < s.fighters.length; i++) {
    if (!isFoe(s, me, i)) continue;
    const o = s.fighters[i];
    const dx = o.x - f.x;
    const dy = o.y - f.y;
    const d = dx * dx + dy * dy;
    if (dy > -20 && d < bestD) { bestD = d; threatX = o.x; }
  }
  if (f.action !== 'tumble' && !(bestD < 160 * 160)) return;
  const now = s.frame;
  if (fromCache(m.land, me, now, 6, out)) return;
  const away = Number.isNaN(threatX) ? 0 : threatX > f.x ? -1 : 1;
  const upb = recoveryCode(v.me);
  const lm = landingMove(v.me);
  const lcode = lm === null ? 0 : codeOf(lm);
  // Nearest soft platform above ground level to drift onto.
  let platX = NaN;
  const ps = STAGE_OF(s).platforms;
  let pd = 1e9;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.solid || p.y >= g.top - 4 || p.y < f.y) continue;
    const cx = p.x + p.w / 2;
    const d = Math.abs(cx - f.x) + (Number.isNaN(threatX) ? 0 : -0.5 * Math.abs(cx - threatX));
    if (d < pd) { pd = d; platX = cx; }
  }
  const add = (name: string, mode: number, a: number, face: number, ff: number, extra: (d: ScriptData) => void,
    pri: number, bonus: number, flags: number): void => {
    const p = m.pool.take(defInterp, 'tumbleExit');
    const d = p.d;
    d.kind = K_LAND; d.b = mode; d.a = a; d.face = face; d.x2 = ff; d.upb = upb; d.c = f.jumpsLeft;
    extra(d);
    p.name = `land:${name}`;
    p.flags = PF_INTR | flags;
    p.minFrames = Math.min(8, a + 2);
    p.horizon = 70;
    p.priority = pri;
    p.bonus = bonus;
    emit(m.land, p, out);
  };
  const none = (): void => { /* no extra fields */ };
  add('driftAway', L_DRIFT, 0, away, 0, none, 74, 1, 0);
  add('driftAwayFF', L_DRIFT, 0, away, 1, none, 76, 1, 0);
  add('driftIn', L_DRIFT, 0, -away, 1, none, 70, 0, 0);
  if (f.jumpsLeft > 0) {
    add('jumpAway', L_DJ, 0, away, 0, none, 72, 1, 0);
    add('jumpAwayLate', L_DJ, 8, away, 0, none, 70, 0.5, 0);
  }
  if (!f.airDodgeUsed) {
    // Scarce: offered, but the search pays for it (a spent dodge is what humans punish).
    add('dodgeAway', L_DODGE, 4, away, 0, (d) => { d.btn = away === 0 ? BD : dirBit(away) | BD; }, 62, -1, 0);
    add('dodgeDown', L_DODGE, 4, 0, 0, (d) => { d.btn = BD; }, 60, -1.5, 0);
  }
  if (lcode !== 0) {
    add('aerialFF', L_AERIAL, 2, away, 1, (d) => { d.code = lcode; }, 70, 0, PF_ATTACK);
    add('aerialLate', L_AERIAL, 10, away, 1, (d) => { d.code = lcode; }, 68, 0, PF_ATTACK);
  }
  if (!Number.isNaN(platX)) add('platform', L_PLAT, 0, 0, 0, (d) => { d.x = platX; }, 66, 0, 0);
  // The plan names the move for staleness only where it attacks.
  for (let i = 0; i < m.land.plans.length; i++) {
    const p = m.land.plans[i];
    if ((p.flags & PF_ATTACK) !== 0) p.move = lm;
  }
}

// ---------------------------------------------------------------------------------------------
// Ledge options and the stall (research 05 section 4; today's ledge rules)
// ---------------------------------------------------------------------------------------------

function genLedgeOption(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  const s = v.p.state;
  const me = v.p.meI;
  const f = s.fighters[me] as SimFighter;
  if (f.action !== 'ledgeHang') return;
  const now = s.frame;
  const grabAt = now - f.actionFrame;
  if (fromCache(m.ledge, grabAt, now, 4, out)) return;
  const inward = f.facing;
  const upb = recoveryCode(v.me);
  const inv = f.invuln;
  const timings = inv > 6 ? [0, inv - 3, inv + 8] : [0, 10];
  const lm = landingMove(v.me);
  const opts: readonly (readonly [number, string, number])[] = [
    [LO_CLIMB, 'climb', 0], [LO_ATTACK, 'attack', PF_ATTACK], [LO_ROLL, 'roll', 0], [LO_JUMP, 'jump', 0],
    [LO_DROPJUMP, 'dropJump', lm === null ? 0 : PF_ATTACK],
  ];
  for (let o = 0; o < opts.length; o++) {
    for (let k = 0; k < timings.length; k++) {
      const p = m.pool.take(defInterp, 'ledgeOption');
      const d = p.d;
      d.kind = K_LEDGE; d.b = opts[o][0]; d.a = timings[k]; d.face = inward; d.upb = upb; d.c = 2;
      d.code = opts[o][0] === LO_DROPJUMP && lm !== null ? codeOf(lm) : 0;
      p.name = `ledge:${opts[o][1]}:${k === 0 ? 'now' : k === 1 ? 'invEnd' : 'late'}`;
      p.flags = PF_INTR | opts[o][2] | (opts[o][0] === LO_DROPJUMP ? PF_TAIL : 0);
      p.move = (opts[o][2] & PF_ATTACK) !== 0 ? (opts[o][0] === LO_ATTACK ? MOVE_SLOT.ledgeAttack : lm) : null;
      p.minFrames = Math.min(20, timings[k] + 1);
      p.horizon = timings[k] + 50;
      p.priority = 78 - k;
      p.bonus = k === 1 ? 1 : 0;
      emit(m.ledge, p, out);
    }
  }
  // Wait on the ledge (a hang never times out): a short hold that lets the trapper commit first.
  {
    const p = m.pool.take(defInterp, 'ledgeOption');
    p.d.kind = K_LEDGE; p.d.b = LO_WAIT; p.d.a = 0; p.d.face = inward;
    p.name = 'ledge:wait'; p.flags = PF_INTR; p.minFrames = 1; p.horizon = 12; p.priority = 70; p.bonus = 0;
    emit(m.ledge, p, out);
  }
  // Stall: drop and regrab, only while the next grab still refreshes the invulnerability.
  if (f.ledgeRegrabs < LEDGE_MAX_REGRABS) {
    const p = m.pool.take(defInterp, 'ledgeOption');
    p.d.kind = K_LEDGE; p.d.b = LO_STALL; p.d.a = Math.max(0, inv - 4); p.d.face = inward; p.d.upb = upb;
    p.name = 'ledge:stall'; p.flags = PF_INTR; p.minFrames = 1; p.horizon = p.d.a + 40; p.priority = 72;
    // Worth more when ahead (run the clock) and when the invulnerability is about to run out.
    p.bonus = (v.stocksAhead > 0 ? 2 : 0) + (inv < 8 ? 1 : 0);
    emit(m.ledge, p, out);
  }
}

// ---------------------------------------------------------------------------------------------
// Out of shield (02 section 11.4): ranked by first active frame against the measured advantage
// ---------------------------------------------------------------------------------------------

interface OosOpt { mode: number; code: number; move: MoveId | null; first: number; name: string }
const OOS_OPTS: OosOpt[] = [];
for (let i = 0; i < 8; i++) OOS_OPTS.push({ mode: 0, code: 0, move: null, first: 0, name: '' });

/** Shield HP below which the shield is dropped: god 20 of 60 (02 section 11.4), lower levels less careful. */
function shieldFloor(v: DecisionView): number {
  return v.level.god ? 20 : 8 + 12 * Math.max(0, Math.min(1, v.level.s));
}

function genOos(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  const s = v.p.state;
  const me = v.p.meI;
  const f = s.fighters[me] as SimFighter;
  if (f.action !== 'shield' && f.action !== 'shieldStun') return;
  const now = s.frame;
  if (fromCache(m.oos, me, now, 1, out)) return;
  const c = m.oos;
  // Low shield: drop it before a break (a break is a stock).
  if (f.shieldHp < shieldFloor(v) && f.shieldHp < SHIELD_MAX) {
    const p = m.pool.take(defInterp, 'oos');
    p.d.kind = K_OOS; p.d.b = OS_DROP;
    p.name = 'oos:drop'; p.flags = PF_INTR; p.minFrames = 2; p.horizon = 6; p.priority = 88; p.bonus = 3;
    emit(c, p, out);
  }
  // The attacker: the nearest foe mid-move.
  let atk = -1;
  let bd = 1e9;
  for (let i = 0; i < s.fighters.length; i++) {
    if (!isFoe(s, me, i)) continue;
    const o = s.fighters[i];
    const d = Math.abs(o.x - f.x) + Math.abs(o.y - f.y);
    if (d < bd) { bd = d; atk = i; }
  }
  if (atk < 0) return;
  const a = s.fighters[atk] as SimFighter;
  // Measured advantage: frames the attacker still needs, less our remaining shield stun.
  let remain = 0;
  if (a.action === 'attack' && a.moveId !== null) {
    const md = CHARACTER_DEFS[a.charId].moves[a.moveId];
    if (md !== undefined) remain = md.totalFrames - a.actionFrame;
    if (!a.onGround && md !== undefined && md.landingLag !== undefined) remain = Math.min(remain, 30) + md.landingLag;
  } else if (a.action === 'land') remain = a.stateTimer;
  else if (a.action === 'grab') remain = grabKitOf(CHARACTER_DEFS[a.charId]).stand.totalFrames - a.actionFrame;
  const stun = f.action === 'shieldStun' ? f.stateTimer : 0;
  const adv = remain - stun;
  const dx = a.x - f.x;
  const adx = Math.abs(dx);
  const dy = a.y - f.y;
  const ahw = CHARACTER_DEFS[a.charId].hurtbox.w / 2;
  const front = dx * f.facing >= 0;
  const def = CHARACTER_DEFS[f.charId];
  let n = 0;
  const kit = grabKitOf(def);
  if (front && adx <= kit.stand.x + kit.stand.r + ahw && dy > -30) {
    const o = OOS_OPTS[n++]; o.mode = OS_GRAB; o.code = 0; o.move = null; o.first = kit.stand.start; o.name = 'grab';
  }
  const us = v.me.moves[MOVE_SLOT.upSmash];
  if (us !== undefined && C_USMASH > 0 && adx <= Math.max(us.reach.front, us.reach.back) + ahw && -dy <= us.reach.up + 40) {
    const o = OOS_OPTS[n++]; o.mode = OS_USMASH; o.code = C_USMASH; o.move = MOVE_SLOT.upSmash; o.first = us.startup; o.name = MOVE_SLOT.upSmash;
  }
  const upb = v.me.roles.recovery.length > 0 ? v.me.roles.recovery[0] : null;
  if (upb !== null) {
    const info = v.me.moves[upb];
    if (info !== undefined && adx <= info.reach.front + ahw && -dy <= info.reach.up + 40 && dy <= info.reach.down + 20) {
      const o = OOS_OPTS[n++]; o.mode = OS_UPB; o.code = codeOf(upb); o.move = upb; o.first = info.startup; o.name = 'upb';
    }
  }
  const oosRole = v.me.roles.oos;
  for (let i = 0; i < oosRole.length && n < OOS_OPTS.length; i++) {
    const id = oosRole[i];
    const info = v.me.moves[id];
    const md = def.moves[id];
    if (info === undefined || md === undefined || codeOf(id) === 0) continue;
    if (!(md.airOnly === true || md.landingLag !== undefined)) continue;   // jump + aerial only
    const reach = front ? info.reach.front : info.reach.back;
    if (adx > reach + ahw) continue;
    const o = OOS_OPTS[n++]; o.mode = OS_JUMP; o.code = codeOf(id); o.move = id; o.first = def.jumpSquat + 1 + info.startup;
    o.name = `jump:${id}`;
  }
  // Rank by first active frame; keep the ones that start inside the advantage.
  for (let i = 1; i < n; i++) {
    for (let j = i; j > 0 && OOS_OPTS[j].first < OOS_OPTS[j - 1].first; j--) {
      const t = OOS_OPTS[j]; OOS_OPTS[j] = OOS_OPTS[j - 1]; OOS_OPTS[j - 1] = t;
    }
  }
  let rank = 0;
  for (let i = 0; i < n; i++) {
    const o = OOS_OPTS[i];
    if (o.first > adv) continue;
    const p = m.pool.take(defInterp, 'oos');
    p.d.kind = K_OOS; p.d.b = o.mode; p.d.code = o.code; p.d.c = def.jumpSquat + 8;
    p.name = `oosRanked:${o.name}`;
    p.move = o.move;
    p.flags = PF_ATTACK | PF_INTR;
    p.minFrames = 2;
    p.horizon = o.first + 30;
    p.priority = 86 - rank * 2;
    p.bonus = rank === 0 ? 4 : 2;
    emit(c, p, out);
    rank++;
    if (rank >= 3) break;
  }
  if (rank === 0 && adv <= 0 && a.action === 'attack') {
    // A string is coming (or nothing fits): hold.
    const p = m.pool.take(defInterp, 'oos');
    p.d.kind = K_OOS; p.d.b = OS_HOLD;
    p.name = 'oosRanked:hold'; p.flags = PF_INTR; p.minFrames = 2; p.horizon = 8; p.priority = 76; p.bonus = 1;
    emit(c, p, out);
  }
}

// ---------------------------------------------------------------------------------------------
// Survival (02 section 11.5): off the ledge where their kill moves connect
// ---------------------------------------------------------------------------------------------

function genSurvival(v: DecisionView, out: PlanInstance[]): void {
  const m = memFor(v);
  const s = v.p.state;
  const f = s.fighters[v.p.meI];
  const g = geoOf(s.stageId);
  if (!groundFree(f) || offstage(f, g)) return;
  const danger = v.aff === undefined || v.aff === null ? 0 : v.aff.dangerHere;
  if (!(danger >= 1)) return;
  const side = sideOf(f.x, g);
  const edgeD = Math.abs(cornerX(side, g) - f.x);
  if (edgeD > 80) return;
  const now = s.frame;
  if (fromCache(m.surv, v.p.meI, now, 10, out)) return;
  const p = m.pool.take(defInterp, 'walk');
  p.d.kind = K_TRAP; p.d.x = cornerX(side, g) - side * 110; p.d.face = -side; p.d.fireAt = now + 1e6; p.d.a = 0;
  p.name = 'survive:center'; p.flags = PF_INTR | PF_MOVE; p.minFrames = 4; p.horizon = 40; p.priority = 70;
  p.bonus = 1 + Math.min(3, danger);
  emit(m.surv, p, out);
}

// ---------------------------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------------------------

function STAGE_OF(s: GameState): StageDef { return STAGE_DEFS[s.stageId]; }

function fam(id: PlanFamilyId, situations: PlanFamily['situations'], generate: PlanFamily['generate']): PlanFamily {
  return { id, situations, generate };
}

const SIT_AIR: PlanFamily['situations'] = ['disadvantage', 'bothOffstage', 'airborne', 'advantage', 'neutral', 'tumble'];

/**
 * Registered with plans/index.ts at the end of the module. The survival plan uses the 'walk' id
 * because the contract has no survival family id.
 */
export const DEFENSE_FAMILIES: readonly PlanFamily[] = [
  fam('recovery', SIT_AIR, genRecovery),
  fam('tech', ['tumble', 'disadvantage', 'airborne', 'advantage', 'neutral'], genTech),
  fam('tumbleExit', ['tumble', 'disadvantage', 'airborne', 'advantage', 'neutral'], genLanding),
  fam('getup', ['downed'], genGetup),
  fam('ledgeOption', ['ledge'], genLedgeOption),
  fam('oos', ['oos', 'disadvantage', 'neutral', 'advantage'], genOos),
  fam('walk', ['neutral', 'disadvantage', 'advantage'], genSurvival),
];

// Registration with plans/index.ts (it never imports this module, so there is no cycle).
registerFamilies(DEFENSE_FAMILIES);
