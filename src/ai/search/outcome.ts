/**
 * Outcome vector and score (02 section 7.3, 03 section 3.1), multi-opponent aware (02 section 15).
 *
 * A rollout fills a Tally while it steps (events: damage, KOs, grabs, Final Smash catches) and
 * then `finishOutcome` reads the end state into an Outcome. `scoreOutcome` turns it into one number
 * with the style weights. Every term is summed over every live opponent, so damage on any of them
 * counts, and our own exposure to several of them at once (sandwiched, crowded) is priced as stock
 * risk. The per-opponent breakdown stays in the Tally (`dealtTo`, `koOf`, `projKoOf`) because the
 * frozen Outcome carries scalars only.
 *
 * Units of the Outcome fields (scoreOutcome multiplies each by a fixed scale, then by its weight):
 * - damageDealt: percent dealt to enemies; damageTaken: percent we took plus 0.4 x a teammate's.
 * - stockDelta: enemy stocks taken inside the window, minus 0.73 per teammate stock lost.
 * - projectedKO: KO equivalents on enemies still alive at the end (a launch that crosses the
 *   blast line is 1, no way back offstage up to 0.83, a table kill chain 1.1, a kill throw ready
 *   0.83, a kill move in reach 0.125), summed over enemies.
 * - ourStockRisk: 1 per own KO in the window, else the chance our stock is gone (launch past the
 *   blast line, no way back), plus soft recovery depth and the multi-opponent exposure terms.
 * - frameAdvantage: frames; the best advantage on any enemy (scaled by reach) plus the worst
 *   disadvantage against a close one, hitstun and dead time folded in.
 * - stageControl: px; enemies' mean distance from centre minus 1.2 x ours, spacing and the stall pull.
 * - shieldHealth, ledgeControl, zone, repetition, continuity: points.
 * - healed: percent the orb drain healed back.
 */
import type { FighterState, GameState, Rect, StageDef } from '../../core/types';
import { AIR_DODGE, TUNING } from '../../core/constants';
import { CHARACTER_DEFS } from '../../characters/registry';
import { STAGE_DEFS } from '../../stages/registry';
import { isLedgeAction } from '../../sim/ledge';
import { castDelay } from '../../sim/moves';
import type { SimFighter } from '../../sim/state';
import type { CharacterAiProfile, ObjectiveWeights, Outcome, ScoreOutcomeFn, Scored, Spot } from '../contracts';

// ---------------------------------------------------------------------------------------------
// Scales (balanced base; the style weights multiply these)
// ---------------------------------------------------------------------------------------------

/** Points per unit of each Outcome field before the style weight. */
export const SCALE = {
  damageDealt: 1, damageTaken: 1,
  /** A KO seen inside the window (02 section 7.3). */
  stockDelta: 520,
  /** A launch that projects a KO. */
  projectedKO: 360,
  /** Our stock lost. */
  ourStockRisk: 640,
  frameAdvantage: 0.3,
  stageControl: 0.01,
  shieldHealth: 1, ledgeControl: 1, zone: 1, repetition: 1, continuity: 1, healed: 1,
} as const;

/** Exposure terms of ourStockRisk, per unit of (0.35 + percent / 150). */
export const SANDWICH_RISK = 0.11;
export const CROWD_RISK = 0.05;
/** Closeness: full threat inside this distance, none past FAR_PX. */
export const NEAR_PX = 90;
export const FAR_PX = 250;
/** Continuity bonus in points for continuing the running interruptible plan. */
export const CONTINUITY_POINTS = 1.5;
/** Staleness cost per unit of Tempo.stale for a commitment (doubled for shots and dodges). */
export const STALE_COST = 1.2;
/** Cycle penalty in points when the tempo cycle detector fires and the plan repeats. */
export const CYCLE_COST = 4;
/** Points per our projectile covering the lane, at most ZONE_CAP of them. */
export const ZONE_POINTS = 6;
export const ZONE_CAP = 2;
/** Points for holding the ledge while an enemy is off the stage. */
export const LEDGE_POINTS = 20;

