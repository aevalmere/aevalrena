/**
 * Aevalmere, the level 10 CPU. Research notes and the design live in docs/CPU_AEVALMERE.md.
 *
 * Levels 1 to 9 (src/ai/index.ts) are hand-written rules with weights. Aevalmere is a search:
 * every decision forward-simulates its best candidate options with the real sim (a pooled copy
 * of the game state and stepGame) against a small set of opponent reply models, scores each
 * future, and commits to the option with the best blend of worst case and expected case.
 *
 * What it may and may not read:
 * - It reads the whole game state: every fighter's action, frame, velocity, jumps, shield,
 *   hitstun and every projectile. That is its "cheat", the same one the Ultimate level 9 has.
 * - It never reads an input the opponent has not already acted on. It plans on a perceived
 *   state that is REACT frames old, rolled forward to now with the opponent assumed to keep
 *   holding what they held, so anything started in the last REACT frames is invisible to it.
 *   That is the reaction floor: no shield ever answers frame 0 of a startup.
 *
 * Invariants shared with the rest of src/ai: deterministic (only the passed rand, never
 * Math.random or the clock), and nothing is allocated on the per-frame path once the pooled
 * scratch states exist. The one exception is inside stepGame itself, which pushes its own event
 * objects while the rollouts run; that is sim code and outside this file's reach.
 */
import type { FighterState, GameState, InputFrame, MatchConfig, MoveDef, MoveId, ProjectileState, Rect } from '../core/types';
import { Btn, DIRECT_CODES, MAX_PLAYERS } from '../core/types';
import { TUNING } from '../core/constants';
import { CHARACTER_DEFS } from '../characters/registry';
import { grabKitOf } from '../characters/common/grabkit';
import { STAGE_DEFS } from '../stages/registry';
import { cloneGameState, createGameState, stepGame } from '../sim';
import { canFinalSmash } from '../sim/finalsmash';
import { isLedgeAction } from '../sim/ledge';
import { sameTeam, type SimFighter } from '../sim/state';

// ---------------------------------------------------------------------------
// Tuning of the brain itself
// ---------------------------------------------------------------------------

/** Perception delay: the brain plans on the state as it was this many frames ago, rolled forward. */
export const AEVALMERE_REACT = 4;
/** History ring length. Must exceed AEVALMERE_REACT. */
const HIST = 8;
/** Frames between re-plans while an interruptible plan (movement, shield, waiting) runs. */
const REPLAN = 3;
/** Same, while recovering: the rollouts there are long, and the plan is a policy anyway. */
const REPLAN_REC = 6;
/**
 * Sim steps one decision may spend across all its rollouts. Deterministic on purpose: a budget
 * read off the wall clock would make the same seed play differently on a slower machine.
 */
const STEP_BUDGET = 2600;
/**
 * Opening ramp: for the first RAMP_FRAMES sim frames of a match a decision may spend only
 * RAMP_BUDGET steps, so the frames where the JIT may still be cold never cost more than about 2 ms.
 * Keyed on the sim frame, so it is as deterministic as the rest.
 */
const RAMP_FRAMES = 240;
const RAMP_BUDGET = 600;
/** Frames of throwaway play warmAevalmere runs on a scratch match. */
const WARM_FRAMES = 400;
/** True while warmAevalmere runs: the full budget, so the heaviest paths get compiled too. */
let warming = false;
/** The config warmAevalmere last ran for: each match is warmed once, by the host or by cpuInput. */
let warmedConfig: MatchConfig | null = null;
/** Share of neutral decisions that take a safe alternative instead of the best option. */
const HUMAN_ALT = 0.06;
/** Weight of the worst opponent reply against the weighted average one, in neutral and on reads. */
const LAMBDA_NEUTRAL = 0.55;
const LAMBDA_READ = 0.3;
/** Bonus for keeping the plan already running, so equal options never flicker frame to frame. */
const CONTINUITY = 1.5;
/** Bonus for a follow-up the precomputed combo table suggests, on top of what the rollout finds. */
const TABLE_BONUS = 4;
/**
 * Staleness: every decision decays each plan's recent-use count, and a commitment already used a lot
 * lately scores this much less per use (projectiles twice as much). A top player mixes up; a script
 * repeats its best option until someone learns it.
 */
const STALE_DECAY = 0.9;
const STALE_COST = 1.2;
/** Frames without any damage on the stage after which the brain leans toward closing distance. */
const STALL_FRAMES = 420;
/** Score per px a launched victim ends a rollout beyond 90 px from us, when the launch is no KO. */
const DEAD_TIME_COST = 0.06;

// ---------------------------------------------------------------------------
// Direct codes: exact move and command inputs a player can bind to their own keys
// ---------------------------------------------------------------------------

const CODES = DIRECT_CODES as readonly string[];
function dc(name: string): number { return CODES.indexOf(name) + 1; }
const C_JAB = dc('jab');
const C_FTILT = dc('ftilt');
const C_UTILT = dc('utilt');
const C_DTILT = dc('dtilt');
const C_DASHATK = dc('dashatk');
const C_FSMASH = dc('fsmash');
const C_USMASH = dc('usmash');
const C_DSMASH = dc('dsmash');
const C_NAIR = dc('nair');
const C_FAIR = dc('fair');
const C_BAIR = dc('bair');
const C_UAIR = dc('uair');
const C_DAIR = dc('dair');
const C_NSPEC = dc('nspecial');
const C_SSPEC = dc('sspecial');
const C_USPEC = dc('uspecial');
const C_DSPEC = dc('dspecial');
const C_PUMMEL = dc('pummel');
const C_FTHROW = dc('fthrow');
const C_BTHROW = dc('bthrow');
const C_UTHROW = dc('uthrow');
const C_DTHROW = dc('dthrow');
const C_SPOT = dc('spotDodge');
const C_ROLLF = dc('rollForward');
const C_ROLLB = dc('rollBack');
const C_DIRAD = dc('dirAirDodge');
const C_LATK = dc('ledgeAttack');
const C_LROLL = dc('ledgeRoll');
const C_LUP = dc('ledgeGetUp');
const C_LJUMP = dc('ledgeJump');
const C_GUATK = dc('getupAttack');
const C_FS = dc('finalSmash');

const L = Btn.Left;
const R = Btn.Right;
const U = Btn.Up;
const D = Btn.Down;
const J = Btn.Jump;
const A = Btn.Attack;
const SP = Btn.Special;
const SH = Btn.Shield;
const G = Btn.Grab;
const WK = Btn.Walk;

function dirBit(d: number): number { return d > 0 ? R : L; }

// ---------------------------------------------------------------------------
// Pooled game-state copies
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

/** Fighter fields copied by value, and object fields copied one level deep (the input buffer). */
let fPrim: string[] = [];
let fObj: string[] = [];
let fObjSub: string[][] = [];
/** Top-level GameState fields copied by value, and small objects copied one level deep (rng). */
let gPrim: string[] = [];
let gObj: string[] = [];
let gObjSub: string[][] = [];
let keysLearned = false;

/**
 * Learns the field lists from a live state once. Reading the shape off the real object rather
 * than listing fields here means a field another worker adds to the sim is copied without anyone
 * having to remember this file. `stats` is deliberately not copied: it is results bookkeeping the
 * sim never branches on, and a scratch state keeps its own stats object so nothing a simulated
 * future does can ever reach the real one. `activeThrow` is immutable def data, shared by ref.
 */
function learnKeys(src: GameState): void {
  const f = src.fighters[0] as unknown as Rec;
  fPrim = []; fObj = []; fObjSub = [];
  const fk = Object.keys(f);
  for (let i = 0; i < fk.length; i++) {
    const k = fk[i];
    const v = f[k];
    if (k === 'stats') continue;
    if (k !== 'activeThrow' && v !== null && typeof v === 'object') {
      fObj.push(k);
      fObjSub.push(Object.keys(v as Rec));
    } else {
      fPrim.push(k);
    }
  }
  gPrim = []; gObj = []; gObjSub = [];
  const s = src as unknown as Rec;
  const gk = Object.keys(s);
  for (let i = 0; i < gk.length; i++) {
    const k = gk[i];
    if (k === 'fighters' || k === 'projectiles' || k === 'events' || k === 'config') continue;
    const v = s[k];
    if (v !== null && typeof v === 'object') {
      gObj.push(k);
      gObjSub.push(Object.keys(v as Rec));
    } else {
      gPrim.push(k);
    }
  }
  keysLearned = true;
}

function copyFighterInto(src: FighterState, dst: FighterState): void {
  const s = src as unknown as Rec;
  const d = dst as unknown as Rec;
  for (let i = 0; i < fPrim.length; i++) { const k = fPrim[i]; d[k] = s[k]; }
  for (let i = 0; i < fObj.length; i++) {
    const k = fObj[i];
    const so = s[k] as Rec;
    const dobj = d[k] as Rec;
    const sub = fObjSub[i];
    for (let j = 0; j < sub.length; j++) dobj[sub[j]] = so[sub[j]];
  }
}

function copyProjectileInto(s: ProjectileState, d: ProjectileState): void {
  d.id = s.id; d.owner = s.owner; d.defId = s.defId;
  d.x = s.x; d.y = s.y; d.vx = s.vx; d.vy = s.vy;
  d.facing = s.facing; d.age = s.age; d.hitSlots = s.hitSlots; d.alive = s.alive;
  d.power = s.power; d.scale = s.scale; d.returned = s.returned;
}

/**
 * Copies `src` into the pooled state `dst` without allocating (after the pool has grown to the
 * largest projectile count it has seen). `dst` must come from cloneGameState of a state of the
 * same match, so its fighters and their stats objects are its own. Projectile slots beyond the
 * source's are kept and marked dead rather than truncated: the sim skips dead slots and hands
 * them back out exactly as it would hand out a fresh one, so the copy steps identically.
 * Written against the public GameState fields plus the sim's own per-fighter scratch, which it
 * learns from the live object; src/sim/state.ts is not touched.
 */
export function copyGameStateInto(src: GameState, dst: GameState): void {
  if (!keysLearned) learnKeys(src);
  const s = src as unknown as Rec;
  const d = dst as unknown as Rec;
  for (let i = 0; i < gPrim.length; i++) { const k = gPrim[i]; d[k] = s[k]; }
  for (let i = 0; i < gObj.length; i++) {
    const k = gObj[i];
    const so = s[k] as Rec;
    const dobj = d[k] as Rec;
    const sub = gObjSub[i];
    for (let j = 0; j < sub.length; j++) dobj[sub[j]] = so[sub[j]];
  }
  dst.config = src.config;
  dst.events.length = 0;
  const sf = src.fighters;
  const df = dst.fighters;
  if (df.length !== sf.length) {
    // Only when a pool is reused across matches with a different player count.
    const fresh = cloneGameState(src).fighters;
    df.length = 0;
    for (let i = 0; i < fresh.length; i++) df.push(fresh[i]);
  }
  for (let i = 0; i < sf.length; i++) copyFighterInto(sf[i], df[i]);
  const sp = src.projectiles;
  const dp = dst.projectiles;
  for (let i = 0; i < sp.length; i++) {
    if (i >= dp.length) {
      dp.push({
        id: 0, owner: 0, defId: '', x: 0, y: 0, vx: 0, vy: 0, facing: 1, age: 0, hitSlots: 0,
        alive: false, power: 1, scale: 1, returned: false,
      });
    }
    copyProjectileInto(sp[i], dp[i]);
  }
  for (let i = sp.length; i < dp.length; i++) dp[i].alive = false;
}

// ---------------------------------------------------------------------------
// Stage reading
// ---------------------------------------------------------------------------

interface StageInfo { minX: number; maxX: number; topY: number; cx: number }
const stageCache = new Map<string, StageInfo>();

function stageInfo(stageId: string): StageInfo {
  const hit = stageCache.get(stageId);
  if (hit) return hit;
  const st = STAGE_DEFS[stageId];
  let minX = -180; let maxX = 180; let topY = 0; let found = false;
  if (st) {
    for (let i = 0; i < st.platforms.length; i++) {
      const p = st.platforms[i];
      if (!p.solid) continue;
      if (!found) { minX = p.x; maxX = p.x + p.w; topY = p.y; found = true; }
      else { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + p.w); topY = Math.min(topY, p.y); }
    }
  }
  const info: StageInfo = { minX, maxX, topY, cx: (minX + maxX) / 2 };
  stageCache.set(stageId, info);
  return info;
}

/** The blast rect, read live from the stage def so a retuned blast zone is seen at once. */
function blastOf(state: GameState): Rect {
  return STAGE_DEFS[state.stageId].blast;
}

function onSoftPlatform(state: GameState, f: FighterState): boolean {
  if (!f.onGround) return false;
  const st = STAGE_DEFS[state.stageId];
  for (let i = 0; i < st.platforms.length; i++) {
    const p = st.platforms[i];
    if (p.solid) continue;
    if (Math.abs(f.y - p.y) > 0.5 || f.x < p.x || f.x > p.x + p.w) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Frame-data reads
// ---------------------------------------------------------------------------

function moveStartup(mv: MoveDef): number {
  let best = -1;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const s = mv.hitboxes[i].start;
    if (best < 0 || s < best) best = s;
  }
  return best;
}

/** Frames until `f` can start a new action on its own, read off its action and the move data. */
function busyFrames(f: FighterState): number {
  const sf = f as SimFighter;
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'air': case 'shield':
      return 0;
    case 'attack': {
      if (f.moveId === null) return 0;
      const mv = CHARACTER_DEFS[f.charId].moves[f.moveId];
      const free = mv.iasa === undefined ? mv.totalFrames : mv.iasa;
      let left = Math.max(0, free - f.actionFrame);
      if (sf.charging) left += 4;
      if (!f.onGround && mv.landingLag !== undefined) left = Math.max(left, 6);
      return left + f.hitlag;
    }
    case 'land': case 'shieldStun': case 'shieldBreak':
      return sf.stateTimer;
    case 'hitstun': return f.hitstun + f.hitlag;
    case 'tumble': return f.hitstun + f.hitlag + 8;
    case 'jumpsquat': return 3;
    case 'spotDodge': return Math.max(0, 22 - f.actionFrame);
    case 'roll': return Math.max(0, 24 - f.actionFrame);
    case 'airDodge': return Math.max(0, 30 - f.actionFrame);
    case 'airHelpless': return 30;
    case 'grab': return Math.max(0, 30 - f.actionFrame);
    case 'grabbed': return 30;
    case 'throw': case 'grabHold': case 'pummel': return 0;
    case 'downed': return 20;
    case 'tech': case 'techRoll': case 'getUp': case 'getUpRoll': return Math.max(0, 30 - f.actionFrame);
    case 'ledgeClimb': case 'ledgeRoll': return Math.max(0, 30 - f.actionFrame);
    case 'footstooled': return 20;
    default: return 10;
  }
}

/** True when a new action pressed now would start right away (or from the buffer within a frame or two). */
function actionableNow(f: FighterState): boolean {
  const sf = f as SimFighter;
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'air': case 'shield':
    case 'ledgeHang': case 'downed': case 'grabHold':
      return f.hitlag === 0;
    case 'attack': {
      if (f.moveId === null || f.hitlag > 0) return false;
      const mv = CHARACTER_DEFS[f.charId].moves[f.moveId];
      return mv.iasa !== undefined && f.actionFrame >= mv.iasa;
    }
    case 'land': case 'shieldStun': return sf.stateTimer <= 2;
    case 'tumble': return f.hitstun <= 0 && f.hitlag === 0;
    case 'hitstun': return f.hitstun <= 1 && f.hitlag === 0;
    default: return false;
  }
}

function launched(f: FighterState): boolean {
  return (f.action === 'hitstun' || f.action === 'tumble') && f.hitstun > 0;
}

function offstage(f: FighterState, si: StageInfo): boolean {
  if (f.onGround || isLedgeAction(f.action)) return false;
  // Parked on the stage lip: past the corner by less than half a hurtbox, at floor height and not
  // falling. The sim's solid-side push keeps landing such a fighter every frame without ever giving
  // it ground support, so a fighter that presses nothing hovers there. It is standing, for our purposes.
  if (Math.abs(f.y - si.topY) < 0.5 && f.vy === 0 && f.x > si.minX - 14 && f.x < si.maxX + 14) return false;
  return f.x < si.minX - 2 || f.x > si.maxX + 2 || f.y > si.topY + 2;
}

