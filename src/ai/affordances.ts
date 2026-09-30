/**
 * Affordances and threats (02 sections 4, 9.1, 10.1, 11.5; 04 section 5; docs/CPU_PLAN.md W2.2).
 *
 * Cheap reads computed every decision before any rollout, from the character profiles and the
 * perceived state: frames until a move connects (travel included), threat zones, whiff punish
 * margins, "can this fighter get back", the true-combo test, kill percent here and danger here,
 * and the situation class.
 *
 * Several opponents: `computeAffordances` fills the contract fields for the named opponent and,
 * when `out` comes from `newAffordances`, a `team` block over every live opponent: each one's
 * threat window on the CPU (projectiles in flight attributed to their owner), the nearest threat,
 * a sandwich flag and `sandwichRisk` (one opponent on each side inside threat range), a
 * `threatSide` in [-1, 1], the most punishable opponent, the free space on the stage, a position
 * that keeps every opponent on one side, and the stage-side cover spot when a teammate is
 * edgeguarding. `teamThreat` computes the same block for any state (targets.ts uses it).
 *
 * Friendly fire does not exist in this sim (perception.ts `hitsLand`): a teammate never counts
 * as a threat and teammates' projectiles are ignored.
 *
 * Deterministic; allocation-free per decision except `trueCombo` and `canGetBack`'s exact path,
 * which step a caller-owned pooled `work` state.
 */
import type { FighterState, GameState, InputFrame, MoveId, StageDef } from '../core/types';
import { Btn, DIRECT_MOVES } from '../core/types';
import { CHARACTER_DEFS } from '../characters/registry';
import { STAGE_DEFS } from '../stages/registry';
import { cloneGameState, stepGame } from '../sim';
import { isLedgeAction } from '../sim/ledge';
import type { SimFighter } from '../sim/state';
import { getAiProfile } from './charprofile/derive';
import { deriveMatchup } from './charprofile/matchup';
import { stageGeo, type StageGeo } from './charprofile/probeHit';
import { RECOVER_DX_BIN, RECOVER_DX_BINS, RECOVER_NONE, recoverBoxIndex } from './charprofile/probeMotion';
import { VP_ESCAPES, comboVictimInput } from './charprofile/combo';
import type {
  Affordances, CanGetBackFn, CharacterAiProfile, ClassifySituationFn, ComputeAffordancesFn, KillPct,
  MatchupProfile, MoveAiInfo, Perceived, Situation, Spot, TrueComboFn,
} from './contracts';
import {
  busyFrames, copyWorldInto, hitsLand, invulnFrames, isLaunched, isLive, isTeammate, MAX_FIGHTERS, ownerIndex,
} from './perception';

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/** An opponent this many frames or fewer from hitting the CPU counts as a flanker (sandwich). */
export const SANDWICH_FRAMES = 24;
/** Threat weight ramps from 1 at THREAT_NEAR frames to 0 at THREAT_FAR frames. */
export const THREAT_NEAR = 8;
export const THREAT_FAR = 45;
/** Envelope margins this close to zero are settled by exact rollouts (02 section 10.1). */
const EXACT_BAND = 40;
/** Frames an exact recovery rollout runs at most. */
const EXACT_FRAMES = 240;
/** Frames the true-combo rollout waits for the follow-up to connect. */
const COMBO_FRAMES = 70;
/** Candidate x positions sampled across the main platform for free space. */
const FREE_SAMPLES = 17;
/** Spacing kept beyond the outermost opponent when putting them all on one side. */
const ONE_SIDE_GAP = 70;
/** A teammate within this many px of a ledge while an opponent is offstage is edgeguarding. */
const EDGEGUARD_BAND = 90;
/** Stage-side cover spot: this far inside the edge the teammate guards. */
const COVER_INSET = 70;
const NO_PUNISH = -999;

// ---------------------------------------------------------------------------------------------
// Caches (keyed by charId and stage; never hold match state)
// ---------------------------------------------------------------------------------------------

const profiles = new Map<string, Map<string, CharacterAiProfile>>();
const moveLists = new Map<CharacterAiProfile, MoveId[]>();
const geos = new Map<string, StageGeo>();

/** Profile of a character on a stage, memoized here so a decision never re-hashes the defs (no key string per call). */
export function profileFor(charId: string, stageId: string): CharacterAiProfile {
  let byStage = profiles.get(charId);
  if (byStage === undefined) { byStage = new Map(); profiles.set(charId, byStage); }
  let p = byStage.get(stageId);
  if (p === undefined) {
    p = getAiProfile(charId, stageId);
    byStage.set(stageId, p);
  }
  return p;
}
/** Drops memoized profiles and matchups (call after a tuning or balance edit, e.g. from warmBrain). */
export function clearAffordanceCaches(): void {
  profiles.clear();
  moveLists.clear();
  matchups.clear();
  geos.clear();
}

const matchups = new Map<string, MatchupProfile>();
/** Matchup A on B for a stage, memoized. */
export function matchupFor(a: CharacterAiProfile, b: CharacterAiProfile, stageId: string): MatchupProfile {
  const key = `${a.charId}|${a.dataHash}|${b.charId}|${b.dataHash}|${stageId}`;
  let m = matchups.get(key);
  if (m === undefined) {
    m = deriveMatchup(a, b, STAGE_DEFS[stageId]);
    matchups.set(key, m);
  }
  return m;
}

