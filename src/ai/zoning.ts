/**
 * Projectiles and zoning (02 sections 12.1 to 12.4; research 21 procedures): when a shot's tail is
 * safe, how long to charge it, how to answer an incoming shot, and the zone term of the outcome.
 * Everything reads ShotProfile (04 section 2) and the sim's projectile defs; nothing names a move.
 *
 * shootSafe: the research 21 formula (the earliest frame the opponent's fastest punish can land,
 * against our shot's total frames, with a shield-stun credit when the shot meets them first) as a
 * prefilter, confirmed by a forward sim when the level has search steps: a clone with the opponent
 * placed `range` px away runs the attack reply (model/replies.ts) against our shot. `safe` is the
 * sim with the shot removed (it may hit nothing); `safeIfAnswered` also counts the run where the
 * shot stays live (they shield or eat it).
 *
 * chargeDecision: the largest hold whose total still beats the punish, the smallest hold that
 * reaches, clamped by the share of the safe hold the caller wants to use; level-shaped (L1 and L2
 * no shots, L3 tap or full only, L4 and L5 holds in steps of 15, god exact), inside the style's
 * shot band that the tempo pressure pulls in. Returns NO_SHOT (-1) or NO_CHARGE_SHOT (-2).
 *
 * answerProjectile: every enemy shot in flight or about to leave a hand is flown ahead against
 * our hurtbox (strength tiers, returns, bursts); the options (shield, spot dodge, roll, jump over,
 * air dodge, counter-shot with a stronger or equal tier, outrun) are checked for feasibility after
 * the level's reaction, ranked by cost (damage times 1 + the shot's drain heal, shield loss, locked
 * frames, ground given), then verified in order by stepping a clone until one takes no damage.
 * A shot that cannot reach us needs no answer (null).
 *
 * zoneTerm: own shots in flight covering the lane between the fighters, capped, off at high
 * pressure. The engagement clock itself lives in tempo.ts.
 *
 * Determinism: no randomness. The sim checks clone the perceived state (one allocation per check,
 * at decision time, never per frame) and are bounded by the level's step budget.
 */
import type {
  AnswerProjectileFn, ChargeDecisionFn, CharacterAiProfile, DecisionView, Intent, LevelVector, PlanFamilyId,
  ShootSafeFn, ShotProfile,
} from './contracts';
import type { FighterState, GameState, InputFrame, MoveId, ProjectileDef, Rect } from '../core/types';
import { Btn, DIRECT_CODES } from '../core/types';
import { SHIELD_MAX, SPOT_DODGE, ROLL, AIR_DODGE, TUNING } from '../core/constants';
import { CHARACTER_DEFS } from '../characters/registry';
import { STAGE_DEFS } from '../stages/registry';
import { cloneGameState, stepGame } from '../sim';
import { PROJECTILE_DEFS, chargedStat } from '../sim/projectiles';
import { fighterHurtbox, sameTeam, type SimFighter } from '../sim/state';
import { stageGeo, type StageGeo } from './charprofile/probeHit';
import { RK, buildRepliesFor } from './model/replies';
import type { ReplyModel, PlanCtx } from './contracts';

export const NO_SHOT = -1;
export const NO_CHARGE_SHOT = -2;

const L = Btn.Left, R = Btn.Right, J = Btn.Jump, SH = Btn.Shield;
const CODES = DIRECT_CODES as readonly string[];
const C_SPOT = CODES.indexOf('spotDodge') + 1;
const C_ROLLF = CODES.indexOf('rollForward') + 1;
const C_ROLLB = CODES.indexOf('rollBack') + 1;
const C_AIRDODGE = CODES.indexOf('airDodge') + 1;

// ---------------------------------------------------------------------------------------------
// Threat of the opponent's punish
// ---------------------------------------------------------------------------------------------

/** Explicit threat numbers for the analytic formulas (research 21 `o`). */
export interface ThreatParams {
  /** Frames before they start moving (0 = worst case). */
  react: number;
  /** px their best punish reaches, frames until it is active once in range. */
  reach: number; startup: number;
  /** Approach speed px per frame (max of run and walk). */
  speed: number;
  /** Our hurtbox half width. */
  halfWidth: number;
}

/**
 * One way the opponent can hit us: `reach` px from them, first active `startup` frames after the
 * press once in reach. A shot (`speed` > 0) also flies: it spawns `spawn` px ahead and needs
 * (distance - spawn) / speed more frames, so a slow shot is a poor punish of a tail.
 */
interface Punish { reach: number; startup: number; speed: number; spawn: number }
interface ThreatKit { punish: Punish[]; dash: number; dashFrames: number; run: number; walk: number }
const threatCache = new WeakMap<CharacterAiProfile, ThreatKit>();

function threatKit(p: CharacterAiProfile): ThreatKit {
  let k = threatCache.get(p);
  if (k !== undefined) return k;
  k = { punish: [], dash: p.physics.dash, dashFrames: p.physics.dashFrames, run: p.physics.run, walk: p.physics.walk };
  const shotMoves = new Set<string>();
  for (let i = 0; i < p.shots.length; i++) {
    const sh = p.shots[i];
    shotMoves.add(sh.moveId);
    const sp = sh.speed(0);
    if (!(sp > 0) || !(sh.damage(0) > 0)) continue;
    k.punish.push({ reach: sh.range(0), startup: sh.castFrames(0), speed: sp, spawn: spawnOffset(sh, 0) });
  }
  const ids = Object.keys(p.moves) as MoveId[];
  for (let i = 0; i < ids.length; i++) {
    const m = p.moves[ids[i]];
    const code = CODES.indexOf(ids[i]) + 1;
    if (code <= 0 || shotMoves.has(ids[i])) continue;       // a shot's reach is its flight, counted above
    if (m.landingLag > 0 || !(m.maxDamage > 0) || m.total > 60 || m.reach.front <= 0) continue;
    if (m.tags.indexOf('recovery') >= 0) continue;
    k.punish.push({ reach: m.reach.front, startup: m.startup, speed: 0, spawn: 0 });
  }
  k.punish.push({ reach: p.grab.dash.reach, startup: p.grab.dash.active[0], speed: 0, spawn: 0 });
  k.punish.push({ reach: p.grab.standing.reach, startup: p.grab.standing.active[0], speed: 0, spawn: 0 });
  threatCache.set(p, k);
  return k;
}

