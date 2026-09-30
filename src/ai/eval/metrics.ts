/**
 * Per-match metrics from a replay log (06 section 2, plan W1.8). Openings and combos follow the
 * Slippi convention through replay.ts ComboTracker (45-frame windows), recomputed here from the
 * `hit`, `stun` and `ko` events so hand-built logs work without `opening` events.
 *
 * `slot` is a player index (0 = spec.a). Opponents are every other player not on its team.
 * A ratio with an empty denominator is NaN; aggregate with a NaN-skipping mean.
 *
 * Strength: win, stocksLost, sds, timeout, firstKoFrame, threeStockTime, damagePerMin, damageTakenPerMin,
 *   koPctTheirs, koPctOurs, kos, openings, openingsPerKo, damagePerOpening, conversionRate,
 *   neutralWinRate, counterHitRate, killConversions.
 * Style (03 section 3.3): approachesPerMin, threatShare, shieldShare, firstHitShare, whiffPunishShare,
 *   dodgesPerMin, projectilesPerMin, offstageShare, meanNeutralDistance, jumpsPerMin, commitmentRate,
 *   grabsPerMin.
 * Human-likeness: reactN, reactUnder6, reactMedian, reactP10, inputsPerMin, repetition, entropyNeutral,
 *   entropyAdvantage, entropyDisadvantage, entropyMean, accidents, airShields, accidentalRolls, mashRate.
 * Cost: costMean, costP99, costFirst, calls.
 */
import { Btn, DIRECT_CODES, SIM_HZ } from '../../core/types';
import type { ComputeMetricsFn, MatchMetrics, MatchResult, ReplayEvent } from '../contracts';
import { ComboTracker, num, str } from './replay';
import { median, quantile } from './stats';
import { scoreOf } from './runner';

/** Threat range as a multiple of the player's longest ground reach (research 32, style signatures). */
export const THREAT_MUL = 1.2;
/** A hit this many frames after an opponent's whiffed move ended still counts as a whiff punish. */
export const WHIFF_WINDOW = 40;
/** A stimulus move counts when the attacker is within its reach plus this margin, px. */
export const REACT_MARGIN = 24;
/** Latest response credited to a stimulus, frames. */
export const REACT_MAX = 60;
/** Moves in the repetition window. */
export const REPEAT_WINDOW = 16;

const DCODES = DIRECT_CODES as readonly string[];
const ROLL_CODES = new Set<number>([DCODES.indexOf('rollForward') + 1, DCODES.indexOf('rollBack') + 1,
  DCODES.indexOf('ledgeRoll') + 1]);
const DODGE_ACTIONS: Readonly<Record<string, true>> = { spotDodge: true, roll: true, airDodge: true };
const OPTION_ACTIONS: Readonly<Record<string, true>> = {
  shield: true, spotDodge: true, roll: true, airDodge: true, grab: true, jumpsquat: true,
};

interface Opening { frame: number; attacker: number; victim: number; neutral: boolean; counter: boolean;
  hits: number; damage: number; kill: boolean; closed: boolean }

/** Frames each player spent per action, from `action` events. */
export function actionFrames(events: readonly ReplayEvent[], players: number, frames: number): Map<string, number>[] {
  const out: Map<string, number>[] = [];
  const cur: string[] = []; const since: number[] = [];
  for (let p = 0; p < players; p++) { out.push(new Map()); cur.push('idle'); since.push(0); }
  const add = (p: number, a: string, d: number): void => { out[p].set(a, (out[p].get(a) ?? 0) + d); };
  for (const e of events) {
    if (e.kind !== 'action' || e.slot < 0 || e.slot >= players) continue;
    add(e.slot, cur[e.slot], e.frame - since[e.slot]);
    cur[e.slot] = str(e, 'a');
    since[e.slot] = e.frame;
  }
  for (let p = 0; p < players; p++) add(p, cur[p], frames - since[p]);
  return out;
}

function entropyBits(counts: Map<string, number>): number {
  let total = 0;
  for (const v of counts.values()) total += v;
  if (total === 0) return NaN;
  let h = 0;
  for (const v of counts.values()) { if (v > 0) { const p = v / total; h -= p * Math.log2(p); } }
  return h;
}

function ratio(a: number, b: number): number { return b > 0 ? a / b : NaN; }