/** Damaging moves of a profile (melee or shot), in MOVE order of the record. */
function attackMoves(p: CharacterAiProfile): MoveId[] {
  let l = moveLists.get(p);
  if (l === undefined) {
    l = [];
    const ids = Object.keys(p.moves) as MoveId[];
    for (let i = 0; i < ids.length; i++) {
      const m = p.moves[ids[i]];
      if (m.maxDamage > 0 && Number.isFinite(m.startup) && m.startup >= 0) l.push(ids[i]);
    }
    moveLists.set(p, l);
  }
  return l;
}

export function geoOf(stageId: string): StageGeo {
  let g = geos.get(stageId);
  if (g === undefined) {
    g = stageGeo(STAGE_DEFS[stageId]);
    geos.set(stageId, g);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Geometry reads
// ---------------------------------------------------------------------------------------------

/** Airborne and past the main platform's edges or below its top, not on a ledge. */
export function isOffstage(f: FighterState, g: StageGeo): boolean {
  if (f.onGround || isLedgeAction(f.action)) return false;
  if (f.action === 'dead' || f.action === 'respawn') return false;
  return f.x < g.left - 2 || f.x > g.right + 2 || f.y > g.top + 2;
}

/** Kill-percent spot of a fighter: offstage when offstage, ledge near an edge, else center. */
export function spotOf(f: FighterState, g: StageGeo): Spot {
  if (isOffstage(f, g) || f.x < g.left || f.x > g.right) return 'offstage';
  if (f.x - g.left < 60 || g.right - f.x < 60) return 'ledge';
  return 'center';
}

/** Pre-hit kill percent rescaled from the profile's own weight to the victim's (matchup.ts formula). */
function rescaleKill(k: number, damage: number, wFrom: number, wTo: number): number {
  if (!Number.isFinite(k)) return NaN;
  return Math.max(0, (k + damage) * (wTo + 100) / (wFrom + 100) - damage);
}

/** Kill percent of `move` of `atk` on a victim of weight `wTo` at `spot`, NaN when it does not kill. */
export function killPctOf(atk: CharacterAiProfile, move: MoveId, spot: Spot, wTo: number): number {
  const m = atk.moves[move];
  if (m === undefined) return NaN;
  return rescaleKill((m.killPct as KillPct)[spot], m.maxDamage, atk.physics.weight, wTo);
}

/** Lowest kill percent over `atk`'s kill-role moves and throws on weight `wTo` at `spot`, NaN if none. */
export function killFloorAt(atk: CharacterAiProfile, spot: Spot, wTo: number): number {
  let best = NaN;
  const kill = atk.roles.kill;
  for (let i = 0; i < kill.length; i++) {
    const k = killPctOf(atk, kill[i], spot, wTo);
    if (Number.isFinite(k) && !(k >= best)) best = k;
  }
  const th = atk.grab.throws;
  for (const id in th) {
    const t = th[id as keyof typeof th];
    const k = rescaleKill(t.killPct[spot], t.damage, atk.physics.weight, wTo);
    if (Number.isFinite(k) && !(k >= best)) best = k;
  }
  return best;
}

/** Frames to rise `h` px from vertical speed `v0` (up, positive) under gravity `g`; Infinity when out of reach. */
function riseFrames(h: number, v0: number, g: number): number {
  if (h <= 0) return 0;
  const disc = v0 * v0 - 2 * g * h;
  if (disc < 0 || g <= 0) return Infinity;
  return (v0 - Math.sqrt(disc)) / g;
}

/**
 * Frames until `move` of fighter `f` (profile `p`) can first connect with a point `dx`, `dy` away
 * (target minus attacker, world px, y down), travel included: busy frames, a turn, walk or dash,
 * a jump or double jump for height, a fall for depth, then the move's startup. Infinity when the
 * move cannot get there (a ground move from offstage, a height no jump reaches).
 */
export function framesToHitFrom(f: FighterState, p: CharacterAiProfile, move: MoveId, dx: number, dy: number): number {
  const info: MoveAiInfo | undefined = p.moves[move];
  if (info === undefined || !(info.maxDamage > 0) || !Number.isFinite(info.startup)) return Infinity;
  const def = CHARACTER_DEFS[f.charId];
  const mv = def.moves[move];
  const busy = busyFrames(f);
  const adx = dx < 0 ? -dx : dx;
  const ahead = dx === 0 || (dx > 0 ? f.facing > 0 : f.facing < 0);
  const grounded = f.onGround;
  let startup = info.startup + 1;
  // Horizontal gap after reach, front or (if it reaches farther) back when the target is behind.
  let reachX = info.reach.front;
  let turn = 0;
  if (!ahead) {
    if (info.reach.back >= adx) reachX = info.reach.back;
    else turn = grounded ? 1 : 0;
  }
  const gapX = Math.max(0, adx - reachX);
  const needUp = dy < 0 ? Math.max(0, -dy - info.reach.up) : 0;
  const needDown = dy > 0 ? Math.max(0, dy - info.reach.down) : 0;
  let tx = 0;
  if (gapX > 0) tx = grounded ? 1 + gapX / Math.max(0.5, p.physics.dash) : gapX / Math.max(0.5, p.physics.airSpeed);
  let ty = 0;
  let jumpCost = 0;
  if (needUp > 0) {
    if (grounded) {
      ty = riseFrames(needUp, def.jumpVel, def.gravity);
      jumpCost = def.jumpSquat;
      if (!Number.isFinite(ty) && f.jumpsLeft > 0) ty = riseFrames(Math.max(0, needUp - p.recovery.rise.fullHop), def.doubleJumpVel, def.gravity) + 30;
    } else {
      const up = f.vy < 0 ? -f.vy : 0;
      ty = riseFrames(needUp, up, def.gravity);
      if (!Number.isFinite(ty) && f.jumpsLeft > 0) ty = riseFrames(needUp, def.doubleJumpVel, def.gravity);
    }
  } else if (needDown > 0) {
    if (grounded) ty = Infinity;
    else ty = needDown / Math.max(1, p.physics.fastFall);
  }
  if (!Number.isFinite(ty)) return Infinity;
  if (mv.airOnly === true && grounded && jumpCost === 0) jumpCost = def.jumpSquat;
  if (mv.groundOnly === true && !grounded) {
    if (needUp > 0) return Infinity;
    const land = f.vy > 0 ? 6 : 12;
    startup += land;
  }
  let best = busy + turn + jumpCost + Math.max(tx, ty) + startup;
  // Shots: cast plus flight, when in range and near the shot's height.
  const shots = p.shots;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (s.moveId !== move) continue;
    const sy = -s.height;
    if (Math.abs(dy - sy) > s.radius(0) + p.physics.hurtbox.h) continue;
    if (adx > s.range(0)) continue;
    const t = busy + turn + s.castFrames(0) + adx / Math.max(0.5, s.speed(0));
    if (t < best) best = t;
  }
  return best;
}

/** Fewest frames any damaging move of `f` needs to reach the point `dx`, `dy` away. */
export function threatFramesFrom(f: FighterState, p: CharacterAiProfile, dx: number, dy: number): number {
  const ids = attackMoves(p);
  let best = Infinity;
  for (let i = 0; i < ids.length; i++) {
    const t = framesToHitFrom(f, p, ids[i], dx, dy);
    if (t < best) best = t;
  }
  return best;
}

/** Frames until a live projectile owned by fighter `oi` reaches fighter `ti` flying straight, Infinity if none. */
export function projectileFrames(s: GameState, oi: number, ti: number): number {
  const t = s.fighters[ti];
  const h = CHARACTER_DEFS[t.charId].hurtbox;
  let best = Infinity;
  const pr = s.projectiles;
  for (let i = 0; i < pr.length; i++) {
    const q = pr[i];
    if (!q.alive || ownerIndex(s, q) !== oi) continue;
    const cy = t.y - h.h / 2;
    if (Math.abs(q.y - cy) > h.h / 2 + 16) continue;
    const dx = t.x - q.x;
    if (Math.abs(dx) <= h.w / 2 + 8) { best = 0; continue; }
    if (q.vx === 0 || (dx > 0) !== (q.vx > 0)) continue;
    const fr = (Math.abs(dx) - h.w / 2) / Math.abs(q.vx);
    if (fr < best) best = fr;
  }
  return best;
}

/**
 * Whiff punish margin of `atk` on `vic`: frames of `vic`'s committed recovery (attack endlag,
 * landing lag, dodge tails, climbs, getups) left after `atk`'s fastest damaging move connects and
 * after `vic`'s invulnerability ends. Positive means a punish exists. NO_PUNISH (-999) when `vic` is
 * not committed to anything (or is in hitstun, which is advantage, not a whiff).
 */
export function whiffMargin(atk: FighterState, pa: CharacterAiProfile, vic: FighterState, pv: CharacterAiProfile): number {
  switch (vic.action) {
    case 'attack': {
      if (vic.moveId === null) return NO_PUNISH;
      const info = pv.moves[vic.moveId];
      if (info !== undefined && vic.actionFrame <= info.activeEnd) return -(info.activeEnd - vic.actionFrame + 1);
      break;
    }
    case 'land': case 'spotDodge': case 'roll': case 'airDodge': case 'ledgeClimb': case 'ledgeRoll': case 'ledgeJump':
    case 'getUp': case 'getUpRoll': case 'tech': case 'techRoll': case 'shieldBreak': case 'jumpsquat': case 'grab':
    case 'airHelpless':
      break;
    default:
      return NO_PUNISH;
  }
  const busy = busyFrames(vic);
  const inv = invulnFrames(vic);
  const dx = vic.x - atk.x; const dy = vic.y - atk.y;
  const reach = threatFramesFrom(atk, pa, dx, dy);
  if (!Number.isFinite(reach)) return NO_PUNISH;
  return busy - Math.max(reach, inv);
}

/** Opened up to anything: launched, downed, broken shield, helpless, held by someone, or stuck in landing lag. */
export function isExposed(f: FighterState): boolean {
  if (!isLive(f) || f.action === 'respawn') return false;
  if (invulnFrames(f) > 0 && f.action !== 'airHelpless') return false;
  switch (f.action) {
    case 'hitstun': case 'tumble': return f.hitstun > 0;
    case 'downed': case 'shieldBreak': case 'airHelpless': case 'grabbed': case 'footstooled': return true;
    case 'land': return (f as SimFighter).stateTimer > 6;
    default: return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Situation
// ---------------------------------------------------------------------------------------------

function underPressure(f: FighterState, g: StageGeo): boolean {
  switch (f.action) {
    case 'hitstun': case 'tumble': case 'land': case 'downed': case 'ledgeHang': case 'ledgeGrab': case 'shieldStun':
    case 'grabbed': case 'shieldBreak': case 'airHelpless': case 'footstooled': case 'getUp': case 'getUpRoll':
    case 'tech': case 'techRoll':
      return true;
    default:
      return isOffstage(f, g);
  }
}

/** Situation class of `meI` against `oppI` (02 section 4). */
export const classifySituation: ClassifySituationFn = (s, meI, oppI) => {
  const me = s.fighters[meI];
  const g = geoOf(s.stageId);
  if (me.action === 'dead' || me.action === 'respawn' || me.stocks <= 0) return 'respawn';
  const opp = oppI >= 0 && oppI < s.fighters.length ? s.fighters[oppI] : null;
  if (me.action === 'finalSmash' || me.action === 'finalSmashVictim'
    || (opp !== null && (opp.action === 'finalSmash' || opp.action === 'finalSmashVictim'))) return 'finalSmash';
  if (me.action === 'grabHold' || me.action === 'pummel' || me.action === 'throw') return 'grabHold';
  if (me.action === 'grabbed') return 'grabbed';
  if (me.action === 'ledgeHang' || me.action === 'ledgeGrab') return 'ledge';
  if (me.action === 'downed') return 'downed';
  if (isLaunched(me) || me.action === 'tumble') return 'tumble';
  if (me.action === 'shield' || me.action === 'shieldStun') return 'oos';
  if (opp === null || !isLive(opp) || opp.action === 'respawn') return me.onGround ? 'neutral' : 'airborne';
  const meOff = isOffstage(me, g);
  if (meOff && isOffstage(opp, g)) return 'bothOffstage';
  if (underPressure(opp, g)) return 'advantage';
  if (meOff || underPressure(me, g)) return 'disadvantage';
  if (!me.onGround) return 'airborne';
  return 'neutral';
};

// ---------------------------------------------------------------------------------------------
// Can get back (02 section 10.1)
// ---------------------------------------------------------------------------------------------

const rollInputs: InputFrame[] = [];
for (let i = 0; i < MAX_FIGHTERS; i++) rollInputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });

function clearInputs(n: number): void {
  for (let j = 0; j < n; j++) {
    const r = rollInputs[j];
    r.held = 0; r.pressed = 0; r.released = 0; r.direct = 0;
  }
}

/** DIRECT_CODES code of a move (DIRECT_MOVES come first in DIRECT_CODES), 0 when not a direct move. */
export function directCodeOf(move: MoveId): number {
  for (let i = 0; i < DIRECT_MOVES.length; i++) if (DIRECT_MOVES[i] === move) return i + 1;
  return 0;
}

function upSpecialAvailable(f: FighterState, prof: CharacterAiProfile): boolean {
  if (f.action === 'airHelpless') return false;
  const rec = prof.roles.recovery;
  if (f.action === 'attack' && f.moveId !== null) {
    for (let i = 0; i < rec.length; i++) if (rec[i] === f.moveId) return false;
  }
  return rec.length > 0;
}

/** Envelope margin in px (positive = inside the recover box), NaN for under-stage positions. */
function envelopeMargin(f: FighterState, prof: CharacterAiProfile, g: StageGeo): number {
  const def = CHARACTER_DEFS[f.charId];
  let dx: number;
  if (f.x < g.left) dx = g.left - f.x;
  else if (f.x > g.right) dx = f.x - g.right;
  else return NaN;
  // Moving away adds to the distance; rising buys height, falling costs some.
  const away = f.x < g.left ? -f.vx : f.vx;
  if (away > 0) dx += away * 10;
  let depth = f.y - g.top;
  if (f.vy < 0) depth -= (f.vy * f.vy) / (2 * Math.max(0.01, def.gravity));
  else depth += f.vy * 6;
  const bin = Math.floor(dx / RECOVER_DX_BIN);
  const upB = upSpecialAvailable(f, prof) ? 1 : 0;
  const dodge = (f as SimFighter).airDodgeUsed ? 0 : 1;
  const box = prof.recovery.recoverBox;
  if (bin >= RECOVER_DX_BINS) {
    const last = box[recoverBoxIndex(f.jumpsLeft, upB, dodge, RECOVER_DX_BINS - 1, def.jumps)];
    const over = dx - RECOVER_DX_BINS * RECOVER_DX_BIN;
    return last === RECOVER_NONE ? -over - 100 : last - depth - over;
  }
  const env = box[recoverBoxIndex(f.jumpsLeft, upB, dodge, bin, def.jumps)];
  if (env === RECOVER_NONE) return -Math.max(1, depth + 100);
  return env - depth;
}

interface RecScript { dodge: 0 | 1 | 2; upbDepth: number; delay: number }
const REC_SCRIPTS: readonly RecScript[] = [
  { dodge: 0, upbDepth: -Infinity, delay: 0 },
  { dodge: 0, upbDepth: 40, delay: 0 },
  { dodge: 1, upbDepth: -Infinity, delay: 0 },
  { dodge: 2, upbDepth: -Infinity, delay: 0 },
  { dodge: 0, upbDepth: -Infinity, delay: 12 },
  { dodge: 0, upbDepth: 40, delay: 12 },
];

function tryRecover(s: GameState, who: number, prof: CharacterAiProfile, sc: RecScript, work: GameState, g: StageGeo): boolean {
  copyWorldInto(s, work);
  const n = work.fighters.length;
  const f = work.fighters[who] as SimFighter;
  const up = prof.roles.recovery.length > 0 ? directCodeOf(prof.roles.recovery[0]) : 0;
  let upbLeft = up !== 0 && upSpecialAvailable(f, prof);
  let dodgeLeft = sc.dodge !== 0 && !f.airDodgeUsed;
  for (let t = 0; t < EXACT_FRAMES; t++) {
    clearInputs(n);
    const inp = rollInputs[who];
    const toward = f.x < g.center ? Btn.Right : Btn.Left;
    if (t >= sc.delay) {
      inp.held = toward;
      const free = (f.action === 'air' || (f.action === 'tumble' && f.hitstun <= 0)) && f.hitlag === 0;
      if (free && f.vy >= 0) {
        if (f.jumpsLeft > 0) { inp.pressed = Btn.Jump; inp.held |= Btn.Jump; }
        else if (dodgeLeft) {
          inp.held = sc.dodge === 1 ? toward | Btn.Up : toward;
          inp.pressed = Btn.Shield;
          dodgeLeft = false;
        } else if (upbLeft && f.y - g.top >= sc.upbDepth) {
          inp.held = toward | Btn.Up;
          inp.direct = up;
          upbLeft = false;
        }
      }
    }
    stepGame(work, rollInputs);
    if (f.action === 'ledgeHang' || f.action === 'ledgeGrab' || f.onGround) return true;
    if (f.action === 'dead' || f.stocks < s.fighters[who].stocks) return false;
    const spent = f.jumpsLeft === 0 && !upbLeft && !dodgeLeft;
    if (spent && f.vy > 0 && f.y > g.top + 120 && f.action !== 'attack' && f.action !== 'airDodge') return false;
  }
  return false;
}

/**
 * Px of slack a fighter has to get back to the stage (negative = it cannot). Grounded, on a ledge
 * or on stage: a large positive number. Offstage: the recover-box envelope margin (04, probeMotion
 * recoverBox) for its live jumps, up special and air dodge; when the margin is within 40 px, or
 * the fighter is launched, moving under the stage or mid-move, six exact rollouts (hold toward,
 * jumps when falling, air dodge diagonal or straight, up special at once or 40 px down, each at a
 * delay of 0 or 12 frames) decide the sign. `work` is a pooled state of the same match.
 */
export const canGetBack: CanGetBackFn = (s, who, prof, work) => {
  const f = s.fighters[who];
  const g = geoOf(s.stageId);
  if (!isLive(f) || f.action === 'respawn') return 999;
  if (!isOffstage(f, g)) return 999;
  const m = envelopeMargin(f, prof, g);
  const settled = Number.isFinite(m) && Math.abs(m) > EXACT_BAND && !isLaunched(f)
    && f.action !== 'attack' && f.action !== 'airDodge';
  if (settled) return m;
  for (let i = 0; i < REC_SCRIPTS.length; i++) {
    if (tryRecover(s, who, prof, REC_SCRIPTS[i], work, g)) return Number.isFinite(m) && m > 1 ? m : 1;
  }
  return Number.isFinite(m) && m < -1 ? m : -1;
};

// ---------------------------------------------------------------------------------------------
// True combo test (02 section 9.1)
// ---------------------------------------------------------------------------------------------

/**
 * One attacker script for `follow`: close the distance (dash on the ground, drift in the air),
 * jump when the victim is above the move's reach (or the move is air-only), and press the move's
 * direct code when the predicted gap after startup is inside its reach.
 */
function attackerInput(atk: FighterState, vic: FighterState, info: MoveAiInfo, code: number, airOnly: boolean,
  groundOnly: boolean, t: number, out: InputFrame): void {
  out.held = 0; out.pressed = 0; out.released = 0; out.direct = 0;
  const dx = vic.x - atk.x;
  const dy = vic.y - atk.y;
  const toward = dx >= 0 ? Btn.Right : Btn.Left;
  const adx = dx < 0 ? -dx : dx;
  const facing = dx === 0 || (dx > 0) === (atk.facing > 0);
  const reach = facing ? info.reach.front : Math.max(info.reach.front, info.reach.back);
  const closing = atk.onGround ? CHARACTER_DEFS[atk.charId].dashSpeed : CHARACTER_DEFS[atk.charId].airSpeed;
  const gapAfter = adx - closing * (info.startup + 1);
  if (busyFrames(atk) > 1) { out.held = toward; return; }
  const wantAir = airOnly || (dy < -info.reach.up && !groundOnly);
  if (wantAir && atk.onGround) {
    out.held = toward | Btn.Jump;
    out.pressed = Btn.Jump;
    return;
  }
  if (groundOnly && !atk.onGround) { out.held = toward; return; }
  if (gapAfter <= reach) {
    out.held = toward;
    out.direct = code;
    return;
  }
  out.held = toward;
  if (atk.onGround && t === 0) out.pressed = toward;
}

function hitLanded(s: GameState, atkSlot: number, vicSlot: number): number {
  const ev = s.events;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.type === 'hit' && e.attacker === atkSlot && e.victim === vicSlot) return 1;
    if (e.type === 'shieldHit' && e.victim === vicSlot) return -1;
    if (e.type === 'grab' && e.attacker === atkSlot && e.victim === vicSlot) return 1;
  }
  return 0;
}

