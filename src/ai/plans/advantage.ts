/**
 * Advantage plan families (docs/CPU_PLAN.md W2.5; cpu-guide 02 sections 9.1 to 9.5, 9.7;
 * research/30).
 *
 * - comboFollow: the combo-table routes for the hit that just landed (key read from the live
 *   state), each re-checked from the real state on a pooled copy before it is offered (the
 *   second ply of 9.2) and run link by link with the table's own input scripts. Every hit is a
 *   new decision (per-hit replanning): the plan is interruptible and the family re-reads the
 *   table at the new hit. Follow-ups get the +6 bonus and the top priority band.
 * - killConfirm: table routes that kill, plus a kill move on a vulnerable target whose percent
 *   is inside the move's window at this spot (level percent error applied).
 * - throw and pummel: in a grab, each throw (with its table follow-up), pummels then a throw.
 * - landingTrap: `predictLanding` over five landing policies (none, drift to stage, fast fall,
 *   double jump, air dodge; dodge policies dropped when the dodge is spent), anti-airs timed to
 *   the landing frame at the landing spot.
 * - techChase: covers per observed option timed to its vulnerable window; before the option is
 *   visible, wait-and-react when every option is coverable at the level's reaction time, else
 *   pre-committed covers per option.
 * - shieldPressure: grab, safe-on-shield pokes, shield-break attempts.
 *
 * Multi-opponent rule: the target is `view.p.oppI`. When another live opponent can reach us
 * before a plan's horizon (`thirdPartyThreat`), the plan is not offered (combos are truncated to
 * the links that land before the threat), and `advantageAbort` tells the brain to drop a running
 * advantage plan when a new view shows the threat window reaching us.
 */
import { CHARACTER_DEFS } from '../../characters/registry';
import { TECH, GETUP, GETUP_ROLL, hitlagFrames } from '../../core/constants';
import type { FighterState, GameState, InputFrame, MoveId, ThrowId } from '../../core/types';
import { cloneGameState, stepGame } from '../../sim/index';
import type { SimFighter } from '../../sim/state';
import { copyGameStateInto } from '../aevalmere';
import { getAiProfile } from '../charprofile/derive';
import {
  buildComboTable, comboHitClassOf, comboLinkInput, comboRouteLinks, comboSpotOf, LK_DASHGRAB, LK_GRAB, makeComboKey,
  type ComboLink,
} from '../charprofile/combo';
import type {
  CharacterAiProfile, ComboRoute, ComboTable, DecisionView, Intent, PlanCtx, PlanFamily, PlanInstance, Situation,
  Spot, StarterId,
} from '../contracts';
import { PF_ATTACK, PF_INTR, PF_KILL, PF_TAIL } from '../contracts';
import {
  C_PUMMEL, codeOf, framesToConnect, G, isAirOnly, K_COMMIT, K_HOLD, KeyedPlanPool, L, liveOpponents, MC_AERIAL,
  MC_SMASH, moveClass, nameFor, Plan, PlanPool, press, R, runState, safeDir, SP, stageGeo, stageOfState,
  targetIndex, travelFrames, WK, isAlive, attackMoves, throwList, softPlatformUnder, type StageGeo,
} from './script';

// ---------------------------------------------------------------------------------------------
// Priorities and constants
// ---------------------------------------------------------------------------------------------

const PR_KILL = 90;
const PR_THROW_KILL = 86;
const PR_COMBO = 80;
const PR_THROW = 72;
const PR_TECH = 70;
const PR_LANDING = 65;
const PR_PRESSURE = 60;
const PR_PUMMEL = 58;
/** Follow-ups first with a bonus (02 section 9.2). */
export const FOLLOW_BONUS = 6;
/** Routes per hit that are re-checked from the live state. */
const ROUTES_CHECKED = 3;
/** Frames of slack kept between a plan's last hit and another opponent's arrival. */
const THREAT_SLACK = 4;

const ADV_SITS: readonly Situation[] = ['advantage', 'neutral', 'grabHold', 'airborne', 'disadvantage'];

// ---------------------------------------------------------------------------------------------
// Scratch states (pooled copies; never the real state)
// ---------------------------------------------------------------------------------------------

let scratch: GameState | null = null;
function scratchOf(src: GameState): GameState {
  if (scratch === null || scratch.fighters.length !== src.fighters.length) scratch = cloneGameState(src);
  copyGameStateInto(src, scratch);
  return scratch;
}
const INPUTS: InputFrame[] = [];
function inputsFor(n: number): InputFrame[] {
  while (INPUTS.length < n) INPUTS.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  for (let i = 0; i < n; i++) { const f = INPUTS[i]; f.held = 0; f.pressed = 0; f.released = 0; f.direct = 0; }
  return INPUTS;
}

// ---------------------------------------------------------------------------------------------
// Profiles and tables for other characters
// ---------------------------------------------------------------------------------------------

const PROFILE_CACHE = new Map<string, Map<string, CharacterAiProfile>>();
function profileOf(charId: string, stageId: string): CharacterAiProfile {
  let m = PROFILE_CACHE.get(stageId);
  if (m === undefined) { m = new Map(); PROFILE_CACHE.set(stageId, m); }
  let p = m.get(charId);
  if (p === undefined) { p = getAiProfile(charId, stageId); m.set(charId, p); }
  return p;
}

