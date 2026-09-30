/**
 * Perception (02 section 3; 03 section 2.1, P column; docs/CPU_PLAN.md W2.1).
 *
 * The brain reads state, never inputs, and it reads everyone but itself `P` frames late:
 * 1. `observe` copies the real state into a ring of pooled states every frame.
 * 2. `view` takes S(now - age), rolls it forward `age` frames with every other fighter holding
 *    what it held then ("continue", the principal hypothesis) and pastes the CPU's own fighter
 *    and own projectiles from the real state on top. Own state is exact; only the world is late.
 * 3. For every other live fighter (up to three) it keeps a small hypothesis set for the hidden
 *    frames: nothing new, or move / shield / spot dodge / roll / jump / air dodge started `ago`
 *    frames ago, weighted by that fighter's predictor (when one is registered) over the delayed
 *    context and cut to the top 4 to 6.
 * 4. Own-input delay on a LAN: with `setOwnDelay(d, pending)` the view perceives the world
 *    `P - d` back (floor 0) and then rolls the whole view forward `d` more frames with the
 *    already-sampled own inputs, so the CPU acts on the frame its input will land on.
 * 5. Passivity trackers per fighter (frames since the last input edge, the last movement of more
 *    than a few px, the last attack) are built only from delayed snapshots, so they leak nothing.
 *
 * Teams: every other fighter is tracked; `PerceivedMulti` says which are opponents and which are
 * teammates (sim/state.ts `sameTeam`). Friendly fire does not exist in this sim: under the Teams
 * rule teammates' hitboxes, grabs and projectiles pass through each other (sim/hits.ts), and
 * without the rule every other fighter is an opponent. Projectiles carry their owner slot and are
 * attributed to a fighter index by `ownerIndex`.
 *
 * Deterministic, no randomness, allocation-free per frame after warm-up (the sim's own event
 * objects aside).
 */
import type { FighterState, GameState, InputFrame, MoveId, ProjectileState } from '../core/types';
import { DIRECT_MOVES } from '../core/types';
import { AIR_DODGE, GETUP, GETUP_ROLL, ROLL, SPOT_DODGE, TECH } from '../core/constants';
import { CHARACTER_DEFS } from '../characters/registry';
import { cloneGameState, stepGame } from '../sim';
import { isLedgeAction } from '../sim/ledge';
import { castDelay } from '../sim/moves';
import { sameTeam, teamOf, type SimFighter } from '../sim/state';
import {
  ACTION_CLASS_COUNT, type CreatePerceptionFn, type Hypothesis, type HypKind, type LevelVector, type ObsContext,
  type Perceived, type Perception, type Predictor,
} from './contracts';
import {
  AC_AD, AC_BUFFERED, AC_GETUP_ATTACK, AC_GRAB, AC_IN, AC_JAB_MASH, AC_JUMP, AC_LEDGE_ATTACK, AC_OUT, AC_ROLL_AWAY,
  AC_ROLL_TO, AC_SHIELD, AC_SPOT, makeContext, newContext,
} from './model/predictor';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Fighters a match can hold. */
export const MAX_FIGHTERS = 4;
/** Hypotheses kept per fighter at most (02 section 3.3: top 4 to 6). */
export const MAX_HYPS = 6;
/** Hypotheses kept per fighter at least, when that many are feasible. */
export const MIN_HYPS = 4;
/** Extra ring slots past maxAge + own delay, so a decision cadence of this many frames keeps the trackers exact. */
const RING_SLACK = 16;
/** Largest own-input delay handled (02 section 3.5: 1 to 4). */
export const MAX_OWN_DELAY = 4;
/** Movement of more than this many px since the last anchor counts as moving (passivity). */
const MOVE_PX = 6;
/** Prior share of "nothing new" before the predictor speaks: most frames nobody starts anything. */
const PRIOR_NONE = 0.5;

// ---------------------------------------------------------------------------------------------
// Fighter reads shared with affordances.ts and targets.ts
// ---------------------------------------------------------------------------------------------

/** Frames until `f` can start a new action on its own, from its action and the move data. */
export function busyFrames(f: FighterState): number {
  const sf = f as SimFighter;
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'air': case 'shield':
    case 'ledgeHang': case 'grabHold':
      return f.hitlag;
    case 'attack': {
      if (f.moveId === null) return f.hitlag;
      const mv = CHARACTER_DEFS[f.charId].moves[f.moveId];
      const free = (mv.iasa === undefined ? mv.totalFrames : mv.iasa) + castDelay(sf, mv);
      let left = Math.max(0, free - f.actionFrame);
      if (sf.charging) left += 4;
      return left + f.hitlag;
    }
    case 'land': case 'shieldStun': case 'shieldBreak': return sf.stateTimer + f.hitlag;
    case 'hitstun': return f.hitstun + f.hitlag;
    case 'tumble': return f.hitstun + f.hitlag;
    case 'jumpsquat': return Math.max(0, CHARACTER_DEFS[f.charId].jumpSquat - f.actionFrame);
    case 'spotDodge': return Math.max(0, SPOT_DODGE.total - f.actionFrame);
    case 'roll': return Math.max(0, ROLL.total - f.actionFrame);
    case 'airDodge': return Math.max(0, AIR_DODGE.total - f.actionFrame);
    case 'airHelpless': return 60;
    case 'grab': return Math.max(0, 30 - f.actionFrame);
    case 'grabbed': return Math.max(30, sf.grabTimer);
    case 'throw': case 'pummel': return Math.max(0, 20 - f.actionFrame);
    case 'downed': return 1;
    case 'tech': return Math.max(0, TECH.inPlace.total - f.actionFrame);
    case 'techRoll': return Math.max(0, TECH.roll.total - f.actionFrame);
    case 'getUp': return Math.max(0, GETUP.total - f.actionFrame);
    case 'getUpRoll': return Math.max(0, GETUP_ROLL.total - f.actionFrame);
    case 'ledgeGrab': return 1;
    case 'ledgeClimb': case 'ledgeRoll': case 'ledgeJump': return Math.max(0, 30 - f.actionFrame);
    case 'footstooled': return 20;
    case 'respawn': return Math.max(0, f.respawnTimer);
    case 'dead': return 9999;
    case 'finalSmash': case 'finalSmashVictim': return 60;
    default: return 10;
  }
}