const victimInput: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };

/**
 * Hitstun budget of `follow` from `attacker` on `victim` in `s`: 1 or more when the follow-up
 * connects under every escape the victim can buffer (nothing, jump, dodge, attack, shield, drift
 * away; combo.ts VP_ESCAPES), the victim's unactionable frames minus the connect frame; below 1 it
 * is not a true combo. `work` is a pooled state of the same match.
 */
export const trueCombo: TrueComboFn = (s, attacker, victim, follow, work) => {
  const code = directCodeOf(follow);
  if (code === 0) return 0;
  const a0 = s.fighters[attacker];
  const v0 = s.fighters[victim];
  if (!isLive(a0) || !isLive(v0) || !hitsLand(s, attacker, victim)) return 0;
  const prof = profileFor(a0.charId, s.stageId);
  const info = prof.moves[follow];
  if (info === undefined || !(info.maxDamage > 0)) return 0;
  const mv = CHARACTER_DEFS[a0.charId].moves[follow];
  const airOnly = mv.airOnly === true;
  const groundOnly = mv.groundOnly === true;
  const vBusy = busyFrames(v0);
  let firstHit = -1;
  const n = s.fighters.length;
  for (let pi = 0; pi < VP_ESCAPES.length; pi++) {
    copyWorldInto(s, work);
    const atk = work.fighters[attacker] as SimFighter;
    const vic = work.fighters[victim] as SimFighter;
    let hitAt = -1;
    for (let t = 0; t < COMBO_FRAMES; t++) {
      clearInputs(n);
      attackerInput(atk, vic, info, code, airOnly, groundOnly, t, rollInputs[attacker]);
      comboVictimInput(VP_ESCAPES[pi], vic, atk, victimInput);
      const vi = rollInputs[victim];
      vi.held = victimInput.held; vi.pressed = victimInput.pressed; vi.released = 0; vi.direct = victimInput.direct ?? 0;
      stepGame(work, rollInputs);
      const h = hitLanded(work, atk.slot, vic.slot);
      if (h < 0) break;
      if (h > 0) { hitAt = t + 1; break; }
      if (!isLive(vic)) break;
    }
    if (hitAt < 0) return 0;
    if (pi === 0) firstHit = hitAt;
  }
  return Math.max(1, vBusy - firstHit + 1);
};

