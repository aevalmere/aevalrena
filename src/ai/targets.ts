/**
 * Target selection for three and four player matches (02 section 15; docs/CPU_PLAN.md W2.15).
 *
 * `pick` scores every live opponent in tiers, highest first:
 *   1. exposed or punishable (launched, downed, helpless, broken shield, landing lag, or a whiff
 *      the CPU's fastest move punishes), ranked by the punish margin;
 *   2. in kill range here (percent at or past the CPU's lowest kill percent on them at their spot),
 *      ranked by percent;
 *   3. everyone else, ranked by nearness (threat frames, then distance).
 * Team terms: an opponent a teammate is already committing to (close, facing them, attacking or
 * comboing them) is avoided while another opponent is available (share the load), except when that
 * opponent is one hit from a KO, where every teammate converges. Under a sandwich (one opponent on
 * each side inside threat range) the flanker with open stage behind it gets a bonus, so the CPU
 * fights through to a position with every opponent on one side. Teammates are never targets.
 *
 * Hysteresis: the current target is kept for 30 frames unless a new event happens (an opponent
 * becomes exposed, punishable or killable, dies, respawns, or the current target stops being
 * valid); after 30 frames a challenger must beat it by a margin. Ties break by the lower slot.
 *
 * `info()` exposes the numbers the plans and the search use: threatSide, sandwichRisk, the cover
 * spot when a teammate edgeguards, the one-side spot and the free spot (affordances.ts teamThreat).
 * Friendly fire does not exist in this sim (perception.ts `hitsLand`), so a teammate's hitbox never
 * needs to be pathed around; `avoidX` stays NaN unless a rule ever turns friendly fire on.
 */
import type { FighterState, GameState } from '../core/types';
import type { CreateTargeterFn, Targeter } from './contracts';
import { geoOf, newTeamThreat, teamThreat, type TeamThreat } from './affordances';
import { friendlyFireOn, isLaunched, isLive, isTeammate, MAX_FIGHTERS } from './perception';

/** No retarget flip inside this many frames without a new event (02 section 15). */
export const RETARGET_FRAMES = 30;
/** After the hold, a challenger must beat the current target's score by this much. */
export const RETARGET_MARGIN = 40;
const TIER_EXPOSED = 3000;
const TIER_KILL = 2000;
const TIER_NEAR = 1000;
/** Penalty for an opponent a teammate is already on, when another is available. */
const SHARE_PENALTY = 1200;
/** Bonus for converging on an opponent one hit from a KO. */
const CONVERGE_BONUS = 400;
/** Percent short of the kill floor that still counts as one hit from a KO. */
const ONE_HIT_PCT = 15;
/** A teammate this close to an opponent, facing them, is committing to them. */
const COMMIT_PX = 90;
const SANDWICH_BONUS = 150;
/**
 * An exposed or punishable opponent outranks the rest only while this near (px): a far one cannot be
 * punished in time, and chasing it across the stage leaves the CPU open to the nearer ones (W3.1,
 * measured in the 1v3 harness case). Kill-range opponents lose one point per px of distance.
 */
const EXPOSED_RANGE = 150;
const KILL_DIST = 1;

/** Target reasoning of the last pick, for plans, search and tests. */
export interface TargetInfo {
  target: number;
  score: number;
  /** Frame of the last switch. */
  switchFrame: number;
  /** Why the current target won: 'exposed' | 'kill' | 'near' | 'none'. */
  reason: string;
  threatSide: number;
  sandwichRisk: number;
  sandwich: boolean;
  /** Fighter index of a teammate edgeguarding and the stage-side spot to cover, -1 and NaN when none. */
  mateEdgeguard: number;
  coverX: number;
  oneSideX: number;
  freeX: number; freeY: number;
  /** Per fighter index: a teammate is committing to that opponent. */
  mateOn: boolean[];
  /** x span of a teammate's active hitbox to path around (only with friendly fire; NaN otherwise). */
  avoidX: number;
}

/** Targeter plus its reasoning. */
export interface TeamTargeter extends Targeter {
  info(): Readonly<TargetInfo>;
  /** The threat block computed in the last pick. */
  threat(): Readonly<TeamThreat>;
}