/** Frames to cover `d` px from a standstill: dash speed for the dash frames, run speed after. */
function approachFrames(d: number, k: ThreatKit): number {
  if (!(d > 0)) return 0;
  const v0 = k.dash > k.walk ? k.dash : k.walk;
  const dashPx = v0 * k.dashFrames;
  if (d <= dashPx) return d / v0;
  const v1 = k.run > k.walk ? k.run : k.walk;
  return k.dashFrames + (d - dashPx) / (v1 > 0 ? v1 : 1);
}

/** Frames from the press (in reach) to the hit landing at `d` px: startup, plus the flight for a shot. */
function hitFrames(p: Punish, d: number): number {
  if (!(p.speed > 0)) return p.startup;
  const at = d < p.reach ? d : p.reach;
  const fly = at - p.spawn;
  return p.startup + (fly > 0 ? fly / p.speed : 0);
}

/** Earliest frame punish `p` lands from `range` px, no reaction. */
function punishTime(p: Punish, range: number, k: ThreatKit): number {
  return approachFrames(range - p.reach, k) + hitFrames(p, range);
}

/** Opponent reaction assumed by our level: 0 (worst case) for god and world's best, up to 12 at casual. */
export function assumedOppReact(level: LevelVector): number {
  if (level.god) return 0;
  const r = Math.round(12 * (1 - level.s));
  return r > 0 ? r : 0;
}

/** Earliest frame the opponent's fastest punish can land from `range` px, profile-based. */
export function punishFrames(opp: CharacterAiProfile, range: number, react: number): number {
  const k = threatKit(opp);
  let best = Infinity;
  for (let i = 0; i < k.punish.length; i++) {
    const t = punishTime(k.punish[i], range, k);
    if (t < best) best = t;
  }
  return react + best;
}

/** Earliest punish frame from explicit numbers (research 21 tHit). */
export function punishFramesAnalytic(range: number, o: ThreatParams): number {
  const gap = range - o.reach > 0 ? range - o.reach : 0;
  return o.react + gap / (o.speed > 0 ? o.speed : 1) + o.startup;
}

// ---------------------------------------------------------------------------------------------
// Shot facts
// ---------------------------------------------------------------------------------------------

function chargeMax(): number { return TUNING.input.chargeMax > 0 ? TUNING.input.chargeMax : 0; }

/** Largest meaningful hold for the shot: chargeMax when the numbers change with h, else 0. */
export function shotMaxHold(shot: ShotProfile): number {
  const m = chargeMax();
  if (m === 0) return 0;
  return shot.totalFrames(m) !== shot.totalFrames(0) || shot.speed(m) !== shot.speed(0)
    || shot.strength(m) !== shot.strength(0) ? m : 0;
}

/** Frames from the press to the end of the move at hold h (the hold is spent rooted). */
export function shotCommit(shot: ShotProfile, h: number): number {
  return (h > 0 ? h : 0) + shot.totalFrames(h);
}

/** px ahead of the thrower the shot spawns at. */
function spawnOffset(shot: ShotProfile, h: number): number {
  const life = shot.lifetime(h);
  const out = shot.returns !== null && shot.returns < life ? shot.returns : life;
  return shot.range(h) - shot.speed(h) * out;
}

/** Drain heal the thrower gets back per percent dealt (0 when the shot does not drain). */
export function shotHealFraction(shot: ShotProfile): number {
  const def = PROJECTILE_DEFS[shot.defId];
  return def !== undefined && def.healFraction !== undefined ? def.healFraction : 0;
}

/** Percent the thrower heals when the shot at hold h lands on the body. */
export function shotHeal(shot: ShotProfile, h: number): number {
  return shot.damage(h) * shotHealFraction(shot);
}

// ---------------------------------------------------------------------------------------------
// shootSafe
// ---------------------------------------------------------------------------------------------

export interface ShootSafeDetail { safe: boolean; safeIfAnswered: boolean; m0: number; m1: number; inRange: boolean }

/** Research 21 shootSafe with explicit threat numbers. */
export function shootSafeAnalytic(shot: ShotProfile, h: number, range: number, o: ThreatParams, margin: number,
  out?: ShootSafeDetail): ShootSafeDetail {
  const r = out ?? { safe: false, safeIfAnswered: false, m0: 0, m1: 0, inRange: false };
  const tHit = punishFramesAnalytic(range, o);
  const sp = shot.speed(h);
  const tShot = (h > 0 ? h : 0) + shot.castFrames(h)
    + (range - spawnOffset(shot, h) - shot.radius(h) - o.halfWidth) / (sp + (o.speed > 0 ? o.speed : 0));
  r.inRange = shot.range(h) >= range - o.halfWidth;
  const credit = r.inRange && tShot < tHit ? shot.frozenOnShield(h) : 0;
  r.m0 = tHit - shotCommit(shot, h);
  r.m1 = r.m0 + credit;
  r.safe = r.m0 >= margin;
  r.safeIfAnswered = r.m1 >= margin;
  return r;
}

/** Threat numbers for the view's opponent at `range` (the punish that is fastest from there). */
export function threatFor(v: DecisionView, range: number, out: ThreatParams): ThreatParams {
  const k = threatKit(v.opp);
  let best = Infinity, bi = 0;
  for (let i = 0; i < k.punish.length; i++) {
    const t = punishTime(k.punish[i], range, k);
    if (t < best) { best = t; bi = i; }
  }
  out.react = assumedOppReact(v.level);
  out.reach = k.punish[bi].reach;
  out.startup = hitFrames(k.punish[bi], range);
  const gap = range - out.reach;
  // Effective speed so the linear formula reproduces the dash-then-run approach time.
  out.speed = gap > 0 ? gap / (best - out.startup) : (k.run > k.walk ? k.run : k.walk);
  out.halfWidth = v.me.physics.hurtbox.w / 2;
  return out;
}