// ---------------------------------------------------------------------------------------------
// Several opponents
// ---------------------------------------------------------------------------------------------

/** One live opponent as seen from the CPU. */
export interface OppThreat {
  index: number;
  /** -1 left of the CPU, 1 right (ties count as right). */
  side: number;
  dx: number; dy: number; dist: number;
  /** Fewest frames any of their moves (or a shot of theirs in flight) needs to hit the CPU. */
  threatFrames: number;
  /** Frames until one of their projectiles in flight reaches the CPU. */
  projFrames: number;
  /** 0..1, 1 at THREAT_NEAR frames or fewer, 0 at THREAT_FAR or more. */
  weight: number;
  busy: number; invuln: number;
  /** CPU's whiff punish margin on them (positive = a punish exists). */
  punish: number;
  exposed: boolean;
  percent: number;
  /** CPU's lowest kill percent on them where they stand (NaN = no killer). */
  killPct: number;
  inKillRange: boolean;
  offstage: boolean;
}

/** Threat picture over every live opponent (and the teammates' edgeguard state). */
export interface TeamThreat {
  n: number;
  opps: OppThreat[];
  /** Index (fighter) of the opponent with the fewest threat frames, -1 none. */
  nearest: number;
  nearestFrames: number;
  sandwich: boolean;
  /** 0..1: the smaller of the strongest left and strongest right threat weights. */
  sandwichRisk: number;
  /** -1..1: where the threat comes from, weighted (negative = from the left), 0 when none. */
  threatSide: number;
  /** Fighter index of the opponent with the best positive whiff punish margin or exposed state, -1 none. */
  punishable: number;
  /** Best free spot (feet): far from every opponent, preferring all of them on one side. */
  freeX: number; freeY: number;
  /** A ground x that puts every opponent on one side of the CPU; NaN when none fits on stage. */
  oneSideX: number;
  /** True when every opponent is already on one side of the CPU. */
  oneSided: boolean;
  /** Fighter index of a teammate edgeguarding, -1 none; coverX the stage-side spot to hold. */
  mateEdgeguard: number;
  coverX: number;
}