/** Frames the fighter cannot be hit by anything (full invulnerability), a roll's high-dodge counted too. */
export function invulnFrames(f: FighterState): number {
  if (f.action === 'dead') return 9999;
  if (f.action === 'respawn' || f.action === 'finalSmash' || f.action === 'finalSmashVictim') return Math.max(f.invuln, 60);
  const sf = f as SimFighter;
  return Math.max(f.invuln, sf.highDodge);
}

/** In hitstun or tumble with hitstun left. */
export function isLaunched(f: FighterState): boolean {
  return (f.action === 'hitstun' || f.action === 'tumble') && f.hitstun > 0;
}

/** Alive and in the match (not dead, stocks left). */
export function isLive(f: FighterState): boolean {
  return f.stocks > 0 && f.action !== 'dead';
}

/** Fighter index of a slot, -1 when absent. */
export function indexOfSlot(state: GameState, slot: number): number {
  const fs = state.fighters;
  for (let i = 0; i < fs.length; i++) if (fs[i].slot === slot) return i;
  return -1;
}

/** Fighter index of the fighter that owns `p` (its shooter), -1 when absent. */
export function ownerIndex(state: GameState, p: ProjectileState): number {
  return indexOfSlot(state, p.owner);
}

/** True when fighters `a` and `b` (indices) are teammates under the Teams rule. */
export function isTeammate(state: GameState, a: number, b: number): boolean {
  if (a === b) return false;
  return sameTeam(state, state.fighters[a].slot, state.fighters[b].slot);
}

/**
 * Whether a hit from fighter `a` lands on fighter `b` in this sim. False for a teammate: the Teams
 * rule turns friendly fire off (hits, grabs, projectiles, footstools), and there is no rule that
 * turns it on, so a teammate's hitbox is never a danger and never needs to be pathed around.
 */
export function hitsLand(state: GameState, a: number, b: number): boolean {
  return a !== b && !isTeammate(state, a, b);
}

/** True when any pair of teammates can hurt each other (never in this sim; kept so callers read one flag). */
export function friendlyFireOn(state: GameState): boolean {
  void state;
  return false;
}

/** Live opponents of `meI` (indices, ascending) into `out`; returns the count. */
export function opponentsOf(state: GameState, meI: number, out: number[]): number {
  let n = 0;
  const fs = state.fighters;
  for (let i = 0; i < fs.length; i++) {
    if (i === meI || !isLive(fs[i]) || isTeammate(state, meI, i)) continue;
    out[n++] = i;
  }
  return n;
}

/** Live teammates of `meI` (indices, ascending) into `out`; returns the count. */
export function teammatesOf(state: GameState, meI: number, out: number[]): number {
  let n = 0;
  const fs = state.fighters;
  for (let i = 0; i < fs.length; i++) {
    if (i === meI || !isLive(fs[i]) || !isTeammate(state, meI, i)) continue;
    out[n++] = i;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Pooled state copy
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
let fighterKeys: string[] | null = null;
let statKeys: string[] | null = null;

function learnFighter(f: FighterState): void {
  const keys = Object.keys(f);
  const plain: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'buffer' || k === 'stats') continue;
    plain.push(k);
  }
  fighterKeys = plain;
  const sk = Object.keys(f.stats);
  const prim: string[] = [];
  const rec = f.stats as unknown as Rec;
  for (let i = 0; i < sk.length; i++) {
    const v = rec[sk[i]];
    if (v === null || typeof v !== 'object') prim.push(sk[i]);
  }
  statKeys = prim;
}

/**
 * The same copy specialised to the learned field list: every property read and written by a
 * constant name, so V8 keeps monomorphic stores (no boxed doubles, several times faster). Built
 * with the Function constructor; where a content security policy forbids it the generic loop runs.
 */
let fastCopy: ((s: Rec, d: Rec) => void) | null = null;
let fastTried = false;
function buildFastCopy(): void {
  fastTried = true;
  const q = (k: string): string => JSON.stringify(k);
  let body = '';
  const keys = fighterKeys as string[];
  for (let i = 0; i < keys.length; i++) body += `d[${q(keys[i])}]=s[${q(keys[i])}];`;
  body += 'd.buffer.btn=s.buffer.btn;d.buffer.age=s.buffer.age;{const ss=s.stats,ds=d.stats;';
  const sk = statKeys as string[];
  for (let i = 0; i < sk.length; i++) body += `ds[${q(sk[i])}]=ss[${q(sk[i])}];`;
  body += '}';
  try {
    fastCopy = new Function('s', 'd', body) as (s: Rec, d: Rec) => void;
  } catch (err) {
    void err;   // blocked by a content security policy: keep the generic copy
    fastCopy = null;
  }
}