const threatScratch: ThreatParams = { react: 0, reach: 0, startup: 0, speed: 1, halfWidth: 13 };
const safeScratch: ShootSafeDetail = { safe: false, safeIfAnswered: false, m0: 0, m1: 0, inRange: false };

function chargeButtonOf(charId: string, moveId: MoveId): number {
  const def = CHARACTER_DEFS[charId];
  const mv = def === undefined ? undefined : def.moves[moveId];
  return mv !== undefined && mv.chargeButton === 'special' ? Btn.Special : Btn.Attack;
}

function actionableOnGround(f: FighterState): boolean {
  if (!f.onGround || f.hitlag > 0) return false;
  return f.action === 'idle' || f.action === 'walk' || f.action === 'dash' || f.action === 'run'
    || f.action === 'crouch' || f.action === 'turn' || f.action === 'land';
}

/** Scratch inputs for the sim checks (grown on first use). */
const simInputs: InputFrame[] = [];
const simPrev: number[] = [];
function inputsFor(n: number): InputFrame[] {
  while (simInputs.length < n) { simInputs.push({ held: 0, pressed: 0, released: 0, direct: 0 }); simPrev.push(0); }
  for (let i = 0; i < n; i++) { const f = simInputs[i]; f.held = 0; f.pressed = 0; f.released = 0; f.direct = 0; simPrev[i] = 0; }
  return simInputs;
}
function setIntent(i: number, it: Intent): void {
  const f = simInputs[i];
  f.held = it.held;
  f.pressed = it.held & ~simPrev[i];
  f.released = simPrev[i] & ~it.held;
  f.direct = it.direct;
  simPrev[i] = it.held;
}
const zeroIntent: Intent = { held: 0, direct: 0, mash: 0 };

const replyScratch: ReplyModel[] = [];
const ctxScratch: PlanCtx = { dir: 1, home: 0, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0,
  me: null as unknown as CharacterAiProfile, stage: null as unknown as PlanCtx['stage'] };
const oppIntent: Intent = { held: 0, direct: 0, mash: 0 };
const meIntent: Intent = { held: 0, direct: 0, mash: 0 };

/** The attack reply for the view's opponent, built once per check. */
function attackReply(v: DecisionView): ReplyModel | null {
  const n = buildRepliesFor(v, v.p.oppI, replyScratch, false, 12);
  for (let i = 0; i < n; i++) if (replyScratch[i].kind === RK.ATK) return replyScratch[i];
  // A situation whose fixed set has no attack (the opponent is not in neutral): no sim check.
  return null;
}

/**
 * Forward sim of our shot at hold h with the opponent `range` px away running the attack reply
 * after `react` frames. Returns the first frame we are hit (Infinity when not within `window`).
 * `keepShot` false removes our projectiles as they spawn (the shot hits nothing).
 */
function simShot(v: DecisionView, shot: ShotProfile, h: number, range: number, react: number, window: number,
  keepShot: boolean, reply: ReplyModel): number {
  const s = cloneGameState(v.p.state);
  const me = s.fighters[v.p.meI] as SimFighter;
  const op = s.fighters[v.p.oppI] as SimFighter;
  const g = geoOf(s.stageId);
  let dir: 1 | -1 = op.x > me.x ? 1 : op.x < me.x ? -1 : me.facing;
  let ox = me.x + dir * range;
  if (ox < g.left + 4 || ox > g.right - 4) {
    dir = dir === 1 ? -1 : 1;
    ox = me.x + dir * range;
    if (ox < g.left + 4 || ox > g.right - 4) return -1;          // no room on the stage: cannot check
  }
  op.x = ox; op.vx = 0;
  if (op.onGround) op.y = me.y;
  me.facing = dir;
  op.facing = dir === 1 ? -1 : 1;
  const inputs = inputsFor(s.fighters.length);
  const code = CODES.indexOf(shot.moveId) + 1;
  const cb = chargeButtonOf(me.charId, shot.moveId);
  const pct0 = me.percent, st0 = me.stocks;
  ctxScratch.me = v.opp; ctxScratch.stage = STAGE_DEFS[s.stageId];
  for (let t = 0; t < window; t++) {
    meIntent.held = t <= h && h > 0 ? cb : 0;
    meIntent.direct = t === 0 ? code : 0;
    setIntent(v.p.meI, meIntent);
    if (t < react) { oppIntent.held = 0; oppIntent.direct = 0; oppIntent.mash = 0; }
    else { ctxScratch.frame = s.frame; reply.step(t - react, op, me, ctxScratch, oppIntent); }
    setIntent(v.p.oppI, oppIntent);
    for (let i = 0; i < s.fighters.length; i++) if (i !== v.p.meI && i !== v.p.oppI) setIntent(i, zeroIntent);
    stepGame(s, inputs);
    if (!keepShot) {
      for (let i = 0; i < s.projectiles.length; i++) if (s.projectiles[i].owner === me.slot) s.projectiles[i].alive = false;
    }
    if (me.percent > pct0 || me.stocks !== st0 || me.hitstun > 0) return t + 1;
  }
  return Infinity;
}

/**
 * Is our shot at hold h safe from `range` (02 section 12.1)? The formula decides alone at levels
 * with no search steps; otherwise the sim confirms (see the file comment). The style's
 * shootSafeMargin is the required margin in frames.
 */