function newOppThreat(): OppThreat {
  return { index: -1, side: 1, dx: 0, dy: 0, dist: 0, threatFrames: Infinity, projFrames: Infinity, weight: 0,
    busy: 0, invuln: 0, punish: NO_PUNISH, exposed: false, percent: 0, killPct: NaN, inKillRange: false, offstage: false };
}

export function newTeamThreat(): TeamThreat {
  const opps: OppThreat[] = [];
  for (let i = 0; i < MAX_FIGHTERS; i++) opps.push(newOppThreat());
  return { n: 0, opps, nearest: -1, nearestFrames: Infinity, sandwich: false, sandwichRisk: 0, threatSide: 0,
    punishable: -1, freeX: 0, freeY: 0, oneSideX: NaN, oneSided: true, mateEdgeguard: -1, coverX: NaN };
}

function threatWeight(frames: number): number {
  if (!(frames < THREAT_FAR)) return 0;
  if (frames <= THREAT_NEAR) return 1;
  return (THREAT_FAR - frames) / (THREAT_FAR - THREAT_NEAR);
}

/**
 * Fills `out` for `meI` in `s`: every live opponent's threat window, the sandwich read, the threat
 * side, the punishable opponent, free space, the one-side spot and the teammate edgeguard cover.
 */
export function teamThreat(s: GameState, meI: number, out: TeamThreat): void {
  const me = s.fighters[meI];
  const g = geoOf(s.stageId);
  const pMe = profileFor(me.charId, s.stageId);
  let n = 0;
  out.nearest = -1; out.nearestFrames = Infinity; out.punishable = -1;
  let bestPunish = 0;
  let leftW = 0; let rightW = 0; let sumW = 0; let sideW = 0;
  let leftClose = false; let rightClose = false;
  let minX = Infinity; let maxX = -Infinity;
  let anyOff = false;
  const fs = s.fighters;
  for (let i = 0; i < fs.length; i++) {
    if (i === meI) continue;
    const f = fs[i];
    if (!isLive(f) || isTeammate(s, meI, i)) continue;
    const o = out.opps[n++];
    const pO = profileFor(f.charId, s.stageId);
    o.index = i;
    o.dx = f.x - me.x; o.dy = f.y - me.y;
    o.dist = Math.sqrt(o.dx * o.dx + o.dy * o.dy);
    o.side = o.dx < 0 ? -1 : 1;
    o.projFrames = projectileFrames(s, i, meI);
    const melee = f.action === 'respawn' ? Infinity : threatFramesFrom(f, pO, me.x - f.x, me.y - f.y);
    o.threatFrames = Math.min(melee, o.projFrames);
    o.weight = threatWeight(o.threatFrames);
    o.busy = busyFrames(f);
    o.invuln = invulnFrames(f);
    o.punish = whiffMargin(me, pMe, f, pO);
    o.exposed = isExposed(f);
    o.percent = f.percent;
    o.offstage = isOffstage(f, g);
    if (o.offstage) anyOff = true;
    o.killPct = killFloorAt(pMe, spotOf(f, g), pO.physics.weight);
    o.inKillRange = Number.isFinite(o.killPct) && f.percent >= o.killPct;
    if (o.threatFrames < out.nearestFrames || (o.threatFrames === out.nearestFrames && out.nearest < 0)) {
      out.nearestFrames = o.threatFrames; out.nearest = i;
    }
    const pScore = o.exposed ? Math.max(o.punish, 1 + Math.max(0, o.busy - o.dist / 8)) : o.punish;
    if (pScore > bestPunish) { bestPunish = pScore; out.punishable = i; }
    if (o.side < 0) { if (o.weight > leftW) leftW = o.weight; if (o.threatFrames <= SANDWICH_FRAMES) leftClose = true; }
    else { if (o.weight > rightW) rightW = o.weight; if (o.threatFrames <= SANDWICH_FRAMES) rightClose = true; }
    sumW += o.weight; sideW += o.side * o.weight;
    if (f.x < minX) minX = f.x;
    if (f.x > maxX) maxX = f.x;
  }
  out.n = n;
  out.sandwich = leftClose && rightClose;
  out.sandwichRisk = Math.min(leftW, rightW);
  out.threatSide = sumW > 0 ? sideW / sumW : 0;
  out.oneSided = n === 0 || minX >= me.x || maxX <= me.x;

  // One-side spot: beyond the outermost opponent, on the stage, the nearer of the two sides that fit.
  const lo = g.left + 12; const hi = g.right - 12;
  const leftSpot = minX - ONE_SIDE_GAP; const rightSpot = maxX + ONE_SIDE_GAP;
  const leftFits = n > 0 && leftSpot >= lo; const rightFits = n > 0 && rightSpot <= hi;
  if (leftFits && rightFits) out.oneSideX = Math.abs(leftSpot - me.x) <= Math.abs(rightSpot - me.x) ? leftSpot : rightSpot;
  else if (leftFits) out.oneSideX = leftSpot;
  else if (rightFits) out.oneSideX = rightSpot;
  else out.oneSideX = NaN;

  // Free space: main platform samples and every pass-through platform top.
  const stage: StageDef = STAGE_DEFS[s.stageId];
  let bestScore = -Infinity;
  out.freeX = me.x; out.freeY = g.top;
  for (let k = 0; k < FREE_SAMPLES; k++) {
    const x = lo + (hi - lo) * k / (FREE_SAMPLES - 1);
    const sc = freeScore(out, fs, x, g.top, me, g);
    if (sc > bestScore) { bestScore = sc; out.freeX = x; out.freeY = g.top; }
  }
  for (let k = 0; k < stage.platforms.length; k++) {
    const p = stage.platforms[k];
    if (p.solid) continue;
    const x = p.x + p.w / 2;
    const sc = freeScore(out, fs, x, p.y, me, g);
    if (sc > bestScore) { bestScore = sc; out.freeX = x; out.freeY = p.y; }
  }

  // Teammate edgeguarding: a teammate near or past an edge while an opponent is offstage.
  out.mateEdgeguard = -1; out.coverX = NaN;
  if (anyOff) {
    for (let i = 0; i < fs.length; i++) {
      if (i === meI || !isTeammate(s, meI, i) || !isLive(fs[i])) continue;
      const m = fs[i];
      const nearL = m.x - g.left < EDGEGUARD_BAND; const nearR = g.right - m.x < EDGEGUARD_BAND;
      if (!nearL && !nearR && !isOffstage(m, g)) continue;
      out.mateEdgeguard = i;
      out.coverX = (m.x < g.center) ? g.left + COVER_INSET : g.right - COVER_INSET;
      break;
    }
  }
}