/**
 * Copies fighter `src` into `dst` without allocating. Every plain field (primitives and the
 * immutable throw def reference) is assigned; the input buffer is copied field by field; stats
 * keep `dst`'s own objects (stats never drive gameplay, and `mostUsedMove` must never be shared
 * with the real state, since the sim writes into it).
 */
export function copyFighterInto(src: FighterState, dst: FighterState): void {
  if (fighterKeys === null) learnFighter(src);
  if (!fastTried) buildFastCopy();
  if (fastCopy !== null) { fastCopy(src as unknown as Rec, dst as unknown as Rec); return; }
  const s = src as unknown as Rec;
  const d = dst as unknown as Rec;
  const keys = fighterKeys as string[];
  for (let i = 0; i < keys.length; i++) d[keys[i]] = s[keys[i]];
  dst.buffer.btn = src.buffer.btn;
  dst.buffer.age = src.buffer.age;
  const ss = src.stats as unknown as Rec;
  const ds = dst.stats as unknown as Rec;
  const sk = statKeys as string[];
  for (let i = 0; i < sk.length; i++) ds[sk[i]] = ss[sk[i]];
}

function copyProjectileInto(s: ProjectileState, d: ProjectileState): void {
  d.id = s.id; d.owner = s.owner; d.defId = s.defId;
  d.x = s.x; d.y = s.y; d.vx = s.vx; d.vy = s.vy;
  d.facing = s.facing; d.age = s.age; d.hitSlots = s.hitSlots; d.alive = s.alive;
  d.power = s.power; d.scale = s.scale; d.returned = s.returned; d.charge = s.charge ?? 0;
}

function deadProjectile(): ProjectileState {
  return { id: 0, owner: -1, defId: '', x: 0, y: 0, vx: 0, vy: 0, facing: 1, age: 0, hitSlots: 0,
    alive: false, power: 1, scale: 1, returned: false, charge: 0 };
}

/**
 * Copies `src` into the pooled state `dst` (made by cloneGameState of a state of the same match)
 * without allocating once `dst` has seen the largest projectile count. Projectile slots past the
 * source's are kept and marked dead: the sim skips dead slots and hands them back out as it would
 * a fresh one, so the copy steps identically. `config` is shared by reference (immutable).
 */
export function copyWorldInto(src: GameState, dst: GameState): void {
  dst.frame = src.frame;
  dst.rng.s = src.rng.s;
  dst.config = src.config;
  dst.stageId = src.stageId;
  dst.finished = src.finished;
  dst.winner = src.winner;
  dst.timeLeft = src.timeLeft;
  dst.nextProjectileId = src.nextProjectileId;
  dst.endFrame = src.endFrame;
  if (src.winnerTeam !== undefined) dst.winnerTeam = src.winnerTeam;
  else if (dst.winnerTeam !== undefined) delete dst.winnerTeam;
  dst.events.length = 0;
  const sf = src.fighters;
  const df = dst.fighters;
  if (df.length !== sf.length) {
    // Only when a pool meets a match with another player count.
    const fresh = cloneGameState(src).fighters;
    df.length = 0;
    for (let i = 0; i < fresh.length; i++) df.push(fresh[i]);
  }
  for (let i = 0; i < sf.length; i++) copyFighterInto(sf[i], df[i]);
  const sp = src.projectiles;
  const dp = dst.projectiles;
  for (let i = 0; i < sp.length; i++) {
    if (i >= dp.length) dp.push(deadProjectile());
    copyProjectileInto(sp[i], dp[i]);
  }
  for (let i = sp.length; i < dp.length; i++) dp[i].alive = false;
}

/** Replaces `meSlot`'s projectiles in `dst` by the real ones in `src` (own shots are known exactly). */
function pasteOwnProjectiles(src: GameState, dst: GameState, meSlot: number): void {
  const dp = dst.projectiles;
  for (let i = 0; i < dp.length; i++) if (dp[i].owner === meSlot) dp[i].alive = false;
  const sp = src.projectiles;
  for (let i = 0; i < sp.length; i++) {
    const p = sp[i];
    if (!p.alive || p.owner !== meSlot) continue;
    let slot = -1;
    for (let j = 0; j < dp.length; j++) if (!dp[j].alive) { slot = j; break; }
    if (slot < 0) { dp.push(deadProjectile()); slot = dp.length - 1; }
    copyProjectileInto(p, dp[slot]);
  }
}

// ---------------------------------------------------------------------------------------------
// Multi-fighter view
// ---------------------------------------------------------------------------------------------

/** What perception knows about one other fighter, from the delayed stream only. */
export interface OtherView {
  index: number; slot: number; team: number;
  /** Other fighter on the CPU's team (friendly fire off: never a target, never a danger). */
  teammate: boolean;
  live: boolean;
  /** Pooled, the first `nHyps` entries valid; `hyps.length === nHyps`; weights sum to 1. */
  hyps: Hypothesis[]; nHyps: number;
  passivity: number; framesSinceEdge: number; framesSinceAttack: number; framesSinceMove: number;
  /** The delayed state visibly changed since the previous decision frame. */
  newEvent: boolean;
  /** Delayed frame of the last visible change. */
  eventFrame: number;
  /** Busy and invulnerable frames as seen in the view state. */
  busy: number; invuln: number;
}

/**
 * Perceived, plus every other fighter: `others[i]` for each fighter index (the CPU's own entry has
 * `live` false), the live opponents and teammates, and the raw delayed snapshot.
 */