/** Sure-tier flags a rollout sets on its Scored record (read by select.ts). */
export const SURE_FS = 1;
export const SURE_KILL = 2;

/** Extra fields on Scored records built by runRollouts. Hand-built Scored objects lack them. */
export interface ScoredExtra { sure: number; hitShare: number }
export function sureOf(s: Scored): number {
  const x = (s as Partial<ScoredExtra>).sure;
  return typeof x === 'number' ? x : 0;
}

/**
 * J = w . o with the scales above. Positive terms: damage dealt, KOs, projected KOs, frame
 * advantage, stage control, shield (net), ledge control, zone, continuity, healed. Negative:
 * damage taken, stock risk, repetition.
 */
export const scoreOutcome: ScoreOutcomeFn = (o: Outcome, w: ObjectiveWeights): number => {
  let s = 0;
  s += w.damageDealt * SCALE.damageDealt * o.damageDealt;
  s -= w.damageTaken * SCALE.damageTaken * o.damageTaken;
  s += w.killProbability * (SCALE.stockDelta * o.stockDelta + SCALE.projectedKO * o.projectedKO);
  s -= w.stockRisk * SCALE.ourStockRisk * o.ourStockRisk;
  s += w.frameAdvantage * SCALE.frameAdvantage * o.frameAdvantage;
  s += w.stageControl * SCALE.stageControl * o.stageControl;
  s += w.shield * SCALE.shieldHealth * o.shieldHealth;
  s += w.ledgeControl * SCALE.ledgeControl * o.ledgeControl;
  s += w.zone * SCALE.zone * o.zone;
  s -= w.repetition * SCALE.repetition * o.repetition;
  s += w.continuity * SCALE.continuity * o.continuity;
  s += w.healed * SCALE.healed * o.healed;
  return s;
};

export function newOutcome(): Outcome {
  return { damageDealt: 0, damageTaken: 0, stockDelta: 0, projectedKO: 0, ourStockRisk: 0, frameAdvantage: 0,
    stageControl: 0, shieldHealth: 0, ledgeControl: 0, zone: 0, repetition: 0, continuity: 0, healed: 0,
    hitLanded: false, hitFrame: -1 };
}

// ---------------------------------------------------------------------------------------------
// Stage reading
// ---------------------------------------------------------------------------------------------

/** Solid ground extent, walk line and underside, read from the live StageDef. */
export interface StageInfo { minX: number; maxX: number; topY: number; botY: number; cx: number }
const stageCache = new Map<string, StageInfo>();

export function stageInfo(stageId: string): StageInfo {
  let info = stageCache.get(stageId);
  if (info === undefined) {
    info = { minX: -180, maxX: 180, topY: 0, botY: 24, cx: 0 };
    stageCache.set(stageId, info);
  }
  const st: StageDef | undefined = STAGE_DEFS[stageId];
  let minX = -180, maxX = 180, topY = 0, botY = 24, found = false;
  if (st) {
    for (let i = 0; i < st.platforms.length; i++) {
      const p = st.platforms[i];
      if (!p.solid) continue;
      if (!found) { minX = p.x; maxX = p.x + p.w; topY = p.y; botY = p.y + p.h; found = true; }
      else {
        if (p.x < minX) minX = p.x;
        if (p.x + p.w > maxX) maxX = p.x + p.w;
        if (p.y < topY) topY = p.y;
        if (p.y + p.h > botY) botY = p.y + p.h;
      }
    }
  }
  info.minX = minX; info.maxX = maxX; info.topY = topY; info.botY = botY; info.cx = (minX + maxX) / 2;
  return info;
}

const UNDER_CLEAR = 20;

export function underStage(x: number, y: number, si: StageInfo): boolean {
  return y > si.botY && x > si.minX - UNDER_CLEAR && x < si.maxX + UNDER_CLEAR;
}