function freeScore(t: TeamThreat, fs: FighterState[], x: number, y: number, me: FighterState, g: StageGeo): number {
  let minD = 400;
  let left = 0; let right = 0;
  for (let i = 0; i < t.n; i++) {
    const f = fs[t.opps[i].index];
    const dx = f.x - x; const dy = f.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < minD) minD = d;
    if (dx < 0) left++; else right++;
  }
  let sc = minD;
  if (t.n > 1 && (left === 0 || right === 0)) sc += 60;
  // A spot at the very edge is a trap unless nobody is near; travel costs a little.
  if (x - g.left < 30 || g.right - x < 30) sc -= 40;
  sc -= Math.abs(x - me.x) * 0.15 + Math.abs(y - me.y) * 0.1;
  return sc;
}

// ---------------------------------------------------------------------------------------------
// Affordances
// ---------------------------------------------------------------------------------------------

/** Affordances plus the several-opponent block. */
export interface TeamAffordances extends Affordances {
  team: TeamThreat;
  meI: number; oppI: number;
  /** Frames any move of the named opponent needs to hit the CPU (their threat window). */
  oppThreatFrames: number;
  /** Frames the CPU's fastest move needs to hit the named opponent. */
  meThreatFrames: number;
}

class AffordancesImpl implements TeamAffordances {
  situation: Situation = 'neutral';
  whiffPunish = NO_PUNISH; meCanGetBack = 999; oppCanGetBack = 999;
  oppInvuln = 0; oppBusy = 0; meBusy = 0; dangerHere = 0;
  team = newTeamThreat();
  meI = -1; oppI = -1;
  oppThreatFrames = Infinity; meThreatFrames = Infinity;
  state: GameState | null = null;
  me: CharacterAiProfile | null = null;
  opp: CharacterAiProfile | null = null;