const TABLES = new WeakMap<CharacterAiProfile, Map<string, ComboTable>>();
/** Combo table of `v.me` on the target's character: the profile's mirror table, else built once. */
export function comboTableFor(v: DecisionView): ComboTable {
  if (v.opp.charId === v.me.charId) return v.me.comboTable;
  let m = TABLES.get(v.me);
  if (m === undefined) { m = new Map(); TABLES.set(v.me, m); }
  let t = m.get(v.opp.charId);
  if (t === undefined) {
    const stage = stageOfState(v.p.state);
    t = buildComboTable(v.me, CHARACTER_DEFS[v.opp.charId], stage, v.mu.brackets);
    m.set(v.opp.charId, t);
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// Third-party threat (multi-opponent)
// ---------------------------------------------------------------------------------------------

const OPP = new Int32Array(8);

/**
 * Frames until a live opponent other than the target could first hit us: travel to its fastest
 * move's reach plus that move's startup, plus any hitstun, hitlag or respawn time it still has.
 * Infinity with no other opponent. Read from the team block of TeamAffordances when present,
 * else computed here from the other fighters' profiles (the contract Affordances only models
 * the target).
 */
export function thirdPartyThreat(v: DecisionView): number {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const ti = v.p.oppI;
  // The affordances' team block (affordances.ts TeamAffordances) has every opponent's threat
  // window, projectiles in flight included; use it when the view carries one.
  const team = (v.aff as { team?: { n: number; opps: readonly { index: number; threatFrames: number }[] } }).team;
  if (team !== undefined && team !== null && Array.isArray(team.opps)) {
    let t = Infinity;
    for (let i = 0; i < team.n; i++) {
      const o = team.opps[i];
      if (o.index !== ti && o.threatFrames < t) t = o.threatFrames;
    }
    return t;
  }
  const k = liveOpponents(s, v.p.meI, OPP);
  let best = Infinity;
  for (let j = 0; j < k; j++) {
    const i = OPP[j];
    if (i === ti) continue;
    const f = s.fighters[i];
    const prof = profileOf(f.charId, s.stageId);
    let fastest = Infinity; let reach = 0;
    const ids = attackMoves(prof);
    for (let q = 0; q < ids.length; q++) {
      const m = prof.moves[ids[q]];
      if (m.tags.indexOf('projectile') >= 0) continue;
      const r = Math.max(m.reach.front, m.reach.back);
      if (m.startup < fastest || (m.startup === fastest && r > reach)) { fastest = m.startup; reach = r; }
    }
    if (fastest === Infinity) fastest = 10;
    const busy = f.hitlag + f.hitstun + (f.action === 'respawn' ? 20 : 0) + (f.action === 'grabbed' ? 20 : 0);
    const gap = Math.max(0, Math.abs(f.x - me.x) - reach - v.me.physics.hurtbox.w / 2);
    const vert = Math.max(0, Math.abs(f.y - me.y) - 40);
    const t = busy + travelFrames(prof, gap) + Math.ceil(vert / Math.max(1, prof.physics.maxFall)) + fastest;
    if (t < best) best = t;
  }
  return best;
}

/**
 * True when a running advantage plan should be dropped: another opponent's threat window now
 * reaches us before the plan's remaining frames. The brain calls it on each new view.
 */
export function advantageAbort(v: DecisionView, plan: PlanInstance, framesLeft: number): boolean {
  if (!(plan instanceof Plan) || !isAdvantagePlan(plan)) return false;
  return thirdPartyThreat(v) < framesLeft + THREAT_SLACK;
}

function isAdvantagePlan(p: Plan): boolean {
  const f = p.family;
  return f === 'comboFollow' || f === 'killConfirm' || f === 'landingTrap' || f === 'techChase' || f === 'shieldPressure'
    || f === 'throw' || f === 'pummel';
}

// ---------------------------------------------------------------------------------------------
// Combo plans
// ---------------------------------------------------------------------------------------------

/** A combo program: an optional lead (a throw code pressed from a hold), then table links. */
interface ComboData { lead: number; leadRelease: number; links: readonly ComboLink[]; js: number }

const LINK_IN: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };

/**
 * Registers: r0 link index (-1 while the lead throw is pending), r1 clock start frame (the frame
 * of the last hit, link step i = frame - r1 + 1), r2 previous hitlag, r3 previous throw frame.
 * A new hit is seen as hitlag rising (melee) or the throw reaching its release frame; the hit
 * advances the link index when it is the current link's move, else (a lingering hit of the
 * previous move) it only restarts the clock, as the table builder does.
 */
function comboFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const d = p.data as ComboData;
  const rs = runState(p, ctx);
  const r = rs.r;
  // r6 marks the registers as set up (r7 is consumed by whichever runState call came first).
  if (r[6] === 0) {
    r[0] = d.lead !== 0 ? -1 : 0; r[1] = ctx.fireAt; r[2] = self.hitlag; r[3] = -1; r[6] = 1;
  }
  const sf = self as SimFighter;
  let onset = false;
  if (self.hitlag > r[2]) onset = true;
  const thr = self.action === 'throw' ? self.actionFrame : -1;
  const rel = sf.activeThrow !== undefined && sf.activeThrow !== null ? sf.activeThrow.releaseFrame : -99;
  if (thr >= 0 && thr === rel && r[3] !== rel) onset = true;
  r[2] = self.hitlag; r[3] = thr;
  let k = r[0];
  if (onset) {
    if (k < 0) k = 0;
    else if (k < d.links.length && linkMatches(d.links[k], self)) k++;
    r[0] = k; r[1] = ctx.frame;
  }
  if (k < 0) {
    if (t === 0 || self.action === 'grabHold') out.direct = d.lead;
    return;
  }
  if (k >= d.links.length) return;
  const link = d.links[k];
  const i = ctx.frame - r[1] + 1;
  const toward = ((ctx.param >> k) & 1) === 1 ? 1 : -1;
  comboLinkInput(link, i - link.start, sf, toward, d.js, LINK_IN);
  out.held = LINK_IN.held | LINK_IN.pressed;
  out.direct = LINK_IN.direct ?? 0;
}

function linkMatches(link: ComboLink, self: FighterState): boolean {
  if (link.kind === LK_GRAB || link.kind === LK_DASHGRAB) return self.action === 'throw';
  return self.action === 'attack' && self.moveId === link.move;
}

interface HitInfo { ok: boolean; starter: StarterId | null; frame: number; damage: number; grounded: boolean;
  dx: number; dy: number; hitClass: 0 | 1 | 2; spot: Spot; pctBefore: number }
const HIT: HitInfo = { ok: false, starter: null, frame: 0, damage: 0, grounded: true, dx: 0, dy: 0, hitClass: 0,
  spot: 'center', pctBefore: 0 };