/** Toward the stage centre, except from under the stage, where home is out past the nearer edge. */
export function homeSign(x: number, y: number, si: StageInfo): number {
  if (underStage(x, y, si)) return x < si.cx ? -1 : 1;
  return x < si.cx ? 1 : -1;
}

// ---------------------------------------------------------------------------------------------
// Fighter reads (ported from aevalmere.ts; generic over characters)
// ---------------------------------------------------------------------------------------------

export function launched(f: FighterState): boolean {
  return (f.action === 'hitstun' || f.action === 'tumble') && f.hitstun > 0;
}

export function alive(f: FighterState): boolean {
  return f.stocks > 0 && f.action !== 'dead';
}

export function offstage(f: FighterState, si: StageInfo): boolean {
  if (f.onGround || isLedgeAction(f.action)) return false;
  if (Math.abs(f.y - si.topY) < 0.5 && f.vy === 0 && f.x > si.minX - 14 && f.x < si.maxX + 14) return false;
  return f.x < si.minX - 2 || f.x > si.maxX + 2 || f.y > si.topY + 2;
}

/** Frames until `f` can act on its own. */
export function busyFrames(f: FighterState): number {
  const sf = f as SimFighter;
  switch (f.action) {
    case 'idle': case 'walk': case 'dash': case 'run': case 'turn': case 'crouch': case 'air': case 'shield':
      return 0;
    case 'attack': {
      if (f.moveId === null) return 0;
      const mv = CHARACTER_DEFS[f.charId].moves[f.moveId];
      const free = (mv.iasa === undefined ? mv.totalFrames : mv.iasa) + castDelay(sf, mv);
      let left = free - f.actionFrame;
      if (left < 0) left = 0;
      if (sf.charging) left += 4;
      if (!f.onGround && mv.landingLag !== undefined && left < 6) left = 6;
      return left + f.hitlag;
    }
    case 'land': case 'shieldStun': case 'shieldBreak': return sf.stateTimer;
    case 'hitstun': return f.hitstun + f.hitlag;
    case 'tumble': return f.hitstun + f.hitlag + 8;
    case 'jumpsquat': return 3;
    case 'spotDodge': return f.actionFrame < 22 ? 22 - f.actionFrame : 0;
    case 'roll': return f.actionFrame < 24 ? 24 - f.actionFrame : 0;
    case 'airDodge': return f.actionFrame < AIR_DODGE.total ? AIR_DODGE.total - f.actionFrame : 0;
    case 'airHelpless': return 30;
    case 'grab': return f.actionFrame < 30 ? 30 - f.actionFrame : 0;
    case 'grabbed': return 30;
    case 'throw': case 'grabHold': case 'pummel': return 0;
    case 'downed': return 20;
    case 'tech': case 'techRoll': case 'getUp': case 'getUpRoll': case 'ledgeClimb': case 'ledgeRoll':
      return f.actionFrame < 30 ? 30 - f.actionFrame : 0;
    case 'footstooled': return 20;
    default: return 10;
  }
}

/**
 * Rough "can this fighter still get back" for an airborne fighter off the stage, 0 to 1: height
 * its jumps and up special can buy against depth, air speed over that airtime against distance.
 */