function facingToward(a: FighterState, b: FighterState): boolean {
  return b.x >= a.x ? a.facing > 0 : a.facing < 0;
}

/** True when teammate `m` is visibly committing to opponent `o`. */
function mateCommits(s: GameState, m: FighterState, o: FighterState): boolean {
  if (!isLive(m) || !isLive(o)) return false;
  // Comboing them: o is launched by m.
  if (isLaunched(o) && o.lastHitBy === m.slot) return true;
  if (o.action === 'grabbed' && (m.action === 'grabHold' || m.action === 'pummel' || m.action === 'throw')) {
    const dx = o.x - m.x;
    if (dx < COMMIT_PX && dx > -COMMIT_PX) return true;
  }
  const dx = o.x - m.x; const dy = o.y - m.y;
  if (dx * dx + dy * dy > COMMIT_PX * COMMIT_PX) return false;
  if (!facingToward(m, o)) return false;
  void s;
  return m.action === 'attack' || m.action === 'dash' || m.action === 'run' || m.action === 'grab'
    || m.action === 'walk' || m.action === 'jumpsquat' || m.action === 'air';
}

class TargeterImpl implements TeamTargeter {
  private readonly t = newTeamThreat();
  private readonly flags = new Int32Array(MAX_FIGHTERS);
  private readonly live = new Uint8Array(MAX_FIGHTERS);
  private readonly scores = new Float64Array(MAX_FIGHTERS);
  private readonly reasons: string[] = ['none', 'none', 'none', 'none'];
  private readonly out: TargetInfo = {
    target: -1, score: 0, switchFrame: -1, reason: 'none', threatSide: 0, sandwichRisk: 0, sandwich: false,
    mateEdgeguard: -1, coverX: NaN, oneSideX: NaN, freeX: 0, freeY: 0, mateOn: [false, false, false, false], avoidX: NaN,
  };
  private lastFrame = -1;
  private config: unknown = null;

  reset(): void {
    this.flags.fill(0);
    this.live.fill(0);
    this.out.target = -1; this.out.score = 0; this.out.switchFrame = -1; this.out.reason = 'none';
    this.lastFrame = -1;
    this.config = null;
  }

  info(): Readonly<TargetInfo> { return this.out; }
  threat(): Readonly<TeamThreat> { return this.t; }