  private fighter(who: 0 | 1): FighterState {
    const s = this.state as GameState;
    return s.fighters[who === 0 ? this.meI : this.oppI];
  }

  framesToHit(who: 0 | 1, move: MoveId, dx: number, dy: number): number {
    if (this.state === null) return Infinity;
    return framesToHitFrom(this.fighter(who), (who === 0 ? this.me : this.opp) as CharacterAiProfile, move, dx, dy);
  }

  inThreat(who: 0 | 1, x: number, y: number, frames: number): boolean {
    if (this.state === null) return false;
    const f = this.fighter(who);
    return threatFramesFrom(f, (who === 0 ? this.me : this.opp) as CharacterAiProfile, x - f.x, y - f.y) <= frames;
  }

  killPctHere(move: MoveId): number {
    if (this.state === null || this.me === null || this.opp === null) return NaN;
    const o = this.fighter(1);
    return killPctOf(this.me, move, spotOf(o, geoOf(this.state.stageId)), this.opp.physics.weight);
  }
}

/** A fresh output object for `computeAffordances` with the several-opponent block. */
export function newAffordances(): TeamAffordances {
  return new AffordancesImpl();
}

/** Work state for canGetBack's exact path, one per pooled view state, built once and reused. */
const workStates = new WeakMap<GameState, GameState>();
function workFor(s: GameState): GameState {
  let w = workStates.get(s);
  if (w === undefined) {
    w = cloneGameState(s);
    workStates.set(s, w);
  }
  return w;
}