/** The hit we just landed on the target (from this frame's events, or inferred inside hitlag). */
function lastHit(v: DecisionView, g: StageGeo): HitInfo {
  HIT.ok = false;
  const s = v.p.state;
  const ti = targetIndex(v);
  if (ti < 0) return HIT;
  const me = s.fighters[v.p.meI];
  const tg = s.fighters[ti];
  let dmg = -1;
  for (let i = 0; i < s.events.length; i++) {
    const e = s.events[i];
    if (e.type === 'hit' && e.attacker === me.slot && e.victim === tg.slot) dmg = e.damage;
  }
  let frame = s.frame;
  if (me.action === 'attack' && me.moveId !== null) {
    if (dmg < 0) {
      if (!(me.hitlag > 0 && tg.hitlag > 0 && tg.lastHitBy === me.slot)) return HIT;
      const m = v.me.moves[me.moveId];
      if (m === undefined) return HIT;
      dmg = m.maxDamage;
      frame = s.frame - Math.max(0, hitlagFrames(dmg) - me.hitlag);
    }
    const def = CHARACTER_DEFS[me.charId];
    HIT.starter = me.moveId;
    HIT.hitClass = comboHitClassOf(def.moves[me.moveId], me.actionFrame);
    HIT.dx = (tg.x - me.x) * me.facing;
    HIT.dy = tg.y - me.y;
  } else if (me.action === 'throw') {
    const id = (me as SimFighter).activeThrowId;
    if (dmg < 0 || id === null || id === 'custom') return HIT;
    HIT.starter = id;
    HIT.hitClass = 0; HIT.dx = 0; HIT.dy = 0;
  } else {
    return HIT;
  }
  HIT.ok = true;
  HIT.frame = frame;
  HIT.damage = dmg;
  HIT.pctBefore = Math.max(0, tg.percent - dmg);
  HIT.grounded = Math.abs(tg.y - g.top) < 1.5 || softPlatformUnder(tg, g) >= 0 || tg.onGround;
  HIT.spot = comboSpotOf(tg.x, stageOfState(s));
  return HIT;
}

interface DryRun { hits: number; lastHitAt: number; mask: number; ko: boolean }
const DRY: DryRun = { hits: 0, lastHitAt: 0, mask: 0, ko: false };
const DRY_INTENT: Intent = { held: 0, direct: 0, mash: 0 };
const DRY_CTX_HOLDER: { ctx: PlanCtx | null } = { ctx: null };

/**
 * Runs `plan` from the live state on a pooled copy (target with no input, everyone else idle)
 * and records how many links land, the frame offset of the last one, and the side of the
 * target at each link's first press (the per-link `toward` bits the plan reads from ctx.param).
 */
function dryRun(v: DecisionView, plan: Plan, hitFrame: number, maxFrames: number): DryRun {
  const d = plan.data as ComboData;
  const s = scratchOf(v.p.state);
  const meI = v.p.meI;
  const ti = v.p.oppI;
  const meSlot = s.fighters[meI].slot;
  const tSlot = s.fighters[ti].slot;
  let ctx = DRY_CTX_HOLDER.ctx;
  if (ctx === null) {
    ctx = { dir: 1, home: 1, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0, me: v.me, stage: stageOfState(s) };
    DRY_CTX_HOLDER.ctx = ctx;
  }
  ctx.me = v.me; ctx.stage = stageOfState(s);
  ctx.startFrame = s.frame; ctx.frame = s.frame; ctx.fireAt = hitFrame; ctx.param = 0;
  DRY.hits = 0; DRY.lastHitAt = 0; DRY.mask = 0; DRY.ko = false;
  const inputs = inputsFor(s.fighters.length);
  let prevHeld = s.fighters[meI].inputHeld;
  let t = 0;
  let lastK = -2;
  const rsHolder = runStateProbe(plan, ctx);
  void rsHolder;
  for (let step = 0; step < maxFrames; step++) {
    const me = s.fighters[meI];
    const tg = s.fighters[ti];
    ctx.frame = s.frame;
    // Record the side before the script reads it on the link's first frame.
    const rs = runStateProbe(plan, ctx);
    const kNow = rs.r[6] === 0 ? (d.lead !== 0 ? -1 : 0) : rs.r[0];
    if (kNow !== lastK && kNow >= 0) {
      if (tg.x > me.x + 0.5 || (Math.abs(tg.x - me.x) <= 0.5 && me.facing > 0)) DRY.mask |= 1 << kNow;
      else DRY.mask &= ~(1 << kNow);
      lastK = kNow;
    }
    ctx.param = DRY.mask;
    rewindProbe(rs);
    plan.script(t, me, ctx, DRY_INTENT);
    if (me.hitlag === 0) t++;
    const inp = inputsFor(s.fighters.length);
    const held = DRY_INTENT.held;
    inp[meI].held = held; inp[meI].pressed = held & ~prevHeld; inp[meI].released = prevHeld & ~held;
    inp[meI].direct = DRY_INTENT.direct;
    prevHeld = held;
    stepGame(s, inputs);
    for (let e = 0; e < s.events.length; e++) {
      const ev = s.events[e];
      if (ev.type === 'hit' && ev.attacker === meSlot && ev.victim === tSlot && ev.kb > 0) { DRY.lastHitAt = step + 1; }
      if (ev.type === 'ko' && ev.slot === tSlot) DRY.ko = true;
      if (ev.type === 'hit' && ev.victim === meSlot) return DRY;
    }
    const k = runStateProbe(plan, ctx).r[0];
    DRY.hits = Math.max(DRY.hits, k);
    if (k >= d.links.length || DRY.ko) break;
  }
  return DRY;
}

// The dry run shares runState with the script; these two helpers read the registers without
// resetting them (runState resets only on a plan change, the start frame or a frame going back).
function runStateProbe(plan: Plan, ctx: PlanCtx): { r: Float64Array } {
  return runState(plan, ctx);
}
function rewindProbe(rs: { r: Float64Array }): void { void rs; }

const comboPool = new KeyedPlanPool<ComboRoute>();

function prepCombo(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const g = stageGeo(ctx.stage);
  const h = lastHit(v, g);
  ctx.fireAt = h.ok ? h.frame : v.p.state.frame;
  ctx.param = p.param;
}

