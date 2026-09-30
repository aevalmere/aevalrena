/**
 * The opponent model's predictor bank (02 sections 6.1, 6.2; research 31 sections 1.1 to 1.3).
 *
 * Observes one opponent frame by frame, classifies what it starts into ACTION_CLASS_COUNT
 * classes, and predicts the next class from a bank of eight members:
 *   0 situation only (Laplace 0.5), 1 order 1, 2 order 2 (Witten-Bell back-off to order 1),
 *   3 the action pair alone (ghost sequence), 4 the full chain 2 -> 1 -> pair -> situation,
 *   5 rhythm (last action x phase), all ported from aevalmere.ts;
 *   6 win-stay/lose-shift, 7 counter-me (COUNTER_ME).
 * Each member keeps a log score s_j = 0.9 s_j + ln q_j(actual); the mixture weights are
 * exp(s_j - max s), so the member that has been reading the player best leads (the Iocaine Powder
 * structure). A timing vote then rescales acting against waiting, as before.
 *
 * Tables decay by the level's gammaSlow per observation in the row; a fast order-1 table at
 * gammaFast feeds the changepoint test (changepoint.ts), which the bank runs itself and answers
 * by scaling the slow counts. Persisted as a sparse v2 JSON (serialize, load).
 *
 * Deterministic and allocation-free per frame: fixed typed arrays, no Math.log or Math.exp
 * (gating.ts has arithmetic versions), no randomness at all.
 */
import type { ActionId, FighterState, GameState, MoveId } from '../../core/types';
import { Btn, DIRECT_MOVES } from '../../core/types';
import { AIR_DODGE } from '../../core/constants';
import { CHARACTER_DEFS } from '../../characters/registry';
import { STAGE_DEFS } from '../../stages/registry';
import { isLedgeAction } from '../../sim/ledge';
import { castDelay } from '../../sim/moves';
import type { SimFighter } from '../../sim/state';
import {
  ACTION_CLASS_COUNT, COUNTER_ME, type CreatePredictorFn, type LevelVector, type MakeContextFn,
  type ObsContext, type Predictor,
} from '../contracts';
import { createChangepointState, POISON_WINDOW, RESET_SCALE, type ChangepointState } from './changepoint';
import { expDet, lnDet } from './gating';

// ---------------------------------------------------------------------------------------------
// Action alphabet (02 section 6.1)
// ---------------------------------------------------------------------------------------------

const NA = ACTION_CLASS_COUNT;
/** 0..16 are the direct moves by DIRECT_MOVES index (0 is the jab); 17 ledge attack; 18 getup attack. */
export const AC_LEDGE_ATTACK = 17;
export const AC_GETUP_ATTACK = 18;
export const AC_GRAB = 19;
export const AC_SHIELD = 20;
export const AC_ROLL_TO = 21;
export const AC_ROLL_AWAY = 22;
export const AC_SPOT = 23;
export const AC_JUMP = 24;
export const AC_AD = 25;
/** Drifts, walks or dashes toward us. */
export const AC_IN = 26;
/** Away from us. */
export const AC_OUT = 27;
/** Does nothing (or keeps hanging, keeps lying there). */
export const AC_NONE = 28;
/** Climbs from the ledge, stands up, techs in place. */
export const AC_STAND = 29;
/** A second jab within JAB_MASH_WINDOW frames of the first. */
export const AC_JAB_MASH = 30;
/**
 * Recovery route, recorded when a recovery ends: base + (grabbed the ledge ? 2 : 0) + (late ? 1 : 0).
 * 31 high early (landed on stage quickly), 32 high late, 33 low early (to the ledge quickly), 34 low late.
 */
export const AC_RECOVERY = 31;
/** An attack that starts on the first actionable frame after hitstun. */
export const AC_BUFFERED = 35;
/** "No previous action yet" in a context key. */
const AC_START = NA;
/** DIRECT_MOVES index of the jab. */
const CLS_JAB = 0;
const JAB_MASH_WINDOW = 20;
/** Frames offstage before a return counts as a recovery at all, and after which it is "late". */
const REC_MIN = 20;
const REC_LATE = 90;

export const ACTION_CLASS_NAMES: readonly string[] = (() => {
  const n: string[] = [];
  for (let i = 0; i < DIRECT_MOVES.length; i++) n.push(DIRECT_MOVES[i]);
  n.push('ledgeAttack', 'getupAttack', 'grab', 'shield', 'rollTo', 'rollAway', 'spotDodge', 'jump', 'airDodge',
    'driftIn', 'driftOut', 'nothing', 'stand', 'jabMash', 'recHighEarly', 'recHighLate', 'recLowEarly',
    'recLowLate', 'bufferedOOH');
  return n;
})();

// ---------------------------------------------------------------------------------------------
// Context (02 section 6.1)
// ---------------------------------------------------------------------------------------------

export const SIT_GROUND = 0;
export const SIT_AIR = 1;
export const SIT_SHIELD = 2;
export const SIT_LAUNCHED = 3;
export const SIT_LEDGE = 4;
export const SIT_DOWN = 5;
export const SIT_OFF = 6;
const N_SIT = 7;
export const ZONE_CENTER = 0;
export const ZONE_LEDGE = 1;
export const ZONE_PLATFORM = 2;
export const ZONE_OFFSTAGE = 3;
/** Horizontal distance from a ledge that counts as "near ledge". */
const NEAR_LEDGE = 48;

/** Hashed context rows per order: the top 10 bits of a 32-bit multiplicative hash. */
const PRED_ROWS = 1024;
const SEQ_ROWS = (NA + 1) * (NA + 1);
const RHY_ROWS = (NA + 1) * 4;
/** Counter-me rows: our modal recent option + 1 (row 0 = none yet). */
const CM_ROWS = NA + 1;
const PRED_ALPHA = 0.5;
/** A loaded profile counts as at most this many observations per context row. */
const PRIOR_OBS = 60;
const SAMPLE_EVERY = 12;
const SAMPLE_HOLD = 6;
const SAMPLE_SETTLE = 8;
const RING_N = 30;
/** Members. */
export const N_MEMBERS = 8;
export const MEMBER_NAMES: readonly string[] = ['situation', 'order1', 'order2', 'sequence', 'chain', 'rhythm',
  'winStayLoseShift', 'counterMe'];