/** Openings (with their combo outcome) for every attacker, from a sorted log. */
export function openingsOf(events: readonly ReplayEvent[], players: number, frames: number): Opening[] {
  const list: Opening[] = [];
  const open: (Opening | null)[] = new Array<Opening | null>(players).fill(null);
  const tracker = new ComboTracker(players, {
    opening(frame, attacker, victim, neutral, counter) {
      const o: Opening = { frame, attacker, victim, neutral, counter, hits: 0, damage: 0, kill: false, closed: false };
      list.push(o);
      open[victim] = o;
    },
    end(_frame, _attacker, victim, hits, damage, kill) {
      const o = open[victim];
      if (o !== null) { o.hits = hits; o.damage = damage; o.kill = kill; o.closed = true; open[victim] = null; }
    },
  });
  let i = 0;
  for (let f = 0; f <= frames; f++) {
    for (; i < events.length && events[i].frame <= f; i++) {
      const e = events[i];
      if (e.slot < 0 || e.slot >= players) continue;
      if (e.kind === 'stun') tracker.setInState(e.slot, num(e, 'on') === 1);
      else if (e.kind === 'hit') {
        const v = num(e, 'v', -1);
        if (v >= 0 && v < players && num(e, 'dmg') > 0) tracker.hit(e.frame, e.slot, v, num(e, 'dmg'), num(e, 'vatk') === 1);
      } else if (e.kind === 'ko') tracker.ko(e.frame, e.slot);
    }
    tracker.tick(f);
  }
  tracker.flush(frames);
  return list;
}

/** Reaction latencies of `slot`, frames, one per stimulus that got a response within REACT_MAX. */
export function reactionsOf(events: readonly ReplayEvent[], slot: number, isOpp: (p: number) => boolean): number[] {
  const stim: number[] = [];
  for (const e of events) {
    if (e.slot < 0 || !isOpp(e.slot)) continue;
    if (e.kind === 'move' && num(e, 'adx') <= num(e, 'reach') + REACT_MARGIN && num(e, 'proj') === 0) {
      stim.push(e.frame + num(e, 'act'));
    } else if (e.kind === 'shot') {
      stim.push(e.frame);
    }
  }
  stim.sort((a, b) => a - b);
  const presses: number[] = [];
  const busy: [number, number][] = [];
  let busyFrom = -1;
  for (const e of events) {
    if (e.slot !== slot) continue;
    if (e.kind === 'press') presses.push(e.frame);
    else if (e.kind === 'stun') {
      if (num(e, 'on') === 1) busyFrom = e.frame;
      else if (busyFrom >= 0) { busy.push([busyFrom, e.frame]); busyFrom = -1; }
    }
  }
  if (busyFrom >= 0) busy.push([busyFrom, Infinity]);
  presses.sort((a, b) => a - b);
  const out: number[] = [];
  let pendingUntil = -1;
  let pi = 0;
  for (const s of stim) {
    if (s <= pendingUntil) continue;
    let stunned = false;
    for (const [a, b] of busy) if (s >= a && s < b) { stunned = true; break; }
    if (stunned) continue;
    while (pi < presses.length && presses[pi] <= s) pi++;
    if (pi < presses.length && presses[pi] - s <= REACT_MAX) {
      out.push(presses[pi] - s);
      pendingUntil = presses[pi];
    }
  }
  return out;
}