function comboFamilyGen(v: DecisionView, out: PlanInstance[], killOnly: boolean): void {
  const ti = targetIndex(v);
  if (ti < 0) return;
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  if (me.action !== 'attack' && me.action !== 'throw') return;
  const g = stageGeo(stageOfState(s));
  const h = lastHit(v, g);
  if (!h.ok || h.starter === null) return;
  const table = comboTableFor(v);
  const key = makeComboKey(table, h.starter, h.pctBefore, h.hitClass, h.dx, h.dy, h.grounded, h.spot);
  // Nearest canonical entry: an exact off-canonical key would build a new entry mid-match (up to
  // 300 ms); the rollouts verify whichever route is taken.
  const routes = table.routesNear !== undefined ? table.routesNear(key) : table.routes(key);
  const depth = v.level.comboDepth;
  if (!(depth >= 1)) return;
  const threat = thirdPartyThreat(v);
  let checked = 0;
  for (let i = 0; i < routes.length && checked < ROUTES_CHECKED; i++) {
    const route = routes[i];
    if (killOnly !== route.kills) continue;
    const links = comboRouteLinks(route);
    if (links === null || links.length === 0) continue;
    checked++;
    const p = comboPool.get(v.slot, route);
    const fam = route.kills ? 'killConfirm' : 'comboFollow';
    if (p.data === null) {
      const use = depth === Infinity || depth >= links.length ? links : links.slice(0, depth);
      p.data = { lead: 0, leadRelease: 0, links: use, js: v.me.physics.jumpSquat } as ComboData;
    }
    const d = p.data as ComboData;
    p.set(fam, p.name || nameFor('combo', route.moves.join('>'), ''), d.links[0].move === null ? null : (typeof d.links[0].move === 'string' && isMove(v.me, d.links[0].move) ? d.links[0].move as MoveId : null),
      d.links[0].start + 2, 120, PF_ATTACK | PF_INTR | (route.kills ? PF_KILL : 0), route.kills ? PR_KILL : PR_COMBO, K_COMMIT);
    p.prog = null; p.fn = comboFn; p.prep = prepCombo; p.target = ti;
    const dry = dryRun(v, p, h.frame, 200);
    if (dry.hits < 1) continue;
    if (dry.lastHitAt + THREAT_SLACK > threat) continue;
    p.param = dry.mask;
    p.horizon = dry.lastHitAt + 8;
    p.bonus = FOLLOW_BONUS + route.damage * 0.1;
    out.push(p);
  }
}

function isMove(p: CharacterAiProfile, id: string): boolean { return p.moves[id as MoveId] !== undefined; }

// ---------------------------------------------------------------------------------------------
// Grab hold: throws and pummels
// ---------------------------------------------------------------------------------------------

const throwPool = new PlanPool();

/** Throw data per slot and throw: a lead-only program, or a lead plus the table follow-up. */
const THROW_DATA = new WeakMap<Plan, ComboData>();

function throwKills(v: DecisionView, id: ThrowId, spot: Spot, pct: number): boolean {
  const th = v.me.grab.throws[id];
  if (th === undefined) return false;
  const kp = th.killPct[spot];
  if (!Number.isFinite(kp)) return false;
  const err = Number.isFinite(v.level.killPctError) ? v.level.killPctError : 0.25;
  return pct >= kp * (1 + err);
}

const THROW_FAMILY: PlanFamily = { id: 'throw', situations: ['grabHold', 'advantage', 'neutral'], generate(v, out) {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  if (me.action !== 'grabHold') return;
  const ti = targetIndex(v);
  if (ti < 0) return;
  const tg = s.fighters[ti];
  const stage = stageOfState(s);
  const spot = comboSpotOf(tg.x, stage);
  const table = comboTableFor(v);
  const ids = throwList(v.me);
  const threat = thirdPartyThreat(v);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const th = v.me.grab.throws[id];
    if (th.release + THREAT_SLACK > threat) continue;
    const kills = throwKills(v, id, spot, tg.percent);
    const p = throwPool.get(v.slot, i);
    let d = THROW_DATA.get(p);
    if (d === undefined) { d = { lead: codeOf(id), leadRelease: th.release, links: [], js: v.me.physics.jumpSquat }; THROW_DATA.set(p, d); }
    // Follow-up from the table for this throw at this percent, if the level combos at all.
    d.links = EMPTY_LINKS;
    let dmg = th.damage;
    if (!kills && v.level.comboDepth >= 1 && v.level.vocabulary.has('comboFollow')) {
      const key = makeComboKey(table, id, tg.percent, 0, 0, 0, true, spot);
      const routes = table.routes(key);
      for (let r = 0; r < routes.length; r++) {
        const links = comboRouteLinks(routes[r]);
        if (links === null || links.length === 0 || routes[r].kills) continue;
        d.links = links.length > v.level.comboDepth ? links.slice(0, v.level.comboDepth) : links;
        dmg += routes[r].damage;
        break;
      }
    }
    p.set('throw', id, null, 2, th.release + 12, PF_ATTACK | (kills ? PF_KILL : 0), kills ? PR_THROW_KILL : PR_THROW, K_COMMIT);
    p.data = d; p.prog = null; p.fn = comboFn; p.prep = prepThrow; p.target = ti;
    p.bonus = (kills ? 20 : 0) + dmg * 0.1;
    if (d.links.length > 0) {
      const dry = dryRun(v, p, s.frame, 160);
      if (dry.hits >= 1) { p.param = dry.mask; p.horizon = dry.lastHitAt + 8; }
      else { d.links = EMPTY_LINKS; }
    }
    out.push(p);
  }
} };
const EMPTY_LINKS: readonly ComboLink[] = [];

function prepThrow(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  ctx.fireAt = v.p.state.frame;
  ctx.param = p.param;
}

/** Pummel ctx.param times, then the throw code in plan.data. */
function pummelFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const rs = runState(p, ctx);
  if (self.action === 'grabHold') {
    if (rs.r[0] < ctx.param) {
      if (rs.r[1] === 0) { out.direct = C_PUMMEL; rs.r[1] = 1; }
    } else {
      out.direct = p.moveCode;
    }
  } else if (self.action === 'pummel' && rs.r[1] === 1) {
    rs.r[0]++; rs.r[1] = 0;
  }
}