export function recoverable(f: FighterState, si: StageInfo): number {
  if (!offstage(f, si)) return 1;
  const def = CHARACTER_DEFS[f.charId];
  const helpless = f.action === 'airHelpless';
  const usUsed = helpless || (f.action === 'attack' && f.moveId !== null && def.moves[f.moveId].helplessAfter === true);
  const jumpRise = (def.doubleJumpVel * def.doubleJumpVel) / (2 * def.gravity);
  const rise = f.jumpsLeft * jumpRise + (usUsed ? 0 : 85);
  const below = f.y - (si.topY + 40);
  let out = f.x < si.minX ? si.minX - f.x : f.x > si.maxX ? f.x - si.maxX : 0;
  if (underStage(f.x, f.y, si)) out = Math.min(f.x - si.minX, si.maxX - f.x) + UNDER_CLEAR * 2;
  const high = si.topY + 200 - f.y;
  const air = f.jumpsLeft * 34 + (usUsed ? 0 : 30) + 20 + (high > 0 ? high / 4 : 0);
  const reachX = def.airSpeed * air + 24;
  const drift = f.x < si.minX ? -f.vx : f.x > si.maxX ? f.vx : 0;
  const outEff = out + (drift > 0 ? drift : 0) * 12;
  const vMargin = rise - below;
  const hMargin = reachX - outEff;
  if (vMargin >= 20 && hMargin >= 20) return 1;
  if (vMargin < -15 || hMargin < -15) return 0;
  const m = (vMargin < hMargin ? vMargin : hMargin) + 15;
  return m <= 0 ? 0 : m >= 35 ? 1 : m / 35;
}

/**
 * Whether a launched fighter leaves the blast rect on the launch alone, stepped the way the sim
 * steps hitstun (knockback decay, gravity), then a short momentum tail. 1 inside hitstun, 0.75 in
 * the tail, 0 otherwise.
 */
export function projectedKo(f: FighterState, blast: Rect): number {
  if (!launched(f)) return 0;
  const sf = f as SimFighter;
  const def = CHARACTER_DEFS[f.charId];
  let x = f.x, y = f.y, spd = sf.kbSpeed, fall = sf.kbFall, vx = f.vx, vy = f.vy;
  const decay = TUNING.knockback.decay;
  for (let k = 0; k < f.hitstun; k++) {
    spd = spd - decay; if (spd < 0) spd = 0;
    fall = fall + def.gravity; if (fall > def.maxFall) fall = def.maxFall;
    vx = sf.kbDirX * spd;
    vy = sf.kbDirY * spd + fall;
    x += vx; y += vy;
    if (x < blast.x || x > blast.x + blast.w || y < blast.y || y > blast.y + blast.h) return 1;
  }
  for (let k = 0; k < 24; k++) {
    vx = vx > 0 ? (vx - def.airAccel > 0 ? vx - def.airAccel : 0) : (vx + def.airAccel < 0 ? vx + def.airAccel : 0);
    vy = vy + def.gravity; if (vy > def.maxFall) vy = def.maxFall;
    x += vx; y += vy;
    if (x < blast.x || x > blast.x + blast.w || y < blast.y) return 0.75;
  }
  return 0;
}

export function spotOf(f: FighterState, si: StageInfo): Spot {
  if (offstage(f, si)) return 'offstage';
  return f.x < si.minX + 60 || f.x > si.maxX - 60 ? 'ledge' : 'center';
}

/** Our kill option on `o` from here: a kill-role move in reach whose kill percent `o` has passed. */
function killReady(m: FighterState, o: FighterState, me: CharacterAiProfile, si: StageInfo): boolean {
  if (!m.onGround || !o.onGround || Math.abs(o.y - m.y) > 24) return false;
  const adx = Math.abs(o.x - m.x);
  const spot = spotOf(o, si);
  const kill = me.roles.kill;
  for (let i = 0; i < kill.length; i++) {
    const mv = me.moves[kill[i]];
    if (mv === undefined) continue;
    const kp = mv.killPct[spot];
    if (kp === kp && o.percent >= kp && adx <= mv.reach.front + 8) return true;
  }
  return false;
}

/** Largest damage of our throws (a held grab's pending payoff). */
function bestThrowDamage(me: CharacterAiProfile): number {
  const th = me.grab.throws;
  let d = 0;
  for (const id in th) { const x = th[id as keyof typeof th].damage; if (x > d) d = x; }
  return d;
}