/** Decay of the member log scores and hit rates. */
const SCORE_DECAY = 0.9;
/** Exponential-weighting rate on the log scores. */
const ETA = 1;
const Q_FLOOR = 1e-4;
/** Our own recent committed options that decide "our most frequent option". */
const OWN_RING = 16;
/** Frames after an opponent action in which its outcome (damage either way) is judged. */
const WS_WINDOW = 90;
const DEFAULT_SLOW = 0.97;
const DEFAULT_FAST = 0.85;
const PROFILE_V = 2;
/** Per-class pseudo-count (one observation spread over the alphabet) in the changepoint's two estimates. */
const CP_PSEUDO = 1 / NA;

const HOLD_FREE = 0;
const HOLD_LEDGE = 1;
const HOLD_DOWN = 2;
const HOLD_OK = [new Uint8Array(NA), new Uint8Array(NA), new Uint8Array(NA)];
HOLD_OK[HOLD_FREE].fill(1);
for (const c of [AC_NONE, AC_STAND, AC_ROLL_TO, AC_OUT, AC_JUMP, AC_LEDGE_ATTACK]) HOLD_OK[HOLD_LEDGE][c] = 1;
for (const c of [AC_NONE, AC_STAND, AC_ROLL_TO, AC_ROLL_AWAY, AC_GETUP_ATTACK]) HOLD_OK[HOLD_DOWN][c] = 1;

function isMoveCls(c: number): boolean { return c === AC_IN || c === AC_OUT || c === AC_NONE; }

// ---------------------------------------------------------------------------------------------
// Frame-data and stage reads (ported from aevalmere.ts)
// ---------------------------------------------------------------------------------------------

interface StageBounds { minX: number; maxX: number; topY: number }
const stageCache = new Map<string, StageBounds>();

function stageBounds(stageId: string): StageBounds {
  let b = stageCache.get(stageId);
  if (b === undefined) { b = { minX: -180, maxX: 180, topY: 0 }; stageCache.set(stageId, b); }
  const st = STAGE_DEFS[stageId];
  let minX = -180, maxX = 180, topY = 0, found = false;
  if (st) {
    for (let i = 0; i < st.platforms.length; i++) {
      const p = st.platforms[i];
      if (!p.solid) continue;
      if (!found) { minX = p.x; maxX = p.x + p.w; topY = p.y; found = true; }
      else { if (p.x < minX) minX = p.x; if (p.x + p.w > maxX) maxX = p.x + p.w; if (p.y < topY) topY = p.y; }
    }
  }
  b.minX = minX; b.maxX = maxX; b.topY = topY;
  return b;
}

function onSoftPlatform(state: GameState, f: FighterState): boolean {
  if (!f.onGround) return false;
  const st = STAGE_DEFS[state.stageId];
  if (!st) return false;
  for (let i = 0; i < st.platforms.length; i++) {
    const p = st.platforms[i];
    if (p.solid) continue;
    if (Math.abs(f.y - p.y) > 0.5 || f.x < p.x || f.x > p.x + p.w) continue;
    return true;
  }
  return false;
}

function launched(f: FighterState): boolean {
  return (f.action === 'hitstun' || f.action === 'tumble') && f.hitstun > 0;
}

function offstage(f: FighterState, si: StageBounds): boolean {
  if (f.onGround || isLedgeAction(f.action)) return false;
  if (Math.abs(f.y - si.topY) < 0.5 && f.vy === 0 && f.x > si.minX - 14 && f.x < si.maxX + 14) return false;
  return f.x < si.minX - 2 || f.x > si.maxX + 2 || f.y > si.topY + 2;
}