const PUMMEL_FAMILY: PlanFamily = { id: 'pummel', situations: ['grabHold', 'advantage', 'neutral'], generate(v, out) {
  const s = v.p.state;
  const me = s.fighters[v.p.meI] as SimFighter;
  if (me.action !== 'grabHold') return;
  const ti = targetIndex(v);
  if (ti < 0) return;
  const tg = s.fighters[ti];
  const spot = comboSpotOf(tg.x, stageOfState(s));
  // Best throw by kill, else by damage.
  const ids = throwList(v.me);
  let best: ThrowId = ids[0];
  for (let i = 0; i < ids.length; i++) {
    const a = v.me.grab.throws[ids[i]];
    const b = v.me.grab.throws[best];
    if (throwKills(v, ids[i], spot, tg.percent + 6) && !throwKills(v, best, spot, tg.percent + 6)) best = ids[i];
    else if (a.damage > b.damage) best = ids[i];
  }
  const timer = typeof me.grabTimer === 'number' ? me.grabTimer : 30;
  for (let k = 1; k <= 3; k++) {
    if (timer < k * 16 + 12) break;
    const p = throwPool.get(v.slot, 10 + k);
    p.set('pummel', nameFor('pummel', '', k === 1 ? '1' : k === 2 ? '2' : '3'), null, 2, k * 18 + 20, PF_ATTACK, PR_PUMMEL, K_COMMIT);
    p.moveCode = codeOf(best); p.prog = null; p.fn = pummelFn; p.prep = null; p.param = k; p.target = ti;
    out.push(p);
  }
} };

// ---------------------------------------------------------------------------------------------
// Landing prediction and landing traps
// ---------------------------------------------------------------------------------------------

export const LP_NONE = 0;
export const LP_DRIFT = 1;
export const LP_FASTFALL = 2;
export const LP_DOUBLEJUMP = 3;
export const LP_AIRDODGE = 4;
export const LANDING_POLICIES = 5;

export interface Landing { policy: number; x: number; t: number; lag: number; weight: number; valid: boolean }
export interface LandingSet { n: number; items: Landing[]; dodgeSpent: boolean }
export function newLandingSet(): LandingSet {
  const items: Landing[] = [];
  for (let i = 0; i < LANDING_POLICIES; i++) items.push({ policy: i, x: 0, t: 0, lag: 0, weight: 0, valid: false });
  return { n: 0, items, dodgeSpent: false };
}

const C_DIRAD_CODE = codeOf('dirAirDodge');
const LAND_CAP = 150;

/**
 * Landing of fighters[victim] under five policies, each by stepping a pooled copy of the live
 * state until the victim stands (02 section 9.4): none, drift toward the stage, fast fall,
 * double jump (at the first actionable frame), air dodge toward the stage (only when the dodge
 * is not spent). Weights are uniform over the valid policies; a policy that never lands in
 * LAND_CAP frames (or dies) is invalid. Returns the count of valid policies.
 */
/**
 * An airborne fighter standing still in the air (no velocity at all while in free fall): it is
 * not falling the way the landing prediction assumes (held in place by something outside the
 * sim's physics, as the harness's pinned opponents are), so a trap timed on its landing would
 * wait for a landing that never comes. A jump apex has vy 0 for at most one frame and rarely
 * together with vx 0.
 */
export function suspendedInAir(v: DecisionView, ti: number): boolean {
  // Read the raw delayed snapshot: the perceived state rolls the target forward under gravity.
  const d = (v.p as { delayed?: GameState | null }).delayed;
  const s = d !== undefined && d !== null && ti < d.fighters.length ? d : v.p.state;
  const f = s.fighters[ti];
  return !f.onGround && f.action === 'air' && f.vy === 0 && f.vx === 0;
}

export function predictLanding(v: DecisionView, victim: number, out: LandingSet): number {
  const s0 = v.p.state;
  const vf = s0.fighters[victim] as SimFighter;
  const g = stageGeo(stageOfState(s0));
  out.dodgeSpent = vf.airDodgeUsed === true;
  let n = 0;
  for (let pol = 0; pol < LANDING_POLICIES; pol++) {
    const it = out.items[pol];
    it.valid = false; it.weight = 0;
    if (pol === LP_AIRDODGE && out.dodgeSpent) continue;
    if (pol === LP_DOUBLEJUMP && vf.jumpsLeft <= 0) continue;
    if (vf.onGround) { if (pol === LP_NONE) { it.valid = true; it.x = vf.x; it.t = 0; it.lag = 0; n++; } continue; }
    const s = scratchOf(s0);
    const f = s.fighters[victim] as SimFighter;
    let used = false;
    let prevHeld = 0;
    for (let t = 1; t <= LAND_CAP; t++) {
      const inp = inputsFor(s.fighters.length);
      const free = f.hitstun === 0 && f.hitlag === 0 && (f.action === 'air' || f.action === 'tumble');
      const home = f.x < g.cx ? R : L;
      let held = 0; let direct = 0;
      if (pol === LP_DRIFT) held = home;
      else if (pol === LP_FASTFALL) { held = free && f.vy > 0 && !f.fastFalling ? Btn_D : 0; }
      else if (pol === LP_DOUBLEJUMP) { held = home; if (free && !used) { held |= Btn_J; used = true; } }
      else if (pol === LP_AIRDODGE) { held = home; if (free && !used) { direct = C_DIRAD_CODE; used = true; } }
      const w = inp[victim];
      w.held = held; w.pressed = held & ~prevHeld; w.released = prevHeld & ~held; w.direct = direct;
      prevHeld = held;
      stepGame(s, inp);
      if (f.action === 'dead' || s.fighters[victim].stocks < vf.stocks) break;
      if (f.onGround) {
        it.valid = true; it.x = f.x; it.t = t;
        it.lag = f.action === 'land' ? f.stateTimer : (f.action === 'downed' || f.action === 'tech' || f.action === 'techRoll') ? 20 : 0;
        n++;
        break;
      }
    }
  }
  for (let pol = 0; pol < LANDING_POLICIES; pol++) if (out.items[pol].valid) out.items[pol].weight = 1 / n;
  out.n = n;
  return n;
}
const Btn_D = 1 << 3;
const Btn_J = 1 << 4;

/**
 * Move to ctx.param, then fire the move on ctx.fireAt (its first active frame meets the timed
 * spot); a late arrival fires on arrival. Faces ctx.dir when firing.
 */
function spotFireFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const rs = runState(p, ctx);
  if (rs.r[0] === 1) return;
  const d = ctx.param - self.x;
  const ad = Math.abs(d);
  const toward = d > 0 ? R : L;
  const arrived = ad <= 5;
  if (!arrived && self.onGround) {
    out.held = ad > 28 ? safeDir(toward, self) : safeDir(toward, self) | WK;
    if (ctx.frame < ctx.fireAt) return;
  }
  if (ctx.frame < ctx.fireAt) {
    // Face the target while waiting.
    if (self.onGround && self.facing !== ctx.dir && p.move !== null && moveClass(p.move) !== MC_SMASH) out.held = (ctx.dir > 0 ? R : L) | WK;
    return;
  }
  if (!self.onGround && !isAirOnly(ctx.me.charId, p.move as MoveId)) return;
  rs.r[0] = 1;
  if (p.moveCode === 0) out.held = press(G, self) | (ctx.dir > 0 ? R : L);
  else { out.direct = p.moveCode; out.held = ctx.dir > 0 ? R : L; }
}

function prepSpotFire(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const g = stageGeo(ctx.stage);
  const aimX = p.param;
  const m = p.move === null ? null : v.me.moves[p.move];
  const vHalf = v.opp.physics.hurtbox.w / 2;
  const side = me.x <= aimX ? -1 : 1;
  const upward = m !== null && m.reach.up > 60 && m.reach.front < 30;
  const spacing = m === null ? v.me.grab.standing.reach + vHalf - 8
    : upward ? 0 : Math.max(0, Math.max(m.reach.front, m.reach.back) + vHalf - 10);
  let x = aimX + side * spacing;
  if (x < g.left + 6) x = g.left + 6;
  if (x > g.right - 6) x = g.right - 6;
  ctx.param = x;
  ctx.dir = aimX >= x ? 1 : -1;
  ctx.fireAt = FIRE_AT.get(p) ?? s.frame;
}
const FIRE_AT = new WeakMap<Plan, number>();

const LANDING_SET = newLandingSet();
const landPool = new PlanPool();

const LANDING_FAMILY: PlanFamily = { id: 'landingTrap', situations: ADV_SITS, generate(v, out) {
  const ti = targetIndex(v);
  if (ti < 0) return;
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const tg = s.fighters[ti];
  if (!me.onGround || me.hitstun > 0 || tg.onGround || tg.action === 'ledgeHang' || tg.action === 'dead') return;
  if (tg.action === 'respawn' || tg.action === 'grabbed' || suspendedInAir(v, ti)) return;
  const g = stageGeo(stageOfState(s));
  if (tg.x < g.left - 20 || tg.x > g.right + 20) return;
  const n = predictLanding(v, ti, LANDING_SET);
  if (n === 0) return;
  const threat = thirdPartyThreat(v);
  const roles = v.me.roles;
  let variant = 0;
  for (let pol = 0; pol < LANDING_POLICIES; pol++) {
    const it = LANDING_SET.items[pol];
    if (!it.valid || it.t > 90) continue;
    if (pol !== LP_NONE && Math.abs(it.x - LANDING_SET.items[LP_NONE].x) < 12 && LANDING_SET.items[LP_NONE].valid) continue;
    for (let r = 0; r < 3; r++) {
      const list = r === 0 ? roles.landing : r === 1 ? roles.juggle : roles.antiAir;
      for (let i = 0; i < list.length; i++) {
        const id = list[i];
        const m = v.me.moves[id];
        if (m === undefined || isAirOnly(v.me.charId, id) || moveClass(id) === MC_AERIAL) continue;
        const travel = travelFrames(v.me, Math.abs(it.x - me.x) - 20);
        const fire = s.frame + it.t - m.startup + Math.min(3, it.lag);
        if (travel + 2 > it.t + it.lag) continue;
        const h = it.t + m.total + 4;
        if (h > threat) continue;
        const p = landPool.get(v.slot, 64 * pol + codeOf(id));
        p.set('landingTrap', nameFor('land', id, POL_NAMES[pol]), id, 1, Math.min(120, h), PF_ATTACK | PF_INTR, PR_LANDING - pol, K_COMMIT);
        p.prog = null; p.fn = spotFireFn; p.prep = prepSpotFire; p.param = it.x; p.target = ti;
        p.bonus = it.weight * 2;
        FIRE_AT.set(p, fire);
        out.push(p);
        variant++;
        if (variant >= 6) return;
      }
    }
  }
  // Grab the landing when the lag is long enough for a dash grab.
  const it = LANDING_SET.items[LP_NONE];
  if (it.valid && it.lag >= 4) {
    const gr = v.me.grab.dash;
    const p = landPool.get(v.slot, 63);
    p.set('landingTrap', 'landGrab', null, 1, Math.min(120, it.t + gr.total + 4), PF_ATTACK | PF_INTR, PR_LANDING, K_COMMIT);
    p.prog = null; p.fn = spotFireFn; p.prep = prepSpotFire; p.param = it.x; p.target = ti;
    FIRE_AT.set(p, s.frame + it.t - gr.active[0] + 1);
    out.push(p);
  }
} };
const POL_NAMES = ['None', 'Drift', 'Ff', 'Jump', 'Dodge'];

// ---------------------------------------------------------------------------------------------
// Tech chase
// ---------------------------------------------------------------------------------------------

/** Options a tumbling victim has on landing: tech in place, tech roll left or right, miss. */
const TO_INPLACE = 0;
const TO_ROLL_L = 1;
const TO_ROLL_R = 2;
const TO_MISS = 3;
const TECH_OPTIONS = 4;
const TO_NAMES = ['InPlace', 'RollL', 'RollR', 'Miss'];

interface Opt { x: number; vs: number; ve: number }
const OPTS: Opt[] = [{ x: 0, vs: 0, ve: 0 }, { x: 0, vs: 0, ve: 0 }, { x: 0, vs: 0, ve: 0 }, { x: 0, vs: 0, ve: 0 }];

/** Reaction frames of this level (the god's perception age, humans their mean reaction). */
function reactionOf(v: DecisionView): number {
  return v.level.god ? v.level.perceptionAge : Math.max(v.level.reactFloor, Math.round(v.level.reactBase));
}

const techPool = new PlanPool();