  pick(s: GameState, meI: number, frame: number): number {
    if (s.config !== this.config || frame < this.lastFrame) {
      this.reset();
      this.config = s.config;
    }
    this.lastFrame = frame;
    const o = this.out;
    const fs = s.fighters;
    teamThreat(s, meI, this.t);
    const t = this.t;
    o.threatSide = t.threatSide; o.sandwichRisk = t.sandwichRisk; o.sandwich = t.sandwich;
    o.mateEdgeguard = t.mateEdgeguard; o.coverX = t.coverX; o.oneSideX = t.oneSideX;
    o.freeX = t.freeX; o.freeY = t.freeY;
    o.avoidX = NaN;
    if (friendlyFireOn(s)) o.avoidX = this.mateHitboxX(s, meI);

    // Teammate commitments.
    for (let i = 0; i < MAX_FIGHTERS; i++) o.mateOn[i] = false;
    for (let j = 0; j < fs.length; j++) {
      if (j === meI || !isTeammate(s, meI, j)) continue;
      for (let k = 0; k < t.n; k++) if (mateCommits(s, fs[j], fs[t.opps[k].index])) o.mateOn[t.opps[k].index] = true;
    }
    let unshared = 0;
    for (let k = 0; k < t.n; k++) if (!o.mateOn[t.opps[k].index]) unshared++;

    // Scores and event flags.
    const g = geoOf(s.stageId);
    let newEvent = false;
    this.scores.fill(-Infinity);
    for (let i = 0; i < MAX_FIGHTERS; i++) {
      const was = this.live[i];
      this.live[i] = 0;
      if (i < fs.length && i !== meI && isLive(fs[i]) && !isTeammate(s, meI, i)) this.live[i] = 1;
      if (was !== this.live[i]) newEvent = true;
    }
    let bestFlanker = -1; let bestRoom = -1;
    if (t.sandwich) {
      for (let k = 0; k < t.n; k++) {
        const e = t.opps[k];
        if (e.threatFrames > 24) continue;
        const f = fs[e.index];
        const room = e.side < 0 ? f.x - g.left : g.right - f.x;
        if (room > bestRoom) { bestRoom = room; bestFlanker = e.index; }
      }
    }
    for (let k = 0; k < t.n; k++) {
      const e = t.opps[k];
      const f = fs[e.index];
      let score: number;
      let reason: string;
      const punishable = e.punish > 0;
      if ((e.exposed || punishable) && e.dist < EXPOSED_RANGE) {
        score = TIER_EXPOSED + Math.min(200, Math.max(e.punish, 0) * 4 + (e.exposed ? 20 : 0)) - e.dist * 0.1;
        reason = 'exposed';
      } else if (e.inKillRange) {
        score = TIER_KILL + Math.min(300, f.percent) - e.dist * KILL_DIST;
        reason = 'kill';
      } else {
        const tf = Number.isFinite(e.threatFrames) ? e.threatFrames : 120;
        score = TIER_NEAR + 300 - Math.min(300, e.dist * 0.5) - Math.min(60, tf) * 0.5;
        reason = 'near';
      }
      // One hit from a KO: converge even if a teammate is on them.
      const oneHit = Number.isFinite(e.killPct) && f.percent >= e.killPct - ONE_HIT_PCT;
      if (o.mateOn[e.index]) {
        if (oneHit) score += CONVERGE_BONUS;
        else if (unshared > 0) score -= SHARE_PENALTY;
      }
      if (e.index === bestFlanker) score += SANDWICH_BONUS;
      // Fewer stocks left: a slight pull (closing out a player ends a threat for good).
      score -= f.stocks * 2;
      this.scores[e.index] = score;
      this.reasons[e.index] = reason;
      // Tier flags: bit 0 exposed/punishable, bit 1 kill range, bit 2 alive-in-match (respawn change).
      const fl = (reason === 'exposed' ? 1 : 0) | (e.inKillRange ? 2 : 0) | (f.action === 'respawn' ? 4 : 0);
      const prev = this.flags[e.index];
      if ((fl & ~prev & 3) !== 0) newEvent = true;
      if ((fl ^ prev) & 4) newEvent = true;
      this.flags[e.index] = fl;
    }
    for (let i = 0; i < MAX_FIGHTERS; i++) if (this.live[i] === 0) this.flags[i] = 0;

    // Best, tie by lower slot.
    let best = -1;
    for (let k = 0; k < t.n; k++) {
      const i = t.opps[k].index;
      if (best < 0 || this.scores[i] > this.scores[best]
        || (this.scores[i] === this.scores[best] && fs[i].slot < fs[best].slot)) best = i;
    }
    const cur = o.target;
    const curValid = cur >= 0 && cur < fs.length && this.live[cur] === 1;
    let pickI = best;
    if (curValid && best >= 0 && best !== cur && !newEvent) {
      const held = o.switchFrame >= 0 && frame - o.switchFrame < RETARGET_FRAMES;
      if (held || this.scores[best] < this.scores[cur] + RETARGET_MARGIN) pickI = cur;
    }
    if (pickI !== cur) o.switchFrame = frame;
    o.target = pickI;
    o.score = pickI >= 0 ? this.scores[pickI] : 0;
    o.reason = pickI >= 0 ? this.reasons[pickI] : 'none';
    return pickI;
  }

  /** Centre x of the nearest teammate's active attack (only meaningful with friendly fire on). */
  private mateHitboxX(s: GameState, meI: number): number {
    const fs = s.fighters;
    let best = NaN; let bestD = Infinity;
    for (let j = 0; j < fs.length; j++) {
      if (j === meI || !isTeammate(s, meI, j) || fs[j].action !== 'attack') continue;
      const d = Math.abs(fs[j].x - fs[meI].x);
      if (d < bestD) { bestD = d; best = fs[j].x; }
    }
    return best;
  }
}

/** One targeter per CPU slot. */
export function createTargeter(): TeamTargeter {
  return new TargeterImpl();
}
const createTargeterCheck: CreateTargeterFn = createTargeter;
void createTargeterCheck;