/**
 * Rough "can this fighter still get back" read for an airborne fighter off the stage: height the
 * remaining jumps and the up special can still buy against how far below the ledge it is, and air
 * speed over that airtime against how far out it is. The rollouts see the real answer inside their
 * horizon; this only has to rank futures that end mid-recovery.
 */
function recoverable(f: FighterState, si: StageInfo): number {
  if (!offstage(f, si)) return 1;
  const def = CHARACTER_DEFS[f.charId];
  const helpless = f.action === 'airHelpless';
  const usUsed = helpless || (f.action === 'attack' && f.moveId === 'uspecial');
  const jumpRise = (def.doubleJumpVel * def.doubleJumpVel) / (2 * def.gravity);
  const rise = f.jumpsLeft * jumpRise + (usUsed ? 0 : 85);
  const below = f.y - (si.topY + 40);
  const out = f.x < si.minX ? si.minX - f.x : f.x > si.maxX ? f.x - si.maxX : 0;
  const air = f.jumpsLeft * 34 + (usUsed ? 0 : 30) + 20 + Math.max(0, (si.topY + 200 - f.y) / 4);
  const reachX = def.airSpeed * air + 24;
  // Moving away fast eats into the horizontal budget.
  const drift = f.x < si.minX ? -f.vx : f.x > si.maxX ? f.vx : 0;
  const outEff = out + Math.max(0, drift) * 12;
  const vMargin = rise - below;
  const hMargin = reachX - outEff;
  if (vMargin >= 20 && hMargin >= 20) return 1;
  if (vMargin < -15 || hMargin < -15) return 0;
  return Math.max(0, Math.min(1, (Math.min(vMargin, hMargin) + 15) / 35));
}

/**
 * Whether a launched fighter is carried out of the blast rect by the launch alone: the knockback
 * speed decays and gravity builds exactly as sim/physics.ts steps a fighter in hitstun. After the
 * hitstun a short momentum tail is stepped too, since drift barely scrubs a strong launch.
 */