/** A cover plan: move so the move's active window overlaps [vs, ve] (frames from now) at x. */
function coverPlan(v: DecisionView, out: PlanInstance[], ti: number, variant: number, name: string, id: MoveId,
  x: number, vs: number, ve: number, pri: number, threat: number): boolean {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const m = v.me.moves[id];
  if (m === undefined) return false;
  const travel = travelFrames(v.me, Math.abs(x - me.x) - Math.max(m.reach.front, m.reach.back));
  const first = Math.max(vs, travel + m.startup);
  if (first > ve + (m.activeEnd - m.startup)) return false;
  const h = first + m.total - m.startup + 4;
  if (h > threat) return false;
  const p = techPool.get(v.slot, variant);
  p.set('techChase', name, id, 1, Math.min(120, h), PF_ATTACK | PF_INTR, pri, K_COMMIT);
  p.prog = null; p.fn = spotFireFn; p.prep = prepSpotFire; p.param = x; p.target = ti;
  FIRE_AT.set(p, s.frame + first - m.startup);
  out.push(p);
  return true;
}

const TECH_FAMILY: PlanFamily = { id: 'techChase', situations: ADV_SITS, generate(v, out) {
  const ti = targetIndex(v);
  if (ti < 0) return;
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  if (!me.onGround || me.hitstun > 0) return;
  const tg = s.fighters[ti] as SimFighter;
  const threat = thirdPartyThreat(v);
  const moves = v.me.roles.techChase;
  const R0 = reactionOf(v);
  const a = tg.action;
  // Option already visible: cover it.
  if (a === 'tech' || a === 'techRoll' || a === 'getUp' || a === 'getUpRoll' || a === 'downed') {
    let x = tg.x; let vs = 0; let ve = 0;
    if (a === 'tech') { vs = TECH.inPlace.invEnd + 1 - tg.actionFrame; ve = TECH.inPlace.total - 1 - tg.actionFrame; }
    else if (a === 'techRoll') {
      vs = TECH.roll.invEnd + 1 - tg.actionFrame; ve = TECH.roll.total - 1 - tg.actionFrame;
      x = clampX(tg.x + tg.vx * Math.max(0, TECH.roll.total - tg.actionFrame), s);
    } else if (a === 'getUp') { vs = GETUP.invEnd + 1 - tg.actionFrame; ve = GETUP.total - 1 - tg.actionFrame; }
    else if (a === 'getUpRoll') {
      vs = GETUP_ROLL.invEnd + 1 - tg.actionFrame; ve = GETUP_ROLL.total - 1 - tg.actionFrame;
      x = clampX(tg.x + tg.vx * Math.max(0, GETUP_ROLL.total - tg.actionFrame), s);
    } else { vs = 0; ve = 20; }
    vs = Math.max(vs, 0);
    if (ve < 0) return;
    let k = 0;
    for (let i = 0; i < moves.length && k < 3; i++) {
      if (coverPlan(v, out, ti, 32 + i, nameFor('cover', moves[i], a), moves[i], x, vs, ve, PR_TECH, threat)) k++;
    }
    return;
  }
  // Tumbling toward the floor: options are not visible yet.
  if (a !== 'tumble' || tg.onGround) return;
  const n = predictLanding(v, ti, LANDING_SET);
  const land = LANDING_SET.items[LP_NONE];
  if (n === 0 || !land.valid || land.t > 60) return;
  const L0 = land.t;
  OPTS[TO_INPLACE].x = land.x; OPTS[TO_INPLACE].vs = L0 + TECH.inPlace.invEnd + 1; OPTS[TO_INPLACE].ve = L0 + TECH.inPlace.total - 1;
  OPTS[TO_ROLL_L].x = clampX(land.x - TECH.roll.distance, s); OPTS[TO_ROLL_L].vs = L0 + TECH.roll.invEnd + 1; OPTS[TO_ROLL_L].ve = L0 + TECH.roll.total - 1;
  OPTS[TO_ROLL_R].x = clampX(land.x + TECH.roll.distance, s); OPTS[TO_ROLL_R].vs = OPTS[TO_ROLL_L].vs; OPTS[TO_ROLL_R].ve = OPTS[TO_ROLL_L].ve;
  OPTS[TO_MISS].x = land.x; OPTS[TO_MISS].vs = L0; OPTS[TO_MISS].ve = L0 + 30;
  // Coverable on reaction: from the option's first frame (L0 + R) we still reach its window.
  let all = true;
  for (let o = 0; o < TECH_OPTIONS && all; o++) {
    let ok = false;
    for (let i = 0; i < moves.length && !ok; i++) {
      const m = v.me.moves[moves[i]];
      if (m === undefined) continue;
      const pre = travelFrames(v.me, Math.max(0, Math.abs(OPTS[o].x - land.x) - Math.max(m.reach.front, m.reach.back)));
      if (L0 + R0 + pre + m.startup <= OPTS[o].ve) ok = true;
    }
    all = ok;
  }
  if (all) {
    // Wait and react: stand at the landing spot; the option is covered by the next decision.
    const p = techPool.get(v.slot, 0);
    p.set('techChase', 'techWait', null, 1, Math.min(60, L0 + 2), PF_INTR, PR_TECH + 1, K_HOLD);
    p.prog = null; p.fn = spotFireWaitFn; p.prep = prepAbsX; p.param = land.x; p.target = ti;
    out.push(p);
    return;
  }
  for (let o = 0; o < TECH_OPTIONS; o++) {
    for (let i = 0; i < moves.length; i++) {
      if (coverPlan(v, out, ti, 1 + o * 8 + i, nameFor('pre', moves[i], TO_NAMES[o]), moves[i], OPTS[o].x, OPTS[o].vs, OPTS[o].ve, PR_TECH - 2, threat)) break;
    }
  }
} };

function clampX(x: number, s: GameState): number {
  const g = stageGeo(stageOfState(s));
  return x < g.left ? g.left : x > g.right ? g.right : x;
}

function prepAbsX(p: Plan, v: DecisionView, ctx: PlanCtx): void { ctx.param = p.param; }

/** Walk or dash to ctx.param and stand. */
function spotFireWaitFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const d = ctx.param - self.x;
  const ad = Math.abs(d);
  if (ad <= 5 || !self.onGround) return;
  const toward = d > 0 ? R : L;
  out.held = ad > 28 ? safeDir(toward, self) : safeDir(toward, self) | WK;
}

// ---------------------------------------------------------------------------------------------
// Kill confirms (single moves on a vulnerable target)
// ---------------------------------------------------------------------------------------------

const killPool = new PlanPool();