export const shootSafe: ShootSafeFn = (v, shot, h, range) => {
  const margin = v.style.shootSafeMargin;
  threatFor(v, range, threatScratch);
  const a = shootSafeAnalytic(shot, h, range, threatScratch, margin, safeScratch);
  if (!(v.level.stepBudget > 0)) return { safe: a.safe, safeIfAnswered: a.safeIfAnswered };
  const me = v.p.state.fighters[v.p.meI];
  if (!actionableOnGround(me)) return { safe: a.safe, safeIfAnswered: a.safeIfAnswered };
  const reply = attackReply(v);
  if (reply === null) return { safe: a.safe, safeIfAnswered: a.safeIfAnswered };
  const window = shotCommit(shot, h) + margin;
  const w = window > 1 ? window : 1;
  const react = threatScratch.react;
  const dry = simShot(v, shot, h, range, react, w, false, reply);
  if (dry < 0) return { safe: a.safe, safeIfAnswered: a.safeIfAnswered };
  const safe = dry === Infinity;
  if (safe) return { safe: true, safeIfAnswered: true };
  const live = simShot(v, shot, h, range, react, w, true, reply);
  return { safe: false, safeIfAnswered: live === Infinity };
};

// ---------------------------------------------------------------------------------------------
// chargeDecision
// ---------------------------------------------------------------------------------------------

/**
 * Research 21 chargeDecision with explicit threat numbers: the hold, NO_SHOT when even a tap is
 * unsafe, NO_CHARGE_SHOT when no safe hold reaches `distance`.
 */
export function chargeHoldAnalytic(shot: ShotProfile, distance: number, o: ThreatParams, margin: number,
  shareUsed: number): number {
  const tHit = punishFramesAnalytic(distance, o);
  return holdFrom(shot, distance, tHit, o.halfWidth, margin, shareUsed);
}

function holdFrom(shot: ShotProfile, distance: number, tHit: number, halfWidth: number, margin: number,
  shareUsed: number): number {
  const maxH = shotMaxHold(shot);
  let hMax = -1;
  for (let h = maxH; h >= 0; h--) if (shotCommit(shot, h) + margin <= tHit) { hMax = h; break; }
  if (hMax < 0) return NO_SHOT;
  let hReach = -1;
  for (let h = 0; h <= maxH; h++) if (shot.range(h) >= distance - halfWidth) { hReach = h; break; }
  if (hReach < 0 || hReach > hMax) return NO_CHARGE_SHOT;
  const share = shareUsed > 1 ? 1 : shareUsed > 0 ? shareUsed : 0;
  let h = Math.round(share * hMax);
  if (h < hReach) h = hReach;
  if (h > hMax) h = hMax;
  return h;
}

/** Holds a level may use: -1 none, 0 tap and full only, 15 steps of 15, 1 exact. */
function holdGrain(level: LevelVector): number {
  if (level.god) return 1;
  if (!level.vocabulary.has('projectile')) return -1;
  if (!level.vocabulary.has('baitProbe')) return 0;        // L3: holds 0 and full (03 section 2.3)
  return 15;
}

/** Charge is free when nothing threatens us during the hold (02 section 12.2). */
export function chargeIsFree(v: DecisionView): boolean {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const op = s.fighters[v.p.oppI];
  const adx = Math.abs(op.x - me.x);
  if (!op.onGround && op.y < me.y - 20 && adx < 60) return false;          // airborne over us
  if (op.action === 'attack' && adx < 110) return false;                     // in a move near us
  if (incomingThreat(v, 40)) return false;                                  // a shot will reach us soon
  return true;
}

const bandScratch: [number, number] = [0, 0];

/**
 * The hold for a shot at `distance` (02 section 12.2): hold frames, NO_SHOT (-1) or
 * NO_CHARGE_SHOT (-2). `shareUsed` in 0..1 picks where in the safe range to sit (1 = the longest
 * safe hold). Outside the style's shot band, pulled in by the tempo pressure: NO_SHOT.
 */
export const chargeDecision: ChargeDecisionFn = (v, shot, distance, shareUsed) => {
  const grain = holdGrain(v.level);
  if (grain < 0) return NO_SHOT;
  const maxH = shotMaxHold(shot);
  const full = shot.range(maxH);
  const p = v.tempo.pressure();
  bandScratch[0] = v.style.shotBand[0];
  bandScratch[1] = v.style.shotBand[1] - p * (v.style.shotBand[1] - v.style.shotBand[0]);
  if (distance > bandScratch[1] * full + v.me.physics.hurtbox.w / 2) return NO_SHOT;
  if (distance < bandScratch[0] * full) return NO_SHOT;
  if (!chargeIsFree(v)) return 0;
  const margin = v.style.shootSafeMargin;
  const tHit = punishFrames(v.opp, distance, assumedOppReact(v.level));
  const h = holdFrom(shot, distance, tHit, v.me.physics.hurtbox.w / 2, margin, shareUsed);
  if (h < 0 || grain === 1 || maxH === 0) return h;
  // Snap down to a hold the level can time, never under the hold that reaches.
  let hMax = -1;
  for (let x = maxH; x >= 0; x--) if (shotCommit(shot, x) + margin <= tHit) { hMax = x; break; }
  let hReach = 0;
  for (let x = 0; x <= maxH; x++) if (shot.range(x) >= distance - v.me.physics.hurtbox.w / 2) { hReach = x; break; }
  if (grain === 0) {
    if (maxH <= hMax && maxH >= hReach && shareUsed >= 0.5) return maxH;
    return hReach === 0 ? 0 : (maxH <= hMax ? maxH : NO_CHARGE_SHOT);
  }
  let snapped = Math.floor(h / grain) * grain;
  if (snapped < hReach) snapped = Math.ceil(hReach / grain) * grain;
  if (snapped > hMax) return NO_CHARGE_SHOT;
  return snapped > maxH ? maxH : snapped;
};

// ---------------------------------------------------------------------------------------------
// Flying shots ahead
// ---------------------------------------------------------------------------------------------