export interface PerceivedMulti extends Perceived {
  others: OtherView[];
  opps: number[]; nOpps: number;
  mates: number[]; nMates: number;
  friendlyFire: boolean;
  /** S(now - age) exactly as it was (pooled; valid until the next observe). */
  delayed: GameState | null;
}

function newOtherView(i: number): OtherView {
  const hyps: Hypothesis[] = [];
  return { index: i, slot: -1, team: -1, teammate: false, live: false, hyps, nHyps: 0, passivity: 0,
    framesSinceEdge: 0, framesSinceAttack: 0, framesSinceMove: 0, newEvent: false, eventFrame: -1, busy: 0, invuln: 0 };
}

/** A fresh output object for `Perception.view`, with room for every fighter. */
export function newPerceived(): PerceivedMulti {
  const others: OtherView[] = [];
  for (let i = 0; i < MAX_FIGHTERS; i++) others.push(newOtherView(i));
  return {
    state: null as unknown as GameState, meI: -1, oppI: -1, frame: -1, age: 0, ownDelay: 0, hyps: others[0].hyps,
    passivity: 0, framesSinceEdge: 0, framesSinceAttack: 0, newEvent: false,
    others, opps: [0, 0, 0, 0], nOpps: 0, mates: [0, 0, 0, 0], nMates: 0, friendlyFire: false, delayed: null,
  };
}

function isMulti(out: Perceived): out is PerceivedMulti {
  return (out as Partial<PerceivedMulti>).others !== undefined;
}

/** Perception plus the multi-fighter hooks the brain and the unit checks use. */
export interface TeamPerception extends Perception {
  /** Predictor for fighter `index`'s hypotheses (null = legality prior only). */
  setPredictor(index: number, pred: Predictor | null): void;
  /** Own-input delay `d` (0 to 4) and the own inputs already sampled for frames now .. now + d - 1. */
  setOwnDelay(d: number, pending: readonly InputFrame[] | null): void;
  /** The observed real state of `frame`, or null when it left the ring. */
  delayedAt(frame: number): GameState | null;
  /** Hypotheses of fighter `index` from the last view (empty before any view). */
  hypsOf(index: number): readonly Hypothesis[];
}

// ---------------------------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------------------------

const HK_NONE = 0, HK_MOVE = 1, HK_SHIELD = 2, HK_SPOT = 3, HK_ROLL = 4, HK_JUMP = 5, HK_AD = 6;
const HK_NAMES: readonly HypKind[] = ['none', 'move', 'shield', 'spotDodge', 'roll', 'jump', 'airDodge'];
/** Candidates: classes x ages, plus the drift and "nothing" entries. */
const CAND_CAP = ACTION_CLASS_COUNT * (32 + MAX_OWN_DELAY) + 8;

/** Where the delayed fighter is, for class legality. */
const LS_GROUND = 0, LS_AIR = 1, LS_LEDGE = 2, LS_DOWN = 3, LS_STUN = 4, LS_OTHER = 5;

function legalSit(f: FighterState): number {
  if (f.action === 'dead' || f.action === 'respawn') return LS_OTHER;
  if (f.action === 'ledgeHang' || f.action === 'ledgeGrab') return LS_LEDGE;
  if (f.action === 'downed') return LS_DOWN;
  if (isLaunched(f) || f.action === 'grabbed' || f.action === 'shieldBreak') return LS_STUN;
  if (isLedgeAction(f.action)) return LS_OTHER;
  return f.onGround ? LS_GROUND : LS_AIR;
}

class HypBuilder {
  readonly probs = new Float64Array(ACTION_CLASS_COUNT);
  readonly ctx: ObsContext = newContext();
  // Candidate columns.
  private readonly cKind = new Int8Array(CAND_CAP);
  private readonly cCls = new Int16Array(CAND_CAP);
  private readonly cAgo = new Int16Array(CAND_CAP);
  private readonly cDir = new Int8Array(CAND_CAP);
  private readonly cW = new Float64Array(CAND_CAP);
  private readonly taken = new Uint8Array(CAND_CAP);
  private n = 0;

  private add(kind: number, cls: number, ago: number, dir: number, w: number): void {
    if (!(w > 0) || this.n >= CAND_CAP) return;
    const i = this.n++;
    this.cKind[i] = kind; this.cCls[i] = cls; this.cAgo[i] = ago; this.cDir[i] = dir; this.cW[i] = w;
    this.taken[i] = 0;
  }