/** A held enemy at a percent where one of our throws kills from here. */
function throwKillReady(o: FighterState, me: CharacterAiProfile, si: StageInfo): boolean {
  const spot = spotOf(o, si);
  const th = me.grab.throws;
  for (const id in th) {
    const kp = th[id as keyof typeof th].killPct[spot];
    if (kp === kp && o.percent >= kp) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Tally: what a rollout saw while stepping
// ---------------------------------------------------------------------------------------------

export const MAX_FIGHTERS = 8;

export interface Tally {
  dealt: number; taken: number; mateTaken: number;
  koEnemy: number; koMe: number; koMate: number;
  grabbed: boolean; fsCaught: boolean;
  hitFrame: number;
  /** Per fighter index. */
  dealtTo: Float64Array; koOf: Float64Array; projKoOf: Float64Array; chainOn: Uint8Array;
  /** Set by finishOutcome: our stock is gone or as good as gone. */
  lost: boolean;
  /** Set by finishOutcome: we end on the ground or the ledge. */
  home: boolean;
  /** Set by finishOutcome: some enemy is KO'd or projected KO'd for sure. */
  killSure: boolean;
}

export function newTally(): Tally {
  return { dealt: 0, taken: 0, mateTaken: 0, koEnemy: 0, koMe: 0, koMate: 0, grabbed: false, fsCaught: false,
    hitFrame: -1, dealtTo: new Float64Array(MAX_FIGHTERS), koOf: new Float64Array(MAX_FIGHTERS),
    projKoOf: new Float64Array(MAX_FIGHTERS), chainOn: new Uint8Array(MAX_FIGHTERS),
    lost: false, home: false, killSure: false };
}

export function resetTally(t: Tally): void {
  t.dealt = 0; t.taken = 0; t.mateTaken = 0; t.koEnemy = 0; t.koMe = 0; t.koMate = 0;
  t.grabbed = false; t.fsCaught = false; t.hitFrame = -1;
  t.dealtTo.fill(0); t.koOf.fill(0); t.projKoOf.fill(0); t.chainOn.fill(0);
  t.lost = false; t.home = false; t.killSure = false;
}

/** Per-decision facts finishOutcome needs besides the end state. */
export interface OutcomeCtx {
  meI: number; targetI: number;
  /** 1 = enemy, 2 = teammate, 0 = us or not in play; per fighter index. */
  side: Uint8Array;
  me: CharacterAiProfile;
  si: StageInfo; blast: Rect;
  /** Our percent and stocks when the decision started (for healed). */
  basePct: number; baseStocks: number;
  /** Preferred ground spacing to the target, px. */
  spacing: number;
  /** Engagement pressure 0..1 (Tempo.pressure clamped). */
  pressure: number;
  /** Constant per-candidate terms. */
  repetition: number; continuity: number;
}

/** Reads the end state of a rollout into `o` and sets the Tally's lost, home and killSure flags. */
export function finishOutcome(st: GameState, t: Tally, c: OutcomeCtx, o: Outcome): void {
  const fs = st.fighters;
  const m = fs[c.meI];
  const si = c.si;
  const blast = c.blast;
  const nf = fs.length;

  let projKO = 0;
  let bestAdv = 0, worstAdv = 0;
  let shield = 0, ledge = 0;
  let heldThrow = 0;
  let sumCentre = 0, nEnemy = 0;
  let threatL = 0, threatR = 0, threatSum = 0, threatMax = 0;
  const bm = busyFrames(m);
  const meAlive = alive(m) && t.koMe === 0;
  const meHome = m.onGround || isLedgeAction(m.action);
  let killSure = t.koEnemy > 0;

  for (let j = 0; j < nf; j++) {
    if (c.side[j] !== 1) continue;
    const e = fs[j];
    if (!alive(e) || e.action === 'respawn' || t.koOf[j] > 0) continue;
    nEnemy++;
    sumCentre += Math.abs(e.x - si.cx);
    const dx = e.x - m.x, dy = e.y - m.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const reach = dist < NEAR_PX ? 1 : dist > FAR_PX ? 0 : 1 - (dist - NEAR_PX) / (FAR_PX - NEAR_PX);
    // Threats on the enemy.
    let pk = 0;
    if (diveDoomed(e, si)) { pk += 1; killSure = true; }
    if (launched(e)) {
      const ko = projectedKo(e, blast);
      pk += ko;
      if (ko >= 1) killSure = true;
      const hs = e.hitstun < 30 ? e.hitstun : 30;
      const adv = hs * 1.5 * reach - (ko === 0 && !offstage(e, si) && dist > NEAR_PX ? (dist - NEAR_PX) * 0.2 : 0);
      if (adv > bestAdv) bestAdv = adv;
    }
    if (offstage(e, si)) {
      const rec = recoverable(e, si);
      if (rec === 0 && !launched(e)) killSure = true;
      pk += (1 - rec) * 0.833;
      const out = e.x < si.minX ? si.minX - e.x : e.x > si.maxX ? e.x - si.maxX : 0;
      const below = e.y - si.topY;
      pk += (out * 0.06 + (below > 0 ? below * 0.08 : 0)) / SCALE.projectedKO;
      if (meHome && isLedgeAction(m.action)) ledge += LEDGE_POINTS;
    }
    if (t.chainOn[j] !== 0 && pk < 1) pk += 1.1 * reach;
    if (e.action === 'shieldBreak') shield += 140;
    if (e.action === 'grabbed') {
      const held = m.action === 'grabHold' || m.action === 'grab' || m.action === 'pummel';
      if (held && throwKillReady(e, c.me, si)) pk += 0.833;
      // A hold still running when the window ends is a throw that has not happened yet: the
      // victim cannot act before it, so its damage is as good as dealt.
      if (held) heldThrow += bestThrowDamage(c.me);
    }
    if (!launched(e) && bm <= 4 && killReady(m, e, c.me, si)) pk += 0.125;
    t.projKoOf[j] = pk;
    projKO += pk;
    // Frame advantage against this enemy.
    const be = busyFrames(e);
    let adv = be - bm;
    if (adv > 24) adv = 24; else if (adv < -24) adv = -24;
    if (e.action === 'grabbed' && (m.action === 'grabHold' || m.action === 'pummel')) adv = 24;
    if (adv > 0) { if (adv * reach > bestAdv) bestAdv = adv * reach; }
    else if (adv < 0) { if (adv * reach < worstAdv) worstAdv = adv * reach; }
    if (bm > 0 && be === 0 && Math.abs(dx) < 64 && Math.abs(dy) < 50) {
      const pen = -bm * 1.2;
      if (pen < worstAdv) worstAdv = pen;
    }
    // Their threat on us: close, free to act, not launched.
    if (!launched(e) && e.action !== 'grabbed' && e.action !== 'shieldBreak') {
      const free = be <= bm + 4 ? 1 : 0.4;
      const thr = reach * free;
      if (dx <= 4 && thr > threatL) threatL = thr;
      if (dx >= -4 && thr > threatR) threatR = thr;
      threatSum += thr;
      if (thr > threatMax) threatMax = thr;
    }
  }

  // Our own stock risk.
  let risk = t.koMe;
  let lost = t.koMe > 0 || !alive(m);
  let ownAdv = 0;
  let healed = 0;
  let shieldOwn = 0;
  if (meAlive) {
    const hp = c.basePct + t.taken - m.percent;
    if (hp > 0.01 && m.stocks === c.baseStocks) healed = hp;
    let p = 0;
    if (diveDoomed(m, si)) { lost = true; p = 1; }
    if (launched(m)) {
      const ko = projectedKo(m, blast);
      if (ko >= 0.75) lost = true;
      p = 0.66 * ko;
      ownAdv -= (m.hitstun < 30 ? m.hitstun : 30) * 1.5;
    }
    if (offstage(m, si)) {
      const rec = recoverable(m, si);
      if (rec === 0) lost = true;
      const q = (1 - rec) * 1.09;
      if (q > p) p = q;
      const out = m.x < si.minX ? si.minX - m.x : m.x > si.maxX ? m.x - si.maxX : 0;
      const below = m.y - si.topY;
      p += (out * 0.12 + (below > 0 ? below * 0.2 : 0) + (m.jumpsLeft === 0 ? 6 : 0)
        + (m.action === 'airHelpless' ? 10 : 0)) / SCALE.ourStockRisk;
    }
    // Exposure: enemies free to hit us from both sides, or more than one on us at all.
    const sandwich = threatL < threatR ? threatL : threatR;
    const crowd = threatSum - threatMax;
    const pctMul = 0.35 + m.percent / 150;
    p += (SANDWICH_RISK * sandwich + CROWD_RISK * crowd) * pctMul;
    risk += p;
    if (m.action === 'shieldBreak') shieldOwn -= 220;
    if (m.shieldHp < 22) shieldOwn -= (22 - m.shieldHp) * 0.8;
    if (m.action === 'downed') ownAdv -= 20;
  }

  // Stage control against the target, spacing, stall pull.
  let stage = 0;
  if (nEnemy > 0) stage += sumCentre / nEnemy;
  stage -= 1.2 * Math.abs(m.x - si.cx);
  const tg = fs[c.targetI];
  if (tg !== undefined && c.side[c.targetI] === 1 && alive(tg)) {
    const adx = Math.abs(tg.x - m.x), ady = Math.abs(tg.y - m.y);
    if (m.onGround && tg.onGround && !launched(tg)) stage -= 2 * Math.abs(adx - c.spacing);
    if (c.pressure > 0) stage -= 4 * c.pressure * Math.sqrt(adx * adx + ady * ady);
  }

  // Zone: our shots in the lane toward the target.
  let zone = 0;
  if (tg !== undefined && c.pressure < 1) {
    let n = 0;
    const ps = st.projectiles;
    const lo = m.x < tg.x ? m.x : tg.x, hi = m.x < tg.x ? tg.x : m.x;
    for (let i = 0; i < ps.length && n < ZONE_CAP; i++) {
      const p = ps[i];
      if (!p.alive || p.owner !== m.slot) continue;
      if (p.x >= lo && p.x <= hi && Math.abs(p.y - tg.y) < 60) n++;
    }
    zone = n * ZONE_POINTS * (1 - c.pressure);
  }

  o.damageDealt = t.dealt + heldThrow;
  o.damageTaken = t.taken + 0.4 * t.mateTaken;
  o.stockDelta = t.koEnemy - 0.73 * t.koMate;
  o.projectedKO = projKO;
  o.ourStockRisk = risk;
  o.frameAdvantage = bestAdv + worstAdv + ownAdv;
  o.stageControl = stage;
  o.shieldHealth = shield + shieldOwn;
  o.ledgeControl = ledge;
  o.zone = zone;
  o.repetition = c.repetition;
  o.continuity = c.continuity;
  o.healed = healed;
  o.hitLanded = t.hitFrame >= 0 || t.grabbed || t.koEnemy > 0;
  o.hitFrame = t.hitFrame;
  t.lost = lost;
  t.home = meAlive && meHome;
  t.killSure = killSure;
}

/**
 * A fighter committed to a dive move (MoveDef.dive: a straight drop until it hits something or the
 * ground) with no stage under it: the drop runs to the bottom blast line (W3.1).
 */
export function diveDoomed(f: FighterState, si: StageInfo): boolean {
  if (f.action !== 'attack' || f.moveId === null || f.onGround || (f as SimFighter).hitGroups !== 0) return false;
  const mv = CHARACTER_DEFS[f.charId]?.moves[f.moveId];
  if (mv === undefined || mv.dive === undefined) return false;
  return f.x < si.minX || f.x > si.maxX || f.y > si.topY + 4;
}