/**
 * Fills `out` for the perceived state: situation against `p.oppI`, the named opponent's reads
 * (contract fields) and, for an `out` from `newAffordances`, the team block over every opponent.
 * `dangerHere` is the largest ratio of the CPU's percent to any opponent move's kill percent at
 * the CPU's spot (1 or more = some opponent move kills the CPU here).
 */
export const computeAffordances: ComputeAffordancesFn = (p, me, opp, mu, out) => {
  const s = p.state;
  const g = geoOf(s.stageId);
  const meF = s.fighters[p.meI];
  const hasOpp = p.oppI >= 0 && p.oppI < s.fighters.length;
  const oF = hasOpp ? s.fighters[p.oppI] : meF;
  out.situation = classifySituation(s, p.meI, hasOpp ? p.oppI : -1);
  out.meBusy = busyFrames(meF);
  out.oppBusy = hasOpp ? busyFrames(oF) : 0;
  out.oppInvuln = hasOpp ? invulnFrames(oF) : 0;
  out.whiffPunish = hasOpp ? whiffMargin(meF, me, oF, opp) : NO_PUNISH;
  const work = workFor(s);
  out.meCanGetBack = canGetBack(s, p.meI, me, work);
  out.oppCanGetBack = hasOpp ? canGetBack(s, p.oppI, opp, work) : 999;
  // Danger: the named opponent through the matchup's danger map, the rest through their profiles.
  const mySpot = spotOf(meF, g);
  let danger = 0;
  if (hasOpp) {
    const dm = mu.danger;
    for (const id in dm) {
      const kp = dm[id as MoveId];
      if (kp === undefined) continue;
      const k = kp[mySpot];
      if (Number.isFinite(k) && k > 0) danger = Math.max(danger, meF.percent / k);
      else if (k === 0) danger = Math.max(danger, 2);
    }
  }
  for (let i = 0; i < s.fighters.length; i++) {
    if (i === p.meI || i === p.oppI || !isLive(s.fighters[i]) || !hitsLand(s, i, p.meI)) continue;
    const po = profileFor(s.fighters[i].charId, s.stageId);
    const ids = attackMoves(po);
    for (let k = 0; k < ids.length; k++) {
      const kp = killPctOf(po, ids[k], mySpot, me.physics.weight);
      if (Number.isFinite(kp) && kp > 0) danger = Math.max(danger, meF.percent / kp);
    }
  }
  out.dangerHere = Math.min(2, danger);
  if (out instanceof AffordancesImpl) {
    out.state = s; out.me = me; out.opp = opp; out.meI = p.meI; out.oppI = hasOpp ? p.oppI : p.meI;
    teamThreat(s, p.meI, out.team);
    out.oppThreatFrames = hasOpp && hitsLand(s, p.oppI, p.meI) ? threatFramesFrom(oF, opp, meF.x - oF.x, meF.y - oF.y) : Infinity;
    out.meThreatFrames = hasOpp ? threatFramesFrom(meF, me, oF.x - meF.x, oF.y - meF.y) : Infinity;
  }
};

/** Contract-shaped view of the helper for callers that hold only a Perceived. */
export function affordancesFor(p: Perceived, out: TeamAffordances): void {
  const s = p.state;
  const me = profileFor(s.fighters[p.meI].charId, s.stageId);
  const oi = p.oppI >= 0 && p.oppI < s.fighters.length ? p.oppI : p.meI;
  const opp = profileFor(s.fighters[oi].charId, s.stageId);
  computeAffordances(p, me, opp, matchupFor(me, opp, s.stageId), out);
}