/** Computes every metric of 06 section 2 for player `slot`. */
export const computeMetrics: ComputeMetricsFn = (r: MatchResult, slot: number): MatchMetrics => {
  const m: MatchMetrics = {};
  const minutes = r.frames / (SIM_HZ * 60);
  m.win = scoreOf(r, slot);
  m.stocksLost = r.stocksLost[slot] ?? NaN;
  m.sds = r.sds[slot] ?? NaN;
  m.timeout = r.timeout ? 1 : 0;
  m.frames = r.frames;
  const c = r.cost[slot];
  m.costMean = c !== undefined ? c.mean : NaN;
  m.costP99 = c !== undefined ? c.p99 : NaN;
  m.costFirst = c !== undefined ? c.first : NaN;
  m.calls = c !== undefined ? c.calls : 0;
  if (r.events === null) return m;

  const events = r.events.slice().sort((a, b) => a.frame - b.frame);
  let players = r.stocksLost.length;
  const team: number[] = [];
  const reach: number[] = [];
  for (const e of events) {
    if (e.kind === 'player' && e.slot >= 0) {
      team[e.slot] = num(e, 'team', e.slot);
      reach[e.slot] = num(e, 'reach', 40);
      if (e.slot + 1 > players) players = e.slot + 1;
    }
  }
  for (let p = 0; p < players; p++) { if (team[p] === undefined) team[p] = p; if (reach[p] === undefined) reach[p] = 40; }
  const isOpp = (p: number): boolean => p !== slot && p >= 0 && p < players && team[p] !== team[slot];

  // ---- strength ----
  let dmgGiven = 0; let dmgTaken = 0;
  const oppKoFrames: number[] = []; const oppKoPct: number[] = []; const ourKoPct: number[] = [];
  for (const e of events) {
    if (e.kind === 'hit') {
      const v = num(e, 'v', -1);
      if (e.slot === slot && isOpp(v)) dmgGiven += num(e, 'dmg');
      else if (v === slot && isOpp(e.slot)) dmgTaken += num(e, 'dmg');
    } else if (e.kind === 'ko') {
      if (isOpp(e.slot)) { oppKoFrames.push(e.frame); oppKoPct.push(num(e, 'pct')); }
      else if (e.slot === slot) ourKoPct.push(num(e, 'pct'));
    }
  }
  m.kos = oppKoFrames.length;
  m.firstKoFrame = oppKoFrames.length > 0 ? oppKoFrames[0] : -1;
  m.threeStockTime = oppKoFrames.length >= 3 ? oppKoFrames[2] : -1;
  m.damagePerMin = ratio(dmgGiven, minutes);
  m.damageTakenPerMin = ratio(dmgTaken, minutes);
  m.koPctTheirs = oppKoPct.length > 0 ? oppKoPct.reduce((a, b) => a + b, 0) / oppKoPct.length : NaN;
  m.koPctOurs = ourKoPct.length > 0 ? ourKoPct.reduce((a, b) => a + b, 0) / ourKoPct.length : NaN;

  const ops = openingsOf(events, players, r.frames);
  let ours = 0; let oursNeutral = 0; let oursCounter = 0; let conv = 0; let kills = 0; let opDamage = 0;
  let theirs = 0; let theirsNeutral = 0;
  for (const o of ops) {
    if (o.attacker === slot && isOpp(o.victim)) {
      ours++; opDamage += o.damage;
      if (o.neutral) oursNeutral++;
      if (o.counter) oursCounter++;
      if (o.hits >= 2) conv++;
      if (o.kill) kills++;
    } else if (o.victim === slot && isOpp(o.attacker)) {
      theirs++;
      if (o.neutral) theirsNeutral++;
    }
  }
  m.openings = ours;
  m.openingsPerKo = ratio(ours, oppKoFrames.length);
  m.damagePerOpening = ratio(opDamage, ours);
  m.conversionRate = ratio(conv, ours);
  m.neutralWinRate = ratio(oursNeutral, oursNeutral + theirsNeutral);
  m.counterHitRate = ratio(oursCounter, ours);
  m.killConversions = kills;
  m.firstHitShare = ratio(ours, ours + theirs);

  // ---- style ----
  const af = actionFrames(events, players, r.frames);
  const mine = af[slot] ?? new Map<string, number>();
  const deadFrames = (mine.get('dead') ?? 0);
  const alive = Math.max(1, r.frames - deadFrames);
  m.shieldShare = ((mine.get('shield') ?? 0) + (mine.get('shieldStun') ?? 0)) / alive;

  let dodges = 0; let shots = 0; let jumps = 0; let moves = 0; let grabs = 0;
  const seq: string[] = [];
  const options: Map<string, number>[] = [new Map(), new Map(), new Map()];
  const inStun: boolean[] = new Array<boolean>(players).fill(false);
  let lastOff = false;
  const situation = (): number => {
    for (let p = 0; p < players; p++) if (isOpp(p) && inStun[p]) return 1;
    return lastOff ? 2 : 0;
  };
  const bump = (mp: Map<string, number>, k: string): void => { mp.set(k, (mp.get(k) ?? 0) + 1); };
  for (const e of events) {
    if (e.kind === 'stun' && e.slot >= 0 && e.slot < players) inStun[e.slot] = num(e, 'on') === 1;
    if (e.slot !== slot) continue;
    switch (e.kind) {
      case 'sample': lastOff = num(e, 'off') === 1; break;
      case 'move': {
        moves++;
        const id = str(e, 'm');
        seq.push(id);
        if (num(e, 'proj') === 1) shots++;
        bump(options[situation()], id);
        break;
      }
      case 'action': {
        const a = str(e, 'a');
        if (DODGE_ACTIONS[a] === true) dodges++;
        if (a === 'grab') grabs++;
        if (OPTION_ACTIONS[a] === true) bump(options[situation()], a);
        if (a === 'ledgeHang') lastOff = true;
        break;
      }
      case 'jump': jumps++; break;
      default: break;
    }
  }
  m.dodgesPerMin = ratio(dodges, minutes);
  m.projectilesPerMin = ratio(shots, minutes);
  m.jumpsPerMin = ratio(jumps, minutes);
  m.commitmentRate = ratio(moves, minutes);
  m.grabsPerMin = ratio(grabs, minutes);

  // Positions: pair our samples with the nearest opponent's sample on the same frame.
  const samples = new Map<number, ReplayEvent[]>();
  for (const e of events) {
    if (e.kind !== 'sample') continue;
    let a = samples.get(e.frame);
    if (a === undefined) { a = []; samples.set(e.frame, a); }
    a.push(e);
  }
  const threat = THREAT_MUL * reach[slot];
  let ourSamples = 0; let offSamples = 0; let neutralSamples = 0; let inThreat = 0; let distSum = 0; let approaches = 0;
  let prevDist = -1; let prevX = 0; let prevOx = 0;
  const stunNow: boolean[] = new Array<boolean>(players).fill(false);
  let si = 0;
  const frameKeys = Array.from(samples.keys()).sort((a, b) => a - b);
  for (const fk of frameKeys) {
    for (; si < events.length && events[si].frame <= fk; si++) {
      const e = events[si];
      if (e.kind === 'stun' && e.slot >= 0 && e.slot < players) stunNow[e.slot] = num(e, 'on') === 1;
    }
    const list = samples.get(fk) as ReplayEvent[];
    let me: ReplayEvent | null = null;
    for (const e of list) if (e.slot === slot) me = e;
    if (me === null) { prevDist = -1; continue; }
    ourSamples++;
    if (num(me, 'off') === 1) offSamples++;
    let opp: ReplayEvent | null = null; let bd = Infinity;
    for (const e of list) {
      if (!isOpp(e.slot)) continue;
      const d = Math.abs(num(e, 'x') - num(me, 'x'));
      if (d < bd) { bd = d; opp = e; }
    }
    let anyStun = stunNow[slot];
    if (opp !== null && stunNow[opp.slot]) anyStun = true;
    if (opp === null || anyStun || num(me, 'off') === 1 || num(opp, 'off') === 1) { prevDist = -1; continue; }
    neutralSamples++;
    distSum += bd;
    if (bd <= threat) inThreat++;
    const x = num(me, 'x'); const ox = num(opp, 'x');
    if (prevDist >= 0 && prevDist > threat && bd <= threat) {
      const dir = Math.sign(ox - x);
      const mineToward = (x - prevX) * dir;
      const theirsToward = -(ox - prevOx) * dir;
      if (mineToward > 0 && mineToward >= theirsToward) approaches++;
    }
    prevDist = bd; prevX = x; prevOx = ox;
  }
  m.offstageShare = ratio(offSamples, ourSamples);
  m.meanNeutralDistance = ratio(distSum, neutralSamples);
  m.threatShare = ratio(inThreat, neutralSamples);
  m.approachesPerMin = ratio(approaches, minutes);

  // Whiff punishes: our damage inside [first active frame, end + WHIFF_WINDOW] of an opponent move that
  // hit or grabbed nobody. A shielded move counts: its end lag is what gets punished.
  const whiffs: [number, number][] = [];
  const openMove: ({ start: number; act: number; landed: boolean } | null)[] = new Array(players).fill(null);
  const closeMove = (p: number, f: number): void => {
    const mv = openMove[p];
    if (mv !== null && !mv.landed) whiffs.push([mv.start + mv.act, f + WHIFF_WINDOW]);
    openMove[p] = null;
  };
  for (const e of events) {
    if (e.slot < 0 || e.slot >= players || !isOpp(e.slot)) continue;
    if (e.kind === 'move') { closeMove(e.slot, e.frame); openMove[e.slot] = { start: e.frame, act: num(e, 'act'), landed: false }; }
    else if (e.kind === 'hit' || e.kind === 'grab') { const mv = openMove[e.slot]; if (mv !== null) mv.landed = true; }
    else if (e.kind === 'action' && str(e, 'a') !== 'attack') closeMove(e.slot, e.frame);
  }
  for (let p = 0; p < players; p++) closeMove(p, r.frames);
  let wpDamage = 0;
  for (const e of events) {
    if (e.kind !== 'hit' || e.slot !== slot || !isOpp(num(e, 'v', -1))) continue;
    for (const [a, b] of whiffs) if (e.frame >= a && e.frame <= b) { wpDamage += num(e, 'dmg'); break; }
  }
  m.whiffPunishShare = ratio(wpDamage, dmgGiven);

  // ---- human-likeness ----
  const rx = reactionsOf(events, slot, isOpp);
  m.reactN = rx.length;
  m.reactUnder6 = rx.filter((x) => x < 6).length;
  m.reactMedian = rx.length > 0 ? median(rx) : NaN;
  m.reactP10 = rx.length > 0 ? quantile(rx, 0.1) : NaN;

  let presses = 0; let airShields = 0; let mashPresses = 0;
  const intentFrames: number[] = [];
  for (const e of events) {
    if (e.kind !== 'press' || e.slot !== slot) continue;
    presses++;
    const b = num(e, 'b');
    const d = num(e, 'd');
    if ((b & Btn.Shield) !== 0 && num(e, 'g') === 0 && str(e, 'a') !== 'ledgeHang') airShields++;
    if (str(e, 'a') === 'grabbed') mashPresses++;
    if ((b & (Btn.Shield | Btn.Dodge)) !== 0 || ROLL_CODES.has(d)) intentFrames.push(e.frame);
  }
  let accidentalRolls = 0;
  for (const e of events) {
    if (e.kind !== 'action' || e.slot !== slot || str(e, 'a') !== 'roll') continue;
    let meant = false;
    for (let k = intentFrames.length - 1; k >= 0; k--) {
      const f = intentFrames[k];
      if (f > e.frame) continue;
      if (e.frame - f <= 20) meant = true;
      break;
    }
    if (!meant) accidentalRolls++;
  }
  m.inputsPerMin = ratio(presses, minutes);
  m.airShields = airShields;
  m.accidentalRolls = accidentalRolls;
  m.accidents = airShields + accidentalRolls;
  const grabbedFrames = mine.get('grabbed') ?? 0;
  m.mashRate = ratio(mashPresses, grabbedFrames / SIM_HZ);

  if (seq.length === 0) m.repetition = NaN;
  else {
    const w = Math.min(REPEAT_WINDOW, seq.length);
    let sum = 0; let wins = 0;
    for (let end = w; end <= seq.length; end++) {
      const cnt = new Map<string, number>();
      let best = 0;
      for (let k = end - w; k < end; k++) { const v = (cnt.get(seq[k]) ?? 0) + 1; cnt.set(seq[k], v); if (v > best) best = v; }
      sum += best / w; wins++;
    }
    m.repetition = sum / wins;
  }
  m.entropyNeutral = entropyBits(options[0]);
  m.entropyAdvantage = entropyBits(options[1]);
  m.entropyDisadvantage = entropyBits(options[2]);
  const hs = [m.entropyNeutral, m.entropyAdvantage, m.entropyDisadvantage].filter((x) => !Number.isNaN(x));
  m.entropyMean = hs.length > 0 ? hs.reduce((a, b) => a + b, 0) / hs.length : NaN;
  return m;
};

/** Count of reactions of `slot` faster than `frames` (the "impossible" count at a human tier is `R - 1`). */
export function reactionsUnder(r: MatchResult, slot: number, frames: number): number {
  if (r.events === null) return 0;
  const events = r.events.slice().sort((a, b) => a.frame - b.frame);
  const team: number[] = [];
  for (const e of events) if (e.kind === 'player') team[e.slot] = num(e, 'team', e.slot);
  const isOpp = (p: number): boolean => p !== slot && p >= 0 && (team[p] ?? p) !== (team[slot] ?? slot);
  return reactionsOf(events, slot, isOpp).filter((x) => x < frames).length;
}