  /**
   * Fills `ov.hyps` for the fighter `oi` of the delayed snapshot `d`, `age` frames old, seen by `meI`.
   * `keep` is the cap (4 to 6).
   */
  build(d: GameState, meI: number, oi: number, age: number, pred: Predictor | null, keep: number,
    pool: Hypothesis[], ov: OtherView): void {
    const f = d.fighters[oi];
    const me = d.fighters[meI];
    const toward = me.x >= f.x ? 1 : -1;
    this.n = 0;
    if (age <= 0 || !isLive(f)) {
      this.emitNone(pool, ov);
      return;
    }
    // Class probabilities: predictor over the delayed context, blended with a flat prior by its confidence.
    let conf = 0;
    if (pred !== null) {
      makeContext(d, meI, oi, d.frame, this.ctx);
      conf = pred.predict(this.ctx, this.probs);
      if (!(conf >= 0)) conf = 0;
      if (conf > 1) conf = 1;
    }
    const sit = legalSit(f);
    const busy = busyFrames(f);
    const sf = f as SimFighter;
    const def = CHARACTER_DEFS[f.charId];
    let nLegal = 0;
    for (let c = 0; c < ACTION_CLASS_COUNT; c++) if (this.classKind(c, sit, f, sf) >= 0) nLegal++;
    let noneMass = 0;
    const flat = nLegal > 0 ? (1 - PRIOR_NONE) / nLegal : 0;
    for (let c = 0; c < ACTION_CLASS_COUNT; c++) {
      const pc = pred !== null ? conf * this.probs[c] : 0;
      const kind = this.classKind(c, sit, f, sf);
      if (kind < 0) { noneMass += pc; continue; }
      const w = pc + (1 - conf) * flat;
      if (kind === HK_NONE) {
        const dir = c === AC_IN ? toward : c === AC_OUT ? -toward : 0;
        if (dir === 0) noneMass += w;
        else this.add(HK_NONE, c, 0, dir, w);
        continue;
      }
      // Started k frames ago needs the fighter free on the step out of frame now - k. A fighter with
      // `busy` frames left acts on the step that ends its last busy frame: busy - 1 <= age - k.
      const kMax = Math.min(age, age - busy + 1);
      if (kMax < 1) { noneMass += w; continue; }
      // A move needs the right ground state for its def.
      if (kind === HK_MOVE && c < DIRECT_MOVES.length) {
        const mv = def.moves[DIRECT_MOVES[c]];
        if ((mv.airOnly === true && f.onGround) || (mv.groundOnly === true && !f.onGround)) { noneMass += w; continue; }
      }
      const dir = c === AC_ROLL_TO ? toward : c === AC_ROLL_AWAY ? -toward : kind === HK_MOVE ? f.facing : 0;
      const per = w / kMax;
      for (let k = 1; k <= kMax; k++) this.add(kind, c, k, dir, per);
    }
    noneMass += (1 - conf) * PRIOR_NONE;
    // "Nothing new" is always kept and always first.
    let total = 0;
    const hyps = ov.hyps;
    let n = 0;
    const h0 = pool[0];
    h0.kind = 'none'; h0.move = null; h0.ago = 0; h0.dir = 0; h0.weight = noneMass;
    hyps[n++] = h0;
    total += noneMass;
    // Greedy by option: the class with the largest total weight goes in with every age it can
    // have (so a kept option covers the whole hidden window), then the next, until the cap.
    // Ties break by class order, so the cut is deterministic.
    while (n < keep) {
      let best = -1; let bestW = 0;
      for (let i = 0; i < this.n; i++) {
        if (this.taken[i] !== 0 || (i > 0 && this.cCls[i - 1] === this.cCls[i] && this.cKind[i - 1] === this.cKind[i])) continue;
        let w = 0;
        for (let j = i; j < this.n && this.cCls[j] === this.cCls[i] && this.cKind[j] === this.cKind[i]; j++) w += this.cW[j];
        if (best < 0 || w > bestW) { best = i; bestW = w; }
      }
      if (best < 0) break;
      for (let j = best; j < this.n && n < keep && this.cCls[j] === this.cCls[best] && this.cKind[j] === this.cKind[best]; j++) {
        this.taken[j] = 1;
        const h = pool[n];
        const kind = this.cKind[j];
        h.kind = HK_NAMES[kind];
        h.move = kind === HK_MOVE ? this.moveOf(this.cCls[j]) : null;
        h.ago = this.cAgo[j];
        h.dir = this.cDir[j];
        h.weight = this.cW[j];
        total += h.weight;
        hyps[n++] = h;
      }
      // A group cut short by the cap still counts as taken.
      for (let j = best; j < this.n && this.cCls[j] === this.cCls[best] && this.cKind[j] === this.cKind[best]; j++) this.taken[j] = 1;
    }
    if (total > 0) for (let i = 0; i < n; i++) hyps[i].weight /= total;
    else { hyps[0].weight = 1; n = 1; }
    hyps.length = n;
    ov.nHyps = n;
  }

  private emitNone(pool: Hypothesis[], ov: OtherView): void {
    const h0 = pool[0];
    h0.kind = 'none'; h0.move = null; h0.ago = 0; h0.dir = 0; h0.weight = 1;
    ov.hyps[0] = h0;
    ov.hyps.length = 1;
    ov.nHyps = 1;
  }

  /** Move of a class, null for the grab, the ledge and getup attacks and the buffered attack. */
  private moveOf(cls: number): MoveId | null {
    if (cls < DIRECT_MOVES.length) return DIRECT_MOVES[cls];
    if (cls === AC_JAB_MASH) return DIRECT_MOVES[0];
    return null;
  }