function projectedKo(f: FighterState, blast: Rect): number {
  if (!launched(f)) return 0;
  const sf = f as SimFighter;
  const def = CHARACTER_DEFS[f.charId];
  let x = f.x; let y = f.y;
  let spd = sf.kbSpeed; let fall = sf.kbFall;
  let vx = f.vx; let vy = f.vy;
  const decay = TUNING.knockback.decay;
  for (let k = 0; k < f.hitstun; k++) {
    spd = Math.max(0, spd - decay);
    fall = Math.min(def.maxFall, fall + def.gravity);
    vx = sf.kbDirX * spd;
    vy = sf.kbDirY * spd + fall;
    x += vx; y += vy;
    if (x < blast.x || x > blast.x + blast.w || y < blast.y || y > blast.y + blast.h) return 1;
  }
  for (let k = 0; k < 24; k++) {
    vx = vx > 0 ? Math.max(0, vx - def.airAccel) : Math.min(0, vx + def.airAccel);
    vy = Math.min(def.maxFall, vy + def.gravity);
    x += vx; y += vy;
    if (x < blast.x || x > blast.x + blast.w || y < blast.y) return 0.75;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Knockback, reproduced from sim/hits.ts for the combo table (the sim does not export it)
// ---------------------------------------------------------------------------

function knockback(p: number, w: number, d: number, bkb: number, kbg: number): number {
  return ((((p / 10) + (p * d / 20)) * (200 / (w + 100)) * 1.4) + 18) * (kbg / 100) + bkb;
}

/**
 * Whether a hit (damage, angle, bkb, kbg) landed now on `v`, launched toward `dir` (+1 right), would
 * carry it out of the live blast rect: the same stepping as projectedKo, from the victim's real spot
 * and percent. This is how the brain knows a finisher is on before it has thrown it.
 */
function hitKillsFrom(v: FighterState, dir: number, damage: number, angle: number, bkb: number, kbg: number, blast: Rect): boolean {
  const def = CHARACTER_DEFS[v.charId];
  const d = damage * TUNING.knockback.damageMul;
  const kb = knockback(v.percent + d, def.weight, d, bkb, kbg) * TUNING.knockback.kbMul;
  const local = angle !== 361 ? angle : kb < TUNING.knockback.sakuraiThreshold ? 0 : 40;
  const rad = (local * Math.PI) / 180;
  const dirX = Math.cos(rad) * dir;
  const dirY = -Math.sin(rad);
  let spd = kb * TUNING.knockback.toVel;
  let fall = 0;
  let x = v.x; let y = v.y - 10;
  let vx = 0; let vy = 0;
  const hs = Math.floor(kb * TUNING.knockback.hitstunPerKb);
  for (let k = 0; k < hs; k++) {
    spd = Math.max(0, spd - TUNING.knockback.decay);
    fall = Math.min(def.maxFall, fall + def.gravity);
    vx = dirX * spd; vy = dirY * spd + fall;
    x += vx; y += vy;
    if (x < blast.x || x > blast.x + blast.w || y < blast.y || y > blast.y + blast.h) return true;
  }
  for (let k = 0; k < 24; k++) {
    vx = vx > 0 ? Math.max(0, vx - def.airAccel) : Math.min(0, vx + def.airAccel);
    vy = Math.min(def.maxFall, vy + def.gravity);
    x += vx; y += vy;
    if (x < blast.x || x > blast.x + blast.w || y < blast.y) return true;
  }
  return false;
}

/** Strongest hitbox of one of Aeval's moves, for the finisher checks. Filled lazily per move id. */
const finisherBox = new Map<string, { damage: number; angle: number; bkb: number; kbg: number }>();
function strongest(charId: string, id: MoveId): { damage: number; angle: number; bkb: number; kbg: number } | null {
  const key = charId + ':' + id;
  const hit = finisherBox.get(key);
  if (hit) return hit;
  const mv = CHARACTER_DEFS[charId].moves[id];
  if (!mv || mv.hitboxes.length === 0) return null;
  let b = mv.hitboxes[0];
  for (let i = 1; i < mv.hitboxes.length; i++) if (mv.hitboxes[i].damage > b.damage) b = mv.hitboxes[i];
  const out = { damage: b.damage, angle: b.angle, bkb: b.bkb, kbg: b.kbg };
  finisherBox.set(key, out);
  return out;
}

/** Best KO a throw of `v` by `m` would score right now: 1 if the forward or back throw kills. */
function throwKills(m: FighterState, v: FighterState, blast: Rect): boolean {
  const th = grabKitOf(CHARACTER_DEFS[m.charId]).throws;
  const f = th.fthrow; const b = th.bthrow;
  if (hitKillsFrom(v, m.facing, f.damage, f.angle, f.bkb, f.kbg, blast)) return true;
  return hitKillsFrom(v, -m.facing, b.damage, b.angle, b.bkb, b.kbg, blast);
}

/**
 * Kill threat at the end of a rollout: we are free, the opponent is on the ground within reach, and
 * one of the finishers (up smash, forward smash toward them, or a grab into a throw) would KO it from
 * where it stands. Rollouts only see a KO that lands inside their horizon; this is the term that
 * walks the brain into position for one, and toward the ledge where the side blast line is near.
 */
function killThreat(m: FighterState, o: FighterState, blast: Rect): number {
  const adx = Math.abs(o.x - m.x);
  if (!o.onGround || !m.onGround || adx > 56 || Math.abs(o.y - m.y) > 20) return 0;
  const dir = o.x >= m.x ? 1 : -1;
  const us = strongest(m.charId, 'usmash');
  if (us !== null && adx < 30 && hitKillsFrom(o, dir, us.damage, us.angle, us.bkb, us.kbg, blast)) return 1;
  const fs = strongest(m.charId, 'fsmash');
  if (fs !== null && hitKillsFrom(o, dir, fs.damage, fs.angle, fs.bkb, fs.kbg, blast)) return 1;
  if (adx < 40) {
    const th = grabKitOf(CHARACTER_DEFS[m.charId]).throws;
    // A grab turns us toward them: the forward throw sends them away from us, the back throw past us.
    if (hitKillsFrom(o, dir, th.fthrow.damage, th.fthrow.angle, th.fthrow.bkb, th.fthrow.kbg, blast)) return 1;
    if (hitKillsFrom(o, -dir, th.bthrow.damage, th.bthrow.angle, th.bthrow.bkb, th.bthrow.kbg, blast)) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Plans. Each is a small input program (or a policy that reads its own fighter) run from the
// frame it is chosen. The same function drives the rollouts and the real output, so what the
// search saw is exactly what gets pressed.
// ---------------------------------------------------------------------------

const F_ATTACK = 1;     // commits to a hitbox: the no-whiff rule applies
const F_INTR = 2;       // may be replaced by a fresh decision every REPLAN frames
const F_TAIL = 4;       // airborne off the stage after its script, the recovery policy takes over
const F_MOVE = 8;       // a safe movement option the humanizer may swap in
const F_PROJ = 16;      // a projectile: judged over a longer horizon
const F_EG = 32;        // leaves the stage on purpose: only taken when the rollout gets back
const F_STALE = 64;     // a dodge: not an attack, but it goes stale like one so two careful CPUs cannot dodge forever

const PLAN_NAME: string[] = [];
const PLAN_MIN: number[] = [];
const PLAN_FLAGS: number[] = [];
const PLAN_H: number[] = [];
function defPlan(name: string, min: number, flags: number, h: number): number {
  PLAN_NAME.push(name); PLAN_MIN.push(min); PLAN_FLAGS.push(flags); PLAN_H.push(h);
  return PLAN_NAME.length - 1;
}

// Ground
const P_WAIT = defPlan('wait', 1, F_INTR | F_MOVE, 16);
const P_WALK_F = defPlan('walkIn', 1, F_INTR | F_MOVE, 16);
const P_WALK_B = defPlan('walkOut', 1, F_INTR | F_MOVE, 16);
const P_DASH_F = defPlan('dashIn', 1, F_INTR, 16);
const P_DASH_B = defPlan('dashOut', 1, F_INTR | F_MOVE, 16);
const P_DD_F = defPlan('danceIn', 8, F_INTR | F_MOVE, 18);
const P_DD_B = defPlan('danceOut', 8, F_INTR | F_MOVE, 18);
const P_JAB = defPlan('jab', 2, F_ATTACK, 22);
const P_FTILT = defPlan('ftilt', 2, F_ATTACK, 28);
const P_UTILT = defPlan('utilt', 2, F_ATTACK, 26);
const P_DTILT = defPlan('dtilt', 2, F_ATTACK, 24);
const P_FSMASH = defPlan('fsmash', 2, F_ATTACK, 40);
const P_FSMASH_C = defPlan('fsmashCharged', 14, F_ATTACK, 40);
const P_USMASH = defPlan('usmash', 2, F_ATTACK, 38);
const P_USMASH_C = defPlan('usmashCharged', 14, F_ATTACK, 40);
const P_DSMASH = defPlan('dsmash', 2, F_ATTACK, 40);
const P_DASHATK = defPlan('dashatk', 2, F_ATTACK, 34);
const P_GRAB = defPlan('grab', 2, F_ATTACK, 30);
const P_DASHGRAB = defPlan('dashGrab', 5, F_ATTACK, 36);
const P_NSPEC = defPlan('orb', 2, F_ATTACK | F_PROJ, 56);
const P_SSPEC = defPlan('crescent', 2, F_ATTACK | F_PROJ, 56);
const P_DSPEC = defPlan('whirlpool', 2, F_ATTACK, 40);
const P_USPEC_G = defPlan('geyser', 2, F_ATTACK | F_TAIL, 40);
const P_SH_NAIR = defPlan('shNair', 3, F_ATTACK | F_TAIL, 34);
const P_SH_FAIR = defPlan('shFair', 3, F_ATTACK | F_TAIL, 34);
const P_SH_BAIR = defPlan('shBair', 3, F_ATTACK | F_TAIL, 34);
const P_SH_UAIR = defPlan('shUair', 3, F_ATTACK | F_TAIL, 34);
const P_SH_DAIR = defPlan('shDair', 3, F_ATTACK | F_TAIL, 34);
const P_SH_FAIR_FF = defPlan('shFairFf', 3, F_ATTACK | F_TAIL, 30);
const P_SH_NAIR_FF = defPlan('shNairFf', 3, F_ATTACK | F_TAIL, 30);
const P_SH_BAIR_R = defPlan('shBairRetreat', 3, F_ATTACK | F_TAIL, 32);
const P_FH_FAIR = defPlan('fhFair', 6, F_ATTACK | F_TAIL, 40);
const P_FH_UAIR = defPlan('fhUair', 6, F_ATTACK | F_TAIL, 40);
const P_FH_UAIR_L = defPlan('fhUairLate', 12, F_ATTACK | F_TAIL, 40);
const P_FH_NAIR = defPlan('fhNair', 6, F_ATTACK | F_TAIL, 40);
const P_FH_BAIR = defPlan('fhBair', 6, F_ATTACK | F_TAIL, 40);
const P_SH_EMPTY_B = defPlan('emptyHopOut', 3, F_MOVE | F_TAIL, 26);
const P_SH_EMPTY_F = defPlan('emptyHopIn', 3, F_TAIL, 26);
const P_FH_EMPTY_N = defPlan('fullHop', 5, F_TAIL, 30);
const P_SHIELD = defPlan('shield', 3, F_INTR, 18);
const P_SPOT = defPlan('spotDodge', 2, F_STALE, 26);
const P_ROLL_F = defPlan('rollIn', 2, F_STALE, 28);
const P_ROLL_B = defPlan('rollOut', 2, F_MOVE | F_STALE, 28);
const P_PLATDROP = defPlan('platformDrop', 2, F_TAIL, 22);
const P_EG_HOG = defPlan('ledgeHog', 1, F_INTR | F_TAIL | F_EG, 50);
const P_EG_BAIR = defPlan('egBair', 12, F_ATTACK | F_TAIL | F_EG, 56);
const P_EG_FAIR = defPlan('egFair', 12, F_ATTACK | F_TAIL | F_EG, 56);
const P_EG_DAIR = defPlan('egDair', 12, F_ATTACK | F_TAIL | F_EG, 56);
const P_EG_NAIR = defPlan('egNair', 12, F_ATTACK | F_TAIL | F_EG, 56);
// Out of shield
const P_OOS_GRAB = defPlan('oosGrab', 2, F_ATTACK, 30);
const P_OOS_USMASH = defPlan('oosUsmash', 2, F_ATTACK, 38);
const P_OOS_USPEC = defPlan('oosGeyser', 2, F_ATTACK | F_TAIL, 40);
const P_OOS_NAIR = defPlan('oosNair', 3, F_ATTACK | F_TAIL, 32);
const P_OOS_UAIR = defPlan('oosUair', 3, F_ATTACK | F_TAIL, 32);
const P_OOS_FAIR = defPlan('oosFair', 3, F_ATTACK | F_TAIL, 32);
const P_OOS_BAIR = defPlan('oosBair', 3, F_ATTACK | F_TAIL, 32);
// Air
const P_A_NONE = defPlan('drift', 1, F_INTR | F_MOVE | F_TAIL, 20);
const P_A_F = defPlan('driftIn', 1, F_INTR | F_TAIL, 20);
const P_A_B = defPlan('driftOut', 1, F_INTR | F_MOVE | F_TAIL, 20);
const P_A_FF = defPlan('fastFall', 1, F_INTR | F_TAIL, 20);
const P_A_FF_F = defPlan('fastFallIn', 1, F_INTR | F_TAIL, 20);
const P_A_FF_B = defPlan('fastFallOut', 1, F_INTR | F_MOVE | F_TAIL, 20);
const P_A_NAIR = defPlan('nair', 2, F_ATTACK | F_TAIL, 30);
const P_A_FAIR = defPlan('fair', 2, F_ATTACK | F_TAIL, 30);
const P_A_BAIR = defPlan('bair', 2, F_ATTACK | F_TAIL, 30);
const P_A_UAIR = defPlan('uair', 2, F_ATTACK | F_TAIL, 30);
const P_A_DAIR = defPlan('dair', 2, F_ATTACK | F_TAIL, 30);
const P_A_NAIR_B = defPlan('nairOut', 2, F_ATTACK | F_TAIL, 30);
const P_A_BAIR_B = defPlan('bairOut', 2, F_ATTACK | F_TAIL, 30);
const P_A_FAIR_FF = defPlan('fairFf', 2, F_ATTACK | F_TAIL, 28);
const P_A_DAIR_FF = defPlan('dairFf', 2, F_ATTACK | F_TAIL, 28);
const P_A_DJ_F = defPlan('jumpIn', 3, F_TAIL, 26);
const P_A_DJ_B = defPlan('jumpOut', 3, F_MOVE | F_TAIL, 26);
const P_A_DJ_N = defPlan('jumpUp', 3, F_TAIL, 26);
const P_A_DJ_FAIR = defPlan('jumpFair', 4, F_ATTACK | F_TAIL, 32);
const P_A_DJ_UAIR = defPlan('jumpUair', 4, F_ATTACK | F_TAIL, 32);
const P_A_DJ_NAIR = defPlan('jumpNair', 4, F_ATTACK | F_TAIL, 32);
const P_A_DJ_BAIR = defPlan('jumpBair', 4, F_ATTACK | F_TAIL, 32);
const P_A_AD_F = defPlan('airDodgeIn', 2, F_TAIL, 34);
const P_A_AD_B = defPlan('airDodgeOut', 2, F_TAIL, 34);
const P_A_AD_S = defPlan('airDodgeHome', 2, F_TAIL, 34);
const P_A_USPEC = defPlan('airGeyser', 2, F_ATTACK | F_TAIL, 44);
const P_A_NSPEC = defPlan('airOrb', 2, F_ATTACK | F_PROJ | F_TAIL, 56);
const P_A_SSPEC = defPlan('airCrescent', 2, F_ATTACK | F_PROJ | F_TAIL, 56);
const P_REC_EARLY = defPlan('recoverEarly', 1, F_INTR, 60);
const P_REC_MID = defPlan('recover', 1, F_INTR, 60);
const P_REC_LATE = defPlan('recoverLate', 1, F_INTR, 60);
const P_REC_AD = defPlan('recoverDodge', 1, F_INTR, 60);
// Ledge
const P_L_WAIT = defPlan('ledgeWait', 1, F_INTR, 34);
const P_L_GETUP = defPlan('ledgeGetUp', 2, 0, 40);
const P_L_ATK = defPlan('ledgeAttack', 2, F_ATTACK, 44);
const P_L_ROLL = defPlan('ledgeRoll', 2, 0, 40);
const P_L_JUMP = defPlan('ledgeJump', 2, F_TAIL, 40);
const P_L_JUMP_FAIR = defPlan('ledgeJumpFair', 6, F_ATTACK | F_TAIL, 44);
const P_L_DROP_FAIR = defPlan('ledgeDropFair', 8, F_ATTACK | F_TAIL, 48);
// Downed
const P_D_UP = defPlan('getUp', 2, 0, 40);
const P_D_ATK = defPlan('getUpAttack', 2, F_ATTACK, 40);
const P_D_ROLL_L = defPlan('getUpRollLeft', 2, 0, 40);
const P_D_ROLL_R = defPlan('getUpRollRight', 2, 0, 40);
// Tech
const P_T_IN = defPlan('techInPlace', 16, 0, 36);
const P_T_L = defPlan('techLeft', 16, 0, 36);
const P_T_R = defPlan('techRight', 16, 0, 36);
// Holding a grab
const P_G_F = defPlan('fthrow', 2, 0, 40);
const P_G_B = defPlan('bthrow', 2, 0, 40);
const P_G_U = defPlan('uthrow', 2, 0, 40);
const P_G_D = defPlan('dthrow', 2, 0, 40);
const P_G_PUMMEL = defPlan('pummel', 2, 0, 24);
// Leaving tumble
const P_X_STAY = defPlan('tumbleStay', 1, F_INTR, 30);
const P_X_DJ_S = defPlan('tumbleJumpHome', 3, F_TAIL, 40);
const P_X_DJ_B = defPlan('tumbleJumpOut', 3, F_TAIL, 36);
const P_X_AD_S = defPlan('tumbleDodgeHome', 2, F_TAIL, 40);
const P_X_DRIFT_S = defPlan('tumbleDriftHome', 2, F_TAIL, 40);
const P_X_FF = defPlan('tumbleFastFall', 2, F_TAIL, 36);
const P_X_NAIR = defPlan('tumbleNair', 3, F_ATTACK | F_TAIL, 36);
// Final Smash
const P_FS = defPlan('finalSmash', 2, 0, 24);
const PLAN_COUNT = PLAN_NAME.length;

/** Debug name of a plan id, for the harness and the docs. */
export function aevalmerePlanName(id: number): string {
  return id >= 0 && id < PLAN_COUNT ? PLAN_NAME[id] : '?';
}

// Script context. Written before each planStep call; read by the scripts and policies.
let cPrev = 0;          // held bits of the previous frame on this fighter
let cDir = 1;           // toward the opponent, fixed when the plan was chosen
let cHome = 1;          // toward the stage centre, fixed when the plan was chosen
let cSi: StageInfo = { minX: -180, maxX: 180, topY: 0, cx: 0 };
let sHeld = 0;
let sDirect = 0;

/** A fresh press of `bit` if it is not held already this frame; nothing otherwise. */
function press(bit: number): number { return (cPrev & bit) === 0 ? bit : 0; }

/**
 * Holds a horizontal direction without ever turning it into the second tap of a double tap: the
 * press waits while the sim's own tap timer (rollTapWindow) would read it as a roll.
 */
function safeDir(bit: number, f: FighterState): number {
  if ((cPrev & bit) !== 0) return bit;
  if (!f.onGround) return bit;
  const d = bit === R ? 1 : -1;
  if (f.dirTapDir === d && f.dirTapAge + 1 <= TUNING.input.rollTapWindow + 1) return 0;
  return bit;
}

/** Recovery thresholds by variant: depth below the stage top to jump at, and to up special at. */
const REC_JUMP_AT = [-30, -5, 25, -5];
const REC_US_AT = [-10, 15, 45, 20];

/**
 * The recovery policy: head for the stage, double jump once falling past a depth, up special once
 * out of jumps past a deeper one, and (variant 3) air dodge onto the ledge when it is close.
 */
function recoverStep(f: FighterState, variant: number): void {
  if (f.onGround || isLedgeAction(f.action)) return;
  const si = cSi;
  const out = f.x < si.minX ? si.minX - f.x : f.x > si.maxX ? f.x - si.maxX : 0;
  if (out === 0 && f.y <= si.topY) return;
  const home = f.x < si.cx ? R : L;
  sHeld = (sHeld & ~(L | R)) | home;
  const below = f.y - si.topY;
  if (f.action !== 'air') return;
  if (f.jumpsLeft > 0 && f.vy > -0.5 && below > REC_JUMP_AT[variant]) {
    sHeld |= press(J);
    return;
  }
  if (variant === 3 && f.jumpsLeft === 0 && out < 70 && below > -20 && below < 40) {
    sDirect = C_DIRAD;
    sHeld |= U;
    return;
  }
  if (f.jumpsLeft === 0 && f.vy > 0 && below > REC_US_AT[variant]) {
    if ((cPrev & SP) === 0) sDirect = C_USPEC;
  }
}

/** Short-hop / full-hop aerial script: Jump held `hold` frames, the aerial sent on frame `atk`. */
function hopAerial(t: number, f: FighterState, code: number, drift: number, hold: number, atk: number, ff: boolean): void {
  if (t === 0) sHeld |= press(J);
  else if (t < hold) sHeld |= J;
  if (t === atk && code !== 0) sDirect = code;
  if (t >= 1) sHeld |= drift;
  if (ff && t > atk && !f.onGround && f.vy > 0 && !f.fastFalling && f.action === 'air') sHeld |= press(D);
}

/** Airborne aerial script: the aerial now, a drift, and optionally a fast fall once it is over. */
function airAerial(t: number, f: FighterState, code: number, drift: number, ff: boolean): void {
  if (t === 0) sDirect = code;
  sHeld |= drift;
  if (ff && t > 0 && f.vy > 0 && !f.fastFalling && f.action === 'air') sHeld |= press(D);
}

/** A double jump (fresh press) toward `drift`, then an optional aerial on frame 3. */
function jumpAerial(t: number, f: FighterState, code: number, drift: number): void {
  if (t === 0) sHeld |= press(J) | drift;
  else sHeld |= drift;
  if (t === 3 && code !== 0 && f.action === 'air') sDirect = code;
}

/**
 * One frame of plan `pid`, `t` frames after it was chosen, for fighter `f` (the real one or a
 * rollout copy). Leaves the input in sHeld / sDirect.
 */
function planStep(pid: number, t: number, f: FighterState): void {
  sHeld = 0;
  sDirect = 0;
  const T = dirBit(cDir);
  const B = dirBit(-cDir);
  const H = dirBit(cHome);
  switch (pid) {
    case P_WAIT: break;
    case P_WALK_F: sHeld = safeDir(T, f) | WK; break;
    case P_WALK_B: sHeld = safeDir(B, f) | WK; break;
    case P_DASH_F: sHeld = safeDir(T, f); break;
    case P_DASH_B: sHeld = safeDir(B, f); break;
    case P_DD_F: sHeld = safeDir(t < 6 ? B : T, f); break;
    case P_DD_B: sHeld = safeDir(t < 6 ? T : B, f); break;
    case P_JAB: if (t === 0) sDirect = C_JAB; break;
    case P_FTILT: if (t === 0) { sDirect = C_FTILT; sHeld = T; } break;
    case P_UTILT: if (t === 0) sDirect = C_UTILT; break;
    case P_DTILT: if (t === 0) { sDirect = C_DTILT; } break;
    case P_FSMASH: if (t === 0) { sDirect = C_FSMASH; if (f.facing !== cDir) sHeld = T; } break;
    case P_FSMASH_C: if (t === 0) sDirect = C_FSMASH; if (t < 13) sHeld = T; break;
    case P_USMASH: if (t === 0) sDirect = C_USMASH; break;
    case P_USMASH_C: if (t === 0) sDirect = C_USMASH; if (t < 13) sHeld = U; break;
    case P_DSMASH: if (t === 0) sDirect = C_DSMASH; break;
    case P_DASHATK: if (t === 0) { sDirect = C_DASHATK; sHeld = T; } break;
    case P_GRAB: if (t === 0) sHeld = press(G); break;
    case P_DASHGRAB: if (t < 3) sHeld = safeDir(T, f); else if (t === 3) sHeld = T | press(G); break;
    case P_NSPEC: if (t === 0) sDirect = C_NSPEC; break;
    case P_SSPEC: if (t === 0) { sDirect = C_SSPEC; sHeld = T; } break;
    case P_DSPEC: if (t === 0) sDirect = C_DSPEC; break;
    case P_USPEC_G: if (t === 0) sDirect = C_USPEC; sHeld |= T; break;
    case P_SH_NAIR: hopAerial(t, f, C_NAIR, T, 1, 1, false); break;
    case P_SH_FAIR: hopAerial(t, f, C_FAIR, T, 1, 1, false); break;
    case P_SH_BAIR: hopAerial(t, f, C_BAIR, 0, 1, 1, false); break;
    case P_SH_UAIR: hopAerial(t, f, C_UAIR, T, 1, 1, false); break;
    case P_SH_DAIR: hopAerial(t, f, C_DAIR, T, 1, 4, false); break;
    case P_SH_FAIR_FF: hopAerial(t, f, C_FAIR, T, 1, 1, true); break;
    case P_SH_NAIR_FF: hopAerial(t, f, C_NAIR, T, 1, 1, true); break;
    case P_SH_BAIR_R: hopAerial(t, f, C_BAIR, B, 1, 1, true); break;
    case P_FH_FAIR: hopAerial(t, f, C_FAIR, T, 4, 6, false); break;
    case P_FH_UAIR: hopAerial(t, f, C_UAIR, T, 4, 6, false); break;
    case P_FH_UAIR_L: hopAerial(t, f, C_UAIR, T, 4, 12, false); break;
    case P_FH_NAIR: hopAerial(t, f, C_NAIR, T, 4, 6, false); break;
    case P_FH_BAIR: hopAerial(t, f, C_BAIR, B, 4, 6, false); break;
    case P_SH_EMPTY_B: hopAerial(t, f, 0, B, 1, 99, true); break;
    case P_SH_EMPTY_F: hopAerial(t, f, 0, T, 1, 99, true); break;
    case P_FH_EMPTY_N: hopAerial(t, f, 0, 0, 4, 99, false); break;
    case P_SHIELD: sHeld = SH; break;
    case P_SPOT: if (t === 0) sDirect = C_SPOT; break;
    case P_ROLL_F: if (t === 0) sDirect = f.facing === cDir ? C_ROLLF : C_ROLLB; break;
    case P_ROLL_B: if (t === 0) sDirect = f.facing === cDir ? C_ROLLB : C_ROLLF; break;
    case P_PLATDROP: if (t === 0) sHeld = press(D); break;
    case P_EG_HOG: {
      // Run for the nearer ledge, and once past the corner turn back toward the stage so the fall snaps to it.
      const nearL = Math.abs(f.x - cSi.minX) < Math.abs(f.x - cSi.maxX);
      const edgeX = nearL ? cSi.minX : cSi.maxX;
      const outBit = nearL ? L : R;
      const inBit = nearL ? R : L;
      if (f.onGround && Math.abs(f.x - edgeX) > 1) sHeld = safeDir(outBit, f);
      else if (!f.onGround) sHeld = inBit;
      break;
    }
    case P_EG_BAIR: case P_EG_FAIR: case P_EG_DAIR: case P_EG_NAIR: {
      // Hop off toward the recovering opponent and meet them with the aerial on frame 8.
      const code = pid === P_EG_BAIR ? C_BAIR : pid === P_EG_FAIR ? C_FAIR : pid === P_EG_DAIR ? C_DAIR : C_NAIR;
      if (f.onGround && t < 2) sHeld = press(J) | T;
      else sHeld = pid === P_EG_BAIR ? B : T;
      if (t === 8) sDirect = code;
      break;
    }
    case P_OOS_GRAB: sHeld = SH | (t === 0 ? press(A) : 0); break;
    case P_OOS_USMASH: sHeld = t === 0 ? SH | U | press(A) : 0; break;
    case P_OOS_USPEC: if (t === 0) { sHeld = SH | U | press(SP); } else sHeld = T; break;
    case P_OOS_NAIR: if (t === 0) sHeld = SH | press(J); else hopAerial(t, f, C_NAIR, T, 1, 1, true); break;
    case P_OOS_UAIR: if (t === 0) sHeld = SH | press(J); else hopAerial(t, f, C_UAIR, T, 1, 1, false); break;
    case P_OOS_FAIR: if (t === 0) sHeld = SH | press(J); else hopAerial(t, f, C_FAIR, T, 1, 1, true); break;
    case P_OOS_BAIR: if (t === 0) sHeld = SH | press(J); else hopAerial(t, f, C_BAIR, B, 1, 1, true); break;
    case P_A_NONE: break;
    case P_A_F: sHeld = T; break;
    case P_A_B: sHeld = B; break;
    case P_A_FF: if (f.vy > 0 && !f.fastFalling) sHeld = press(D); break;
    case P_A_FF_F: sHeld = T | (f.vy > 0 && !f.fastFalling ? press(D) : 0); break;
    case P_A_FF_B: sHeld = B | (f.vy > 0 && !f.fastFalling ? press(D) : 0); break;
    case P_A_NAIR: airAerial(t, f, C_NAIR, T, false); break;
    case P_A_FAIR: airAerial(t, f, C_FAIR, T, false); break;
    case P_A_BAIR: airAerial(t, f, C_BAIR, T, false); break;
    case P_A_UAIR: airAerial(t, f, C_UAIR, T, false); break;
    case P_A_DAIR: airAerial(t, f, C_DAIR, T, false); break;
    case P_A_NAIR_B: airAerial(t, f, C_NAIR, B, true); break;
    case P_A_BAIR_B: airAerial(t, f, C_BAIR, B, true); break;
    case P_A_FAIR_FF: airAerial(t, f, C_FAIR, T, true); break;
    case P_A_DAIR_FF: airAerial(t, f, C_DAIR, T, true); break;
    case P_A_DJ_F: jumpAerial(t, f, 0, T); break;
    case P_A_DJ_B: jumpAerial(t, f, 0, B); break;
    case P_A_DJ_N: jumpAerial(t, f, 0, 0); break;
    case P_A_DJ_FAIR: jumpAerial(t, f, C_FAIR, T); break;
    case P_A_DJ_UAIR: jumpAerial(t, f, C_UAIR, T); break;
    case P_A_DJ_NAIR: jumpAerial(t, f, C_NAIR, T); break;
    case P_A_DJ_BAIR: jumpAerial(t, f, C_BAIR, B); break;
    case P_A_AD_F: if (t === 0) sDirect = C_DIRAD; sHeld = T; break;
    case P_A_AD_B: if (t === 0) sDirect = C_DIRAD; sHeld = B; break;
    case P_A_AD_S: if (t === 0) sDirect = C_DIRAD; sHeld = H | (t === 0 ? U : 0); break;
    case P_A_USPEC: if (t === 0) sDirect = C_USPEC; sHeld = offstage(f, cSi) ? H : T; break;
    case P_A_NSPEC: if (t === 0) sDirect = C_NSPEC; break;
    case P_A_SSPEC: if (t === 0) { sDirect = C_SSPEC; sHeld = T; } break;
    case P_REC_EARLY: recoverStep(f, 0); break;
    case P_REC_MID: recoverStep(f, 1); break;
    case P_REC_LATE: recoverStep(f, 2); break;
    case P_REC_AD: recoverStep(f, 3); break;
    case P_L_WAIT: break;
    case P_L_GETUP: if (t === 0) sDirect = C_LUP; break;
    case P_L_ATK: if (t === 0) sDirect = C_LATK; break;
    case P_L_ROLL: if (t === 0) sDirect = C_LROLL; break;
    case P_L_JUMP: if (t === 0) sDirect = C_LJUMP; sHeld = H; break;
    case P_L_JUMP_FAIR: if (t === 0) sDirect = C_LJUMP; if (t === 5) sDirect = C_FAIR; sHeld = H; break;
    case P_L_DROP_FAIR: {
      // Drop off the ledge, jump straight back, and fair onto the stage.
      const away = f.facing === 1 ? L : R;
      if (t === 0) sHeld = press(away);
      else if (t === 3) sHeld = press(J) | H;
      else sHeld = H;
      if (t === 6) sDirect = C_FAIR;
      break;
    }
    case P_D_UP: if (t === 0) sHeld = press(U); break;
    case P_D_ATK: if (t === 0) sDirect = C_GUATK; break;
    case P_D_ROLL_L: if (t === 0) sHeld = press(L); break;
    case P_D_ROLL_R: if (t === 0) sHeld = press(R); break;
    case P_T_IN: if (t === 0) sHeld = press(SH); break;
    case P_T_L: sHeld = L | (t === 0 ? press(SH) : 0); break;
    case P_T_R: sHeld = R | (t === 0 ? press(SH) : 0); break;
    case P_G_F: if (t === 0) sDirect = C_FTHROW; break;
    case P_G_B: if (t === 0) sDirect = C_BTHROW; break;
    case P_G_U: if (t === 0) sDirect = C_UTHROW; break;
    case P_G_D: if (t === 0) sDirect = C_DTHROW; break;
    case P_G_PUMMEL: if (t === 0) sDirect = C_PUMMEL; break;
    case P_X_STAY: break;
    case P_X_DJ_S: if (t === 0) sHeld = press(G); else if (t === 2) sHeld = press(J) | H; else sHeld = H; break;
    case P_X_DJ_B: if (t === 0) sHeld = press(G); else if (t === 2) sHeld = press(J) | B; else sHeld = B; break;
    case P_X_AD_S: if (t === 0) { sDirect = C_DIRAD; sHeld = H | U; } else sHeld = H; break;
    case P_X_DRIFT_S: if (t === 0) sHeld = press(G); else sHeld = H; break;
    case P_X_FF: if (t === 0) sHeld = press(G); else if (f.vy > 0 && !f.fastFalling) sHeld = press(D); break;
    case P_X_NAIR: if (t === 0) sHeld = press(G); else sHeld = B; if (t === 2) sDirect = C_NAIR; break;
    case P_FS: if (t === 0) sDirect = C_FS; break;
    default: break;
  }
  if ((PLAN_FLAGS[pid] & F_TAIL) !== 0 && t >= PLAN_MIN[pid] && offstage(f, cSi)) recoverStep(f, 1);
}

// ---------------------------------------------------------------------------
// Opponent reply models, run inside the rollouts. Built from the opponent's state only.
// ---------------------------------------------------------------------------

const OM_CONT = 0;      // keeps holding what it held, presses nothing new
const OM_DEF = 1;       // shields (air dodges in the air), then grabs out of shield
const OM_ATK = 2;       // closes and hits with its fastest reaching option
const OM_REC = 3;       // off the stage: recovers
const OM_L_UP = 4;      // on the ledge: climbs
const OM_L_ATK = 5;     // ledge attack
const OM_L_ROLL = 6;    // ledge roll
const OM_L_JUMP = 7;    // ledge jump
const OM_T_NONE = 8;    // launched: no tech, lies down
const OM_T_IN = 9;      // techs in place
const OM_T_TO = 10;     // tech rolls toward us
const OM_T_AWAY = 11;   // tech rolls away
const OM_ESC = 12;      // air dodges out of hitstun as soon as it ends
const OM_D_UP = 13;     // downed: stands
const OM_D_ATK = 14;    // get-up attack
const OM_D_TO = 15;     // rolls toward us
const OM_D_AWAY = 16;   // rolls away
const OM_R_TO = 17;     // rolls toward us (out of a shield, usually)
const OM_R_AWAY = 18;   // rolls away

let oPrev = 0;
let oHeld = 0;
let oDirect = 0;
let oCont = 0;          // held bits the opponent had when the rollout started
let oTeched = false;

function oPress(bit: number): number { return (oPrev & bit) === 0 ? bit : 0; }

function oppActionable(o: FighterState): boolean {
  return actionableNow(o) && o.action !== 'ledgeHang' && o.action !== 'downed' && o.action !== 'grabHold';
}

function oppStep(model: number, t: number, o: FighterState, m: FighterState): void {
  oHeld = 0;
  oDirect = 0;
  const toMe = m.x < o.x ? L : R;
  const away = m.x < o.x ? R : L;
  const adx = Math.abs(m.x - o.x);
  const dy = m.y - o.y;
  if (model !== OM_CONT && offstage(o, cSi)) model = OM_REC;
  switch (model) {
    case OM_CONT:
      oHeld = oCont;
      if (offstage(o, cSi)) model = OM_REC; else return;
      break;
    case OM_DEF:
      if (o.onGround) {
        oHeld = SH;
        const kit = grabKitOf(CHARACTER_DEFS[o.charId]);
        if (o.action === 'shield' && adx < kit.stand.x + kit.stand.r + 13 && Math.abs(dy) < 30 && m.invuln === 0) {
          oHeld |= oPress(A);
        }
      } else if (t === 0 && oppActionable(o)) {
        oDirect = C_DIRAD;
        oHeld = away;
      } else {
        oHeld = away;
      }
      return;
    case OM_ATK: {
      if (!oppActionable(o) && o.action !== 'shield') { oHeld = 0; return; }
      if (o.onGround) {
        if (m.action === 'shield' && adx < 38 && Math.abs(dy) < 30) { oHeld = o.action === 'shield' ? SH | oPress(A) : oPress(G); return; }
        if (o.action === 'shield') { oHeld = 0; return; }
        if (dy < -40 && adx < 30) { oDirect = C_UTILT; return; }
        if (adx <= 40 && Math.abs(dy) < 40) { oDirect = (o.facing === 1) === (m.x > o.x) ? C_JAB : C_FTILT; oHeld = toMe; return; }
        if (adx <= 58 && Math.abs(dy) < 40) { oDirect = C_FTILT; oHeld = toMe; return; }
        if (adx <= 92 && Math.abs(dy) < 40) { oDirect = C_DASHATK; oHeld = toMe; return; }
        oHeld = toMe;
        return;
      }
      oHeld = toMe;
      if (adx < 40 && Math.abs(dy) < 44) oDirect = dy < -24 ? C_UAIR : dy > 24 ? C_DAIR : C_NAIR;
      return;
    }
    case OM_L_UP: if (t === 0 && o.action === 'ledgeHang') oDirect = C_LUP; return;
    case OM_L_ATK: if (t === 0 && o.action === 'ledgeHang') oDirect = C_LATK; return;
    case OM_L_ROLL: if (t === 0 && o.action === 'ledgeHang') oDirect = C_LROLL; return;
    case OM_L_JUMP: if (t === 0 && o.action === 'ledgeHang') oDirect = C_LJUMP; return;
    case OM_T_NONE: return;
    case OM_T_IN: case OM_T_TO: case OM_T_AWAY: {
      if (model === OM_T_TO) oHeld = toMe;
      else if (model === OM_T_AWAY) oHeld = away;
      // The press lands a few frames before touchdown, well inside TECH.window.
      if (!oTeched && launched(o) && o.vy > 0 && o.y > cSi.topY - 30 && o.x > cSi.minX && o.x < cSi.maxX) {
        oHeld |= oPress(SH);
        oTeched = true;
      }
      return;
    }
    case OM_ESC:
      if (o.action === 'tumble' && o.hitstun <= 0) { oDirect = C_DIRAD; oHeld = away; }
      else oHeld = away;
      return;
    case OM_D_UP: if (o.action === 'downed') oHeld = oPress(U); return;
    case OM_D_ATK: if (o.action === 'downed') oDirect = C_GUATK; return;
    case OM_D_TO: if (o.action === 'downed') oHeld = oPress(toMe); return;
    case OM_D_AWAY: if (o.action === 'downed') oHeld = oPress(away); return;
    case OM_R_TO: case OM_R_AWAY:
      if (t === 0 && o.onGround && (oppActionable(o) || o.action === 'shieldStun')) {
        const toward = model === OM_R_TO;
        const faceIn = (o.facing === 1) === (m.x > o.x);
        oDirect = toward === faceIn ? C_ROLLF : C_ROLLB;
      }
      return;
    default: break;
  }
  if (model === OM_REC) {
    // The same recovery policy the brain uses for itself, run on the opponent's fighter.
    const saveHeld = sHeld; const saveDirect = sDirect; const savePrev = cPrev;
    sHeld = 0; sDirect = 0; cPrev = oPrev;
    recoverStep(o, 1);
    oHeld = sHeld; oDirect = sDirect;
    sHeld = saveHeld; sDirect = saveDirect; cPrev = savePrev;
  }
}

// ---------------------------------------------------------------------------
// Per-slot memory
// ---------------------------------------------------------------------------

const HB_LEDGE = 0;     // after hanging: [climb, attack, roll, jump, drop]
const HB_TECH = 1;      // tumble landing: [none, in place, toward, away]
const HB_DOWN = 2;      // downed: [stand, attack, toward, away]
const HB_ESC = 3;       // leaving hitstun in the air: [attack, air dodge, jump, nothing]
const HB_NEUTRAL = 4;   // next thing started in neutral or after landing: [attack, shield or dodge, move, nothing]
const HB_SHIELD = 5;    // leaving a shield: [attack or grab, drop it, roll toward, roll away, jump]
const HB_COUNT = 6;
const HB_WIDTH = 5;

interface Scratch { st: GameState }

interface AmMem {
  matchRef: GameState['config'] | null;
  lastFrame: number;
  prevHeld: number;
  plan: number;
  planT: number;
  planDir: number;
  planHome: number;
  lastDecide: number;
  lastSig: number;
  hist: Scratch[];
  histFrame: Int32Array;
  outHeld: Int32Array;
  outDirect: Int32Array;
  perceived: Scratch | null;
  work: Scratch | null;
  // Opponent observation
  oppIdx: number;
  oppPrevAction: string;
  oppPrevMove: string | null;
  oppPrevHitstun: number;
  oppEscWatch: number;
  oppIdleRun: number;       // frames the opponent has stood free in neutral without starting anything
  habits: Float64Array;
  recent: Int32Array;       // last 16 opponent move starts, as MOVE_INDEX
  recentPos: number;
  repetition: number;       // share of those that are the single most common move, 0..1
  // Combo bookkeeping
  lastStarter: number;      // COMBO_MOVES index of our last hit on the opponent, -1 none
  lastDamageFrame: number;
  lastStageDamage: number;
  used: Float64Array;       // recent-use count per plan, for STALE_COST
  // Debug counters for the harness
  decisions: number;
  steps: number;
  alternates: number;
  mashPhase: number;
  techBusy: number;
}

const memSlots: AmMem[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  memSlots.push({
    matchRef: null, lastFrame: -1, prevHeld: 0, plan: -1, planT: 0, planDir: 1, planHome: 1,
    lastDecide: -999, lastSig: -1,
    hist: [], histFrame: new Int32Array(HIST), outHeld: new Int32Array(HIST), outDirect: new Int32Array(HIST),
    perceived: null, work: null,
    oppIdx: -1, oppPrevAction: '', oppPrevMove: null, oppPrevHitstun: 0, oppEscWatch: 0, oppIdleRun: 0,
    habits: new Float64Array(HB_COUNT * HB_WIDTH), recent: new Int32Array(16), recentPos: 0, repetition: 0,
    lastStarter: -1, lastDamageFrame: 0, lastStageDamage: 0, used: new Float64Array(PLAN_COUNT),
    decisions: 0, steps: 0, alternates: 0, mashPhase: 0, techBusy: 0,
  });
}

function resetMem(mem: AmMem): void {
  mem.matchRef = null; mem.lastFrame = -1; mem.prevHeld = 0; mem.plan = -1; mem.planT = 0;
  mem.planDir = 1; mem.planHome = 1; mem.lastDecide = -999; mem.lastSig = -1;
  mem.histFrame.fill(-1); mem.outHeld.fill(0); mem.outDirect.fill(0);
  mem.oppIdx = -1; mem.oppPrevAction = ''; mem.oppPrevMove = null; mem.oppPrevHitstun = 0; mem.oppEscWatch = 0; mem.oppIdleRun = 0;
  mem.habits.fill(1); mem.recent.fill(-1); mem.recentPos = 0; mem.repetition = 0;
  mem.lastStarter = -1; mem.lastDamageFrame = 0; mem.lastStageDamage = 0; mem.used.fill(0);
  mem.decisions = 0; mem.steps = 0; mem.alternates = 0; mem.mashPhase = 0; mem.techBusy = 0;
}
for (let i = 0; i < memSlots.length; i++) resetMem(memSlots[i]);

/** Debug counters for the harness: decisions made, sim steps spent, safe alternates taken. */
export function aevalmereStats(slot: number): { decisions: number; steps: number; alternates: number; plan: string } {
  const m = memSlots[slot];
  return { decisions: m.decisions, steps: m.steps, alternates: m.alternates, plan: aevalmerePlanName(m.plan) };
}

// ---------------------------------------------------------------------------
// Combo table: precomputed at module init from the move data (see buildComboTable)
// ---------------------------------------------------------------------------

const COMBO_MOVES: readonly MoveId[] = [
  'jab', 'ftilt', 'utilt', 'dtilt', 'dashatk', 'fsmash', 'usmash', 'dsmash',
  'nair', 'fair', 'bair', 'uair', 'dair', 'uspecial',
];
const COMBO_THROWS = ['fthrow', 'bthrow', 'uthrow', 'dthrow'] as const;
const N_STARTERS = COMBO_MOVES.length + COMBO_THROWS.length;
const BRACKETS = [15, 45, 80, 120];
const N_BRACKET = BRACKETS.length;
const N_POS = 3;          // 0 mid-stage, 1 near a ledge, 2 airborne above us
/** Up to three follow-ups per entry, best chain first, as COMBO_MOVES indexes; -1 empty. */
const comboNext = new Int8Array(N_STARTERS * N_BRACKET * N_POS * 3).fill(-1);
const comboLen = new Int8Array(N_STARTERS * N_BRACKET * N_POS);
const comboDamage = new Float32Array(N_STARTERS * N_BRACKET * N_POS);
const comboKills = new Uint8Array(N_STARTERS * N_BRACKET * N_POS);
let comboSig = '';

function bracketOf(p: number): number { return p < 30 ? 0 : p < 60 ? 1 : p < 100 ? 2 : 3; }

interface HitSpec { start: number; x: number; y: number; r: number; damage: number; angle: number; bkb: number; kbg: number }
const hitSpec: HitSpec = { start: 0, x: 0, y: 0, r: 0, damage: 0, angle: 0, bkb: 0, kbg: 0 };

/** The strongest hitbox of a move, or of a throw, into hitSpec. False when there is none. */
function loadHit(idx: number): boolean {
  const def = CHARACTER_DEFS.aeval;
  if (idx >= COMBO_MOVES.length) {
    const th = grabKitOf(def).throws[COMBO_THROWS[idx - COMBO_MOVES.length]];
    hitSpec.start = th.releaseFrame; hitSpec.x = 18; hitSpec.y = -10; hitSpec.r = 0;
    hitSpec.damage = th.damage; hitSpec.angle = th.angle; hitSpec.bkb = th.bkb; hitSpec.kbg = th.kbg;
    return true;
  }
  const mv = def.moves[COMBO_MOVES[idx]];
  let best = -1;
  for (let i = 0; i < mv.hitboxes.length; i++) {
    if (best < 0 || mv.hitboxes[i].damage > mv.hitboxes[best].damage) best = i;
  }
  if (best < 0) return false;
  const hb = mv.hitboxes[best];
  hitSpec.start = hb.start; hitSpec.x = hb.x; hitSpec.y = hb.y; hitSpec.r = hb.r;
  hitSpec.damage = hb.damage; hitSpec.angle = hb.angle; hitSpec.bkb = hb.bkb; hitSpec.kbg = hb.kbg;
  return true;
}

/** Frames our side stays busy after landing starter `idx`, counted from its hit frame. */
function starterLag(idx: number): number {
  const def = CHARACTER_DEFS.aeval;
  if (idx >= COMBO_MOVES.length) {
    const th = grabKitOf(def).throws[COMBO_THROWS[idx - COMBO_MOVES.length]];
    return th.totalFrames - th.releaseFrame;
  }
  const mv = def.moves[COMBO_MOVES[idx]];
  const hitAt = moveStartup(mv);
  if (mv.airOnly === true) {
    // Out of a short hop: fast fall to the floor, then the landing lag.
    return Math.min(mv.totalFrames - hitAt, 8) + (mv.landingLag === undefined ? 4 : mv.landingLag);
  }
  if (COMBO_MOVES[idx] === 'uspecial') return 999;
  return (mv.iasa === undefined ? mv.totalFrames : mv.iasa) - hitAt;
}

const comboOut = { dx: 0, dy: 0, hitstun: 0, kb: 0, vx: 0, vy: 0 };

/** Launch of hit `hitSpec` on a victim at percent p (after the hit), into comboOut after `frames`. */
function launchAfter(p: number, frames: number, grounded: boolean): void {
  const def = CHARACTER_DEFS.aeval;
  const kb = knockback(p, def.weight, hitSpec.damage, hitSpec.bkb, hitSpec.kbg) * TUNING.knockback.kbMul;
  const local = hitSpec.angle !== 361 ? hitSpec.angle : kb < TUNING.knockback.sakuraiThreshold ? 0 : 40;
  const rad = (local * Math.PI) / 180;
  let dirX = Math.cos(rad);
  let dirY = -Math.sin(rad);
  if (grounded && local < 15 && kb < TUNING.knockback.tumbleKb) dirY = 0;
  if (!Number.isFinite(dirX)) dirX = 0;
  let spd = kb * TUNING.knockback.toVel;
  let fall = 0;
  let x = 0; let y = 0; let vx = dirX * spd; let vy = dirY * spd;
  const hs = Math.floor(kb * TUNING.knockback.hitstunPerKb);
  const airborne = dirY < 0 || !grounded;
  for (let k = 0; k < frames && k < hs; k++) {
    spd = Math.max(0, spd - TUNING.knockback.decay);
    if (airborne) fall = Math.min(def.maxFall, fall + def.gravity);
    vx = dirX * spd; vy = dirY * spd + fall;
    x += vx; y += vy;
    if (!airborne && y > 0) y = 0;
  }
  comboOut.dx = x; comboOut.dy = y; comboOut.hitstun = hs; comboOut.kb = kb; comboOut.vx = vx; comboOut.vy = vy;
}

/**
 * True when a launch of hitSpec on a victim at percent p, from a victim spot of class `pos`, is
 * carried out of the blast rect: stepped the way the sim steps hitstun, then a short tail.
 */
function launchKills(p: number, pos: number, blast: Rect, si: StageInfo): boolean {
  const def = CHARACTER_DEFS.aeval;
  const kb = knockback(p, def.weight, hitSpec.damage, hitSpec.bkb, hitSpec.kbg) * TUNING.knockback.kbMul;
  const local = hitSpec.angle !== 361 ? hitSpec.angle : kb < TUNING.knockback.sakuraiThreshold ? 0 : 40;
  const rad = (local * Math.PI) / 180;
  const dirX = Math.cos(rad);
  const dirY = -Math.sin(rad);
  let spd = kb * TUNING.knockback.toVel;
  let fall = 0;
  // Launched toward the nearer blast line from a ledge spot, from the middle otherwise.
  let x = pos === 1 ? si.maxX - 20 : si.cx;
  let y = pos === 2 ? si.topY - 80 : si.topY - 10;
  const hs = Math.floor(kb * TUNING.knockback.hitstunPerKb);
  let vx = 0; let vy = 0;
  for (let k = 0; k < hs; k++) {
    spd = Math.max(0, spd - TUNING.knockback.decay);
    fall = Math.min(def.maxFall, fall + def.gravity);
    vx = dirX * spd; vy = dirY * spd + fall;
    x += vx; y += vy;
    if (x < blast.x || x > blast.x + blast.w || y < blast.y || y > blast.y + blast.h) return true;
  }
  return false;
}

/**
 * Whether follow-up `f` connects after starter hitSpec, on a victim at percent p: our remaining
 * lag plus the follow-up's startup (and a jump squat for an aerial) has to fit inside the victim's
 * hitstun, and the victim's body at that frame has to sit where the follow-up's hitbox can be
 * brought: dash distance for a grounded move, short or full hop height for an aerial.
 */
function followFits(starter: number, p: number, grounded: boolean, f: number): boolean {
  const def = CHARACTER_DEFS.aeval;
  const mv = def.moves[COMBO_MOVES[f]];
  const st = moveStartup(mv);
  if (st < 0) return false;
  const lag = starterLag(starter);
  if (lag > 200) return false;
  const aerial = mv.airOnly === true;
  const reach = lag + st + (aerial ? def.jumpSquat : 0);
  loadHit(starter);
  launchAfter(p, reach, grounded);
  if (reach > comboOut.hitstun) return false;
  // Where the victim's feet sit relative to the spot we hit them from.
  const startX = hitSpec.x + 13;
  const vdx = startX + comboOut.dx;
  const vdy = comboOut.dy;
  // The follow-up's own best box.
  let best = -1;
  for (let i = 0; i < mv.hitboxes.length; i++) if (best < 0 || mv.hitboxes[i].damage > mv.hitboxes[best].damage) best = i;
  const hb = mv.hitboxes[best];
  const slack = comboOut.hitstun - reach;
  const travel = aerial ? def.airSpeed * (st + slack) : def.dashSpeed * Math.max(0, slack);
  const needX = Math.abs(vdx - hb.x) - hb.r - 13;
  if (needX > travel) return false;
  // Vertical: the box band against the body band [vdy - 40, vdy], lifted by a hop for aerials.
  const t = st;
  const lift = aerial ? Math.max(3.5 * t - 0.075 * t * t, Math.min(97, 5.4 * t - 0.075 * t * t)) : 0;
  const top = hb.y - hb.r - lift - (aerial ? 50 : 0);
  const bottom = hb.y + hb.r - (aerial ? 0 : 0);
  return top <= vdy && bottom >= vdy - 40;
}

let chainBestDmg = 0;
let chainBestLen = 0;
let chainBestKill = false;

function chainSearch(starter: number, p: number, grounded: boolean, depth: number, dmg: number, pos: number, blast: Rect, si: StageInfo): void {
  loadHit(starter);
  const kills = launchKills(p, pos, blast, si);
  const value = dmg + (kills ? 60 : 0);
  const bestValue = chainBestDmg + (chainBestKill ? 60 : 0);
  if (value > bestValue || (value === bestValue && depth > chainBestLen)) {
    chainBestDmg = dmg; chainBestLen = depth; chainBestKill = kills;
  }
  if (depth >= 4 || kills) return;
  for (let f = 0; f < COMBO_MOVES.length; f++) {
    if (!followFits(starter, p, grounded, f)) continue;
    loadHit(f);
    const d = hitSpec.damage;
    chainSearch(f, p + d, false, depth + 1, dmg + d, pos, blast, si);
  }
}

/**
 * The combo table. For every starter (each move's strongest hitbox, and each throw), each victim
 * percent bracket, and each victim spot class, it lists the follow-ups that are true combos by the
 * sim's own hitstun formula, ranked by the best chain (up to 4 hits) each one opens, and whether
 * that chain ends in a launch that crosses the blast rect. Rebuilt whenever the knockback tuning
 * or the blast rect changes, so the F4 panel's sliders keep it honest.
 */
function buildComboTable(stageId: string): void {
  const kbT = TUNING.knockback;
  const blast = STAGE_DEFS[stageId].blast;
  const sig = `${kbT.toVel}|${kbT.decay}|${kbT.hitstunPerKb}|${kbT.tumbleKb}|${kbT.kbMul}|${kbT.sakuraiThreshold}|${blast.x}|${blast.y}|${blast.w}|${blast.h}|${stageId}`;
  if (sig === comboSig) return;
  comboSig = sig;
  const si = stageInfo(stageId);
  comboNext.fill(-1); comboLen.fill(0); comboDamage.fill(0); comboKills.fill(0);
  const scoreF = new Float32Array(COMBO_MOVES.length);
  for (let s = 0; s < N_STARTERS; s++) {
    if (!loadHit(s)) continue;
    for (let b = 0; b < N_BRACKET; b++) {
      for (let pos = 0; pos < N_POS; pos++) {
        const p0 = BRACKETS[b];
        loadHit(s);
        const pAfter = p0 + hitSpec.damage;
        const grounded = pos !== 2;
        scoreF.fill(-1);
        let bestLen = 1; let bestDmg = 0; let bestKill = false;
        for (let f = 0; f < COMBO_MOVES.length; f++) {
          if (!followFits(s, pAfter, grounded, f)) continue;
          loadHit(f);
          const d = hitSpec.damage;
          chainBestDmg = 0; chainBestLen = 0; chainBestKill = false;
          chainSearch(f, pAfter + d, false, 2, d, pos, blast, si);
          scoreF[f] = chainBestDmg + (chainBestKill ? 60 : 0);
          if (scoreF[f] > bestDmg + (bestKill ? 60 : 0)) { bestDmg = chainBestDmg; bestLen = chainBestLen; bestKill = chainBestKill; }
        }
        const e = (s * N_BRACKET + b) * N_POS + pos;
        for (let k = 0; k < 3; k++) {
          let bi = -1;
          for (let f = 0; f < COMBO_MOVES.length; f++) if (scoreF[f] >= 0 && (bi < 0 || scoreF[f] > scoreF[bi])) bi = f;
          if (bi < 0) break;
          comboNext[e * 3 + k] = bi;
          scoreF[bi] = -1;
        }
        comboLen[e] = bestLen; comboDamage[e] = bestDmg; comboKills[e] = bestKill ? 1 : 0;
      }
    }
  }
}

// Precomputed at module init for the first stage in the registry; a match on another stage, or a
// knockback retune from the F4 panel, rebuilds it at the next match start.
buildComboTable(Object.keys(STAGE_DEFS)[0]);

/** Debug read of the combo table for the harness and the docs. */
export function aevalmereComboSummary(stageId: string): { entries: number; chains3: number; chains4: number; kills: number; example: string } {
  buildComboTable(stageId);
  let entries = 0; let chains3 = 0; let chains4 = 0; let kills = 0;
  let example = '';
  for (let s = 0; s < N_STARTERS; s++) {
    for (let b = 0; b < N_BRACKET; b++) {
      for (let pos = 0; pos < N_POS; pos++) {
        const e = (s * N_BRACKET + b) * N_POS + pos;
        if (comboNext[e * 3] < 0) continue;
        entries++;
        if (comboLen[e] >= 3) chains3++;
        if (comboLen[e] >= 4) chains4++;
        if (comboKills[e] === 1) kills++;
        if (example === '' && comboLen[e] >= 3) {
          const name = s < COMBO_MOVES.length ? COMBO_MOVES[s] : COMBO_THROWS[s - COMBO_MOVES.length];
          example = `${name} at ${BRACKETS[b]}% -> ${COMBO_MOVES[comboNext[e * 3]]} (chain ${comboLen[e]} hits, ${comboDamage[e].toFixed(0)}%${comboKills[e] ? ', kills' : ''})`;
        }
      }
    }
  }
  return { entries, chains3, chains4, kills, example };
}

function comboIndexOf(id: string | null): number {
  if (id === null) return -1;
  for (let i = 0; i < COMBO_MOVES.length; i++) if (COMBO_MOVES[i] === id) return i;
  for (let i = 0; i < COMBO_THROWS.length; i++) if (COMBO_THROWS[i] === id) return COMBO_MOVES.length + i;
  return -1;
}

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------

const rollInputs: InputFrame[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) rollInputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });
const rollPrev = new Int32Array(MAX_PLAYERS);

/** What the last rollout saw, beside its score. */
let rDealt = 0;
let rTaken = 0;
let rKoOpp = 0;
let rKoMe = 0;
/** Teams: KOs of other enemies than the modelled one, KOs and damage of our teammates. */
let rKoOther = 0;
let rKoMate = 0;
let rMateTaken = 0;
let rGrabbed = false;
let rFsCaught = false;
let rBackHome = false;

interface Base { myPct: number; oppPct: number; myStocks: number; oppStocks: number; stall: boolean }
const base: Base = { myPct: 0, oppPct: 0, myStocks: 0, oppStocks: 0, stall: false };

/**
 * Runs plan `pid` for `h` frames on a copy of `from`, the opponent replying with `model`, and
 * scores the future. Everyone else keeps holding what they held.
 */
function rollout(from: GameState, work: GameState, meI: number, oppI: number, pid: number, model: number, h: number, myPrev: number): number {
  copyGameStateInto(from, work);
  const fs = work.fighters;
  for (let i = 0; i < fs.length; i++) rollPrev[i] = fs[i].inputHeld;
  rollPrev[meI] = myPrev;
  oCont = fs[oppI].inputHeld;
  oTeched = false;
  rDealt = 0; rTaken = 0; rKoOpp = 0; rKoMe = 0; rKoOther = 0; rKoMate = 0; rMateTaken = 0; rGrabbed = false; rFsCaught = false; rBackHome = false;
  const meSlot = fs[meI].slot;
  const oppSlot = fs[oppI].slot;
  let t = 0;
  for (; t < h; t++) {
    const m = fs[meI];
    const o = fs[oppI];
    cPrev = rollPrev[meI];
    planStep(pid, t, m);
    const mi = rollInputs[meI];
    mi.held = sHeld; mi.pressed = sHeld & ~rollPrev[meI]; mi.released = rollPrev[meI] & ~sHeld; mi.direct = sDirect;
    rollPrev[meI] = sHeld;
    for (let i = 0; i < fs.length; i++) {
      if (i === meI) continue;
      const inp = rollInputs[i];
      if (i === oppI) {
        oPrev = rollPrev[i];
        oppStep(model, t, o, m);
        inp.held = oHeld; inp.pressed = oHeld & ~rollPrev[i]; inp.released = rollPrev[i] & ~oHeld; inp.direct = oDirect;
        rollPrev[i] = oHeld;
      } else {
        const hd = fs[i].inputHeld;
        inp.held = hd; inp.pressed = 0; inp.released = 0; inp.direct = 0;
      }
    }
    stepGame(work, rollInputs);
    const ev = work.events;
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if (x.type === 'hit') {
        // Only damage to an enemy is worth anything; damage a teammate takes counts against us.
        if (x.attacker === meSlot && x.victim !== meSlot && !sameTeam(work, meSlot, x.victim)) rDealt += x.damage;
        else if (x.victim === meSlot) rTaken += x.damage;
        else if (sameTeam(work, meSlot, x.victim)) rMateTaken += x.damage;
      } else if (x.type === 'ko') {
        if (x.slot === meSlot) rKoMe++;
        else if (sameTeam(work, meSlot, x.slot)) rKoMate++;
        else if (x.slot === oppSlot) rKoOpp++;
        else rKoOther++;
      } else if (x.type === 'grab') {
        if (x.attacker === meSlot && !sameTeam(work, meSlot, x.victim)) rGrabbed = true;
      } else if (x.type === 'finalSmash') {
        if (x.attacker === meSlot && x.victim === oppSlot) rFsCaught = true;
      }
    }
    if (work.finished) { t++; break; }
  }
  const mf = fs[meI];
  rBackHome = mf.onGround || isLedgeAction(mf.action);
  return evaluate(work, meI, oppI, t);
}

/** Scores the future a rollout ended in, from our side. */
function evaluate(st: GameState, meI: number, oppI: number, frames: number): number {
  const m = st.fighters[meI];
  const o = st.fighters[oppI];
  const si = cSi;
  const blast = blastOf(st);
  let s = 0;
  s += rDealt * 1.0 - rTaken * 1.25;
  s += rKoOpp * 520 - rKoMe * 640 + rKoOther * 420 - rKoMate * 380 - rMateTaken * 0.5;
  const adx = Math.abs(o.x - m.x);
  const ady = Math.abs(o.y - m.y);
  // Hitstun and frame advantage are only worth something while we can still get to the victim: a
  // launch that parks them high above the tall Tidegate ceiling for two seconds buys nothing but time.
  const dist = Math.sqrt(adx * adx + ady * ady);
  const reach = dist < 90 ? 1 : dist > 250 ? 0 : 1 - (dist - 90) / 160;
  if (rKoOpp === 0 && o.stocks > 0) {
    if (launched(o)) {
      const ko = projectedKo(o, blast);
      s += 360 * ko;
      s += Math.min(o.hitstun, 30) * 0.45 * reach;
      // Dead time: a launch that is not a KO and leaves the victim far above or away is time we
      // spend waiting for it to come down instead of hitting it again.
      if (ko === 0 && !offstage(o, si)) s -= Math.max(0, dist - 90) * DEAD_TIME_COST;
    }
    if (offstage(o, si)) {
      const rec = recoverable(o, si);
      s += (1 - rec) * 300;
      const out = o.x < si.minX ? si.minX - o.x : o.x > si.maxX ? o.x - si.maxX : 0;
      s += out * 0.06 + Math.max(0, o.y - si.topY) * 0.08;
    }
    if (o.action === 'shieldBreak') s += 140;
    if (o.action === 'grabbed') {
      s += 14;
      // Held at kill percent: the throw that follows is a KO, so the grab is worth one already.
      if ((m.action === 'grabHold' || m.action === 'grab' || m.action === 'pummel') && throwKills(m, o, blast)) s += 300;
    }
    if (!launched(o) && busyFrames(m) <= 4) s += 45 * killThreat(m, o, blast);
    if (o.action === 'finalSmashVictim') s += 90;
  }
  if (rKoMe === 0 && m.stocks > 0) {
    if (launched(m)) {
      s -= 420 * projectedKo(m, blast);
      s -= Math.min(m.hitstun, 30) * 0.45;
    }
    if (offstage(m, si)) {
      const rec = recoverable(m, si);
      s -= (1 - rec) * 700;
      const out = m.x < si.minX ? si.minX - m.x : m.x > si.maxX ? m.x - si.maxX : 0;
      s -= out * 0.12 + Math.max(0, m.y - si.topY) * 0.2 + (m.jumpsLeft === 0 ? 6 : 0);
      if (m.action === 'airHelpless') s -= 10;
    }
    if (m.action === 'shieldBreak') s -= 220;
    if (m.action === 'grabbed') s -= 20;
    if (m.shieldHp < 22) s -= (22 - m.shieldHp) * 0.8;
    if (m.action === 'downed') s -= 6;
  }
  // Frame advantage: who acts first once the horizon ends.
  const bm = busyFrames(m);
  const bo = busyFrames(o);
  const adv = Math.max(-24, Math.min(24, bo - bm));
  s += adv * 0.3 * (adv > 0 ? reach : 1);
  if (bm > 0 && bo === 0 && adx < 64 && ady < 50) s -= bm * 0.35;
  // Stage control and spacing, both small next to damage.
  s -= Math.abs(m.x - si.cx) * 0.012;
  s += Math.abs(o.x - si.cx) * 0.01;
  if (m.onGround && o.onGround && !launched(o)) s -= Math.abs(adx - 58) * 0.02;
  // The pull reads the real distance: a fighter parked on a platform over the opponent is not close.
  if (base.stall) s -= Math.sqrt(adx * adx + ady * ady) * 0.04 - rDealt * 0.5;
  void frames;
  return s;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

const cand = new Int32Array(64);
const candBonus = new Float64Array(64);
let nCand = 0;
const models = new Int32Array(8);
const mWeight = new Float64Array(8);
let nModels = 0;
const scoreBuf = new Float64Array(8);
/** Normalised reply weight below which a model no longer counts toward the worst case. */
const WORST_MIN_W = 0.08;

function addCand(pid: number, bonus: number): void {
  for (let i = 0; i < nCand; i++) if (cand[i] === pid) { if (bonus > candBonus[i]) candBonus[i] = bonus; return; }
  if (nCand >= cand.length) return;
  cand[nCand] = pid; candBonus[nCand] = bonus; nCand++;
}

function addModel(model: number, w: number): void {
  if (nModels >= models.length || w <= 0) return;
  models[nModels] = model; mWeight[nModels] = w; nModels++;
}

function habitW(mem: AmMem, ctx: number, i: number): number {
  let sum = 0;
  for (let k = 0; k < HB_WIDTH; k++) sum += mem.habits[ctx * HB_WIDTH + k];
  return mem.habits[ctx * HB_WIDTH + i] / (sum > 0 ? sum : 1);
}

/** Opponent reply models for the opponent's (perceived) situation, weighted by what it tends to do. */
function pickModels(mem: AmMem, o: FighterState, si: StageInfo): number {
  nModels = 0;
  if (o.action === 'dead' || o.action === 'respawn' || o.stocks <= 0) { addModel(OM_CONT, 1); return LAMBDA_NEUTRAL; }
  if (o.action === 'ledgeHang') {
    addModel(OM_L_UP, habitW(mem, HB_LEDGE, 0)); addModel(OM_L_ATK, habitW(mem, HB_LEDGE, 1));
    addModel(OM_L_ROLL, habitW(mem, HB_LEDGE, 2)); addModel(OM_L_JUMP, habitW(mem, HB_LEDGE, 3));
    addModel(OM_CONT, habitW(mem, HB_LEDGE, 4));
    return LAMBDA_READ;
  }
  if (o.action === 'downed') {
    addModel(OM_D_UP, habitW(mem, HB_DOWN, 0)); addModel(OM_D_ATK, habitW(mem, HB_DOWN, 1));
    addModel(OM_D_TO, habitW(mem, HB_DOWN, 2)); addModel(OM_D_AWAY, habitW(mem, HB_DOWN, 3));
    return LAMBDA_READ;
  }
  if (launched(o) || o.action === 'tumble') {
    const overStage = o.x > si.minX && o.x < si.maxX;
    if (o.action === 'tumble' && overStage) {
      addModel(OM_T_NONE, habitW(mem, HB_TECH, 0)); addModel(OM_T_IN, habitW(mem, HB_TECH, 1));
      addModel(OM_T_TO, habitW(mem, HB_TECH, 2)); addModel(OM_T_AWAY, habitW(mem, HB_TECH, 3));
    } else {
      addModel(OM_CONT, habitW(mem, HB_ESC, 3) + habitW(mem, HB_ESC, 2));
      addModel(OM_ESC, habitW(mem, HB_ESC, 1));
      addModel(OM_ATK, habitW(mem, HB_ESC, 0));
    }
    return LAMBDA_READ + (1 - mem.repetition) * 0.15;
  }
  if (offstage(o, si)) { addModel(OM_REC, 1); return LAMBDA_NEUTRAL; }
  if (o.action === 'shield' || o.action === 'shieldStun') {
    // Out of a shield the options are few, and each opponent favours some: weight them by habit.
    addModel(OM_CONT, 0.15 + habitW(mem, HB_SHIELD, 1));
    addModel(OM_DEF, 0.15 + habitW(mem, HB_SHIELD, 0));
    addModel(OM_ATK, 0.1 + habitW(mem, HB_SHIELD, 4) * 0.5);
    addModel(OM_R_TO, habitW(mem, HB_SHIELD, 2));
    addModel(OM_R_AWAY, habitW(mem, HB_SHIELD, 3));
    return LAMBDA_NEUTRAL - mem.repetition * 0.25;
  }
  // A passive opponent (one that stands there, or only walks) is read as such: the "keeps doing what
  // it does" reply takes the weight, and the attacking and shielding replies shrink toward nothing.
  const passive = passivity(mem);
  const active = 1 - passive;
  addModel(OM_CONT, 0.25 * active + habitW(mem, HB_NEUTRAL, 2) * 0.5 + passive * 1.5);
  addModel(OM_ATK, (0.25 + habitW(mem, HB_NEUTRAL, 0) * 0.5) * active);
  addModel(OM_DEF, (0.2 + habitW(mem, HB_NEUTRAL, 1) * 0.5) * active);
  // A CPU that repeats itself is read harder: the worst case matters less once it is predictable.
  return LAMBDA_NEUTRAL - mem.repetition * 0.25 - passive * 0.45;
}

/** Plans matching a combo-table follow-up, for our current footing. */
function addFollowPlans(moveIdx: number, grounded: boolean, facingIn: boolean, bonus: number): void {
  const id = COMBO_MOVES[moveIdx];
  switch (id) {
    case 'jab': if (grounded) addCand(P_JAB, bonus); break;
    case 'ftilt': if (grounded) addCand(P_FTILT, bonus); break;
    case 'utilt': if (grounded) addCand(P_UTILT, bonus); break;
    case 'dtilt': if (grounded) addCand(P_DTILT, bonus); break;
    case 'dashatk': if (grounded) addCand(P_DASHATK, bonus); break;
    case 'fsmash': if (grounded) addCand(P_FSMASH, bonus); break;
    case 'usmash': if (grounded) addCand(P_USMASH, bonus); break;
    case 'dsmash': if (grounded) addCand(P_DSMASH, bonus); break;
    case 'nair': addCand(grounded ? P_SH_NAIR : P_A_NAIR, bonus); if (grounded) addCand(P_FH_NAIR, bonus); break;
    case 'fair': if (facingIn) { addCand(grounded ? P_SH_FAIR : P_A_FAIR, bonus); if (grounded) addCand(P_FH_FAIR, bonus); } break;
    case 'bair': if (!facingIn) addCand(grounded ? P_SH_BAIR : P_A_BAIR, bonus); break;
    case 'uair': addCand(grounded ? P_SH_UAIR : P_A_UAIR, bonus); if (grounded) { addCand(P_FH_UAIR, bonus); addCand(P_FH_UAIR_L, bonus); } else addCand(P_A_DJ_UAIR, bonus); break;
    case 'dair': addCand(grounded ? P_SH_DAIR : P_A_DAIR, bonus); break;
    case 'uspecial': addCand(grounded ? P_USPEC_G : P_A_USPEC, bonus); break;
    default: break;
  }
}

/** Builds the candidate list for our situation. Returns false when there is nothing to decide. */
function buildCandidates(st: GameState, meI: number, oppI: number, mem: AmMem, canFs: boolean): boolean {
  nCand = 0;
  const m = st.fighters[meI];
  const o = st.fighters[oppI];
  const si = cSi;
  const dx = o.x - m.x;
  const adx = Math.abs(dx);
  const dy = o.y - m.y;      // negative: the opponent is above us
  const facingIn = m.facing === cDir;
  const oLaunched = launched(o) || o.action === 'tumble';
  const oBusy = busyFrames(o);
  let shots = 0;
  for (let i = 0; i < st.projectiles.length; i++) {
    const pr = st.projectiles[i];
    if (pr.alive && pr.owner !== m.slot && !sameTeam(st, m.slot, pr.owner)) shots++;
  }
  const threat = (o.action === 'attack' && busyFrames(o) > 0) || shots > 0;

  if (canFs) addCand(P_FS, 0);

  // Combo table suggestions when the opponent is still in our hitstun.
  if (oLaunched && mem.lastStarter >= 0) {
    const b = bracketOf(o.percent);
    const pos = !o.onGround && dy < -30 ? 2 : (o.x < si.minX + 50 || o.x > si.maxX - 50) ? 1 : 0;
    const e = (mem.lastStarter * N_BRACKET + b) * N_POS + pos;
    for (let k = 0; k < 3; k++) {
      const f = comboNext[e * 3 + k];
      if (f < 0) break;
      addFollowPlans(f, m.onGround, facingIn, TABLE_BONUS - k);
    }
  }

  switch (m.action) {
    case 'ledgeHang':
      addCand(P_L_WAIT, 0); addCand(P_L_GETUP, 0); addCand(P_L_ATK, 0); addCand(P_L_ROLL, 0);
      addCand(P_L_JUMP, 0); addCand(P_L_JUMP_FAIR, 0); addCand(P_L_DROP_FAIR, 0);
      return true;
    case 'downed':
      addCand(P_D_UP, 0); addCand(P_D_ATK, 0); addCand(P_D_ROLL_L, 0); addCand(P_D_ROLL_R, 0);
      return true;
    case 'grabHold':
      addCand(P_G_F, 0); addCand(P_G_B, 0); addCand(P_G_U, 0); addCand(P_G_D, 0);
      if ((m as SimFighter).grabTimer > 34 && o.percent < 90) addCand(P_G_PUMMEL, 0);
      return true;
    case 'shield': case 'shieldStun':
      addCand(P_SHIELD, 0); addCand(P_WAIT, 0);
      if (adx < 60) { addCand(P_OOS_GRAB, 0); addCand(P_OOS_USMASH, 0); addCand(P_OOS_NAIR, 0); }
      if (adx < 50) addCand(P_OOS_USPEC, 0);
      if (adx < 80) { addCand(facingIn ? P_OOS_FAIR : P_OOS_BAIR, 0); addCand(P_OOS_UAIR, 0); }
      addCand(P_SPOT, 0); addCand(P_ROLL_B, 0); addCand(P_ROLL_F, 0);
      return true;
    case 'tumble':
      addCand(P_X_STAY, 0); addCand(P_X_DJ_S, 0); addCand(P_X_AD_S, 0); addCand(P_X_DRIFT_S, 0);
      if (m.jumpsLeft > 0) addCand(P_X_DJ_B, 0);
      addCand(P_X_FF, 0);
      if (adx < 60) addCand(P_X_NAIR, 0);
      return true;
    default: break;
  }

  if (!m.onGround) {
    const off = offstage(m, si);
    if (off) {
      addCand(P_REC_MID, 0); addCand(P_REC_EARLY, 0); addCand(P_REC_LATE, 0); addCand(P_REC_AD, 0);
      if (m.jumpsLeft > 0) addCand(P_A_DJ_F, 0);
      if (m.action === 'air') addCand(P_A_USPEC, 0);
      addCand(P_A_AD_S, 0);
    }
    addCand(P_A_NONE, 0); addCand(P_A_F, 0); addCand(P_A_B, 0);
    if (m.vy > -1 && !m.fastFalling && !off) { addCand(P_A_FF, 0); addCand(P_A_FF_B, 0); addCand(P_A_FF_F, 0); }
    if (adx < 90 && Math.abs(dy) < 90) {
      addCand(P_A_NAIR, 0);
      addCand(facingIn ? P_A_FAIR : P_A_BAIR, 0);
      if (dy < -10) addCand(P_A_UAIR, 0);
      if (dy > 10) { addCand(P_A_DAIR, 0); addCand(P_A_DAIR_FF, 0); }
      if (facingIn) addCand(P_A_FAIR_FF, 0); else addCand(P_A_BAIR_B, 0);
      addCand(P_A_NAIR_B, 0);
    }
    if (m.jumpsLeft > 0 && !off) {
      addCand(P_A_DJ_B, 0);
      if (adx < 110) { addCand(P_A_DJ_F, 0); if (dy < 0) addCand(P_A_DJ_UAIR, 0); addCand(facingIn ? P_A_DJ_FAIR : P_A_DJ_BAIR, 0); }
      addCand(P_A_DJ_N, 0);
    }
    if (threat && adx < 100) { addCand(P_A_AD_B, 0); addCand(P_A_AD_F, 0); }
    if (adx > 60 && adx < 200 && Math.abs(dy) < 40) { addCand(P_A_NSPEC, 0); addCand(P_A_SSPEC, 0); }
    // The geyser rises about 85 px: a target far above is out of its reach, and the rise is a whiff.
    if (dy < -30 && dy > -130 && adx < 40) addCand(P_A_USPEC, 0);
    return true;
  }

  // Grounded.
  const oOff = offstage(o, si) || o.action === 'ledgeHang';
  addCand(P_WAIT, 0);
  addCand(P_DASH_F, 0); addCand(P_DASH_B, 0);
  if (adx < 160) { addCand(P_DD_F, 0); addCand(P_DD_B, 0); }
  if (adx < 140) addCand(P_WALK_B, 0);
  if (adx < 110) addCand(P_WALK_F, 0);
  if (threat || adx < 80) { addCand(P_SHIELD, 0); addCand(P_SPOT, 0); addCand(P_ROLL_B, 0); }
  if (threat && adx < 60) addCand(P_ROLL_F, 0);
  if (adx < 64 && Math.abs(dy) < 60) {
    addCand(P_JAB, 0); addCand(P_FTILT, 0); addCand(P_DTILT, 0); addCand(P_GRAB, 0);
    addCand(P_FSMASH, 0); addCand(P_DSMASH, 0);
    if (oBusy >= 22) addCand(P_FSMASH_C, 0);
  }
  if (adx < 44 && dy < 20) {
    addCand(P_UTILT, 0); addCand(P_USMASH, 0);
    if (oBusy >= 22 || (dy < -60 && !o.onGround)) addCand(P_USMASH_C, 0);
  }
  if (adx < 34) addCand(P_DSPEC, 0);
  if (adx < 130) { addCand(P_DASHATK, 0); addCand(P_DASHGRAB, 0); }
  if (adx < 120 && dy > -120) {
    addCand(P_SH_NAIR, 0); addCand(P_SH_NAIR_FF, 0);
    if (facingIn) { addCand(P_SH_FAIR, 0); addCand(P_SH_FAIR_FF, 0); addCand(P_FH_FAIR, 0); }
    else { addCand(P_SH_BAIR, 0); addCand(P_SH_BAIR_R, 0); addCand(P_FH_BAIR, 0); }
    addCand(P_SH_EMPTY_B, 0); addCand(P_SH_EMPTY_F, 0);
  }
  if (dy < -20 && adx < 80) { addCand(P_SH_UAIR, 0); addCand(P_FH_UAIR, 0); addCand(P_FH_UAIR_L, 0); addCand(P_FH_NAIR, 0); addCand(P_FH_EMPTY_N, 0); }
  if (dy > 20 && adx < 120 && onSoftPlatform(st, m)) { addCand(P_PLATDROP, 0); if (adx < 60) addCand(P_SH_DAIR, 0); }
  if (adx > 50 && adx < 220 && Math.abs(dy) < 40 && !oLaunched) { addCand(P_NSPEC, 0); addCand(P_SSPEC, 0); }
  if (adx < 40 && dy < -20 && dy > -130) addCand(P_USPEC_G, 0);
  if (oOff && m.jumpsLeft > 0 && m.percent < 150) {
    const nearEdge = Math.min(Math.abs(m.x - si.minX), Math.abs(m.x - si.maxX)) < 70;
    const oSameSide = (o.x < si.cx) === (m.x < si.cx);
    if (oSameSide) {
      addCand(P_EG_HOG, 0);
      if (nearEdge) { addCand(P_EG_NAIR, 0); addCand(P_EG_DAIR, 0); addCand(facingIn ? P_EG_FAIR : P_EG_BAIR, 0); }
    }
  }
  return true;
}

/**
 * The search: every candidate against every reply model, blended, the no-whiff rule applied,
 * then the humanizer's occasional safe alternative. Returns the chosen plan id.
 */
function decide(real: GameState, st: GameState, work: GameState, meI: number, oppI: number, mem: AmMem, rand: () => number, canFs: boolean): number {
  const m = st.fighters[meI];
  const o = st.fighters[oppI];
  if (!buildCandidates(st, meI, oppI, mem, canFs)) return -1;
  const lambda = Math.max(0.1, Math.min(0.8, pickModels(mem, o, cSi)));
  let wsum = 0;
  for (let k = 0; k < nModels; k++) wsum += mWeight[k];
  for (let k = 0; k < nModels; k++) mWeight[k] /= wsum > 0 ? wsum : 1;
  const neutralModels = nModels >= 3 && models[0] === OM_CONT && models[1] === OM_ATK;

  let budget = warming || st.frame >= RAMP_FRAMES ? STEP_BUDGET : RAMP_BUDGET;
  let best = -1;
  let bestScore = -Infinity;
  let altBest = -1;
  let altScore = -Infinity;
  let bestWorst = -Infinity;
  const recovering = offstage(m, cSi);
  for (let c = 0; c < nCand; c++) {
    const pid = cand[c];
    const flags = PLAN_FLAGS[pid];
    let h = PLAN_H[pid];
    // Models: movement is judged against the continuing and the attacking reply; commitments get
    // the shielding one too, since "safe on shield" is half of the no-whiff rule.
    let nm = nModels;
    if (neutralModels && (flags & F_ATTACK) === 0) nm = 2;
    if (budget < h * nm) {
      if (budget < 12 * nm) break;
      h = Math.floor(budget / nm);
    }
    budget -= h * nm;
    let worst = Infinity;
    let avg = 0;
    let wUsed = 0;
    let connects = false;
    let shieldSafe = false;
    let returns = true;
    let fsAll = pid === P_FS;
    let atkSafe = true;
    for (let k = 0; k < nm; k++) {
      const sc = rollout(st, work, meI, oppI, pid, models[k], h, mem.prevHeld);
      scoreBuf[k] = sc;
      mem.steps += h;
      // A reply the habits have all but ruled out does not get to set the worst case.
      if (mWeight[k] >= WORST_MIN_W && sc < worst) worst = sc;
      avg += sc * mWeight[k];
      wUsed += mWeight[k];
      if (rDealt > 0 || rGrabbed || rKoOpp > 0) connects = true;
      if (models[k] === OM_DEF && rTaken === 0 && !rKoMe) shieldSafe = true;
      if (models[k] === OM_ATK && (rTaken > 0 || rKoMe > 0)) atkSafe = false;
      if ((flags & F_EG) !== 0 && !rBackHome && rKoOpp === 0) returns = false;
      if (pid === P_FS && !rFsCaught) fsAll = false;
    }
    avg /= wUsed > 0 ? wUsed : 1;
    if (worst === Infinity) worst = avg;
    if (pid === P_FS) {
      if (!fsAll) continue;
      return P_FS;       // the catch is guaranteed in every reply the search can think of
    }
    // No whiffs: a commitment has to connect in some reply, or be safe when they shield it. A shot
    // has to connect, or at least leave nothing for a rushing reply to punish.
    if ((flags & F_ATTACK) !== 0 && !connects) {
      if ((flags & F_PROJ) === 0 ? !shieldSafe : !atkSafe) continue;
    }
    if ((flags & F_EG) !== 0 && !returns) continue;
    let score = lambda * worst + (1 - lambda) * avg + candBonus[c] * (connects ? 1 : 0);
    if (pid === mem.plan && (flags & F_INTR) !== 0) score += CONTINUITY;
    if ((flags & (F_ATTACK | F_STALE)) !== 0) score -= mem.used[pid] * STALE_COST * ((flags & (F_PROJ | F_STALE)) !== 0 ? 2 : 1);
    score += rand() * 0.25;
    if (score > bestScore) { bestScore = score; best = pid; bestWorst = worst; }
    if ((flags & F_MOVE) !== 0 && worst > -2 && score > altScore) { altScore = score; altBest = pid; }
  }
  mem.decisions++;
  void real; void bestWorst;
  for (let i = 0; i < PLAN_COUNT; i++) mem.used[i] *= STALE_DECAY;
  if (best >= 0 && (PLAN_FLAGS[best] & (F_ATTACK | F_STALE)) !== 0) mem.used[best] += 1;
  // Humanizer: now and then take a safe movement option instead of the best one, when it costs
  // little. Never while recovering, launched or holding someone: those have one right answer.
  if (!recovering && m.action !== 'grabHold' && !launched(o) && altBest >= 0 && altBest !== best &&
      altScore > bestScore - 25 && rand() < HUMAN_ALT) {
    mem.alternates++;
    return altBest;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Observation: habits, patterns, combo starters
// ---------------------------------------------------------------------------

const MOVE_IDS: readonly MoveId[] = [
  'jab', 'ftilt', 'utilt', 'dtilt', 'dashatk', 'fsmash', 'usmash', 'dsmash', 'nair', 'fair', 'bair',
  'uair', 'dair', 'nspecial', 'sspecial', 'uspecial', 'dspecial', 'ledgeatk', 'getupatk',
];

/** Frames of an opponent standing free in neutral that count as one "did nothing" observation. */
const IDLE_BUMP = 20;

/** Free in neutral: could act, is not launched, holding a ledge, lying down or mid-move. */
function neutralFree(o: FighterState): boolean {
  switch (o.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'land': case 'air':
      return o.hitstun <= 0 && o.stocks > 0;
    default: return false;
  }
}

/** Share of the opponent's recent neutral answers that were "nothing": 0 active, 1 a punching bag. */
function passivity(mem: AmMem): number {
  return habitW(mem, HB_NEUTRAL, 3);
}

function bump(mem: AmMem, ctx: number, i: number): void {
  const o = ctx * HB_WIDTH;
  for (let k = 0; k < HB_WIDTH; k++) mem.habits[o + k] *= 0.94;
  mem.habits[o + i] += 1;
}

function observe(state: GameState, meI: number, oppI: number, mem: AmMem): void {
  const o = state.fighters[oppI];
  const me = state.fighters[meI];
  if (mem.oppIdx !== oppI) {
    mem.oppIdx = oppI; mem.oppPrevAction = o.action; mem.oppPrevMove = o.moveId; mem.oppPrevHitstun = o.hitstun;
    return;
  }
  const prev = mem.oppPrevAction;
  const act = o.action;
  const toMe = (me.x - o.x) * o.vx > 0;
  if (prev !== act) {
    if (prev === 'ledgeHang') {
      if (act === 'ledgeClimb') bump(mem, HB_LEDGE, 0);
      else if (act === 'attack') bump(mem, HB_LEDGE, 1);
      else if (act === 'ledgeRoll') bump(mem, HB_LEDGE, 2);
      else if (act === 'air' && o.vy < 0) bump(mem, HB_LEDGE, 3);
      else if (act === 'air') bump(mem, HB_LEDGE, 4);
    }
    if (prev === 'tumble') {
      if (act === 'downed') bump(mem, HB_TECH, 0);
      else if (act === 'tech') bump(mem, HB_TECH, 1);
      else if (act === 'techRoll') bump(mem, HB_TECH, toMe ? 2 : 3);
      else if (act === 'airDodge') bump(mem, HB_ESC, 1);
      else if (act === 'air') mem.oppEscWatch = 10;
    }
    if (prev === 'downed') {
      if (act === 'getUp') bump(mem, HB_DOWN, 0);
      else if (act === 'attack') bump(mem, HB_DOWN, 1);
      else if (act === 'getUpRoll') bump(mem, HB_DOWN, toMe ? 2 : 3);
    }
    if (prev === 'hitstun' && !o.onGround) mem.oppEscWatch = 10;
    if (mem.oppEscWatch > 0 && prev === 'air') {
      if (act === 'attack') { bump(mem, HB_ESC, 0); mem.oppEscWatch = 0; }
      else if (act === 'airDodge') { bump(mem, HB_ESC, 1); mem.oppEscWatch = 0; }
    }
    if (prev === 'shield' || prev === 'shieldStun') {
      if (act === 'attack' || act === 'grab') bump(mem, HB_SHIELD, 0);
      else if (act === 'idle') bump(mem, HB_SHIELD, 1);
      else if (act === 'roll') bump(mem, HB_SHIELD, toMe ? 2 : 3);
      else if (act === 'jumpsquat') bump(mem, HB_SHIELD, 4);
    }
    // Neutral: what they start from a free state, landing included.
    if (prev === 'idle' || prev === 'walk' || prev === 'dash' || prev === 'run' || prev === 'turn' || prev === 'crouch' || prev === 'land') {
      if (act === 'attack' || act === 'grab') bump(mem, HB_NEUTRAL, 0);
      else if (act === 'shield' || act === 'spotDodge' || act === 'roll') bump(mem, HB_NEUTRAL, 1);
      else if (act === 'jumpsquat') bump(mem, HB_NEUTRAL, 2);
    }
  }
  if (mem.oppEscWatch > 0) {
    mem.oppEscWatch--;
    if (o.airJumped && o.action === 'air') { bump(mem, HB_ESC, 2); mem.oppEscWatch = 0; }
    else if (mem.oppEscWatch === 0) bump(mem, HB_ESC, 3);
  }
  // Doing nothing is a habit too. Every IDLE_BUMP frames an opponent spends free in neutral without
  // starting an attack, a grab, a shield or a dodge counts as one "nothing" answer, so a player who
  // stands there (or a dummy that only walks) is read as passive within a few seconds and the
  // attacking and shielding reply models stop vetoing the kill moves that would work on it.
  if (neutralFree(o)) {
    mem.oppIdleRun++;
    if (mem.oppIdleRun % IDLE_BUMP === 0) bump(mem, HB_NEUTRAL, 3);
  } else if (act === 'attack' || act === 'grab' || act === 'shield' || act === 'spotDodge' || act === 'roll' || act === 'airDodge') {
    mem.oppIdleRun = 0;
  }
  // Pattern repetition: what share of the last 16 moves they started is the single commonest one.
  if (act === 'attack' && o.moveId !== null && (prev !== 'attack' || o.moveId !== mem.oppPrevMove)) {
    let idx = -1;
    for (let i = 0; i < MOVE_IDS.length; i++) if (MOVE_IDS[i] === o.moveId) idx = i;
    mem.recent[mem.recentPos] = idx;
    mem.recentPos = (mem.recentPos + 1) & 15;
    let top = 0; let n = 0;
    for (let i = 0; i < 16; i++) {
      if (mem.recent[i] < 0) continue;
      n++;
      let c = 0;
      for (let j = 0; j < 16; j++) if (mem.recent[j] === mem.recent[i]) c++;
      if (c > top) top = c;
    }
    mem.repetition = n >= 8 ? top / n : 0;
  }
  mem.oppPrevAction = act;
  mem.oppPrevMove = o.moveId;
  mem.oppPrevHitstun = o.hitstun;

  // Our last hit on them, for the combo table, and the stall clock.
  const meSlot = me.slot;
  for (let e = 0; e < state.events.length; e++) {
    const ev = state.events[e];
    if (ev.type !== 'hit') continue;
    mem.lastDamageFrame = state.frame;
    if (ev.attacker === meSlot && ev.victim === o.slot) {
      const sf = me as SimFighter;
      const id = me.action === 'throw' && sf.activeThrowId !== null ? sf.activeThrowId : me.moveId;
      const ci = comboIndexOf(id);
      if (ci >= 0) mem.lastStarter = ci;
    }
  }
  if (!launched(o) && o.action !== 'tumble') mem.lastStarter = -1;
}

// ---------------------------------------------------------------------------
// Perception: the state as it was AEVALMERE_REACT frames ago, rolled forward to now
// ---------------------------------------------------------------------------

function snapshot(state: GameState, mem: AmMem): void {
  const i = ((state.frame % HIST) + HIST) % HIST;
  if (mem.hist.length < HIST) {
    while (mem.hist.length < HIST) mem.hist.push({ st: cloneGameState(state) });
  }
  copyGameStateInto(state, mem.hist[i].st);
  mem.histFrame[i] = state.frame;
}

/**
 * Builds the perceived state into mem.perceived. The opponent is shown as it was REACT frames ago,
 * kept holding what it held then; our own fighter is copied from the real state, since nobody
 * has to react to their own inputs. Falls back to the real state when the history is short.
 */
function perceive(state: GameState, meI: number, mem: AmMem): GameState {
  const P = (mem.perceived as Scratch).st;
  const from = state.frame - AEVALMERE_REACT;
  const i = ((from % HIST) + HIST) % HIST;
  if (from < 0 || mem.histFrame[i] !== from) {
    copyGameStateInto(state, P);
    return P;
  }
  copyGameStateInto(mem.hist[i].st, P);
  const fs = P.fighters;
  for (let k = 0; k < AEVALMERE_REACT; k++) {
    const fi = ((from + k) % HIST + HIST) % HIST;
    for (let j = 0; j < fs.length; j++) {
      const inp = rollInputs[j];
      if (j === meI) {
        const prev = k === 0 ? fs[j].inputHeld : mem.outHeld[((from + k - 1) % HIST + HIST) % HIST];
        const held = mem.outHeld[fi];
        inp.held = held; inp.pressed = held & ~prev; inp.released = prev & ~held; inp.direct = mem.outDirect[fi];
      } else {
        inp.held = fs[j].inputHeld; inp.pressed = 0; inp.released = 0; inp.direct = 0;
      }
    }
    stepGame(P, rollInputs);
  }
  copyFighterInto(state.fighters[meI], P.fighters[meI]);
  P.events.length = 0;
  return P;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function nearestOpp(state: GameState, meI: number): number {
  const me = state.fighters[meI];
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < state.fighters.length; i++) {
    if (i === meI) continue;
    const f = state.fighters[i];
    if (f.stocks <= 0 || sameTeam(state, me.slot, f.slot)) continue;
    const d = (f.x - me.x) * (f.x - me.x) + (f.y - me.y) * (f.y - me.y) + (f.action === 'dead' ? 1e9 : 0);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Predicted frames until our tumble lands, stepping a copy of the real state, or -1. */
function tumbleLandIn(state: GameState, meI: number, work: GameState, mem: AmMem): number {
  copyGameStateInto(state, work);
  const fs = work.fighters;
  for (let t = 1; t <= 12; t++) {
    for (let j = 0; j < fs.length; j++) {
      const inp = rollInputs[j];
      inp.held = j === meI ? 0 : fs[j].inputHeld; inp.pressed = 0; inp.released = 0; inp.direct = 0;
    }
    stepGame(work, rollInputs);
    mem.steps++;
    const a = fs[meI].action;
    if (a === 'downed' || a === 'tech' || a === 'techRoll' || fs[meI].onGround) return t;
    if (a !== 'tumble' && a !== 'hitstun') return -1;
  }
  return -1;
}

function finish(mem: AmMem, state: GameState, out: InputFrame, held: number, direct: number): InputFrame {
  held &= ~Btn.Taunt;
  out.held = held;
  out.pressed = held & ~mem.prevHeld;
  out.released = mem.prevHeld & ~held;
  out.direct = direct;
  mem.prevHeld = held;
  const i = ((state.frame % HIST) + HIST) % HIST;
  mem.outHeld[i] = held;
  mem.outDirect[i] = direct;
  return out;
}

/** Allocates the history ring and scratch states for `slot`, shaped like `state`. */
function ensurePool(mem: AmMem, state: GameState): void {
  if (mem.perceived === null || mem.perceived.st.fighters.length !== state.fighters.length) mem.perceived = { st: cloneGameState(state) };
  if (mem.work === null || mem.work.st.fighters.length !== state.fighters.length) mem.work = { st: cloneGameState(state) };
  if (mem.hist.length > 0 && mem.hist[0].st.fighters.length !== state.fighters.length) mem.hist = [];
  while (mem.hist.length < HIST) mem.hist.push({ st: cloneGameState(state) });
}

/**
 * Gets every level 10 slot of `config` ready before its first real frame: allocates the pooled
 * states, builds the combo table for the current tuning, and plays WARM_FRAMES throwaway frames on
 * a scratch match (its own config object and its own seeded random, never the match's) so the
 * search code is compiled hot. The real match's first call then sees a new config and resets the
 * slot's memory, keeping only the pools, so warming changes no outcome. A second call with the same
 * config object returns at once, so the host may call it before frame 0 and cpuInput may call it again.
 */
export function warmAevalmere(config: MatchConfig): void {
  if (config === warmedConfig) return;
  warmedConfig = config;
  buildComboTable(config.stageId);
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < config.players.length; i++) {
    const p = config.players[i];
    players.push({ slot: p.slot, charId: p.charId, cpu: p.cpu, cpuLevel: p.cpuLevel, team: p.team });
  }
  const scratchCfg: MatchConfig = {
    stageId: config.stageId, players, stocks: 3, timeLimitSec: 0, seed: 12345,
    finalSmash: config.finalSmash, cpuZeroMoves: config.cpuZeroMoves, teams: config.teams,
  };
  const st = createGameState(scratchCfg);
  let seed = 0x2545f491;
  const rand = (): number => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  const inputs: InputFrame[] = [];
  for (let i = 0; i < st.fighters.length; i++) inputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  const tmp: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
  // Every slot plays as Aevalmere here, so both sides of the search (and the mirror) get compiled.
  // Fighters start close together so the warm-up actually fights instead of walking.
  st.fighters[0].x = -30;
  if (st.fighters.length > 1) st.fighters[1].x = 30;
  warming = true;
  try {
    for (let f = 0; f < WARM_FRAMES && !st.finished; f++) {
      for (let i = 0; i < st.fighters.length; i++) {
        const slot = st.fighters[i].slot;
        ensurePool(memSlots[slot], st);
        const o = aevalmereInput(st, slot, rand, tmp);
        inputs[i].held = o.held; inputs[i].pressed = o.pressed; inputs[i].released = o.released; inputs[i].direct = o.direct;
      }
      stepGame(st, inputs);
    }
  } finally {
    warming = false;
  }
  for (let i = 0; i < st.fighters.length; i++) {
    const mem = memSlots[st.fighters[i].slot];
    // Forget the scratch match entirely; the pools stay.
    mem.matchRef = null;
    mem.lastFrame = -1;
  }
}

/**
 * Level 10. One synthesized input frame for `slot`, written into `out`. Called by cpuInput for
 * any level of 10 or more.
 */
export function aevalmereInput(state: GameState, slot: number, rand: () => number, out: InputFrame): InputFrame {
  const mem = memSlots[slot];
  if (mem.matchRef !== state.config || state.frame < mem.lastFrame - 60) {
    const keepHist = mem.hist;
    const keepP = mem.perceived;
    const keepW = mem.work;
    resetMem(mem);
    mem.hist = keepHist;
    mem.perceived = keepP;
    mem.work = keepW;
    mem.matchRef = state.config;
    buildComboTable(state.stageId);
  }
  mem.lastFrame = state.frame;
  let meI = -1;
  for (let i = 0; i < state.fighters.length; i++) if (state.fighters[i].slot === slot) meI = i;
  if (meI < 0) return finish(mem, state, out, 0, 0);
  ensurePool(mem, state);
  const work = (mem.work as Scratch).st;
  snapshot(state, mem);
  cSi = stageInfo(state.stageId);
  const me = state.fighters[meI];

  if (me.stocks <= 0 || me.action === 'dead') { mem.plan = -1; return finish(mem, state, out, 0, 0); }
  const oppI = nearestOpp(state, meI);
  if (oppI >= 0) observe(state, meI, oppI, mem);

  // Stall clock: no damage anywhere on the stage for a while makes closing distance worth more.
  // Against a passive opponent the clock runs five times as fast: there is nothing to wait out.
  base.stall = state.frame - mem.lastDamageFrame > STALL_FRAMES * (1 - 0.8 * passivity(mem));

  // Respawn platform: take a beat, then drop while the invincibility still has frames to spend.
  if (me.action === 'respawn') {
    mem.plan = -1;
    if (me.actionFrame < 20) return finish(mem, state, out, 0, 0);
    return finish(mem, state, out, (mem.prevHeld & D) === 0 ? D : 0, 0);
  }
  // Held: mash at the full rate the sim counts, a fresh group of four presses every frame. Shield and
  // Dodge are left out because both are tech presses and would lock the tech out after the throw.
  if (me.action === 'grabbed') {
    mem.plan = -1;
    mem.mashPhase ^= 1;
    return finish(mem, state, out, mem.mashPhase === 0 ? (L | U | J | A) : (R | D | SP | G), 0);
  }
  if (me.action === 'footstooled' || me.action === 'finalSmash' || me.action === 'finalSmashVictim' ||
      me.action === 'grab' || me.action === 'pummel' || me.action === 'throw') {
    mem.plan = -1;
    return finish(mem, state, out, 0, 0);
  }
  if (oppI < 0) {
    // Nobody to fight: stay home.
    mem.plan = P_REC_MID; mem.planT = 0; mem.planHome = me.x < cSi.cx ? 1 : -1;
  }

  const o = oppI >= 0 ? state.fighters[oppI] : me;
  const def = CHARACTER_DEFS[me.charId];
  const canFs = oppI >= 0 && state.config.finalSmash === true && canFinalSmash(state, me as SimFighter, def);

  // Tech: always, timed to the predicted landing, direction chosen by rollouts.
  let forced = -1;
  if (me.action === 'tumble' && oppI >= 0 && me.vy > 0 && (me as SimFighter).techLockout <= 1 && mem.techBusy === 0) {
    const land = tumbleLandIn(state, meI, work, mem);
    if (land >= 1 && land <= 8) {
      nCand = 0;
      addCand(P_T_IN, 0); addCand(P_T_L, 0); addCand(P_T_R, 0);
      cDir = o.x >= me.x ? 1 : -1;
      cHome = me.x < cSi.cx ? 1 : -1;
      pickModels(mem, o, cSi);
      let bestS = -Infinity;
      for (let c = 0; c < nCand; c++) {
        let s = 0;
        let w = 0;
        for (let k = 0; k < nModels; k++) {
          const md = models[k] >= OM_L_UP ? OM_CONT : models[k];
          s += rollout(state, work, meI, oppI, cand[c], md, 36, mem.prevHeld) * mWeight[k];
          w += mWeight[k];
          mem.steps += 36;
        }
        s /= w > 0 ? w : 1;
        if (s > bestS) { bestS = s; forced = cand[c]; }
      }
      mem.techBusy = 24;
    }
  }
  if (mem.techBusy > 0) mem.techBusy--;

  // Launched: nothing a neutral plan pressed may linger, since any Shield or Dodge is a tech press
  // and any other press ends a tumble. The escape is planned when the hitstun runs out.
  const techPlan = mem.plan === P_T_IN || mem.plan === P_T_L || mem.plan === P_T_R;
  if (forced < 0 && launched(me) && me.hitstun > 1 && !techPlan) mem.plan = -1;

  // Decide?
  let need = forced >= 0;
  if (!need && oppI >= 0) {
    const act = actionableNow(me);
    const pid = mem.plan;
    const sinceDecide = state.frame - mem.lastDecide;
    // What the opponent was doing REACT frames ago: a change there is something we can now see.
    const hi = (((state.frame - AEVALMERE_REACT) % HIST) + HIST) % HIST;
    let sig = -1;
    if (state.frame >= AEVALMERE_REACT && mem.histFrame[hi] === state.frame - AEVALMERE_REACT) {
      const po = mem.hist[hi].st.fighters[oppI];
      const hp = mem.hist[hi].st.projectiles;
      let live = 0;
      for (let k = 0; k < hp.length; k++) if (hp[k].alive) live++;
      sig = po.action.length * 131 + (po.moveId === null ? 0 : po.moveId.length * 7 + po.moveId.charCodeAt(0)) + (po.onGround ? 1 : 0) + live * 1000;
    }
    const trigger = sig !== mem.lastSig;
    if (pid < 0) need = act;
    else if (act) {
      const flags = PLAN_FLAGS[pid];
      const minDone = mem.planT >= PLAN_MIN[pid];
      if (minDone) {
        if ((flags & F_INTR) === 0) need = true;
        else {
          const rec = pid === P_REC_EARLY || pid === P_REC_MID || pid === P_REC_LATE || pid === P_REC_AD;
          need = trigger || sinceDecide >= (rec ? REPLAN_REC : REPLAN);
        }
      }
    }
    // A plan that lost its footing (launched, grabbed onto a ledge) is thought through again.
    if (!need && pid >= 0 && act && (launched(me) || me.action === 'ledgeHang' || me.action === 'downed')) {
      const flags = PLAN_FLAGS[pid];
      const ledgePlan = pid >= P_L_WAIT && pid <= P_L_DROP_FAIR;
      const downPlan = pid >= P_D_UP && pid <= P_D_ROLL_R;
      if ((me.action === 'ledgeHang' && !ledgePlan) || (me.action === 'downed' && !downPlan)) need = true;
      void flags;
    }
    if (need) mem.lastSig = sig;
  }

  if (forced >= 0) {
    mem.plan = forced; mem.planT = 0; mem.lastDecide = state.frame;
    mem.planDir = o.x >= me.x ? 1 : -1;
    mem.planHome = me.x < cSi.cx ? 1 : -1;
  } else if (need && oppI >= 0) {
    const P = perceive(state, meI, mem);
    const pm = P.fighters[meI];
    const po = P.fighters[oppI];
    cDir = po.x > pm.x ? 1 : po.x < pm.x ? -1 : pm.facing;
    cHome = pm.x < cSi.cx ? 1 : -1;
    const bm = P.fighters[meI];
    base.myPct = bm.percent; base.oppPct = po.percent; base.myStocks = bm.stocks; base.oppStocks = po.stocks;
    const pid = decide(state, P, work, meI, oppI, mem, rand, canFs);
    mem.lastDecide = state.frame;
    if (pid >= 0) {
      if (pid !== mem.plan || (PLAN_FLAGS[pid] & F_INTR) === 0) mem.planT = 0;
      mem.plan = pid;
      mem.planDir = cDir;
      mem.planHome = cHome;
    }
  }

  // Execute the plan on the real fighter.
  let held = 0;
  let direct = 0;
  if (mem.plan >= 0) {
    cPrev = mem.prevHeld;
    cDir = mem.planDir;
    cHome = mem.planHome;
    planStep(mem.plan, mem.planT, me);
    held = sHeld;
    direct = sDirect;
    mem.planT++;
  }
  // Reaction floor, as a hard gate: never a fresh shield while an opponent's startup is 0 or 1 frames old.
  if ((held & SH) !== 0 && (mem.prevHeld & SH) === 0 && me.onGround && !launched(me)) {
    for (let i = 0; i < state.fighters.length; i++) {
      if (i === meI) continue;
      const f = state.fighters[i];
      if (sameTeam(state, me.slot, f.slot)) continue;
      if (f.action === 'attack' && f.actionFrame <= 1 && f.hitlag === 0) { held &= ~SH; break; }
    }
  }
  return finish(mem, state, out, held, direct);
}