/** One enemy shot, live or about to spawn, flown ahead against our hurtbox. */
interface Flyer {
  owner: number; defId: string;
  x: number; y: number; vx: number; vy: number; gravity: number; age: number; lifetime: number;
  returnFrame: number; returned: boolean; r: number; spawnIn: number;
  burstR: number; burstLife: number; strength: number; damage: number; low: boolean; heal: number;
  /** First and last frame (from now) the shot overlaps us standing still; -1 none. */
  tHit: number; tEnd: number;
  /** Frames the shot has been visible (age, or frames into the throwing move). */
  seen: number; shooterX: number;
}
const MAX_FLYERS = 8;
const flyers: Flyer[] = [];
for (let i = 0; i < MAX_FLYERS; i++) {
  flyers.push({ owner: 0, defId: '', x: 0, y: 0, vx: 0, vy: 0, gravity: 0, age: 0, lifetime: 0, returnFrame: -1,
    returned: false, r: 0, spawnIn: 0, burstR: 0, burstLife: 0, strength: 0, damage: 0, low: false, heal: 0,
    tHit: -1, tEnd: -1, seen: 0, shooterX: 0 });
}
let nFlyers = 0;
const HURT: Rect = { x: 0, y: 0, w: 0, h: 0 };
const FLY_MAX = 200;