  /** HK_* kind of class `c` for a fighter in legality situation `sit`, -1 when it cannot start there. */
  private classKind(c: number, sit: number, f: FighterState, sf: SimFighter): number {
    if (sit === LS_OTHER) return c === AC_IN || c === AC_OUT ? -1 : HK_NONE;
    if (sit === LS_STUN) {
      if (c === AC_BUFFERED) return HK_MOVE;
      if (c === AC_AD) return f.onGround || sf.airDodgeUsed ? -1 : HK_AD;
      if (c === AC_JUMP) return f.jumpsLeft > 0 ? HK_JUMP : -1;
      return c === AC_IN || c === AC_OUT ? HK_NONE : -1;
    }
    if (sit === LS_LEDGE) {
      if (c === AC_LEDGE_ATTACK) return HK_MOVE;
      if (c === AC_ROLL_TO || c === AC_ROLL_AWAY) return HK_ROLL;
      if (c === AC_JUMP) return HK_JUMP;
      if (c < DIRECT_MOVES.length || c === AC_GRAB || c === AC_SHIELD || c === AC_SPOT || c === AC_AD
        || c === AC_GETUP_ATTACK || c === AC_BUFFERED || c === AC_JAB_MASH) return -1;
      return HK_NONE;
    }
    if (sit === LS_DOWN) {
      if (c === AC_GETUP_ATTACK) return HK_MOVE;
      if (c === AC_ROLL_TO || c === AC_ROLL_AWAY) return HK_ROLL;
      if (c < DIRECT_MOVES.length || c === AC_GRAB || c === AC_SHIELD || c === AC_SPOT || c === AC_AD || c === AC_JUMP
        || c === AC_LEDGE_ATTACK || c === AC_BUFFERED || c === AC_JAB_MASH) return -1;
      return HK_NONE;
    }
    const ground = sit === LS_GROUND;
    if (c < DIRECT_MOVES.length) return HK_MOVE;
    switch (c) {
      case AC_LEDGE_ATTACK: case AC_GETUP_ATTACK: case AC_BUFFERED: return -1;
      case AC_JAB_MASH: return ground ? HK_MOVE : -1;
      case AC_GRAB: return ground ? HK_MOVE : -1;
      case AC_SHIELD: return ground ? HK_SHIELD : -1;
      case AC_SPOT: return ground ? HK_SPOT : -1;
      case AC_ROLL_TO: case AC_ROLL_AWAY: return ground ? HK_ROLL : -1;
      case AC_JUMP: return ground || f.jumpsLeft > 0 ? HK_JUMP : -1;
      case AC_AD: return !ground && !sf.airDodgeUsed ? HK_AD : -1;
      default: return HK_NONE;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Trackers (delayed stream only)
// ---------------------------------------------------------------------------------------------

class Tracker {
  processed = -1;
  prevAction = '';
  prevHeld = 0;
  prevPercent = 0;
  prevStocks = 0;
  anchorX = 0; anchorY = 0;
  lastEdge = -1; lastMove = -1; lastAttack = -1; lastEvent = -1;
  /** eventFrame already reported at the previous decision frame. */
  seenBase = -1;
  seenCur = -1;

  reset(): void {
    this.processed = -1; this.prevAction = ''; this.prevHeld = 0; this.prevPercent = 0; this.prevStocks = 0;
    this.anchorX = 0; this.anchorY = 0;
    this.lastEdge = -1; this.lastMove = -1; this.lastAttack = -1; this.lastEvent = -1;
    this.seenBase = -1; this.seenCur = -1;
  }

  feed(s: GameState, i: number): void {
    const f = s.fighters[i];
    const fr = s.frame;
    if (this.processed < 0) {
      this.prevAction = f.action; this.prevHeld = f.inputHeld; this.prevPercent = f.percent; this.prevStocks = f.stocks;
      this.anchorX = f.x; this.anchorY = f.y;
      this.lastEdge = fr; this.lastMove = fr; this.lastAttack = fr; this.lastEvent = fr;
      this.processed = fr;
      return;
    }
    const sf = f as SimFighter;
    if (f.inputHeld !== this.prevHeld || sf.inputPressed !== 0) this.lastEdge = fr;
    const dx = f.x - this.anchorX; const dy = f.y - this.anchorY;
    if (dx > MOVE_PX || dx < -MOVE_PX || dy > MOVE_PX || dy < -MOVE_PX) {
      this.lastMove = fr; this.anchorX = f.x; this.anchorY = f.y;
    }
    const attacking = f.action === 'attack' || f.action === 'grab' || f.action === 'throw' || f.action === 'pummel';
    if (attacking && (this.prevAction !== f.action || f.actionFrame === 0)) this.lastAttack = fr;
    if (f.action !== this.prevAction || f.percent !== this.prevPercent || f.stocks !== this.prevStocks
      || (f.action === 'attack' && f.actionFrame === 0)) this.lastEvent = fr;
    this.prevAction = f.action; this.prevHeld = f.inputHeld; this.prevPercent = f.percent; this.prevStocks = f.stocks;
    this.processed = fr;
  }
}

// ---------------------------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------------------------

const NO_INPUT_HELD = 0;
const NO_HYPS: readonly Hypothesis[] = [];

class PerceptionImpl implements TeamPerception {
  private readonly ringSize: number;
  private readonly ring: GameState[] = [];
  private readonly ringFrame: Int32Array;
  private readonly viewState: GameState;
  private readonly inputs: InputFrame[] = [];
  private readonly trackers: Tracker[] = [];
  private readonly preds: (Predictor | null)[] = [];
  private readonly pools: Hypothesis[][] = [];
  private readonly others: OtherView[] = [];
  private readonly builder = new HypBuilder();
  private config: unknown = null;
  private lastObserved = -1;
  private firstObserved = -1;
  private ownDelay = 0;
  private pending: readonly InputFrame[] | null = null;
  // View cache: the rolled state is shared by every opponent's view in one frame.
  private viewKeyFrame = -1; private viewKeyAge = -1; private viewKeyMe = -1; private viewKeyD = -1;
  private viewKeyObs = -1;
  private decisionFrame = -1;
  private delayedRef: GameState | null = null;

  constructor(poolFrom: GameState, readonly maxAge: number) {
    this.ringSize = Math.max(1, maxAge) + MAX_OWN_DELAY + RING_SLACK;
    this.ringFrame = new Int32Array(this.ringSize).fill(-1);
    for (let i = 0; i < this.ringSize; i++) this.ring.push(cloneGameState(poolFrom));
    this.viewState = cloneGameState(poolFrom);
    for (let i = 0; i < MAX_FIGHTERS; i++) {
      this.inputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });
      this.trackers.push(new Tracker());
      this.preds.push(null);
      const pool: Hypothesis[] = [];
      for (let k = 0; k < MAX_HYPS; k++) pool.push({ kind: 'none', move: null, ago: 0, dir: 0, weight: 0 });
      this.pools.push(pool);
      this.others.push(newOtherView(i));
    }
  }

  reset(): void {
    this.ringFrame.fill(-1);
    for (let i = 0; i < MAX_FIGHTERS; i++) {
      this.trackers[i].reset();
      const ov = this.others[i];
      ov.hyps.length = 0; ov.nHyps = 0; ov.live = false; ov.eventFrame = -1; ov.newEvent = false;
    }
    this.config = null;
    this.lastObserved = -1;
    this.firstObserved = -1;
    this.viewKeyFrame = -1;
    this.viewKeyObs = -1;
    this.decisionFrame = -1;
    this.delayedRef = null;
  }

  setPredictor(index: number, pred: Predictor | null): void {
    if (index >= 0 && index < MAX_FIGHTERS) this.preds[index] = pred;
  }

  setOwnDelay(d: number, pending: readonly InputFrame[] | null): void {
    this.ownDelay = d < 0 ? 0 : d > MAX_OWN_DELAY ? MAX_OWN_DELAY : Math.floor(d);
    this.pending = pending;
    this.viewKeyFrame = -1;
  }

  delayedAt(frame: number): GameState | null {
    if (frame < 0) return null;
    const i = frame % this.ringSize;
    return this.ringFrame[i] === frame ? this.ring[i] : null;
  }

  hypsOf(index: number): readonly Hypothesis[] {
    return this.others[index].hyps;
  }

  observe(real: GameState, meI: number): void {
    void meI;
    // A new match or a backward jump (rollback re-simulation, a harness restart) clears memory.
    if (real.config !== this.config || (this.lastObserved >= 0 && real.frame < this.lastObserved)) {
      this.reset();
      this.config = real.config;
    }
    if (real.frame === this.lastObserved) return;
    const i = real.frame % this.ringSize;
    copyWorldInto(real, this.ring[i]);
    this.ringFrame[i] = real.frame;
    if (this.firstObserved < 0) this.firstObserved = real.frame;
    this.lastObserved = real.frame;
  }

  /** Newest stored snapshot with frame <= target, else the oldest stored one (match start). */
  private snapshotFor(target: number): GameState | null {
    for (let f = target; f >= 0 && f > target - this.ringSize; f--) {
      const s = this.delayedAt(f);
      if (s !== null) return s;
    }
    let best: GameState | null = null;
    let bestF = Infinity;
    for (let k = 0; k < this.ringSize; k++) {
      const f = this.ringFrame[k];
      if (f >= 0 && f < bestF) { bestF = f; best = this.ring[k]; }
    }
    return best;
  }

  private feedTrackers(upTo: number, n: number): void {
    for (let j = 0; j < n; j++) {
      const t = this.trackers[j];
      let from = t.processed < 0 ? upTo : t.processed + 1;
      if (upTo - from >= this.ringSize) from = upTo - this.ringSize + 1;
      for (let f = from; f <= upTo; f++) {
        const s = this.delayedAt(f);
        if (s !== null && j < s.fighters.length) t.feed(s, j);
      }
    }
  }

  view(real: GameState, meI: number, oppI: number, level: LevelVector, pred: Predictor, out: Perceived): void {
    this.observe(real, meI);
    const F = real.frame;
    const P = Math.min(this.maxAge, Math.max(0, Math.round(level.perceptionAge)));
    const pendingOk = this.pending !== null && this.pending.length >= this.ownDelay;
    const d = pendingOk ? this.ownDelay : 0;
    const wantAge = Math.max(0, P - d);
    const n = real.fighters.length;
    if (oppI >= 0 && oppI < MAX_FIGHTERS && pred !== null) this.preds[oppI] = pred;

    // Decision-frame bookkeeping for newEvent: events already seen at an earlier frame are old.
    if (F !== this.decisionFrame) {
      for (let j = 0; j < n; j++) this.trackers[j].seenBase = this.trackers[j].seenCur;
      this.decisionFrame = F;
    }

    const fresh = !(this.viewKeyFrame === F && this.viewKeyAge === wantAge && this.viewKeyMe === meI
      && this.viewKeyD === d && this.viewKeyObs === this.lastObserved);
    let age = wantAge;
    if (fresh) {
      const D = this.snapshotFor(F - wantAge);
      const V = this.viewState;
      if (D === null) {
        copyWorldInto(real, V);
        age = 0;
        this.delayedRef = null;
      } else {
        age = F - D.frame;
        this.delayedRef = D;
        this.feedTrackers(D.frame, n);
        copyWorldInto(D, V);
        // Roll the delayed world to now: others continue what they held; own inputs are read back
        // from the ring (each snapshot records the input that produced it). Own state is pasted after.
        for (let k = 0; k < age; k++) {
          const next = this.delayedAt(D.frame + k + 1);
          for (let j = 0; j < n; j++) {
            const inp = this.inputs[j];
            inp.pressed = 0; inp.released = 0; inp.direct = 0;
            if (j === meI && next !== null) {
              const nf = next.fighters[j] as SimFighter;
              inp.held = nf.inputHeld; inp.pressed = nf.inputPressed;
            } else {
              inp.held = j < D.fighters.length ? D.fighters[j].inputHeld : NO_INPUT_HELD;
            }
          }
          stepGame(V, this.inputs);
        }
        V.frame = F;
        copyFighterInto(real.fighters[meI], V.fighters[meI]);
        pasteOwnProjectiles(real, V, real.fighters[meI].slot);
        V.events.length = 0;
      }
      // Own-input delay: roll the whole view forward d frames with the already-sampled own inputs.
      if (d > 0 && this.pending !== null) {
        for (let k = 0; k < d; k++) {
          for (let j = 0; j < n; j++) {
            const inp = this.inputs[j];
            if (j === meI) {
              const src = this.pending[k];
              inp.held = src.held; inp.pressed = src.pressed; inp.released = src.released; inp.direct = src.direct ?? 0;
            } else {
              inp.held = V.fighters[j].inputHeld; inp.pressed = 0; inp.released = 0; inp.direct = 0;
            }
          }
          stepGame(V, this.inputs);
        }
        V.events.length = 0;
      }
      this.viewKeyFrame = F; this.viewKeyAge = wantAge; this.viewKeyMe = meI; this.viewKeyD = d;
      this.viewKeyObs = this.lastObserved;
      this.fillOthers(real, meI, age, level);
    } else {
      age = this.delayedRef === null ? 0 : F - this.delayedRef.frame;
      // The rolled state is shared, but the named opponent's predictor may be new: rebuild its set.
      const D = this.delayedRef;
      const ov = this.others[oppI];
      if (D !== null && ov !== undefined && ov.live && !ov.teammate) {
        this.builder.build(D, meI, oppI, age, this.preds[oppI], keepFor(level), this.pools[oppI], ov);
      }
    }

    const V = this.viewState;
    out.state = V;
    out.meI = meI;
    out.oppI = oppI;
    out.frame = F + d;
    out.age = age;
    out.ownDelay = d;
    const ov = oppI >= 0 && oppI < n ? this.others[oppI] : null;
    if (ov !== null) {
      out.hyps = ov.hyps;
      out.passivity = ov.passivity;
      out.framesSinceEdge = ov.framesSinceEdge;
      out.framesSinceAttack = ov.framesSinceAttack;
      out.newEvent = ov.newEvent;
    } else {
      out.hyps = NO_HYPS;
      out.passivity = 0; out.framesSinceEdge = 0; out.framesSinceAttack = 0; out.newEvent = false;
    }
    if (isMulti(out)) {
      for (let j = 0; j < MAX_FIGHTERS; j++) out.others[j] = this.others[j];
      out.nOpps = opponentsOf(V, meI, out.opps);
      out.nMates = teammatesOf(V, meI, out.mates);
      out.friendlyFire = friendlyFireOn(V);
      out.delayed = this.delayedRef;
    }
  }

  private fillOthers(real: GameState, meI: number, age: number, level: LevelVector): void {
    const V = this.viewState;
    const D = this.delayedRef;
    const n = V.fighters.length;
    const keep = keepFor(level);
    const F = real.frame;
    for (let j = 0; j < MAX_FIGHTERS; j++) {
      const ov = this.others[j];
      if (j >= n || j === meI) {
        ov.live = false; ov.hyps.length = 0; ov.nHyps = 0; ov.newEvent = false;
        continue;
      }
      const f = V.fighters[j];
      ov.index = j;
      ov.slot = f.slot;
      ov.team = teamOf(V, f.slot);
      ov.teammate = isTeammate(V, meI, j);
      ov.live = isLive(f);
      const t = this.trackers[j];
      if (t.processed >= 0) {
        ov.framesSinceEdge = F - t.lastEdge;
        ov.framesSinceMove = F - t.lastMove;
        ov.framesSinceAttack = F - t.lastAttack;
        ov.passivity = Math.min(ov.framesSinceEdge, ov.framesSinceMove, ov.framesSinceAttack);
        ov.eventFrame = t.lastEvent;
        t.seenCur = t.lastEvent;
        ov.newEvent = t.lastEvent > t.seenBase;
      } else {
        ov.framesSinceEdge = 0; ov.framesSinceMove = 0; ov.framesSinceAttack = 0; ov.passivity = 0;
        ov.eventFrame = -1; ov.newEvent = false;
      }
      ov.busy = busyFrames(f);
      ov.invuln = invulnFrames(f);
      if (D !== null && ov.live) this.builder.build(D, meI, j, age, this.preds[j], keep, this.pools[j], ov);
      else {
        const h0 = this.pools[j][0];
        h0.kind = 'none'; h0.move = null; h0.ago = 0; h0.dir = 0; h0.weight = 1;
        ov.hyps[0] = h0; ov.hyps.length = 1; ov.nHyps = 1;
      }
    }
  }
}

function keepFor(level: LevelVector): number {
  const c = level.optionsCap;
  if (!(c < MAX_HYPS)) return MAX_HYPS;
  return c < MIN_HYPS ? MIN_HYPS : Math.floor(c);
}

/** Pooled perception for one CPU slot; `maxAge` is the largest snapshot age any level asks for. */
export function createPerception(poolFrom: GameState, maxAge: number): TeamPerception {
  return new PerceptionImpl(poolFrom, maxAge);
}
const createPerceptionCheck: CreatePerceptionFn = createPerception;
void createPerceptionCheck;