/** Frames the target stays unable to act (hitstun, landing lag, shield stun, tech or getup). */
function vulnerableFor(tg: FighterState, v: DecisionView): number {
  if (tg.hitlag > 0) return tg.hitlag + tg.hitstun;
  if (tg.hitstun > 1) return tg.hitstun;
  const a = tg.action;
  if (a === 'land' || a === 'shieldStun' || a === 'downed' || a === 'shieldBreak') return Math.max(1, v.aff.oppBusy);
  if (a === 'attack' && tg.moveId !== null) {
    const m = v.opp.moves[tg.moveId];
    if (m !== undefined && tg.actionFrame > m.activeEnd) return m.total - tg.actionFrame;
  }
  return 0;
}

const KILL_FAMILY: PlanFamily = { id: 'killConfirm', situations: ADV_SITS, generate(v, out) {
  comboFamilyGen(v, out, true);
  const ti = targetIndex(v);
  if (ti < 0) return;
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const tg = s.fighters[ti];
  if (!me.onGround || me.hitstun > 0 || me.hitlag > 0 || (me.action !== 'idle' && me.action !== 'walk'
    && me.action !== 'dash' && me.action !== 'run' && me.action !== 'crouch' && me.action !== 'land' && me.action !== 'turn')) return;
  const win = vulnerableFor(tg, v);
  if (win <= 0 || tg.invuln > 0) return;
  const spot = comboSpotOf(tg.x, stageOfState(s));
  const err = Number.isFinite(v.level.killPctError) ? v.level.killPctError : NaN;
  const kills = v.me.roles.kill;
  const vHalf = v.opp.physics.hurtbox.w / 2;
  const threat = thirdPartyThreat(v);
  for (let i = 0; i < kills.length; i++) {
    const id = kills[i];
    const m = v.me.moves[id];
    if (m === undefined) continue;
    let kp = v.aff.killPctHere(id);
    if (!Number.isFinite(kp)) kp = m.killPct[spot];
    if (!Number.isFinite(kp)) continue;
    // Casual tiers (no kill map) throw kill moves whenever one is available: skip the percent test.
    if (Number.isFinite(err) && tg.percent < kp * (1 + err)) continue;
    const f = framesToConnect(v.me, id, Math.abs(tg.x - me.x), tg.y - me.y, vHalf);
    if (!(f <= win)) continue;
    if (f + m.total > threat) continue;
    const p = killPool.get(v.slot, codeOf(id));
    p.set('killConfirm', nameFor('kill', id, ''), id, 2, f + m.total, PF_ATTACK | PF_KILL, PR_KILL, K_COMMIT);
    p.prog = null; p.fn = spotFireFn; p.prep = prepSpotFire; p.param = tg.x; p.target = ti;
    FIRE_AT.set(p, s.frame);
    p.bonus = FOLLOW_BONUS;
    out.push(p);
  }
} };

const COMBO_FAMILY: PlanFamily = { id: 'comboFollow', situations: ADV_SITS, generate(v, out) {
  comboFamilyGen(v, out, false);
} };

// ---------------------------------------------------------------------------------------------
// Shield pressure
// ---------------------------------------------------------------------------------------------

const pressurePool = new PlanPool();

/** Fastest out-of-shield answer of the target (grab active frame or an oos move's startup). */
function fastestOos(v: DecisionView): number {
  let f = v.opp.grab.standing.active[0];
  const oos = v.opp.roles.oos;
  for (let i = 0; i < oos.length; i++) {
    const m = v.opp.moves[oos[i]];
    if (m === undefined) continue;
    const st = m.startup + (isAirOnly(v.opp.charId, oos[i]) ? v.opp.physics.jumpSquat + 1 : 0);
    if (st < f) f = st;
  }
  return f;
}

const PRESSURE_FAMILY: PlanFamily = { id: 'shieldPressure', situations: ADV_SITS, generate(v, out) {
  const ti = targetIndex(v);
  if (ti < 0) return;
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const tg = s.fighters[ti];
  if (tg.action !== 'shield' && tg.action !== 'shieldStun') return;
  if (!me.onGround || me.hitstun > 0 || me.hitlag > 0) return;
  const threat = thirdPartyThreat(v);
  const adx = Math.abs(tg.x - me.x);
  const vHalf = v.opp.physics.hurtbox.w / 2;
  // Grab beats shield.
  const gr = v.me.grab.dash;
  const gh = travelFrames(v.me, adx - gr.reach - vHalf) + gr.total;
  if (gh < threat && adx < 220) {
    const p = pressurePool.get(v.slot, 0);
    p.set('shieldPressure', 'pressureGrab', null, 2, Math.min(90, gh + 4), PF_ATTACK, PR_PRESSURE + 2, K_COMMIT);
    p.prog = null; p.fn = spotFireFn; p.prep = prepSpotFire; p.param = tg.x; p.target = ti;
    FIRE_AT.set(p, s.frame);
    out.push(p);
  }
  // Safe pokes (measured on-shield advantage beats their fastest out-of-shield answer), and
  // shield-break attempts when a move's damage reaches the remaining shield.
  const oos = fastestOos(v);
  const ids = attackMoves(v.me);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const m = v.me.moves[id];
    if (m.tags.indexOf('projectile') >= 0 && !m.chargeable) continue;
    const safe = m.safeShield && -m.advShield < oos;
    const breaks = m.maxDamage * (m.chargeable ? 1.4 : 1) >= tg.shieldHp;
    if (!safe && !breaks) continue;
    const f = framesToConnect(v.me, id, adx, tg.y - me.y, vHalf);
    if (!(f <= 40) || f + m.total > threat) continue;
    const p = pressurePool.get(v.slot, 1 + codeOf(id));
    p.set('shieldPressure', nameFor(breaks ? 'break' : 'pressure', id, ''), id, 2, f + m.total + 4, PF_ATTACK,
      breaks ? PR_PRESSURE + 4 : PR_PRESSURE, K_COMMIT);
    p.prog = null; p.fn = spotFireFn; p.prep = prepSpotFire; p.param = tg.x; p.target = ti;
    FIRE_AT.set(p, s.frame);
    out.push(p);
  }
} };

void SP; void PF_TAIL; void isAlive;

/** Advantage families, in registry order. */
export const ADVANTAGE_FAMILIES: readonly PlanFamily[] = [
  KILL_FAMILY, COMBO_FAMILY, THROW_FAMILY, PUMMEL_FAMILY, TECH_FAMILY, LANDING_FAMILY, PRESSURE_FAMILY,
];