function circleRect(cx: number, cy: number, r: number, rc: Rect): boolean {
  const nx = cx < rc.x ? rc.x : cx > rc.x + rc.w ? rc.x + rc.w : cx;
  const ny = cy < rc.y ? rc.y : cy > rc.y + rc.h ? rc.y + rc.h : cy;
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

function burstOf(def: ProjectileDef, charge: number, scale: number, f: Flyer): void {
  const b = def.burstId !== undefined ? PROJECTILE_DEFS[def.burstId] : undefined;
  if (b === undefined) { f.burstR = 0; f.burstLife = 0; return; }
  f.burstR = chargedStat(b, charge, 'r') * scale;
  f.burstLife = b.lifetime;
}

/** Flies `f` ahead (the sim's stepProjectiles order) and fills tHit and tEnd against `rc`. */
function fly(f: Flyer, rc: Rect): void {
  f.tHit = -1; f.tEnd = -1;
  let x = f.x, y = f.y, vx = f.vx, vy = f.vy, age = f.age, returned = f.returned;
  let inside = false;
  const start = f.spawnIn;
  for (let k = 1; k <= FLY_MAX; k++) {
    if (k < start) continue;                     // not thrown yet (it moves on its spawn frame)
    if (f.returnFrame >= 0 && !returned && age >= f.returnFrame) { vx = -vx; returned = true; }
    x += vx; y += vy; vy += f.gravity; age++;
    const dead = age >= f.lifetime;
    const hit = circleRect(x, y, f.r, rc);
    if (hit) {
      if (f.tHit < 0) f.tHit = k;
      f.tEnd = k;
      inside = true;
    } else if (inside) {
      inside = false;
      if (f.tHit >= 0) break;                   // first pass over (a return is judged next decision)
    }
    if (dead) {
      if (f.burstR > 0 && f.tHit < 0 && circleRect(x, y, f.burstR, rc)) { f.tHit = k; f.tEnd = k + f.burstLife; }
      break;
    }
  }
}

function geoOf(stageId: string): StageGeo {
  let g = geoCache.get(stageId);
  if (g === undefined) { g = stageGeo(STAGE_DEFS[stageId]); geoCache.set(stageId, g); }
  return g;
}
const geoCache = new Map<string, StageGeo>();

/** Collects the enemy shots that can reach fighter `meI` (live, and ones about to leave a hand). */
function collectFlyers(s: GameState, meI: number, profiles: (charId: string) => CharacterAiProfile | null): number {
  nFlyers = 0;
  const me = s.fighters[meI];
  const def = CHARACTER_DEFS[me.charId];
  fighterHurtbox(me, def, HURT);
  for (let i = 0; i < s.projectiles.length && nFlyers < MAX_FLYERS; i++) {
    const p = s.projectiles[i];
    if (!p.alive || p.owner === me.slot || sameTeam(s, p.owner, me.slot)) continue;
    const pd = PROJECTILE_DEFS[p.defId];
    if (pd === undefined) continue;
    if ((p.hitSlots & (1 << meI)) !== 0) continue;
    const f = flyers[nFlyers];
    const ch = p.charge ?? 0;
    f.owner = p.owner; f.defId = p.defId; f.x = p.x; f.y = p.y; f.vx = p.vx; f.vy = p.vy; f.gravity = pd.gravity;
    f.age = p.age; f.lifetime = Math.round(chargedStat(pd, ch, 'lifetime'));
    f.returnFrame = pd.returnFrame === undefined ? -1 : pd.returnFrame; f.returned = p.returned;
    f.r = chargedStat(pd, ch, 'r') * p.scale; f.spawnIn = 0;
    f.strength = chargedStat(pd, ch, 'strength'); f.damage = chargedStat(pd, ch, 'damage') * p.power;
    f.low = pd.low === true; f.heal = pd.healFraction ?? 0; f.seen = p.age;
    let sx = p.x;
    for (let j = 0; j < s.fighters.length; j++) if (s.fighters[j].slot === p.owner) sx = s.fighters[j].x;
    f.shooterX = sx;
    burstOf(pd, ch, p.scale, f);
    fly(f, HURT);
    if (f.tHit >= 0) nFlyers++;
  }
  // Shots still in a hand: an enemy in a move whose timeline throws one it has not thrown yet.
  for (let j = 0; j < s.fighters.length && nFlyers < MAX_FLYERS; j++) {
    const o = s.fighters[j];
    if (j === meI || sameTeam(s, o.slot, me.slot) || o.action !== 'attack' || o.moveId === null) continue;
    const prof = profiles(o.charId);
    if (prof === null) continue;
    for (let k = 0; k < prof.shots.length && nFlyers < MAX_FLYERS; k++) {
      const sh = prof.shots[k];
      if (sh.moveId !== o.moveId) continue;
      const pd = PROJECTILE_DEFS[sh.defId];
      if (pd === undefined) continue;
      const h = o.charge;
      const cast = sh.castFrames(h);
      // The move frame advances before the spawn check, and a released charge restarts at frame 0.
      const spawnIn = o.charging ? cast + 1 : cast - o.actionFrame;
      if (spawnIn <= 0) continue;                // already thrown (a live shot above)
      const f = flyers[nFlyers];
      const frac = shotMaxHold(sh) > 0 ? h / chargeMax() : 0;
      f.owner = o.slot; f.defId = sh.defId; f.x = o.x + pd.x * o.facing; f.y = o.y + pd.y;
      f.vx = sh.speed(h) * o.facing; f.vy = pd.vy; f.gravity = pd.gravity; f.age = 0; f.lifetime = sh.lifetime(h);
      f.returnFrame = pd.returnFrame === undefined ? -1 : pd.returnFrame; f.returned = false;
      f.r = sh.radius(h); f.spawnIn = spawnIn; f.strength = sh.strength(h); f.damage = sh.damage(h);
      f.low = sh.low; f.heal = pd.healFraction ?? 0; f.seen = o.charging ? 0 : o.actionFrame; f.shooterX = o.x;
      const scale = pd.r > 0 ? sh.radius(h) / chargedStat(pd, frac, 'r') : 1;
      burstOf(pd, frac, scale, f);
      fly(f, HURT);
      if (f.tHit >= 0) nFlyers++;
    }
  }
  return nFlyers;
}

function viewProfiles(v: DecisionView): (charId: string) => CharacterAiProfile | null {
  return (charId: string) => (charId === v.opp.charId ? v.opp : charId === v.me.charId ? v.me : null);
}

/** True when an enemy shot overlaps us within `within` frames. */
export function incomingThreat(v: DecisionView, within: number): boolean {
  const n = collectFlyers(v.p.state, v.p.meI, viewProfiles(v));
  for (let i = 0; i < n; i++) if (flyers[i].tHit <= within) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// answerProjectile
// ---------------------------------------------------------------------------------------------

/** What the answer is and how to run it. `startIn`, `until` are frames from the decision. */
export interface AnswerDetail {
  family: PlanFamilyId | null;
  /** Kind of script (see answerScript). */
  kind: number;
  startIn: number; until: number;
  /** +1 toward the shooter, -1 away (roll, outrun). */
  dir: number;
  /** Counter-shot: direct code, hold and charge button. */
  code: number; hold: number; chargeBtn: number;
  /** The shot answered. */
  tHit: number; tEnd: number; strength: number; damage: number; heal: number; shooterX: number;
  cost: number; works: boolean; simulated: boolean; threat: boolean;
}

export const ANS = { NONE: 0, SHIELD: 1, SPOT: 2, ROLL: 3, JUMP: 4, AIRDODGE: 5, COUNTER: 6, OUTRUN: 7, EAT: 8 } as const;
const ANS_FAMILY: readonly (PlanFamilyId | null)[] = [null, 'shield', 'spotDodge', 'roll', 'emptyHop', 'airDodge',
  'projectile', 'dash', 'wait'];

export function newAnswerDetail(): AnswerDetail {
  return { family: null, kind: 0, startIn: 0, until: 0, dir: 1, code: 0, hold: 0, chargeBtn: 0, tHit: -1, tEnd: -1,
    strength: 0, damage: 0, heal: 0, shooterX: 0, cost: 0, works: false, simulated: false, threat: false };
}

/** Cost weights (research 21 answerProjectile). */
const W_DMG = 1, W_SHIELD = 0.35, W_TEMPO = 0.12, W_PROGRESS = 0.02;
/** Room an outrun needs, px. */
const OUTRUN_ROOM = 80;
const MAX_CANDS = 12;
const cands: AnswerDetail[] = [];
for (let i = 0; i < MAX_CANDS; i++) cands.push(newAnswerDetail());
let nCands = 0;

function addCand(kind: number, startIn: number, until: number, dir: number, cost: number, f: Flyer): AnswerDetail | null {
  if (nCands >= MAX_CANDS) return null;
  const c = cands[nCands++];
  c.family = ANS_FAMILY[kind]; c.kind = kind; c.startIn = startIn; c.until = until; c.dir = dir;
  c.code = 0; c.hold = 0; c.chargeBtn = 0; c.cost = cost;
  c.tHit = f.tHit; c.tEnd = f.tEnd; c.strength = f.strength; c.damage = f.damage; c.heal = f.heal; c.shooterX = f.shooterX;
  c.works = false; c.simulated = false; c.threat = true;
  return c;
}

function copyDetail(src: AnswerDetail, dst: AnswerDetail): AnswerDetail {
  dst.family = src.family; dst.kind = src.kind; dst.startIn = src.startIn; dst.until = src.until; dst.dir = src.dir;
  dst.code = src.code; dst.hold = src.hold; dst.chargeBtn = src.chargeBtn; dst.tHit = src.tHit; dst.tEnd = src.tEnd;
  dst.strength = src.strength; dst.damage = src.damage; dst.heal = src.heal; dst.shooterX = src.shooterX;
  dst.cost = src.cost; dst.works = src.works; dst.simulated = src.simulated; dst.threat = src.threat;
  return dst;
}

/** Reaction frames the level needs before it can start an answer to a cue seen `seen` frames ago. */
function startMin(level: LevelVector, seen: number): number {
  const r = level.god ? level.perceptionAge : Math.round(level.reactBase);
  const s = r - seen;
  return s > 0 ? s : 0;
}

function actionableAir(f: FighterState): boolean {
  return !f.onGround && f.hitlag === 0 && f.action === 'air';
}

/**
 * The script of an answer at frame `t` from the decision, for fighter `self` (writes `out`).
 * Exported so plan scripts and the unit checks run the same inputs the verifier stepped.
 */
export function answerScript(d: AnswerDetail, t: number, self: FighterState, g: StageGeo, out: Intent): void {
  out.held = 0; out.direct = 0; out.mash = 0;
  if (d.family === null || t < d.startIn) return;
  const k = t - d.startIn;
  const toward = d.shooterX < self.x ? L : R;
  const away = toward === L ? R : L;
  switch (d.kind) {
    case ANS.SHIELD:
      if (t <= d.until) out.held = SH;
      return;
    case ANS.SPOT:
      if (k === 0) out.direct = C_SPOT;
      return;
    case ANS.ROLL: {
      if (k !== 0) return;
      const faceShooter = (self.facing === 1) === (d.shooterX > self.x);
      const wantToward = d.dir > 0;
      out.direct = wantToward === faceShooter ? C_ROLLF : C_ROLLB;
      return;
    }
    case ANS.JUMP:
      if (k < 8) out.held = J;
      return;
    case ANS.AIRDODGE:
      if (k === 0) out.direct = C_AIRDODGE;
      return;
    case ANS.COUNTER:
      if (k === 0) out.direct = d.code;
      if (d.hold > 0 && k <= d.hold) out.held = d.chargeBtn;
      return;
    case ANS.OUTRUN: {
      if (t > d.until) return;
      const dirBit = d.dir > 0 ? toward : away;
      const edge = dirBit === R ? g.right - self.x : self.x - g.left;
      if (self.onGround && edge < 24) return;           // never runs off the stage
      out.held = dirBit;
      return;
    }
    default: return;
  }
}

/** Steps a clone with our answer and everyone else idle; true when we take no damage through `until` + 10. */
function verifyAnswer(v: DecisionView, d: AnswerDetail, g: StageGeo): { ok: boolean; steps: number } {
  const s = cloneGameState(v.p.state);
  const meI = v.p.meI;
  const me = s.fighters[meI];
  const pct0 = me.percent, st0 = me.stocks;
  const inputs = inputsFor(s.fighters.length);
  let horizon = (d.tEnd > d.until ? d.tEnd : d.until) + 10;
  if (horizon > FLY_MAX) horizon = FLY_MAX;
  let t = 0;
  for (; t < horizon; t++) {
    answerScript(d, t, me, g, meIntent);
    setIntent(meI, meIntent);
    for (let i = 0; i < s.fighters.length; i++) if (i !== meI) setIntent(i, zeroIntent);
    stepGame(s, inputs);
    if (me.percent > pct0 + 1e-9 || me.stocks !== st0 || me.action === 'shieldBreak'
      || me.action === 'hitstun' || me.action === 'tumble') return { ok: false, steps: t + 1 };
  }
  return { ok: true, steps: t };
}

/** Our shots that can clash: the cheapest hold whose tier beats (or ties) `strength`. */
function counterCandidates(v: DecisionView, f: Flyer, smin: number): void {
  const me = v.p.state.fighters[v.p.meI];
  if (!actionableOnGround(me)) return;
  if ((me.facing === 1) !== (f.shooterX > me.x)) return;          // must face the shooter
  for (let i = 0; i < v.me.shots.length; i++) {
    const sh = v.me.shots[i];
    const code = CODES.indexOf(sh.moveId) + 1;
    if (code <= 0) continue;
    const maxH = shotMaxHold(sh);
    let hWin = -1, hTie = -1;
    for (let h = 0; h <= maxH; h++) {
      const st = sh.strength(h);
      if (st > f.strength) { hWin = h; break; }
      if (st === f.strength && hTie < 0) hTie = h;
    }
    const h = hWin >= 0 ? hWin : hTie;
    if (h < 0) continue;
    const spawnAt = smin + h + sh.castFrames(h);
    if (spawnAt >= f.tHit) continue;
    const zoneGain = hWin >= 0 ? 2 + shotHeal(sh, h) : 0;
    const c = addCand(ANS.COUNTER, smin, smin + shotCommit(sh, h), 1,
      W_TEMPO * shotCommit(sh, h) - zoneGain + (hWin >= 0 ? 0 : 1.5), f);
    if (c !== null) { c.code = code; c.hold = h; c.chargeBtn = chargeButtonOf(me.charId, sh.moveId); }
  }
}

/** Fills `out` with the answer to the most urgent enemy shot; returns its family (null = nothing to answer). */
export function answerProjectileDetail(v: DecisionView, out: AnswerDetail): PlanFamilyId | null {
  const s = v.p.state;
  const me = s.fighters[v.p.meI];
  const g = geoOf(s.stageId);
  const n = collectFlyers(s, v.p.meI, viewProfiles(v));
  out.family = null; out.threat = false; out.works = true; out.kind = ANS.NONE;
  if (n === 0) return null;
  // Most urgent shot first.
  let fi = 0;
  for (let i = 1; i < n; i++) if (flyers[i].tHit < flyers[fi].tHit) fi = i;
  const f = flyers[fi];
  const smin = startMin(v.level, f.seen);
  const span = f.tEnd - f.tHit + 1;
  const eatCost = W_DMG * f.damage * (1 + f.heal) + W_TEMPO * 20;
  nCands = 0;
  const ground = actionableOnGround(me) || me.action === 'shield';
  const toShooter = f.shooterX < me.x ? -1 : 1;
  if (ground) {
    // Shield: up by tHit, held through the pass.
    const shieldLeft = me.shieldHp - f.damage;
    if (f.tHit - smin >= 1 && shieldLeft > SHIELD_MAX * 0.15) {
      const st = f.tHit - 3 > smin ? f.tHit - 3 : smin;
      addCand(ANS.SHIELD, st, f.tEnd + 3, 0, W_SHIELD * f.damage + W_TEMPO * (f.tEnd + 3 - st + 8), f);
    }
    // Spot dodge: the pass inside the intangible frames.
    const inv = SPOT_DODGE.invEnd - SPOT_DODGE.invStart + 1;
    if (span <= inv) {
      let st = f.tHit - SPOT_DODGE.invStart - ((inv - span) >> 1);
      if (st < smin) st = smin;
      if (st + SPOT_DODGE.invStart <= f.tHit && f.tEnd <= st + SPOT_DODGE.invEnd) {
        addCand(ANS.SPOT, st, st + SPOT_DODGE.total, 0, W_TEMPO * SPOT_DODGE.total, f);
      }
    }
    // Roll through toward the shooter (not against low shots), or away when there is room.
    if (!f.low) {
      let st = f.tHit - ROLL.invStart - 2;
      if (st < smin) st = smin;
      if (st + ROLL.invStart <= f.tHit) {
        const roomToward = toShooter > 0 ? g.right - me.x : me.x - g.left;
        const roomAway = toShooter > 0 ? me.x - g.left : g.right - me.x;
        if (roomToward > ROLL.distance + 10) addCand(ANS.ROLL, st, st + ROLL.total, 1, W_TEMPO * ROLL.total - W_PROGRESS * ROLL.distance, f);
        if (roomAway > ROLL.distance + 10) addCand(ANS.ROLL, st, st + ROLL.total, -1, W_TEMPO * ROLL.total + W_PROGRESS * ROLL.distance, f);
      }
    }
    // Jump over: shot top under a full hop's height; three start timings for the verifier.
    const top = me.y - (f.y - f.r);
    if (top < v.me.recovery.rise.fullHop - v.me.physics.hurtbox.h * 0.5) {
      for (let lead = 14; lead >= 6; lead -= 4) {
        const st = f.tHit - lead;
        if (st < smin) continue;
        addCand(ANS.JUMP, st, st + 30, 0, W_TEMPO * 12 + lead * 0.01, f);
      }
      if (f.tHit - smin >= v.me.physics.jumpSquat + 3) addCand(ANS.JUMP, smin, smin + 30, 0, W_TEMPO * 12 + 0.2, f);
    }
    counterCandidates(v, f, smin);
    // Outrun: run away while it dies out (needs room).
    const room = toShooter > 0 ? me.x - g.left : g.right - me.x;
    if (room > OUTRUN_ROOM) addCand(ANS.OUTRUN, smin, f.tEnd + 10, -1, W_TEMPO * 10 + W_PROGRESS * room * 0.5 + 0.5, f);
  } else if (actionableAir(me)) {
    if (!(me as SimFighter).airDodgeUsed) {
      let st = f.tHit - AIR_DODGE.invStart - 1;
      if (st < smin) st = smin;
      if (st + AIR_DODGE.invStart <= f.tHit && f.tEnd <= st + AIR_DODGE.invEnd) {
        addCand(ANS.AIRDODGE, st, st + AIR_DODGE.total, 0, W_TEMPO * AIR_DODGE.total, f);
      }
    }
    addCand(ANS.OUTRUN, smin, f.tEnd + 10, -1, W_TEMPO * 6 + 1, f);
  }
  // Rank by cost (stable: insertion order on ties).
  for (let i = 1; i < nCands; i++) {
    const x = cands[i]; let j = i - 1;
    while (j >= 0 && cands[j].cost > x.cost) { cands[j + 1] = cands[j]; j--; }
    cands[j + 1] = x;
  }
  // Verify in cost order within the step budget.
  let budget = v.level.stepBudget > 1500 ? 1500 : v.level.stepBudget;
  let chosen = -1;
  for (let i = 0; i < nCands; i++) {
    if (!(cands[i].cost < eatCost + 50)) continue;
    if (!(budget > 0)) { if (chosen < 0) chosen = i; break; }
    const r = verifyAnswer(v, cands[i], g);
    budget -= r.steps;
    cands[i].simulated = true;
    cands[i].works = r.ok;
    if (r.ok) { chosen = i; break; }
  }
  if (chosen >= 0) {
    copyDetail(cands[chosen], out);
    if (!out.simulated) out.works = true;           // analytic only: feasible by the frame math
    return out.family;
  }
  // Nothing verified: take the hit (the cheapest honest outcome), marked as not working.
  out.family = 'wait'; out.kind = ANS.EAT; out.startIn = 0; out.until = 0; out.threat = true; out.works = false;
  out.tHit = f.tHit; out.tEnd = f.tEnd; out.strength = f.strength; out.damage = f.damage; out.heal = f.heal;
  out.shooterX = f.shooterX; out.cost = eatCost; out.simulated = false;
  return out.family;
}

const answerScratch = newAnswerDetail();

/** The plan family that answers the most urgent enemy shot (02 section 12.3), or null when none reaches us. */
export const answerProjectile: AnswerProjectileFn = (v) => answerProjectileDetail(v, answerScratch);

/** Stage geometry used by answerScript. */
export function zoningGeo(stageId: string): StageGeo { return geoOf(stageId); }

// ---------------------------------------------------------------------------------------------
// Zone term (02 section 12.4)
// ---------------------------------------------------------------------------------------------

/** Cap on the zone term. */
export const ZONE_CAP = 1;
/** Pressure at or above which the zone term is off. */
export const ZONE_OFF_PRESSURE = 0.75;

/**
 * Own shots in flight covering the lane between the fighters: each live shot of ours between
 * us (or passing the opponent) and moving toward them counts 0.5 x (1 + strength / 10), capped at
 * ZONE_CAP, scaled by (1 - p / 0.75) and 0 from p 0.75 up.
 */
export function zoneTerm(s: GameState, meI: number, oppI: number, pressure: number): number {
  if (pressure >= ZONE_OFF_PRESSURE) return 0;
  const me = s.fighters[meI], op = s.fighters[oppI];
  const lo = me.x < op.x ? me.x : op.x, hi = me.x < op.x ? op.x : me.x;
  const toward = op.x > me.x ? 1 : -1;
  let z = 0;
  for (let i = 0; i < s.projectiles.length; i++) {
    const p = s.projectiles[i];
    if (!p.alive || p.owner !== me.slot) continue;
    if (p.vx * toward <= 0) continue;
    if (p.x < lo - 10 || p.x > hi + 10) continue;
    const pd = PROJECTILE_DEFS[p.defId];
    const st = pd === undefined ? 1 : chargedStat(pd, p.charge ?? 0, 'strength');
    z += 0.5 * (1 + st / 10);
  }
  if (z > ZONE_CAP) z = ZONE_CAP;
  return z * (1 - pressure / ZONE_OFF_PRESSURE);
}