/** Frames until `f` can start a new action on its own. */
function busyFrames(f: FighterState): number {
  const sf = f as SimFighter;
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'air': case 'shield':
      return 0;
    case 'attack': {
      if (f.moveId === null) return 0;
      const def = CHARACTER_DEFS[f.charId];
      const mv = def ? def.moves[f.moveId] : undefined;
      if (mv === undefined) return 0;
      const free = (mv.iasa === undefined ? mv.totalFrames : mv.iasa) + castDelay(sf, mv);
      let left = Math.max(0, free - f.actionFrame);
      if (sf.charging) left += 4;
      if (!f.onGround && mv.landingLag !== undefined) left = Math.max(left, 6);
      return left + f.hitlag;
    }
    case 'land': case 'shieldStun': case 'shieldBreak': return sf.stateTimer;
    case 'hitstun': return f.hitstun + f.hitlag;
    case 'tumble': return f.hitstun + f.hitlag + 8;
    case 'jumpsquat': return 3;
    case 'spotDodge': return Math.max(0, 22 - f.actionFrame);
    case 'roll': return Math.max(0, 24 - f.actionFrame);
    case 'airDodge': return Math.max(0, AIR_DODGE.total - f.actionFrame);
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

/** Free in neutral: could act, is not launched, holding a ledge, lying down or mid-move. */
function neutralFree(o: FighterState): boolean {
  switch (o.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'land': case 'air':
      return o.hitstun <= 0 && o.stocks > 0;
    case 'tumble':
      return o.hitstun <= 0 && o.hitlag === 0 && o.onGround && o.stocks > 0;
    default: return false;
  }
}

function sitOf(o: FighterState, si: StageBounds): number {
  if (isLedgeAction(o.action)) return SIT_LEDGE;
  if (o.action === 'downed' || o.action === 'getUp' || o.action === 'getUpRoll' || o.action === 'tech' || o.action === 'techRoll') return SIT_DOWN;
  if (launched(o) || o.action === 'tumble') return SIT_LAUNCHED;
  if (offstage(o, si)) return SIT_OFF;
  if (o.action === 'shield' || o.action === 'shieldStun') return SIT_SHIELD;
  return o.onGround ? SIT_GROUND : SIT_AIR;
}

function distBucket(m: FighterState, o: FighterState): number {
  const dx = o.x - m.x, dy = o.y - m.y;
  const d2 = dx * dx + dy * dy;
  return d2 < 3600 ? 0 : d2 < 14400 ? 1 : d2 < 48400 ? 2 : 3;
}

function oursOf(m: FighterState): number {
  if (m.action === 'shield' || m.action === 'shieldStun') return 2;
  return busyFrames(m) > 2 ? 1 : 0;
}

/**
 * Percent bucket. 02 section 6.1 asks for the bucket relative to the opponent's kill-percent
 * bracket (04); until the character profile is wired into the model, fixed brackets
 * 0-59 / 60-99 / 100-139 / 140+ stand in.
 */
function pctBucket(o: FighterState): number {
  const p = o.percent;
  return p < 60 ? 0 : p < 100 ? 1 : p < 140 ? 2 : 3;
}

function zoneOf(state: GameState, o: FighterState, si: StageBounds): number {
  if (offstage(o, si)) return ZONE_OFFSTAGE;
  if (onSoftPlatform(state, o)) return ZONE_PLATFORM;
  if (o.x - si.minX < NEAR_LEDGE || si.maxX - o.x < NEAR_LEDGE) return ZONE_LEDGE;
  return ZONE_CENTER;
}

function holdOf(o: FighterState): number {
  return o.action === 'ledgeHang' ? HOLD_LEDGE : o.action === 'downed' ? HOLD_DOWN : HOLD_FREE;
}

/**
 * Fills the state-derived fields of an observation context: situation, distance, our state,
 * percent bucket and stage zone of the opponent `oppI` as seen by `meI`. The history fields
 * (`last`, `prev`, `phase`) are set to -1: they belong to a predictor's own action history, and
 * `predict`, `counts` and `fastCounts` read a negative value as "use mine".
 */
export const makeContext: MakeContextFn = (state: GameState, meI: number, oppI: number, frame: number, out: ObsContext): void => {
  void frame;
  const o = state.fighters[oppI];
  const m = state.fighters[meI];
  const si = stageBounds(state.stageId);
  out.sit = sitOf(o, si);
  out.dist = distBucket(m, o);
  out.ours = oursOf(m);
  out.pctBucket = pctBucket(o);
  out.zone = zoneOf(state, o, si);
  out.last = -1; out.prev = -1; out.phase = -1;
};

export function newContext(): ObsContext {
  return { sit: SIT_GROUND, dist: 3, ours: 0, last: -1, prev: -1, phase: -1, pctBucket: 0, zone: ZONE_CENTER };
}

// ---------------------------------------------------------------------------------------------
// Classifier (one per watched fighter)
// ---------------------------------------------------------------------------------------------

interface Track {
  prevAction: ActionId | '';
  prevMove: MoveId | null;
  pendRoll: number;
  freeRun: number;
  moveCls: number;
  moveRun: number;
  lastSample: number;
  lastObs: number;
  lastJab: number;
  lastStun: number;
  offSince: number;
  recPending: number;
  sampled: boolean;
}

function newTrack(): Track {
  return { prevAction: '', prevMove: null, pendRoll: 0, freeRun: 0, moveCls: -1, moveRun: 0, lastSample: -1,
    lastObs: 0, lastJab: -9999, lastStun: -9999, offSince: -1, recPending: -1, sampled: false };
}

function resetTrack(t: Track): void {
  t.prevAction = ''; t.prevMove = null; t.pendRoll = 0; t.freeRun = 0; t.moveCls = -1; t.moveRun = 0;
  t.lastSample = -1; t.lastObs = 0; t.lastJab = -9999; t.lastStun = -9999; t.offSince = -1; t.recPending = -1;
  t.sampled = false;
}

const DIRECT_LIST = DIRECT_MOVES as readonly string[];

/** Attack class of a move start: its DIRECT_MOVES index, or the ledge or getup attack by where it came from. */
function attackIndex(id: MoveId, prev: ActionId | ''): number {
  const i = DIRECT_LIST.indexOf(id);
  if (i >= 0) return i;
  if (prev !== '' && isLedgeAction(prev)) return AC_LEDGE_ATTACK;
  if (prev === 'downed' || prev === 'getUp' || prev === 'tech') return AC_GETUP_ATTACK;
  return -1;
}

/**
 * Classifies what `o` started this frame (or, in neutral, its drift sample). Returns the class
 * or -1; `t.sampled` says whether it was a movement sample rather than a started action.
 */
function classify(state: GameState, o: FighterState, me: FighterState, t: Track, frame: number, si: StageBounds): number {
  const act = o.action;
  const prev = t.prevAction;
  t.sampled = false;
  const alive = o.stocks > 0 && act !== 'dead' && act !== 'respawn';
  let cls = -1;
  if (alive && prev !== '' && prev !== 'dead' && prev !== 'respawn') {
    const toMe = (me.x - o.x) * o.vx > 0;
    if (t.pendRoll > 0) {
      if (Math.abs(o.vx) > 0.3 || t.pendRoll === 1) { cls = toMe ? AC_ROLL_TO : AC_ROLL_AWAY; t.pendRoll = 0; } else t.pendRoll--;
    }
    if (cls < 0 && act === 'attack' && o.moveId !== null && (prev !== 'attack' || o.moveId !== t.prevMove)) {
      const idx = attackIndex(o.moveId, prev);
      if (idx >= 0) {
        cls = idx;
        if (idx === CLS_JAB) {
          if (frame - t.lastJab <= JAB_MASH_WINDOW) cls = AC_JAB_MASH;
          t.lastJab = frame;
        }
        if (cls !== AC_JAB_MASH && frame - t.lastStun <= 1) cls = AC_BUFFERED;
      }
    } else if (cls < 0 && prev !== act) {
      switch (act) {
        case 'grab': cls = AC_GRAB; break;
        case 'shield': if (prev !== 'shieldStun') cls = AC_SHIELD; break;
        case 'roll': case 'techRoll': case 'getUpRoll': t.pendRoll = 4; break;
        case 'ledgeRoll': cls = AC_ROLL_TO; break;
        case 'spotDodge': cls = AC_SPOT; break;
        case 'airDodge': cls = AC_AD; break;
        case 'ledgeClimb': case 'getUp': case 'tech': cls = AC_STAND; break;
        case 'air': if (prev === 'ledgeHang') cls = AC_OUT; break;
        default: break;
      }
    }
    if (cls < 0) {
      const ev = state.events;
      for (let e = 0; e < ev.length; e++) {
        const x = ev[e];
        if (x.type === 'jump' && x.slot === o.slot) { cls = AC_JUMP; break; }
      }
    }
    // Recovery route: judged on the frame the fighter is back on the stage or the ledge.
    if (offstage(o, si)) {
      if (t.offSince < 0) t.offSince = frame;
    } else if (t.offSince >= 0) {
      const away = frame - t.offSince;
      if (away >= REC_MIN && (o.onGround || isLedgeAction(act))) {
        t.recPending = AC_RECOVERY + (isLedgeAction(act) ? 2 : 0) + (away > REC_LATE ? 1 : 0);
      }
      t.offSince = -1;
    }
    if (cls < 0 && t.recPending >= 0 && t.pendRoll === 0) { cls = t.recPending; t.recPending = -1; }
    const free = neutralFree(o);
    const hx = o.inputHeld & (Btn.Left | Btn.Right);
    const hDir = hx === Btn.Right ? 1 : hx === Btn.Left ? -1 : 0;
    const mc = hDir === 0 ? AC_NONE : (me.x - o.x) * hDir > 0 ? AC_IN : AC_OUT;
    if (free) t.freeRun++; else t.freeRun = 0;
    if (mc === t.moveCls) t.moveRun++; else { t.moveCls = mc; t.moveRun = 1; }
    if (cls < 0 && t.pendRoll === 0) {
      const since = frame - t.lastObs;
      if (free && t.freeRun >= SAMPLE_SETTLE) {
        if ((mc !== t.lastSample && t.moveRun >= SAMPLE_HOLD) || since >= SAMPLE_EVERY) { cls = mc; t.sampled = true; }
      } else if ((act === 'ledgeHang' || act === 'downed') && since >= SAMPLE_EVERY) {
        cls = AC_NONE; t.sampled = true;
      } else if (act === 'shield' && since >= SAMPLE_EVERY) {
        cls = AC_SHIELD; t.sampled = true;
      }
    }
  }
  if (!alive) { t.offSince = -1; t.recPending = -1; }
  if (o.hitstun > 0) t.lastStun = frame;
  t.prevAction = act; t.prevMove = o.moveId;
  if (cls >= 0) { t.lastObs = frame; t.lastSample = t.sampled ? cls : -1; }
  return cls;
}

// ---------------------------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------------------------

/** Predictor plus the hooks the brain, the harness and the unit checks use. */
export interface PredictorBank extends Predictor {
  /** Clears tables, scores and history (a fresh match with no profile). */
  reset(): void;
  /**
   * Records one opponent action made in context `ctx` (history fields -1 = mine), exactly as
   * `observe` does after classifying it. For the harness and unit checks.
   */
  recordAction(cls: number, ctx: ObsContext, frame: number, sampled: boolean): void;
  /** Records one of our own committed options (feeds counter-me). */
  recordOwn(cls: number): void;
  /** Win-stay/lose-shift memory: in situation `sit` the opponent's `cls` worked (1), failed (-1) or neither (0). */
  recordOutcome(sit: number, cls: number, outcome: number): void;
  /** The predictor's own current context (history fields filled). */
  currentContext(out: ObsContext): void;
  /** Top class of the last predict call. */
  topClass(): number;
  stats(): { total: number; hits: number; recent: number; recentN: number; resets: number; lastReset: number };
  readonly changepoint: ChangepointState;
}

class Bank implements PredictorBank {
  private readonly learn: boolean;
  private readonly gSlow: number;
  private readonly gFast: number;
  private readonly nMin: number;
  // Slow tables (decayed by gSlow)
  private readonly o0 = new Float32Array(N_SIT * NA); private readonly t0 = new Float32Array(N_SIT);
  private readonly o1 = new Float32Array(PRED_ROWS * NA); private readonly t1 = new Float32Array(PRED_ROWS);
  private readonly o2 = new Float32Array(PRED_ROWS * NA); private readonly t2 = new Float32Array(PRED_ROWS);
  private readonly oS = new Float32Array(SEQ_ROWS * NA); private readonly tS = new Float32Array(SEQ_ROWS);
  private readonly oR = new Float32Array(RHY_ROWS * NA); private readonly tR = new Float32Array(RHY_ROWS);
  private readonly oT = new Float32Array(RHY_ROWS * 2); private readonly tT = new Float32Array(RHY_ROWS);
  private readonly oC = new Float32Array(CM_ROWS * NA); private readonly tC = new Float32Array(CM_ROWS);
  // Fast tables (decayed by gFast): order-1 key for fastCounts, per situation for the changepoint test
  private readonly oF = new Float32Array(PRED_ROWS * NA); private readonly tF = new Float32Array(PRED_ROWS);
  private readonly f0 = new Float32Array(N_SIT * NA); private readonly tf0 = new Float32Array(N_SIT);
  // Win-stay/lose-shift: per situation, the last action and how it went
  private readonly wsAct = new Int16Array(N_SIT);
  private readonly wsOut = new Int8Array(N_SIT);
  private pendCls = -1; private pendSit = 0; private pendFrame = 0;
  private pendMyPct = 0; private pendOppPct = 0; private pendMyStocks = 0; private pendOppStocks = 0;
  // Our own recent options
  private readonly ownRing = new Int16Array(OWN_RING);
  private readonly ownCount = new Int16Array(NA);
  private ownPos = 0; private ownN = 0; private modal = -1;
  // History
  private last = AC_START; private last2 = AC_START; private act1 = AC_START; private act2 = AC_START;
  private actFrame = 0;
  // Keys of the context the next observation is made in
  private k0 = 0; private k1 = 0; private k2 = 0; private kS = 0; private kR = 0; private kM = 0; private kHold = 0;
  private kSit = 0;
  // Scores
  private readonly score = new Float64Array(N_MEMBERS);
  private readonly hit = new Float64Array(N_MEMBERS);
  private readonly ring = new Uint8Array(RING_N);
  private ringPos = 0; private ringN = 0; private total = 0; private hits = 0;
  // Scratch
  private readonly compP = new Float64Array(N_MEMBERS * NA);
  private readonly predP = new Float64Array(NA);
  private readonly w = new Float64Array(N_MEMBERS);
  private readonly kn = { k: 0, n: 0 };
  private readonly cur: ObsContext = newContext();
  private readonly tmpCtx: ObsContext = newContext();
  private readonly tOpp = newTrack();
  private readonly tMe = newTrack();
  private lastFrame = -1;
  private stO = -1; private stM = -1;
  private top = AC_NONE;
  // Prior bookkeeping
  private priorLoaded = false;
  private llrPrior = 0;
  readonly changepoint: ChangepointState = createChangepointState();
  /** Every slow table and its totals: what a changepoint, a stock change or a poisoned prior scales. */
  private readonly slowTables: readonly Float32Array[] = [this.o0, this.t0, this.o1, this.t1, this.o2, this.t2,
    this.oS, this.tS, this.oR, this.tR, this.oT, this.tT, this.oC, this.tC];

  constructor(level: LevelVector) {
    const L = level.learning;
    this.learn = L.enabled;
    this.gSlow = L.enabled && L.gammaSlow > 0 && L.gammaSlow < 1 ? L.gammaSlow : DEFAULT_SLOW;
    this.gFast = L.enabled && L.gammaFast > 0 && L.gammaFast < 1 ? L.gammaFast : DEFAULT_FAST;
    this.nMin = L.enabled && L.nMin >= 1 ? L.nMin : 4;
    this.reset();
  }

  reset(): void {
    this.o0.fill(0); this.t0.fill(0); this.o1.fill(0); this.t1.fill(0); this.o2.fill(0); this.t2.fill(0);
    this.oS.fill(0); this.tS.fill(0); this.oR.fill(0); this.tR.fill(0); this.oT.fill(0); this.tT.fill(0);
    this.oC.fill(0); this.tC.fill(0); this.oF.fill(0); this.tF.fill(0); this.f0.fill(0); this.tf0.fill(0);
    this.wsAct.fill(-1); this.wsOut.fill(0); this.pendCls = -1;
    this.ownRing.fill(-1); this.ownCount.fill(0); this.ownPos = 0; this.ownN = 0; this.modal = -1;
    this.last = AC_START; this.last2 = AC_START; this.act1 = AC_START; this.act2 = AC_START; this.actFrame = 0;
    this.score.fill(0); this.hit.fill(0); this.ring.fill(0); this.ringPos = 0; this.ringN = 0; this.total = 0; this.hits = 0;
    resetTrack(this.tOpp); resetTrack(this.tMe);
    this.lastFrame = -1; this.stO = -1; this.stM = -1; this.top = AC_NONE;
    this.priorLoaded = false; this.llrPrior = 0;
    this.changepoint.reset();
    const c = this.tmpCtx;
    c.sit = SIT_GROUND; c.dist = 3; c.ours = 0; c.last = -1; c.prev = -1; c.phase = -1; c.pctBucket = 0; c.zone = ZONE_CENTER;
    this.setKeys(c, HOLD_FREE, 0);
  }

  // ---- keys -----------------------------------------------------------------------------------

  private phaseAt(frame: number): number {
    const since = frame - this.actFrame;
    return since <= 10 ? 0 : since <= 25 ? 1 : since <= 60 ? 2 : 3;
  }

  /** Sets the row keys from `ctx` (history fields < 0 read from this predictor). */
  private setKeys(ctx: ObsContext, hold: number, frame: number): void {
    const sit = clampInt(ctx.sit, 0, N_SIT - 1);
    const dist = clampInt(ctx.dist, 0, 3);
    const ours = clampInt(ctx.ours, 0, 2);
    const last = ctx.last >= 0 ? clampInt(ctx.last, 0, NA) : this.last;
    const prev = ctx.prev >= 0 ? clampInt(ctx.prev, 0, NA) : this.last2;
    const phase = ctx.phase >= 0 ? clampInt(ctx.phase, 0, 3) : this.phaseAt(frame);
    const pct = clampInt(ctx.pctBucket, 0, 3);
    const zone = clampInt(ctx.zone, 0, 3);
    const key1 = (((sit * 4 + dist) * 3 + ours) * (NA + 1) + last) * 4 + phase;
    const key2 = ((key1 * (NA + 1) + prev) * 4 + pct) * 4 + zone;
    this.kSit = sit;
    this.k0 = sit;
    this.k1 = Math.imul(key1 + 1, 0x9e3779b1) >>> 22;
    this.k2 = Math.imul(key2 + 7, 0x85ebca6b) >>> 22;
    this.kS = this.act1 * (NA + 1) + this.act2;
    this.kR = this.act1 * 4 + phase;
    this.kM = this.modal + 1;
    this.kHold = hold;
  }

  private holdFor(ctx: ObsContext): number {
    if (ctx.last < 0 && ctx.sit === this.cur.sit) return this.kHold;
    return ctx.sit === SIT_LEDGE ? HOLD_LEDGE : ctx.sit === SIT_DOWN ? HOLD_DOWN : HOLD_FREE;
  }

  // ---- prediction -----------------------------------------------------------------------------

  /** Fills compP and predP for the current keys; returns confidence. */
  private compute(): number {
    const { o0, t0, o1, t1, o2, t2, oS, tS, oR, tR, oC, tC, compP, predP } = this;
    const k0 = this.k0, k1 = this.k1, k2 = this.k2, kS = this.kS, kR = this.kR, kM = this.kM;
    const n0 = t0[k0], n1 = t1[k1], n2 = t2[k2], nS = tS[kS], nR = tR[kR], nM = tC[kM];
    const b0 = k0 * NA, b1 = k1 * NA, b2 = k2 * NA, bS = kS * NA, bR = kR * NA, bM = kM * NA;
    let u1 = 0, u2 = 0, uS = 0, uR = 0, uM = 0;
    for (let a = 0; a < NA; a++) {
      if (o1[b1 + a] > 0.05) u1++;
      if (o2[b2 + a] > 0.05) u2++;
      if (oS[bS + a] > 0.05) uS++;
      if (oR[bR + a] > 0.05) uR++;
      if (oC[bM + a] > 0.05) uM++;
    }
    const lR = nR > 0 ? nR / (nR + Math.max(1, uR)) : 0;
    const l1 = n1 > 0 ? n1 / (n1 + Math.max(1, u1)) : 0;
    const l2 = n2 > 0 ? n2 / (n2 + Math.max(1, u2)) : 0;
    const lS = nS > 0 ? nS / (nS + Math.max(1, uS)) : 0;
    const lM = nM > 0 ? nM / (nM + Math.max(1, uM)) : 0;
    const d0 = n0 + PRED_ALPHA * NA;
    const wa = this.wsAct[this.kSit], wo = this.wsOut[this.kSit];
    const B6 = 6 * NA, B7 = COUNTER_ME * NA;
    let loseMass = 0;
    for (let a = 0; a < NA; a++) {
      const p0 = (o0[b0 + a] + PRED_ALPHA) / d0;
      const pS = nS > 0 ? lS * (oS[bS + a] / nS) + (1 - lS) * p0 : p0;
      const q1 = n1 > 0 ? l1 * (o1[b1 + a] / n1) + (1 - l1) * p0 : p0;
      const q2 = n2 > 0 ? l2 * (o2[b2 + a] / n2) + (1 - l2) * q1 : q1;
      const c1 = n1 > 0 ? l1 * (o1[b1 + a] / n1) + (1 - l1) * pS : pS;
      compP[a] = p0;
      compP[NA + a] = q1;
      compP[2 * NA + a] = q2;
      compP[3 * NA + a] = pS;
      compP[4 * NA + a] = n2 > 0 ? l2 * (o2[b2 + a] / n2) + (1 - l2) * c1 : c1;
      compP[5 * NA + a] = nR > 0 ? lR * (oR[bR + a] / nR) + (1 - lR) * p0 : p0;
      // Win-stay/lose-shift in this situation.
      let ws = p0;
      if (wa >= 0) {
        if (wo > 0) ws = 0.4 * p0 + (a === wa ? 0.6 : 0);
        else if (wo < 0) { ws = a === wa ? 0 : p0; loseMass += ws; }
        else ws = 0.7 * p0 + (a === wa ? 0.3 : 0);
      }
      compP[B6 + a] = ws;
      compP[B7 + a] = nM > 0 ? lM * (oC[bM + a] / nM) + (1 - lM) * p0 : p0;
    }
    if (wa >= 0 && wo < 0 && loseMass > 0) for (let a = 0; a < NA; a++) compP[B6 + a] /= loseMass;
    if (this.kHold !== HOLD_FREE) {
      const ok = HOLD_OK[this.kHold];
      for (let c = 0; c < N_MEMBERS; c++) {
        const o = c * NA;
        let s = 0;
        for (let a = 0; a < NA; a++) { if (ok[a] === 0) compP[o + a] = 0; s += compP[o + a]; }
        if (s > 0) for (let a = 0; a < NA; a++) compP[o + a] /= s;
      }
    }
    // Exponential weighting on the decayed log scores.
    const w = this.w;
    let smax = -Infinity;
    for (let c = 0; c < N_MEMBERS; c++) if (this.score[c] > smax) smax = this.score[c];
    let wsum = 0;
    for (let c = 0; c < N_MEMBERS; c++) { w[c] = expDet(ETA * (this.score[c] - smax)); wsum += w[c]; }
    for (let a = 0; a < NA; a++) {
      let v = 0;
      for (let c = 0; c < N_MEMBERS; c++) v += w[c] * compP[c * NA + a];
      predP[a] = v / wsum;
    }
    // Timing vote (ported): after this action, in this phase, does the opponent act or wait?
    const nT = this.tT[kR];
    if (nT >= 1) {
      let actMass = 0;
      for (let a = 0; a < NA; a++) if (!isMoveCls(a)) actMass += predP[a];
      const pAct = (this.oT[kR * 2 + 1] + 0.5) / (nT + 1);
      const wT = nT / (nT + 2);
      const target = (1 - wT) * actMass + wT * pAct;
      const sA = actMass > 1e-9 ? target / actMass : 1;
      const sM = actMass < 1 - 1e-9 ? (1 - target) / (1 - actMass) : 1;
      for (let a = 0; a < NA; a++) predP[a] *= isMoveCls(a) ? sM : sA;
    }
    let b = 0;
    for (let a = 1; a < NA; a++) if (predP[a] > predP[b]) b = a;
    this.top = b;
    return (n1 + n2 + 0.5 * nS) / (n1 + n2 + 0.5 * nS + 6);
  }

  predict(ctx: ObsContext, out: Float64Array): number {
    if (!this.learn) {
      const d0 = this.t0[clampInt(ctx.sit, 0, N_SIT - 1)] + PRED_ALPHA * NA;
      const b0 = clampInt(ctx.sit, 0, N_SIT - 1) * NA;
      for (let a = 0; a < NA; a++) out[a] = (this.o0[b0 + a] + PRED_ALPHA) / d0;
      return 0;
    }
    this.withKeys(ctx);
    const conf = this.compute();
    for (let a = 0; a < NA; a++) out[a] = this.predP[a];
    this.restoreKeys();
    return conf;
  }

  // Temporary key swap so a query in another context leaves the stored keys intact.
  private sk0 = 0; private sk1 = 0; private sk2 = 0; private skS = 0; private skR = 0; private skM = 0; private skH = 0; private skSit = 0;
  private withKeys(ctx: ObsContext): void {
    this.sk0 = this.k0; this.sk1 = this.k1; this.sk2 = this.k2; this.skS = this.kS; this.skR = this.kR;
    this.skM = this.kM; this.skH = this.kHold; this.skSit = this.kSit;
    this.setKeys(ctx, this.holdFor(ctx), this.lastFrame < 0 ? 0 : this.lastFrame);
  }
  private restoreKeys(): void {
    this.k0 = this.sk0; this.k1 = this.sk1; this.k2 = this.sk2; this.kS = this.skS; this.kR = this.skR;
    this.kM = this.skM; this.kHold = this.skH; this.kSit = this.skSit;
  }

  counts(ctx: ObsContext, cls: number): { k: number; n: number } {
    this.withKeys(ctx);
    const c = clampInt(cls, 0, NA - 1);
    const kn = this.kn;
    const n2 = this.t2[this.k2], n1 = this.t1[this.k1];
    if (n2 >= this.nMin) { kn.k = this.o2[this.k2 * NA + c]; kn.n = n2; }
    else if (n1 > 0) { kn.k = this.o1[this.k1 * NA + c]; kn.n = n1; }
    else { kn.k = this.o0[this.k0 * NA + c]; kn.n = this.t0[this.k0]; }
    this.restoreKeys();
    return kn;
  }

  fastCounts(ctx: ObsContext, cls: number): { k: number; n: number } {
    this.withKeys(ctx);
    const c = clampInt(cls, 0, NA - 1);
    this.kn.k = this.oF[this.k1 * NA + c]; this.kn.n = this.tF[this.k1];
    this.restoreKeys();
    return this.kn;
  }

  memberScores(out: Float64Array): void {
    let smax = -Infinity;
    for (let c = 0; c < N_MEMBERS; c++) if (this.score[c] > smax) smax = this.score[c];
    let s = 0;
    for (let c = 0; c < N_MEMBERS; c++) { this.w[c] = expDet(ETA * (this.score[c] - smax)); s += this.w[c]; }
    const n = Math.min(out.length, N_MEMBERS);
    for (let c = 0; c < n; c++) out[c] = this.w[c] / s;
  }

  topClass(): number { return this.top; }

  // ---- learning -------------------------------------------------------------------------------

  private bump(o: Float32Array, t: Float32Array, row: number, cls: number, width: number, decay: number): void {
    const b = row * width;
    for (let k = 0; k < width; k++) o[b + k] *= decay;
    o[b + cls] += 1;
    t[row] = t[row] * decay + 1;
  }

  /** One observed action under the stored keys: scored first, then learned. */
  private record(cls: number, frame: number, sampled: boolean): void {
    this.compute();
    const hitNow = this.top === cls ? 1 : 0;
    const compP = this.compP;
    for (let c = 0; c < N_MEMBERS; c++) {
      const o = c * NA;
      const q = compP[o + cls];
      this.score[c] = this.score[c] * SCORE_DECAY + lnDet(q > Q_FLOOR ? q : Q_FLOOR);
      let b = 0;
      for (let a = 1; a < NA; a++) if (compP[o + a] > compP[o + b]) b = a;
      this.hit[c] = this.hit[c] * SCORE_DECAY + (b === cls ? 1 - SCORE_DECAY : 0);
    }
    this.total++; this.hits += hitNow;
    this.ring[this.ringPos] = hitNow; this.ringPos = (this.ringPos + 1) % RING_N; if (this.ringN < RING_N) this.ringN++;
    // Changepoint evidence: fast against slow per-situation table. Not the order-1 rows: those are
    // keyed by the opponent's own last action, so a new habit lands in rows neither table has seen.
    const g = this.gSlow;
    const pSlow = (this.o0[this.k0 * NA + cls] + CP_PSEUDO) / (this.t0[this.k0] + 1);
    const pFast = (this.f0[this.k0 * NA + cls] + CP_PSEUDO) / (this.tf0[this.k0] + 1);
    // Learn.
    this.bump(this.o0, this.t0, this.k0, cls, NA, g);
    this.bump(this.o1, this.t1, this.k1, cls, NA, g);
    this.bump(this.o2, this.t2, this.k2, cls, NA, g);
    this.bump(this.oS, this.tS, this.kS, cls, NA, g);
    this.bump(this.oR, this.tR, this.kR, cls, NA, g);
    this.bump(this.oT, this.tT, this.kR, isMoveCls(cls) ? 0 : 1, 2, g);
    this.bump(this.oC, this.tC, this.kM, cls, NA, g);
    this.bump(this.oF, this.tF, this.k1, cls, NA, this.gFast);
    this.bump(this.f0, this.tf0, this.k0, cls, NA, this.gFast);
    this.last2 = this.last; this.last = cls;
    if (!sampled) { this.act2 = this.act1; this.act1 = cls; this.actFrame = frame; }
    const fired = this.changepoint.update(pSlow, pFast, frame);
    let poisoned = false;
    if (this.priorLoaded && frame <= POISON_WINDOW) {
      const v = this.llrPrior + lnDet(pFast > Q_FLOOR ? pFast : Q_FLOOR) - lnDet(pSlow > Q_FLOOR ? pSlow : Q_FLOOR);
      this.llrPrior = v > 0 ? v : 0;
      poisoned = this.changepoint.poisoned(frame, this.llrPrior);
    }
    if (fired || poisoned) this.scaleCounts(RESET_SCALE);
  }

  recordAction(cls: number, ctx: ObsContext, frame: number, sampled: boolean): void {
    if (!this.learn || cls < 0 || cls >= NA) return;
    this.lastFrame = frame;
    this.setKeys(ctx, ctx.sit === SIT_LEDGE ? HOLD_LEDGE : ctx.sit === SIT_DOWN ? HOLD_DOWN : HOLD_FREE, frame);
    this.record(cls, frame, sampled);
    this.refreshCurrent(ctx, frame);
  }

  /** After a record the history changed: re-key the current context so predict sees the new history. */
  private refreshCurrent(ctx: ObsContext, frame: number): void {
    const c = this.cur;
    c.sit = ctx.sit; c.dist = ctx.dist; c.ours = ctx.ours; c.pctBucket = ctx.pctBucket; c.zone = ctx.zone;
    c.last = -1; c.prev = -1; c.phase = -1;
    this.setKeys(c, this.kHold, frame);
  }

  recordOwn(cls: number): void {
    if (cls < 0 || cls >= NA) return;
    const old = this.ownRing[this.ownPos];
    if (old >= 0) this.ownCount[old]--;
    this.ownRing[this.ownPos] = cls;
    this.ownCount[cls]++;
    this.ownPos = (this.ownPos + 1) % OWN_RING;
    if (this.ownN < OWN_RING) this.ownN++;
    // Modal option; a tie keeps the current modal so it does not flicker.
    let best = this.modal, bc = best >= 0 ? this.ownCount[best] : 0;
    for (let a = 0; a < NA; a++) if (this.ownCount[a] > bc) { bc = this.ownCount[a]; best = a; }
    this.modal = best;
    this.kM = this.modal + 1;
  }

  recordOutcome(sit: number, cls: number, outcome: number): void {
    const s = clampInt(sit, 0, N_SIT - 1);
    this.wsAct[s] = cls;
    this.wsOut[s] = outcome > 0 ? 1 : outcome < 0 ? -1 : 0;
  }

  private finalizePending(me: FighterState, o: FighterState): void {
    const dealt = me.stocks < this.pendMyStocks ? 100 : Math.max(0, me.percent - this.pendMyPct);
    const taken = o.stocks < this.pendOppStocks ? 100 : Math.max(0, o.percent - this.pendOppPct);
    this.recordOutcome(this.pendSit, this.pendCls, dealt > taken ? 1 : taken > dealt ? -1 : 0);
    this.pendCls = -1;
  }

  observe(state: GameState, meI: number, oppI: number, frame: number): void {
    const o = state.fighters[oppI];
    const me = state.fighters[meI];
    if (o === undefined || me === undefined) return;
    if (frame < this.lastFrame) {
      // Backward jump (a rollback or a new match on the same object): history restarts, tables stay.
      resetTrack(this.tOpp); resetTrack(this.tMe); this.pendCls = -1; this.stO = -1; this.stM = -1;
    }
    this.lastFrame = frame;
    const si = stageBounds(state.stageId);
    if (this.stO >= 0 && (o.stocks !== this.stO || me.stocks !== this.stM)) {
      const f = this.changepoint.onStockChange(frame);
      if (f < 1) this.scaleCounts(f);
    }
    this.stO = o.stocks; this.stM = me.stocks;
    const mine = classify(state, me, o, this.tMe, frame, si);
    if (mine >= 0 && !this.tMe.sampled) this.recordOwn(mine);
    if (this.pendCls >= 0 && frame - this.pendFrame >= WS_WINDOW) this.finalizePending(me, o);
    const cls = classify(state, o, me, this.tOpp, frame, si);
    if (cls >= 0 && this.learn) {
      const sampled = this.tOpp.sampled;
      if (!sampled) {
        if (this.pendCls >= 0) this.finalizePending(me, o);
        this.pendCls = cls; this.pendSit = this.kSit; this.pendFrame = frame;
        this.pendMyPct = me.percent; this.pendOppPct = o.percent; this.pendMyStocks = me.stocks; this.pendOppStocks = o.stocks;
      }
      this.record(cls, frame, sampled);
    }
    makeContext(state, meI, oppI, frame, this.cur);
    this.setKeys(this.cur, holdOf(o), frame);
  }

  currentContext(out: ObsContext): void {
    const c = this.cur;
    out.sit = c.sit; out.dist = c.dist; out.ours = c.ours; out.pctBucket = c.pctBucket; out.zone = c.zone;
    out.last = this.last; out.prev = this.last2; out.phase = this.phaseAt(this.lastFrame < 0 ? 0 : this.lastFrame);
  }

  scaleCounts(f: number): void {
    if (!(f >= 0) || f === 1) return;
    const tables = this.slowTables;
    for (let i = 0; i < tables.length; i++) { const t = tables[i]; for (let j = 0; j < t.length; j++) t[j] *= f; }
  }

  stats(): { total: number; hits: number; recent: number; recentN: number; resets: number; lastReset: number } {
    let h = 0;
    for (let i = 0; i < this.ringN; i++) h += this.ring[i];
    return { total: this.total, hits: this.hits, recent: this.ringN > 0 ? h / this.ringN : 0, recentN: this.ringN,
      resets: this.changepoint.resets, lastReset: this.changepoint.lastReset };
  }

  // ---- persistence (v2) -----------------------------------------------------------------------

  /**
   * Sparse v2 profile: {"v":2,"na":36,"rows":1024,"t":{name:[index,value,...]},"sc":[...],"hr":[...]}.
   * Values rounded to two decimals, entries under 0.01 dropped, so the size follows how much the
   * player has been seen, not the table size.
   */
  serialize(): string {
    const t: Record<string, number[]> = {
      o0: sparse(this.o0), o1: sparse(this.o1), o2: sparse(this.o2), sq: sparse(this.oS),
      rh: sparse(this.oR), tm: sparse(this.oT), cm: sparse(this.oC),
    };
    const sc: number[] = [], hr: number[] = [];
    for (let c = 0; c < N_MEMBERS; c++) { sc.push(round2(this.score[c])); hr.push(round2(this.hit[c])); }
    return JSON.stringify({ v: PROFILE_V, na: NA, rows: PRED_ROWS, t, sc, hr });
  }

  /**
   * Replaces the tables with a saved v2 profile as a prior, each row capped at PRIOR_OBS
   * observations. False, and nothing changed, for anything else (a v1 profile included).
   */
  load(text: string): boolean {
    let obj: unknown;
    try { obj = JSON.parse(text); } catch (err) { void err; return false; }   // corrupt = no profile
    if (obj === null || typeof obj !== 'object') return false;
    const p = obj as Record<string, unknown>;
    if (p.v !== PROFILE_V || p.na !== NA || p.rows !== PRED_ROWS) return false;
    const t = p.t as Record<string, unknown> | null;
    if (t === null || typeof t !== 'object') return false;
    const specs: [string, Float32Array][] = [['o0', this.o0], ['o1', this.o1], ['o2', this.o2], ['sq', this.oS],
      ['rh', this.oR], ['tm', this.oT], ['cm', this.oC]];
    const dense: Float64Array[] = [];
    for (const [name, dst] of specs) {
      const d = unsparse(t[name], dst.length);
      if (d === null) return false;
      dense.push(d);
    }
    if (!validNums(p.sc, N_MEMBERS, -1e6, 0) || !validNums(p.hr, N_MEMBERS, 0, 1)) return false;
    this.reset();
    loadScaled(dense[0], this.o0, this.t0, NA);
    loadScaled(dense[1], this.o1, this.t1, NA);
    loadScaled(dense[2], this.o2, this.t2, NA);
    loadScaled(dense[3], this.oS, this.tS, NA);
    loadScaled(dense[4], this.oR, this.tR, NA);
    loadScaled(dense[5], this.oT, this.tT, 2);
    loadScaled(dense[6], this.oC, this.tC, NA);
    for (let c = 0; c < N_MEMBERS; c++) { this.score[c] = p.sc[c]; this.hit[c] = p.hr[c]; }
    this.priorLoaded = true;
    this.llrPrior = 0;
    return true;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  const i = v | 0;
  return i < lo ? lo : i > hi ? hi : i;
}

function round2(x: number): number { return Math.round(x * 100) / 100; }

function sparse(a: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const v = round2(a[i]);
    if (v >= 0.01) out.push(i, v);
  }
  return out;
}

function unsparse(v: unknown, len: number): Float64Array | null {
  if (!Array.isArray(v) || v.length % 2 !== 0) return null;
  const d = new Float64Array(len);
  for (let i = 0; i < v.length; i += 2) {
    const idx: unknown = v[i], val: unknown = v[i + 1];
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= len) return null;
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return null;
    d[idx] = val;
  }
  return d;
}

function validNums(v: unknown, n: number, lo: number, hi: number): v is number[] {
  if (!Array.isArray(v) || v.length !== n) return false;
  for (let i = 0; i < n; i++) { const x: unknown = v[i]; if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) return false; }
  return true;
}

/** Copies row by row, each row scaled so its mass is at most PRIOR_OBS, and rebuilds the totals. */
function loadScaled(src: Float64Array, dst: Float32Array, tot: Float32Array, width: number): void {
  const rows = src.length / width;
  for (let r = 0; r < rows; r++) {
    let t = 0;
    for (let k = 0; k < width; k++) t += src[r * width + k];
    const s = t > PRIOR_OBS ? PRIOR_OBS / t : 1;
    for (let k = 0; k < width; k++) dst[r * width + k] = src[r * width + k] * s;
    tot[r] = t * s;
  }
}

/** Contract entry point. */
export const createPredictor: CreatePredictorFn = (level: LevelVector): Predictor => new Bank(level);

/** Same object typed with its extra hooks. */
export function createPredictorBank(level: LevelVector): PredictorBank { return new Bank(level); }
