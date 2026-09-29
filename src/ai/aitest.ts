import { Btn, DIRECT_CODES } from '../core/types';
import type { FighterState, GameState, InputFrame, MatchConfig, MoveId } from '../core/types';
import { FS_METER, SHIELD_MAX } from '../core/constants';
import { CHARACTER_DEFS } from '../characters/registry';
import { nextFloat } from '../core/rng';
import { createGameState, stepGame } from '../sim';
import { forceGrab } from '../sim/grab';
import { applyHit } from '../sim/hits';
import { clearBuffer } from '../sim/input';
import { setAction, simFighters } from '../sim/state';
import { STAGE_DEFS } from '../stages/registry';
import { cpuInput, cpuIntendedRolls, setCpuProjBlockOverrideForTest } from './index';
import {
  aevalmereComboSummary, aevalmereKillConfirms, aevalmerePredictorStats, aevalmereStats, flushAevalmereProfiles,
  setAevalmereProfileStore, warmAevalmere,
} from './aevalmere';
import { CappedProfileStore, MemoryProfileStore, PROFILE_CAP, PROFILE_INDEX_KEY, PROFILE_PREFIX, type ProfileStore } from './profile';

declare const process: {
  argv: string[];
  stdout: { write(text: string): void };
  exitCode?: number;
};

/** `info`: printed with an INFO prefix and never counted toward the pass or the exit code. */
interface TestResult { name: string; pass: boolean; detail: string; info?: boolean }

const AERIAL_MOVES: Record<string, boolean> = { nair: true, fair: true, bair: true, uair: true, dair: true };
const MIN_AERIAL_GAP = 45;
/** Frames a matrix match is given before it is called a stall. */
const MATCH_CAP = 24000;
/** Seeds every matrix matchup is replayed over. Fixed, so the whole harness is reproducible. */
const SEEDS = [5, 17, 23, 41, 97];
const MATRIX_STOCKS = 2;
/** Each matchup is played on both sides of each seed, because slot 0 spawns with an advantage. */
const MATCHES_PER_MATCHUP = SEEDS.length * 2;
/** Share of a matchup's matches the higher level has to take for the ladder to count as ordered. */
const WIN_RATE_FLOOR = 0.7;

/** `zeroMoves` is written into the config as given; left out, the rule field is absent entirely. */
function cpuConfig(
  levelA: number, levelB: number, seed: number, stocks: number, zeroMoves?: boolean, stageId = 'tidegate',
): MatchConfig {
  const cfg: MatchConfig = {
    stageId,
    players: [
      { slot: 0, charId: 'aeval', cpu: true, cpuLevel: levelA },
      { slot: 1, charId: 'aeval', cpu: true, cpuLevel: levelB },
    ],
    stocks,
    timeLimitSec: 0,
    seed,
  };
  if (zeroMoves !== undefined) cfg.cpuZeroMoves = zeroMoves;
  return cfg;
}

/** Defensive / back-facing options the owner reported the CPU never used. */
interface OptionCounts { spotDodge: number; roll: number; airDodge: number; bair: number }

function emptyOptions(): OptionCounts {
  return { spotDodge: 0, roll: 0, airDodge: 0, bair: 0 };
}

function addOptions(into: OptionCounts, from: OptionCounts): void {
  into.spotDodge += from.spotDodge;
  into.roll += from.roll;
  into.airDodge += from.airDodge;
  into.bair += from.bair;
}

function optionsLine(c: OptionCounts): string {
  return `spotDodge=${c.spotDodge} roll=${c.roll} airDodge=${c.airDodge} bair=${c.bair}`;
}

/**
 * Aeval's whole kit, minus taunt. Every one of these has to appear in a level 9 CPU's play for
 * the CPU to count as using the character rather than a handful of favourite buttons.
 */
const KIT_MOVES = [
  'jab', 'ftilt', 'utilt', 'dtilt', 'dashatk',
  'fsmash', 'usmash', 'dsmash',
  'nair', 'fair', 'bair', 'uair', 'dair',
  'nspecial', 'sspecial', 'uspecial', 'dspecial',
  'ledgeatk',
];

// 'getupatk' is deliberately absent from KIT_MOVES. It only comes out of a knockdown, and a level 9
// CPU techs nearly every landing that would have been one, so how often it appears in a sweep is a
// measure of the opponent's hits, not of the CPU's kit. testCpuGetUp holds the CPU to it instead.
const CHARGEABLE_SMASHES: Record<string, boolean> = { fsmash: true, usmash: true, dsmash: true };

/**
 * Every move that can be charged, read off the character data rather than listed by hand.
 * advanceMove pins actionFrame to 0 on each charging frame, so the "action frame went
 * backwards" restart test fires once per held frame for any of these. nspecial became
 * chargeable and a hand-written smash list silently missed it, inflating its count.
 */
const CHARGEABLE_MOVES: Record<string, boolean> = (() => {
  const out: Record<string, boolean> = {};
  const chars = Object.keys(CHARACTER_DEFS).sort();
  for (let c = 0; c < chars.length; c++) {
    const moves = CHARACTER_DEFS[chars[c]].moves;
    const ids = Object.keys(moves);
    for (let i = 0; i < ids.length; i++) {
      if (moves[ids[i] as MoveId].chargeable === true) out[ids[i]] = true;
    }
  }
  return out;
})();
/** Charge frames that separate a deliberate hold from the one-frame slack of a normal release. */
const CHARGE_MIN = 6;

/** Everything the harness watches beyond the four defensive options: moves, movement, charges. */
interface KitCounts {
  moves: Record<string, number>;
  tauntNeutral: number;     // taunts started while an opponent was alive and able to punish
  shortHop: number;
  fullHop: number;
  fastFall: number;
  dropThrough: number;
  smashUses: number;
  chargedSmashes: number;
  techs: number;            // 'tech' events, in place or rolling
  techRolls: number;
  downed: number;           // entries into 'downed', i.e. landings that were not teched
  footstools: number;       // footstool events this slot jumped off
}

function emptyKit(): KitCounts {
  const moves: Record<string, number> = {};
  for (let i = 0; i < KIT_MOVES.length; i++) moves[KIT_MOVES[i]] = 0;
  moves.taunt = 0;
  moves.taunt2 = 0;
  moves.taunt3 = 0;
  return {
    moves, tauntNeutral: 0, shortHop: 0, fullHop: 0, fastFall: 0, dropThrough: 0,
    smashUses: 0, chargedSmashes: 0, techs: 0, techRolls: 0, downed: 0, footstools: 0,
  };
}

function addKit(into: KitCounts, from: KitCounts): void {
  const keys = Object.keys(from.moves);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    into.moves[k] = (into.moves[k] === undefined ? 0 : into.moves[k]) + from.moves[k];
  }
  into.tauntNeutral += from.tauntNeutral;
  into.shortHop += from.shortHop;
  into.fullHop += from.fullHop;
  into.fastFall += from.fastFall;
  into.dropThrough += from.dropThrough;
  into.smashUses += from.smashUses;
  into.chargedSmashes += from.chargedSmashes;
  into.techs += from.techs;
  into.techRolls += from.techRolls;
  into.downed += from.downed;
  into.footstools += from.footstools;
}

/** Distinct kit moves (taunt excluded) that were used at least once. */
function kitVariety(k: KitCounts): number {
  let n = 0;
  for (let i = 0; i < KIT_MOVES.length; i++) if (k.moves[KIT_MOVES[i]] > 0) n++;
  return n;
}

/**
 * Sim-private fighter fields the harness reads as evidence. They are not on the frozen
 * FighterState contract, but they are on the object the sim steps, and cloneGameState copies
 * them, so reading them is observing the simulation, not reaching into the AI.
 */
interface SimView { shortHop: boolean; dropTimer: number; activeThrowId: string | null }
function simView(f: FighterState): SimView { return f as unknown as SimView; }

interface CpuMatchRun {
  state: GameState;
  frames: number;
  koCount: number;
  selfDestructs: number;
  sdBySlot: number[];
  aerialStarts: number[][];
  /** Per slot: entries into each dodge action, and bair starts. */
  options: OptionCounts[];
  /** Per slot: every move used, movement mechanics, and smash charging. */
  kit: KitCounts[];
  /** Per slot: rolls the CPU asked for on purpose, read off the AI's debug counter at the end. */
  intendedRolls: number[];
  /** Final Smash starts seen ('finalSmash' events of phase 'start', or entries into the action). */
  fsStarts: number;
  /** Highest Final Smash meter either fighter reached. */
  maxMeter: number;
}

/** Runs a full CPU-vs-CPU match, driving both slots through cpuInput every frame, and tracks
 * KOs, self-destructs and aerial-attack start frames per slot along the way. */
function runCpuMatch(levelA: number, levelB: number, maxFrames: number, seed: number, stocks: number): CpuMatchRun {
  const state = createGameState(cpuConfig(levelA, levelB, seed, stocks));
  const rand = () => nextFloat(state.rng);
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0 },
    { held: 0, pressed: 0, released: 0 },
  ];
  const prevMoveId: (string | null)[] = [null, null];
  const prevAction: (string | null)[] = [null, null];
  const aerialStarts: number[][] = [[], []];
  const options: OptionCounts[] = [emptyOptions(), emptyOptions()];
  const kit: KitCounts[] = [emptyKit(), emptyKit()];
  const sdBySlot = [0, 0];
  const prevFrameNo = [-1, -1];       // actionFrame last seen, to spot a move restarted into itself
  const prevFastFall = [false, false];
  const prevDrop = [0, 0];
  const maxCharge = [0, 0];           // charge frames seen so far in the current smash
  const chargeMove: (string | null)[] = [null, null];
  let koCount = 0;
  let selfDestructs = 0;
  let fsStarts = 0;
  let maxMeter = 0;
  let frame = 0;
  for (; frame < maxFrames; frame++) {
    inputs[0] = cpuInput(state, 0, levelA, rand);
    inputs[1] = cpuInput(state, 1, levelB, rand);
    stepGame(state, inputs);

    for (let s = 0; s < 2; s++) {
      const f = state.fighters[s];
      const id = f.moveId;
      if (id !== null && AERIAL_MOVES[id] && id !== prevMoveId[s]) aerialStarts[s].push(state.frame);
      if (id === 'bair' && prevMoveId[s] !== 'bair') options[s].bair++;
      const act = f.action;
      if (f.fsMeter > maxMeter) maxMeter = f.fsMeter;
      if (act === 'finalSmash' && prevAction[s] !== 'finalSmash') fsStarts++;

      // A move counts as freshly used when the id changes, or when the same id restarts (its
      // action frame counter went backwards), so a jab straight into another jab is two uses.
      // The restart half is skipped for chargeable smashes: advanceMove pins actionFrame to 0 on
      // every charging frame (src/sim/moves.ts), so the backwards test fires once per held frame
      // and a single charged fsmash would otherwise read as dozens of separate uses.
      const restarted = f.actionFrame <= prevFrameNo[s] && f.hitlag === 0 &&
        (id === null || CHARGEABLE_MOVES[id] !== true);
      const started = id !== null && act === 'attack' &&
        (id !== prevMoveId[s] || prevAction[s] !== 'attack' || restarted);
      if (started && id !== null) {
        const k = kit[s];
        k.moves[id] = (k.moves[id] === undefined ? 0 : k.moves[id]) + 1;
        if (id === 'taunt' || id === 'taunt2' || id === 'taunt3') {
          const other = state.fighters[1 - s];
          // A taunt is only free when nobody is left who could walk over and punish it.
          if (other && other.stocks > 0 && other.action !== 'dead') k.tauntNeutral++;
        }
        if (CHARGEABLE_SMASHES[id] === true) {
          k.smashUses++;
          chargeMove[s] = id;
          maxCharge[s] = 0;
        }
      }
      if (chargeMove[s] !== null) {
        if (id === chargeMove[s] && act === 'attack') {
          if (f.charge > maxCharge[s]) maxCharge[s] = f.charge;
        } else {
          if (maxCharge[s] >= CHARGE_MIN) kit[s].chargedSmashes++;
          chargeMove[s] = null;
          maxCharge[s] = 0;
        }
      }

      // Movement mechanics. A short hop is a jumpsquat that took off with shortHop still set.
      if (prevAction[s] === 'jumpsquat' && act !== 'jumpsquat') {
        if (simView(f).shortHop) kit[s].shortHop++;
        else kit[s].fullHop++;
      }
      if (f.fastFalling && !prevFastFall[s]) kit[s].fastFall++;
      const drop = simView(f).dropTimer;
      if (drop > prevDrop[s]) kit[s].dropThrough++;

      if (act !== prevAction[s]) {
        if (act === 'spotDodge') options[s].spotDodge++;
        else if (act === 'roll') options[s].roll++;
        else if (act === 'airDodge') options[s].airDodge++;
        else if (act === 'downed') kit[s].downed++;
      }
      prevMoveId[s] = id;
      prevAction[s] = act;
      prevFrameNo[s] = f.actionFrame;
      prevFastFall[s] = f.fastFalling;
      prevDrop[s] = drop;
    }

    for (let i = 0; i < state.events.length; i++) {
      const ev = state.events[i];
      if (ev.type === 'ko') {
        koCount++;
        const victim = state.fighters[ev.slot];
        if (victim && victim.lastHitBy === -1) { selfDestructs++; sdBySlot[ev.slot]++; }
      } else if (ev.type === 'tech') {
        kit[ev.slot].techs++;
        if (ev.roll) kit[ev.slot].techRolls++;
      } else if (ev.type === 'footstool') {
        kit[ev.attacker].footstools++;
      }
    }

    if (state.finished) { frame++; break; }
  }
  // A smash still charging when the match ended still counted as charged.
  for (let s = 0; s < 2; s++) {
    if (chargeMove[s] !== null && maxCharge[s] >= CHARGE_MIN) kit[s].chargedSmashes++;
  }
  // Read before any other match drives cpuInput, which would reset the counter for its own match.
  const intendedRolls = [cpuIntendedRolls(0), cpuIntendedRolls(1)];
  return {
    state, frames: frame, koCount, selfDestructs, sdBySlot, aerialStarts, options, kit, intendedRolls, fsStarts, maxMeter,
  };
}

interface MatchupSummary {
  levelA: number;         // the level under test (the higher one, for an ordered pair)
  levelB: number;
  winsA: number;          // matches won by levelA, counted across both sides of every seed
  winsB: number;
  draws: number;
  stocksA: number;        // stocks levelA finished with, summed over every match
  stocksB: number;
  sdA: number;            // self-destructs charged to levelA, on whichever slot it played
  sdB: number;
  avgFrames: number;
  finished: number;
  runs: CpuMatchRun[];
  optA: OptionCounts;     // dodges/bair performed by levelA, on whichever slot it played
  optB: OptionCounts;
  kitA: KitCounts;        // kit usage by levelA, on whichever slot it played
  kitB: KitCounts;
  totalFrames: number;    // frames of play summed over the matchup, for per-frame option rates
}

/**
 * Replays one matchup across every seed on both sides. Slot 0 spawns on the left with a real
 * positional edge, so a one-sided matrix would credit the ladder for a spawn advantage.
 */
function runMatchup(levelA: number, levelB: number): MatchupSummary {
  const out: MatchupSummary = {
    levelA, levelB, winsA: 0, winsB: 0, draws: 0, stocksA: 0, stocksB: 0,
    sdA: 0, sdB: 0, avgFrames: 0, finished: 0, runs: [],
    optA: emptyOptions(), optB: emptyOptions(), kitA: emptyKit(), kitB: emptyKit(), totalFrames: 0,
  };
  let totalFrames = 0;
  for (let i = 0; i < SEEDS.length; i++) {
    for (let side = 0; side < 2; side++) {
      const a = side === 0 ? levelA : levelB;
      const b = side === 0 ? levelB : levelA;
      const run = runCpuMatch(a, b, MATCH_CAP, SEEDS[i], MATRIX_STOCKS);
      const slotA = side === 0 ? 0 : 1;
      const slotB = 1 - slotA;
      out.runs.push(run);
      totalFrames += run.frames;
      if (run.state.finished) out.finished++;
      if (run.state.winner === slotA) out.winsA++;
      else if (run.state.winner === slotB) out.winsB++;
      else out.draws++;
      out.stocksA += run.state.fighters[slotA].stocks;
      out.stocksB += run.state.fighters[slotB].stocks;
      out.sdA += run.sdBySlot[slotA];
      out.sdB += run.sdBySlot[slotB];
      addOptions(out.optA, run.options[slotA]);
      addOptions(out.optB, run.options[slotB]);
      addKit(out.kitA, run.kit[slotA]);
      addKit(out.kitB, run.kit[slotB]);
    }
  }
  out.totalFrames = totalFrames;
  out.avgFrames = Math.round(totalFrames / MATCHES_PER_MATCHUP);
  return out;
}

function summaryLine(m: MatchupSummary): string {
  const rate = ((m.winsA / MATCHES_PER_MATCHUP) * 100).toFixed(0);
  return `  L${m.levelA} vs L${m.levelB}: L${m.levelA} wins ${m.winsA}/${MATCHES_PER_MATCHUP} (${rate}%)` +
    ` stocks ${m.stocksA}-${m.stocksB} sd ${m.sdA}/${m.sdB}` +
    ` avg ${m.avgFrames}f finished ${m.finished}/${MATCHES_PER_MATCHUP}`;
}

function aerialSpacingOk(starts: number[][]): { ok: boolean; detail: string } {
  for (let s = 0; s < starts.length; s++) {
    const list = starts[s];
    for (let i = 1; i < list.length; i++) {
      const gap = list[i] - list[i - 1];
      if (gap < MIN_AERIAL_GAP) {
        return { ok: false, detail: `slot ${s} gap ${gap}f between aerials at ${list[i - 1]} and ${list[i]}` };
      }
    }
  }
  let total = 0;
  for (let s = 0; s < starts.length; s++) total += starts[s].length;
  return { ok: true, detail: `${total} aerial starts, all >= ${MIN_AERIAL_GAP} frames apart` };
}

let runA: CpuMatchRun | null = null;
const matrix: MatchupSummary[] = [];

function matchupOf(a: number, b: number): MatchupSummary {
  for (let i = 0; i < matrix.length; i++) {
    const m = matrix[i];
    if (m.levelA === a && m.levelB === b) return m;
  }
  throw new Error(`matchup ${a}v${b} not run`);
}

function testL1v1(): TestResult {
  runA = runCpuMatch(1, 1, 20000, 5, 1);
  const ok = runA.state.finished && runA.koCount >= 1;
  return {
    name: 'a. level 1 vs level 1 finishes with a KO',
    pass: ok,
    detail: `finished=${runA.state.finished} frames=${runA.frames} kos=${runA.koCount}`,
  };
}

/** The whole 1..9 range, run as a matrix of representative matchups over fixed seeds. */
function testMatrix(): TestResult {
  const pairs = [[9, 1], [9, 5], [5, 1], [9, 9], [1, 1], [7, 3], [2, 2]];
  for (let i = 0; i < pairs.length; i++) matrix.push(runMatchup(pairs[i][0], pairs[i][1]));
  let unfinished = 0;
  for (let i = 0; i < matrix.length; i++) unfinished += MATCHES_PER_MATCHUP - matrix[i].finished;
  return {
    name: 'b. every matrix matchup finishes inside the frame cap',
    pass: unfinished === 0,
    detail: `${matrix.length} matchups x ${MATCHES_PER_MATCHUP} matches, unfinished=${unfinished}`,
  };
}

/** Monotonic expectation: the higher level has to beat the lower one clearly, not marginally. */
function testMonotonic(): TestResult {
  const checks = [[9, 1], [9, 5], [5, 1], [7, 3]];
  const fails: string[] = [];
  const rates: string[] = [];
  for (let i = 0; i < checks.length; i++) {
    const m = matchupOf(checks[i][0], checks[i][1]);
    const rate = m.winsA / MATCHES_PER_MATCHUP;
    const margin = m.stocksA - m.stocksB;
    rates.push(`L${m.levelA}>L${m.levelB} ${(rate * 100).toFixed(0)}% +${margin}`);
    if (rate < WIN_RATE_FLOOR) {
      fails.push(`L${m.levelA} v L${m.levelB} only ${m.winsA}/${MATCHES_PER_MATCHUP}`);
    } else if (margin < MATRIX_STOCKS) {
      fails.push(`L${m.levelA} v L${m.levelB} stock margin ${margin}`);
    }
  }
  return {
    name: 'c. higher level beats lower level on both sides of every matchup',
    pass: fails.length === 0,
    detail: fails.length === 0 ? rates.join(', ') : fails.join('; '),
  };
}

/** Runs the right ledge off, drifting back to grab; no input while hanging; re-grabs if
 * knocked off. Never attacks, so it never affects the aerial-cooldown or self-destruct checks. */
function p2LedgeHold(f: FighterState): InputFrame {
  if (f.action === 'ledgeHang' || f.action === 'ledgeClimb' || f.action === 'ledgeRoll') {
    return { held: 0, pressed: 0, released: 0 };
  }
  if (f.onGround) return { held: Btn.Right, pressed: 0, released: 0 };
  return { held: Btn.Left, pressed: 0, released: 0 };
}

function testLedgeApproach(): TestResult {
  const state = createGameState(cpuConfig(2, 0, 3, 5));
  state.fighters[1].x = 150;
  const rand = () => nextFloat(state.rng);
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0 },
    { held: 0, pressed: 0, released: 0 },
  ];
  let cpuDied = false;
  let p2MaxPercent = 0;
  for (let i = 0; i < 1800; i++) {
    inputs[0] = cpuInput(state, 0, 2, rand);
    inputs[1] = p2LedgeHold(state.fighters[1]);
    stepGame(state, inputs);
    if (state.fighters[1].percent > p2MaxPercent) p2MaxPercent = state.fighters[1].percent;
    for (let k = 0; k < state.events.length; k++) {
      const ev = state.events[k];
      if (ev.type === 'ko' && ev.slot === 0) cpuDied = true;
    }
  }
  const ok = p2MaxPercent > 0 && !cpuDied;
  return {
    name: 'd. level 2 CPU hits a ledge-hanging opponent',
    pass: ok,
    detail: `p2 max percent=${p2MaxPercent.toFixed(1)} cpuDied=${cpuDied}`,
  };
}

function testAerialCooldown(): TestResult {
  if (!runA || matrix.length === 0) {
    return { name: 'e. aerial cooldown respected', pass: false, detail: 'prior runs missing' };
  }
  const a = aerialSpacingOk(runA.aerialStarts);
  let worst = '';
  let total = 0;
  for (let i = 0; i < matrix.length; i++) {
    const m = matrix[i];
    for (let r = 0; r < m.runs.length; r++) {
      const res = aerialSpacingOk(m.runs[r].aerialStarts);
      for (let s = 0; s < m.runs[r].aerialStarts.length; s++) total += m.runs[r].aerialStarts[s].length;
      if (!res.ok && worst === '') {
        worst = `L${m.levelA}vL${m.levelB} seed ${SEEDS[r >> 1]} side ${r & 1}: ${res.detail}`;
      }
    }
  }
  return {
    name: 'e. no two aerials from the same slot start within 45 frames',
    pass: a.ok && worst === '',
    detail: worst === '' ? `l1v1: ${a.detail} | matrix: ${total} aerial starts, all spaced` : worst,
  };
}

/** Level 9 leaves the stage to edgeguard, so this is the check that it never trades its own stock
 * for the read: across the whole matrix, nobody may self-destruct. */
function testNoSelfDestruct(): TestResult {
  if (!runA || matrix.length === 0) {
    return { name: 'f. no self-destructs', pass: false, detail: 'prior runs missing' };
  }
  let total = runA.selfDestructs;
  const offenders: string[] = [];
  for (let i = 0; i < matrix.length; i++) {
    const m = matrix[i];
    total += m.sdA + m.sdB;
    if (m.sdA + m.sdB > 0) offenders.push(`L${m.levelA}vL${m.levelB} ${m.sdA}/${m.sdB}`);
  }
  let scenarioSd = 0;
  const sdLabels: string[] = [];
  const stacked = vertAbove.concat(vertBelow);
  for (let i = 0; i < stacked.length; i++) {
    scenarioSd += stacked[i].sd;
    if (stacked[i].sd > 0 && sdLabels.length < 4) sdLabels.push(`${stacked[i].label} x${stacked[i].sd}`);
  }
  for (let i = 0; i < spamRuns.length; i++) {
    scenarioSd += spamRuns[i].sd;
    if (spamRuns[i].sd > 0 && sdLabels.length < 4) {
      sdLabels.push(`spam ${spamRuns[i].label} cpu x${spamRuns[i].cpuSd} spammer x${spamRuns[i].sd - spamRuns[i].cpuSd}`);
    }
  }
  if (scenarioSd > 0) offenders.push(`scripted scenarios ${scenarioSd} (${sdLabels.join(', ')})`);
  total += scenarioSd;
  const runCount = 1 + matrix.length * MATCHES_PER_MATCHUP + stacked.length + spamRuns.length;
  return {
    name: 'f. no self-destructs anywhere: every level, every scripted scenario',
    pass: total === 0,
    detail: total === 0 ? `zero self-destructs across ${runCount} runs` : offenders.join('; '),
  };
}

// ---------------------------------------------------------------------------
// Defect 1: vertical dead zones. The CPU stalled whenever the opponent sat
// directly above or directly below it, because every approach it owned was
// horizontal. These scenarios park an opponent in exactly those spots and
// demand a hit inside a bounded number of frames.
// ---------------------------------------------------------------------------

/** Frames a level 9 CPU is given to land a hit on a parked, directly-stacked opponent. */
const VERT_HIT_CAP = 180;
/** Longest run of frames the CPU may spend making no horizontal progress and landing no hit. */
const VERT_STALL_CAP = 120;
/** "No horizontal progress" means moving less than this many px away from the last mark. */
const VERT_PROGRESS_PX = 4;
/** Vertical separations tested, in px. Spec range for the dead zone is roughly 60-140. */
const VERT_DYS = [60, 90, 120, 140];
/** Small horizontal offsets, so "directly above" is tested as a band and not one pixel. */
const VERT_DXS = [0, 10, -10];
const VERT_SEEDS = [5, 17, 23, 41, 97];

interface VertRun {
  hit: boolean;
  hitFrame: number;     // frames until the parked opponent first took damage, or -1
  maxStall: number;     // longest run of frames with no horizontal progress and no hit
  sd: number;
  label: string;
}

/**
 * One stacked-opponent scenario. The opponent is a dummy: it never presses a button and is
 * re-pinned to a fixed world position every frame, so the only thing that can end the scenario
 * is the CPU solving the vertical gap. Pinning is absolute (not relative to the CPU) so the CPU
 * is free to reposition, and horizontal progress stays a meaningful stall signal.
 */
function runVerticalScenario(above: boolean, cpuSlot: number, dy: number, dxOff: number, seed: number): VertRun {
  const levelA = cpuSlot === 0 ? 9 : 1;
  const levelB = cpuSlot === 0 ? 1 : 9;
  const state = createGameState(cpuConfig(levelA, levelB, seed, 1));
  const rand = () => nextFloat(state.rng);
  const idle: InputFrame = { held: 0, pressed: 0, released: 0 };
  const inputs: InputFrame[] = [idle, idle];
  const oppSlot = 1 - cpuSlot;
  // Let the spawn drop resolve so both fighters are settled before anything is teleported.
  for (let i = 0; i < 30; i++) stepGame(state, inputs);

  const me = state.fighters[cpuSlot];
  const opp = state.fighters[oppSlot];
  let pinX: number;
  let pinY: number;
  if (above) {
    me.x = 0; me.y = 0; me.vx = 0; me.vy = 0; me.onGround = true;
    me.action = 'idle'; me.actionFrame = 0; me.moveId = null; me.jumpsLeft = 2;
    pinX = dxOff; pinY = -dy;                 // opponent floats directly overhead
  } else {
    me.x = dxOff; me.y = -dy; me.vx = 0; me.vy = 0; me.onGround = false;
    me.action = 'air'; me.actionFrame = 0; me.moveId = null; me.jumpsLeft = 2;
    pinX = 0; pinY = 0;                       // opponent stands on the stage below
  }
  opp.percent = 0;
  opp.invuln = 0;

  let hitFrame = -1;
  let maxStall = 0;
  let stall = 0;
  let markX = me.x;
  let sd = 0;
  for (let i = 0; i < VERT_HIT_CAP; i++) {
    // Re-park the dummy: zero velocity, fixed position, no inputs, never acting.
    opp.x = pinX;
    opp.y = pinY;
    opp.vx = 0;
    opp.vy = 0;
    opp.invuln = 0;
    if (above) { opp.onGround = false; opp.action = 'air'; } else { opp.onGround = true; opp.action = 'idle'; }

    inputs[cpuSlot] = cpuInput(state, cpuSlot, 9, rand);
    inputs[oppSlot] = idle;
    stepGame(state, inputs);

    let hitThisFrame = false;
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'hit' && ev.victim === oppSlot) hitThisFrame = true;
      if (ev.type === 'ko' && state.fighters[ev.slot].lastHitBy === -1) sd++;
    }
    if (opp.percent > 0) hitThisFrame = true;

    if (hitThisFrame) { hitFrame = i + 1; break; }
    if (Math.abs(me.x - markX) > VERT_PROGRESS_PX) { markX = me.x; stall = 0; }
    else { stall++; if (stall > maxStall) maxStall = stall; }
  }
  const side = above ? 'above' : 'below';
  return {
    hit: hitFrame >= 0,
    hitFrame,
    maxStall,
    sd,
    label: `${side} slot${cpuSlot} dy=${dy} dx=${dxOff} seed=${seed}`,
  };
}

const vertAbove: VertRun[] = [];
const vertBelow: VertRun[] = [];

function runVerticalSweep(): void {
  for (let d = 0; d < VERT_DYS.length; d++) {
    for (let x = 0; x < VERT_DXS.length; x++) {
      for (let s = 0; s < VERT_SEEDS.length; s++) {
        for (let slot = 0; slot < 2; slot++) {
          vertAbove.push(runVerticalScenario(true, slot, VERT_DYS[d], VERT_DXS[x], VERT_SEEDS[s]));
          vertBelow.push(runVerticalScenario(false, slot, VERT_DYS[d], VERT_DXS[x], VERT_SEEDS[s]));
        }
      }
    }
  }
}

function vertHitResult(name: string, runs: VertRun[]): TestResult {
  let hits = 0;
  let sum = 0;
  let worst = 0;
  const misses: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.hit) {
      hits++;
      sum += r.hitFrame;
      if (r.hitFrame > worst) worst = r.hitFrame;
    } else if (misses.length < 4) {
      misses.push(r.label);
    }
  }
  const avg = hits === 0 ? -1 : (sum / hits).toFixed(1);
  const detail = `${hits}/${runs.length} resolved, avg ${avg}f, slowest ${worst}f, cap ${VERT_HIT_CAP}f` +
    (misses.length === 0 ? '' : ` | stalled: ${misses.join(', ')}`);
  return { name, pass: hits === runs.length, detail };
}

function vertGroupLine(label: string, runs: VertRun[]): string {
  let hits = 0;
  let sum = 0;
  let worst = 0;
  let stall = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.hit) { hits++; sum += r.hitFrame; if (r.hitFrame > worst) worst = r.hitFrame; }
    if (r.maxStall > stall) stall = r.maxStall;
  }
  const avg = hits === 0 ? 'n/a' : (sum / hits).toFixed(1);
  return `  ${label}: hit in ${hits}/${runs.length}, avg ${avg}f, slowest ${worst}f,` +
    ` longest no-progress run ${stall}f`;
}

function testVertAbove(): TestResult {
  return vertHitResult('g. level 9 CPU hits an opponent parked directly above it', vertAbove);
}

function testVertBelow(): TestResult {
  return vertHitResult('h. airborne level 9 CPU hits an opponent directly below it', vertBelow);
}

/** A CPU that neither moves horizontally nor lands anything is doing nothing at all. */
function testVertNoStall(): TestResult {
  let worst = 0;
  let worstLabel = '';
  const offenders: string[] = [];
  const all = vertAbove.concat(vertBelow);
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (r.maxStall > worst) { worst = r.maxStall; worstLabel = r.label; }
    if (r.maxStall > VERT_STALL_CAP && offenders.length < 4) offenders.push(`${r.label} stalled ${r.maxStall}f`);
  }
  return {
    name: `i. CPU never idles ${VERT_STALL_CAP}+ frames without moving or hitting, stacked`,
    pass: offenders.length === 0,
    detail: offenders.length === 0
      ? `${all.length} scenarios, longest no-progress run ${worst}f (${worstLabel}), cap ${VERT_STALL_CAP}f`
      : offenders.join('; '),
  };
}

// ---------------------------------------------------------------------------
// Defect 2: a human beat the CPU by throwing projectiles at it until its shield
// broke. The opponent here is not a CPU: it is a fixed routine that only ever
// retreats to range and throws nspecial / sspecial.
// ---------------------------------------------------------------------------

/** Range the spammer keeps between itself and the CPU before it throws anything. */
const SPAM_RANGE = 110;
/** Frames between volleys. nspecial is 40 frames long, so this is back-to-back throwing. */
const SPAM_PERIOD = 8;
/** Frames the spammer faces the CPU before firing, so a no-direction nspecial goes the right way. */
const SPAM_AIM_FRAMES = 2;
const SPAM_SEEDS = [5, 17, 23];
const SPAM_STOCKS = 2;
const SPAM_CAP = 20000;
/** Shield HP the CPU may dip to briefly, but must not sit under. SHIELD_MAX is 60. */
const SHIELD_LOW_WATER = 18;
/** Consecutive frames below the low-water mark that count as "about to be broken". */
const SHIELD_LOW_FRAMES = 60;

interface SpamMem { aim: number; timer: number; volley: number; prevHeld: number }

/**
 * The scripted spammer. No CPU logic at all: hold away until out of the CPU's reach, turn to
 * face it, throw a projectile special, repeat. Alternates sspecial in so both of the projectile
 * specials the owner was beaten by are represented. Recovers off-stage only well enough to keep
 * throwing; it is a punching bag with a gun, not an opponent.
 */
function spammerInput(state: GameState, slot: number, mem: SpamMem, out: InputFrame): InputFrame {
  const me = state.fighters[slot];
  const foe = state.fighters[1 - slot];
  let held = 0;
  if (me.action === 'dead' || me.stocks <= 0) {
    held = 0;
  } else if (!me.onGround) {
    held = me.x < 0 ? Btn.Right : Btn.Left;
    if (me.vy > 0.5 && me.jumpsLeft > 0) held |= Btn.Jump;
    else if (me.vy > 0 && me.jumpsLeft === 0) held |= Btn.Special | Btn.Up;
  } else {
    const dx = foe.x - me.x;
    const adx = Math.abs(dx);
    const toward = dx < 0 ? Btn.Left : Btn.Right;
    const away = dx < 0 ? Btn.Right : Btn.Left;
    const nearEdge = me.x < -150 || me.x > 150;
    if (mem.timer > 0) mem.timer--;
    if (me.action === 'attack' || me.action === 'hitstun' || me.action === 'tumble') {
      held = 0;
    } else if (adx < SPAM_RANGE && !nearEdge) {
      held = away;
      mem.aim = 0;
    } else if (mem.timer > 0) {
      held = 0;
    } else if (mem.aim < SPAM_AIM_FRAMES) {
      mem.aim++;
      held = toward;
    } else {
      mem.aim = 0;
      mem.volley++;
      mem.timer = SPAM_PERIOD;
      held = mem.volley % 3 === 0 ? (toward | Btn.Special) : Btn.Special;
    }
  }
  out.pressed = held & ~mem.prevHeld;
  out.released = mem.prevHeld & ~held;
  out.held = held;
  mem.prevHeld = held;
  return out;
}

interface SpamRun {
  label: string;
  finished: boolean;
  frames: number;
  winnerIsCpu: boolean;
  cpuStocks: number;
  spamStocks: number;
  volleys: number;
  minShield: number;
  worstLowRun: number;      // longest run of frames the CPU's shield sat under the low-water mark
  broke: boolean;           // shieldHp hit 0 or the CPU entered shieldBreak
  sd: number;
  cpuSd: number;            // the share of sd that was the CPU's own stock
}

function runSpamMatch(cpuSlot: number, seed: number): SpamRun {
  const levelA = cpuSlot === 0 ? 9 : 0;
  const levelB = cpuSlot === 0 ? 0 : 9;
  const state = createGameState(cpuConfig(levelA, levelB, seed, SPAM_STOCKS));
  const rand = () => nextFloat(state.rng);
  const spamSlot = 1 - cpuSlot;
  const mem: SpamMem = { aim: 0, timer: 0, volley: 0, prevHeld: 0 };
  const spamFrame: InputFrame = { held: 0, pressed: 0, released: 0 };
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0 },
    { held: 0, pressed: 0, released: 0 },
  ];
  const cpu = state.fighters[cpuSlot];
  let minShield = cpu.shieldHp;
  let lowRun = 0;
  let worstLowRun = 0;
  let broke = false;
  let sd = 0;
  let cpuSd = 0;
  let frames = 0;
  for (; frames < SPAM_CAP; frames++) {
    inputs[cpuSlot] = cpuInput(state, cpuSlot, 9, rand);
    inputs[spamSlot] = spammerInput(state, spamSlot, mem, spamFrame);
    stepGame(state, inputs);

    if (cpu.shieldHp < minShield) minShield = cpu.shieldHp;
    if (cpu.shieldHp <= 0 || cpu.action === 'shieldBreak') broke = true;
    // A stock lost resets the shield; only count the low-water run while the CPU is really alive.
    if (cpu.action !== 'dead' && cpu.shieldHp < SHIELD_LOW_WATER) {
      lowRun++;
      if (lowRun > worstLowRun) worstLowRun = lowRun;
    } else {
      lowRun = 0;
    }
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'shieldBreak' && ev.slot === cpuSlot) broke = true;
      if (ev.type === 'ko' && state.fighters[ev.slot].lastHitBy === -1) {
        sd++;
        if (ev.slot === cpuSlot) cpuSd++;
      }
    }
    if (state.finished) { frames++; break; }
  }
  return {
    label: `seed ${seed} cpu=slot${cpuSlot}`,
    finished: state.finished,
    frames,
    winnerIsCpu: state.winner === cpuSlot,
    cpuStocks: state.fighters[cpuSlot].stocks,
    spamStocks: state.fighters[spamSlot].stocks,
    volleys: mem.volley,
    minShield,
    worstLowRun,
    broke,
    sd,
    cpuSd,
  };
}

const spamRuns: SpamRun[] = [];

function runSpamSweep(): void {
  for (let i = 0; i < SPAM_SEEDS.length; i++) {
    for (let slot = 0; slot < 2; slot++) spamRuns.push(runSpamMatch(slot, SPAM_SEEDS[i]));
  }
}

function testSpamBeaten(): TestResult {
  let wins = 0;
  let unfinished = 0;
  let volleys = 0;
  let cpuStocks = 0;
  let spamStocks = 0;
  const losses: string[] = [];
  for (let i = 0; i < spamRuns.length; i++) {
    const r = spamRuns[i];
    volleys += r.volleys;
    cpuStocks += r.cpuStocks;
    spamStocks += r.spamStocks;
    if (!r.finished) unfinished++;
    if (r.winnerIsCpu) wins++;
    else losses.push(`${r.label} stocks ${r.cpuStocks}-${r.spamStocks}`);
  }
  return {
    name: 'j. level 9 CPU beats the scripted projectile spammer on both sides',
    pass: wins === spamRuns.length && unfinished === 0,
    detail: `won ${wins}/${spamRuns.length}, stocks ${cpuStocks}-${spamStocks},` +
      ` ${volleys} volleys thrown, unfinished ${unfinished}` +
      (losses.length === 0 ? '' : ` | lost: ${losses.join('; ')}`),
  };
}

function testSpamShield(): TestResult {
  let broke = 0;
  let worstMin = 999;
  let worstLow = 0;
  const offenders: string[] = [];
  for (let i = 0; i < spamRuns.length; i++) {
    const r = spamRuns[i];
    if (r.minShield < worstMin) worstMin = r.minShield;
    if (r.worstLowRun > worstLow) worstLow = r.worstLowRun;
    if (r.broke) { broke++; offenders.push(`${r.label} SHIELD BROKEN`); }
    else if (r.worstLowRun >= SHIELD_LOW_FRAMES) {
      offenders.push(`${r.label} shield under ${SHIELD_LOW_WATER} for ${r.worstLowRun}f`);
    }
  }
  return {
    name: `k. spam never breaks the level 9 shield, nor pins it under ${SHIELD_LOW_WATER} for ${SHIELD_LOW_FRAMES}f`,
    pass: offenders.length === 0,
    detail: `breaks=${broke}/${spamRuns.length}, shieldHp low-water ${worstMin.toFixed(2)}/60,` +
      ` longest sub-${SHIELD_LOW_WATER} run ${worstLow}f` +
      (offenders.length === 0 ? '' : ` | ${offenders.join('; ')}`),
  };
}

// ---------------------------------------------------------------------------
// Defect 3: the CPU never spot-dodged, rolled, air-dodged or threw a bair.
// Counted across the whole matrix sweep, and compared against levels 1-2 so the
// test proves difficulty scaling rather than "the move exists in the move list".
// ---------------------------------------------------------------------------

/** Times each option has to show up at level 9 across the whole sweep to count as real. */
const OPTION_FLOOR = 10;
/** Level 9 has to use each option at least this many times as often as a level 1-2 CPU. */
const OPTION_RATIO = 3;

/**
 * Options used by every slot in the matrix whose level falls in [lo, hi], together with the
 * frames those slots actually played. A raw total would be unfair in both directions: level 9
 * appears in a different number of matchups than level 1-2, and its matches last longer. The
 * scaling test therefore compares uses per 1000 frames of play, not raw counts.
 */
function optionsForLevels(lo: number, hi: number): { counts: OptionCounts; frames: number } {
  const counts = emptyOptions();
  let frames = 0;
  for (let i = 0; i < matrix.length; i++) {
    const m = matrix[i];
    if (m.levelA >= lo && m.levelA <= hi) { addOptions(counts, m.optA); frames += m.totalFrames; }
    if (m.levelB >= lo && m.levelB <= hi) { addOptions(counts, m.optB); frames += m.totalFrames; }
  }
  return { counts, frames };
}

function levelNineOptions(): OptionCounts { return optionsForLevels(9, 9).counts; }

/** Same aggregation, for the whole kit rather than the four defensive options. */
function kitForLevels(lo: number, hi: number): { counts: KitCounts; frames: number } {
  const counts = emptyKit();
  let frames = 0;
  for (let i = 0; i < matrix.length; i++) {
    const m = matrix[i];
    if (m.levelA >= lo && m.levelA <= hi) { addKit(counts, m.kitA); frames += m.totalFrames; }
    if (m.levelB >= lo && m.levelB <= hi) { addKit(counts, m.kitB); frames += m.totalFrames; }
  }
  return { counts, frames };
}

function per1k(count: number, frames: number): number {
  return frames === 0 ? 0 : (count * 1000) / frames;
}

function ratesLine(counts: OptionCounts, frames: number): string {
  return `spotDodge=${per1k(counts.spotDodge, frames).toFixed(2)}` +
    ` roll=${per1k(counts.roll, frames).toFixed(2)}` +
    ` airDodge=${per1k(counts.airDodge, frames).toFixed(2)}` +
    ` bair=${per1k(counts.bair, frames).toFixed(2)} per 1k frames`;
}

function testOptionsUsed(): TestResult {
  if (matrix.length === 0) return { name: 'l. dodges and bair used', pass: false, detail: 'matrix missing' };
  const hi = levelNineOptions();
  const fails: string[] = [];
  if (hi.spotDodge < OPTION_FLOOR) fails.push(`spotDodge ${hi.spotDodge}`);
  if (hi.roll < OPTION_FLOOR) fails.push(`roll ${hi.roll}`);
  if (hi.airDodge < OPTION_FLOOR) fails.push(`airDodge ${hi.airDodge}`);
  if (hi.bair < OPTION_FLOOR) fails.push(`bair ${hi.bair}`);
  return {
    name: `l. level 9 uses spotDodge, roll, airDodge and bair at least ${OPTION_FLOOR}x each`,
    pass: fails.length === 0,
    detail: fails.length === 0 ? `L9 ${optionsLine(hi)}` : `L9 ${optionsLine(hi)} | under floor: ${fails.join(', ')}`,
  };
}

function testOptionsScale(): TestResult {
  if (matrix.length === 0) return { name: 'm. dodge use scales with level', pass: false, detail: 'matrix missing' };
  const hi = optionsForLevels(9, 9);
  const lo = optionsForLevels(1, 2);
  const fails: string[] = [];
  const check = (label: string, a: number, b: number): void => {
    const hiRate = per1k(a, hi.frames);
    const loRate = per1k(b, lo.frames);
    // 0 vs 0 is not "scaled", it is an option neither level owns: fail it rather than pass free.
    if (hiRate === 0 || loRate * OPTION_RATIO > hiRate) {
      fails.push(`${label} L9 ${hiRate.toFixed(2)} vs L1-2 ${loRate.toFixed(2)}`);
    }
  };
  check('spotDodge', hi.counts.spotDodge, lo.counts.spotDodge);
  check('roll', hi.counts.roll, lo.counts.roll);
  check('airDodge', hi.counts.airDodge, lo.counts.airDodge);
  check('bair', hi.counts.bair, lo.counts.bair);
  return {
    name: `m. level 1-2 use each option at least ${OPTION_RATIO}x less often than level 9`,
    pass: fails.length === 0,
    detail: `L9 ${ratesLine(hi.counts, hi.frames)} | L1-2 ${ratesLine(lo.counts, lo.frames)}` +
      (fails.length === 0 ? '' : ` | not scaled: ${fails.join(', ')}`),
  };
}

// ---------------------------------------------------------------------------
// Kit coverage. "Makes the most of its entire kit" means every tool Aeval owns
// shows up in a level 9 CPU's play, movement mechanics are used on purpose, and
// smashes are charged rather than always released on frame one. The bar for any
// single move is vocabulary, not frequency: a situational tool like dspecial or
// ledgeatk only has to appear, while taunt has to never appear in neutral.
// ---------------------------------------------------------------------------

/** Uses of a single move, across the whole level 9 sweep, for it to count as part of the kit. */
const KIT_MOVE_FLOOR = 3;
/** Uses of each movement mechanic, across the whole level 9 sweep. */
const MOVEMENT_FLOOR = 10;
/** Share of level 9 smashes that must be charged past CHARGE_MIN frames. */
const CHARGE_SHARE = 0.05;
/** Absolute number of charged smashes required, so a tiny smash count can't pass on a ratio. */
const CHARGE_FLOOR = 3;
/** Level 9 short hops / move variety have to beat level 1-2 by this factor, per 1000 frames. */
const KIT_RATIO = 3;
const VARIETY_RATIO = 1.5;

function kitTable(counts: KitCounts, frames: number): string {
  const parts: string[] = [];
  for (let i = 0; i < KIT_MOVES.length; i++) {
    const id = KIT_MOVES[i];
    const n = counts.moves[id];
    parts.push(`${id}=${n}(${per1k(n, frames).toFixed(2)})`);
  }
  parts.push(`taunt=${counts.moves.taunt} taunt2=${counts.moves.taunt2} taunt3=${counts.moves.taunt3}`);
  parts.push(`getupatk=${counts.moves.getupatk === undefined ? 0 : counts.moves.getupatk}`);
  return parts.join(' ');
}

function movementLine(counts: KitCounts, frames: number): string {
  return `shortHop=${counts.shortHop}(${per1k(counts.shortHop, frames).toFixed(2)})` +
    ` fullHop=${counts.fullHop} fastFall=${counts.fastFall}` +
    ` dropThrough=${counts.dropThrough}` +
    ` smashes=${counts.smashUses} charged=${counts.chargedSmashes}` +
    ` techs=${counts.techs} techRolls=${counts.techRolls} downed=${counts.downed} footstools=${counts.footstools}`;
}

/** Every move in the kit, taunt excepted, has to appear in level 9's play. */
function testKitCoverage(): TestResult {
  if (matrix.length === 0) return { name: 'o. whole kit used', pass: false, detail: 'matrix missing' };
  const hi = kitForLevels(9, 9);
  const missing: string[] = [];
  for (let i = 0; i < KIT_MOVES.length; i++) {
    const id = KIT_MOVES[i];
    if (hi.counts.moves[id] < KIT_MOVE_FLOOR) missing.push(`${id}=${hi.counts.moves[id]}`);
  }
  return {
    name: `o. level 9 uses every move in the kit at least ${KIT_MOVE_FLOOR}x (taunt excepted)`,
    pass: missing.length === 0,
    detail: `variety ${kitVariety(hi.counts)}/${KIT_MOVES.length} moves over ${hi.frames}f` +
      (missing.length === 0 ? '' : ` | under floor: ${missing.join(', ')}`),
  };
}

/** 90 frames with no hitbox in front of a live opponent is a donated stock, at any level. */
function testNoTaunt(): TestResult {
  if (matrix.length === 0) return { name: 'p. taunt never used in neutral', pass: false, detail: 'matrix missing' };
  const offenders: string[] = [];
  let total = 0;
  for (let i = 0; i < matrix.length; i++) {
    const m = matrix[i];
    const n = m.kitA.tauntNeutral + m.kitB.tauntNeutral;
    total += n;
    if (n > 0) offenders.push(`L${m.levelA}vL${m.levelB} ${m.kitA.tauntNeutral}/${m.kitB.tauntNeutral}`);
  }
  return {
    name: 'p. no CPU taunts while a live opponent could punish it',
    pass: total === 0,
    detail: total === 0 ? 'zero neutral taunts at every level' : `${total} neutral taunts: ${offenders.join('; ')}`,
  };
}

/** Short hop, fast fall and platform drop-through are the movement half of the kit. */
function testMovementMechanics(): TestResult {
  if (matrix.length === 0) return { name: 'q. movement mechanics used', pass: false, detail: 'matrix missing' };
  const hi = kitForLevels(9, 9);
  const c = hi.counts;
  const missing: string[] = [];
  if (c.shortHop < MOVEMENT_FLOOR) missing.push(`shortHop ${c.shortHop}`);
  if (c.fastFall < MOVEMENT_FLOOR) missing.push(`fastFall ${c.fastFall}`);
  if (c.dropThrough < MOVEMENT_FLOOR) missing.push(`dropThrough ${c.dropThrough}`);
  return {
    name: `q. level 9 short hops, fast falls and drops through platforms (${MOVEMENT_FLOOR}x each)`,
    pass: missing.length === 0,
    detail: `${movementLine(c, hi.frames)} over ${hi.frames}f` +
      (missing.length === 0 ? '' : ` | under floor: ${missing.join(', ')}`),
  };
}

function testShortHopScaling(): TestResult {
  if (matrix.length === 0) return { name: 'r. short hops scale with level', pass: false, detail: 'matrix missing' };
  const hi = kitForLevels(9, 9);
  const lo = kitForLevels(1, 2);
  const hiRate = per1k(hi.counts.shortHop, hi.frames);
  const loRate = per1k(lo.counts.shortHop, lo.frames);
  return {
    name: `r. level 9 short hops at least ${KIT_RATIO}x as often as level 1-2`,
    pass: hiRate > 0 && loRate * KIT_RATIO <= hiRate,
    detail: `L9 ${hi.counts.shortHop} (${hiRate.toFixed(2)}/1k frames)` +
      ` vs L1-2 ${lo.counts.shortHop} (${loRate.toFixed(2)}/1k frames)`,
  };
}

/** A smash released on frame one is half a smash; a top CPU holds it when it has the time. */
function testChargedSmashes(): TestResult {
  if (matrix.length === 0) return { name: 's. smashes are charged', pass: false, detail: 'matrix missing' };
  const hi = kitForLevels(9, 9);
  const c = hi.counts;
  const share = c.smashUses === 0 ? 0 : c.chargedSmashes / c.smashUses;
  return {
    name: `s. level 9 charges at least ${(CHARGE_SHARE * 100).toFixed(0)}% of its smashes past ${CHARGE_MIN} frames`,
    pass: c.chargedSmashes >= CHARGE_FLOOR && share >= CHARGE_SHARE,
    detail: `${c.chargedSmashes}/${c.smashUses} smashes charged (${(share * 100).toFixed(1)}%),` +
      ` floor ${CHARGE_FLOOR} and ${(CHARGE_SHARE * 100).toFixed(0)}%`,
  };
}

/**
 * Kit variety as a difficulty signal. Compared both as a raw distinct-move count and as distinct
 * moves per 1000 frames, because a level 9 match is shorter and the rate alone would flatter it.
 */
function testKitScaling(): TestResult {
  if (matrix.length === 0) return { name: 't. kit variety scales with level', pass: false, detail: 'matrix missing' };
  const hi = kitForLevels(9, 9);
  const lo = kitForLevels(1, 2);
  const hiVar = kitVariety(hi.counts);
  const loVar = kitVariety(lo.counts);
  const hiRate = per1k(hiVar, hi.frames);
  const loRate = per1k(loVar, lo.frames);
  const pass = hiRate > 0 && hiVar > loVar && loRate * VARIETY_RATIO <= hiRate;
  return {
    name: `t. level 9 kit variety beats level 1-2, raw and at ${VARIETY_RATIO}x per 1k frames`,
    pass,
    detail: `L9 ${hiVar}/${KIT_MOVES.length} distinct (${hiRate.toFixed(3)}/1k frames over ${hi.frames}f)` +
      ` vs L1-2 ${loVar}/${KIT_MOVES.length} distinct (${loRate.toFixed(3)}/1k frames over ${lo.frames}f)`,
  };
}

// ---------------------------------------------------------------------------
// Guardrails: determinism, and the frame cap on the scripted scenarios.
// ---------------------------------------------------------------------------

function digestRun(r: CpuMatchRun): string {
  const s = r.state;
  let out = `f${r.frames}|w${s.winner}|rng${s.rng.s}|ko${r.koCount}|sd${r.selfDestructs}`;
  for (let i = 0; i < s.fighters.length; i++) {
    const f = s.fighters[i];
    out += `|${f.slot}:${f.x.toFixed(6)},${f.y.toFixed(6)},${f.percent.toFixed(6)},${f.stocks},` +
      `${f.action},${f.moveId},${f.shieldHp.toFixed(6)}`;
  }
  for (let i = 0; i < r.options.length; i++) out += `|o${i}:${optionsLine(r.options[i])}`;
  for (let i = 0; i < r.kit.length; i++) {
    out += `|k${i}:${kitTable(r.kit[i], 1)}:${movementLine(r.kit[i], 1)}:${r.kit[i].tauntNeutral}`;
  }
  return out;
}

function digestSpam(r: SpamRun): string {
  return `${r.frames}|${r.finished}|${r.winnerIsCpu}|${r.cpuStocks}|${r.spamStocks}|` +
    `${r.volleys}|${r.minShield.toFixed(6)}|${r.worstLowRun}|${r.broke}`;
}

/**
 * The same seed and the same levels must produce byte-identical results. Both runs are taken
 * back to back, which also catches per-slot AI scratch state leaking from one match into the next.
 */
function testDeterminism(): TestResult {
  const a1 = runCpuMatch(9, 5, MATCH_CAP, 41, MATRIX_STOCKS);
  const a2 = runCpuMatch(9, 5, MATCH_CAP, 41, MATRIX_STOCKS);
  const b1 = runCpuMatch(7, 3, MATCH_CAP, 17, MATRIX_STOCKS);
  const b2 = runCpuMatch(7, 3, MATCH_CAP, 17, MATRIX_STOCKS);
  const s1 = runSpamMatch(0, 97);
  const s2 = runSpamMatch(0, 97);
  const fails: string[] = [];
  if (digestRun(a1) !== digestRun(a2)) fails.push('L9vL5 seed 41 diverged');
  if (digestRun(b1) !== digestRun(b2)) fails.push('L7vL3 seed 17 diverged');
  if (digestSpam(s1) !== digestSpam(s2)) fails.push('spam seed 97 diverged');
  return {
    name: 'n. identical seeds and levels replay byte-identically',
    pass: fails.length === 0,
    detail: fails.length === 0
      ? `3 replayed pairs identical (${a1.frames}f, ${b1.frames}f, ${s1.frames}f)`
      : fails.join('; '),
  };
}

// ---------------------------------------------------------------------------
// Input rules wave: a second tap of the same direction is a roll (Down again is a
// spot dodge), grabs beat shields, and a grabbed fighter mashes out.
// ---------------------------------------------------------------------------

/** Seeds for the double-tap check. */
const TAP_SEEDS = [5, 17];
/** Unasked-for rolls a slot may still show over a whole match, for landing-frame edge cases. */
const TAP_SLACK = 2;

/** Every roll the sim starts has to be one the CPU asked for, give or take TAP_SLACK. */
function testNoAccidentalRoll(): TestResult {
  const fails: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < TAP_SEEDS.length; i++) {
    const run = runCpuMatch(5, 5, MATCH_CAP, TAP_SEEDS[i], MATRIX_STOCKS);
    for (let s = 0; s < 2; s++) {
      const rolls = run.options[s].roll;
      const meant = run.intendedRolls[s];
      parts.push(`seed ${TAP_SEEDS[i]} slot ${s} rolls=${rolls} intended=${meant}`);
      if (rolls > meant + TAP_SLACK) fails.push(`seed ${TAP_SEEDS[i]} slot ${s} ${rolls} > ${meant}+${TAP_SLACK}`);
    }
  }
  return {
    name: `u. level 5 CPUs never double tap into a roll they did not ask for (slack ${TAP_SLACK})`,
    pass: fails.length === 0,
    detail: parts.join(', ') + (fails.length === 0 ? '' : ` | over: ${fails.join('; ')}`),
  };
}

const GRAB_SEEDS = [5, 17, 23];
/** Frames a level 9 CPU gets to grab a dummy that sits in shield next to it. */
const GRAB_CAP = 600;

/**
 * A dummy that holds shield in place 40 px from a level 9 CPU. It never lets go and its shield
 * is topped up every frame, so no hit can ever get through: the grab is the only answer.
 */
function runGrabScenario(seed: number): { frame: number; label: string } {
  const state = createGameState(cpuConfig(9, 0, seed, 3));
  const rand = () => nextFloat(state.rng);
  const idle: InputFrame = { held: 0, pressed: 0, released: 0 };
  const inputs: InputFrame[] = [idle, idle];
  for (let i = 0; i < 30; i++) stepGame(state, inputs);
  const cpu = state.fighters[0];
  const dummy = state.fighters[1];
  cpu.x = -20; cpu.vx = 0; cpu.facing = 1;
  dummy.x = 20; dummy.vx = 0; dummy.facing = -1;
  let prevHeld = 0;
  for (let i = 0; i < GRAB_CAP; i++) {
    if (dummy.action !== 'grabbed') {
      dummy.shieldHp = SHIELD_MAX;
      dummy.x = 20;
      dummy.vx = 0;
    }
    const held = Btn.Shield;
    inputs[0] = cpuInput(state, 0, 9, rand);
    inputs[1] = { held, pressed: held & ~prevHeld, released: prevHeld & ~held };
    prevHeld = held;
    stepGame(state, inputs);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'grab' && ev.attacker === 0) return { frame: i + 1, label: `seed ${seed}` };
    }
  }
  return { frame: -1, label: `seed ${seed}` };
}

function testCpuGrabs(): TestResult {
  const parts: string[] = [];
  let ok = true;
  for (let i = 0; i < GRAB_SEEDS.length; i++) {
    const r = runGrabScenario(GRAB_SEEDS[i]);
    if (r.frame < 0) ok = false;
    parts.push(`${r.label} ${r.frame < 0 ? 'no grab' : `grab at ${r.frame}f`}`);
  }
  return {
    name: `v. level 9 CPU grabs a dummy parked in shield within ${GRAB_CAP} frames on every seed`,
    pass: ok,
    detail: parts.join(', '),
  };
}

const MASH_SEEDS = [5, 17, 23];
const MASH_CAP = 600;

/** Frames a CPU of `level` takes to mash out of a plain grab from a holder that never throws. */
function mashOutFrames(level: number, seed: number): number {
  const state = createGameState(cpuConfig(level, 0, seed, 3));
  const rand = () => nextFloat(state.rng);
  const idle: InputFrame = { held: 0, pressed: 0, released: 0 };
  const inputs: InputFrame[] = [idle, idle];
  for (let i = 0; i < 30; i++) stepGame(state, inputs);
  const fighters = simFighters(state);
  const victim = fighters[0];
  const holder = fighters[1];
  holder.x = 0; holder.vx = 0; holder.facing = -1; setAction(holder, 'idle');
  victim.x = -14; victim.vx = 0; victim.facing = 1; setAction(victim, 'idle');
  if (!forceGrab(state, holder, victim)) return -1;
  for (let i = 0; i < MASH_CAP; i++) {
    inputs[0] = cpuInput(state, 0, level, rand);
    inputs[1] = idle;
    stepGame(state, inputs);
    if (victim.action !== 'grabbed') return i + 1;
  }
  return MASH_CAP;
}

function testMashOut(): TestResult {
  const parts: string[] = [];
  let ok = true;
  for (let i = 0; i < MASH_SEEDS.length; i++) {
    const hi = mashOutFrames(9, MASH_SEEDS[i]);
    const lo = mashOutFrames(1, MASH_SEEDS[i]);
    if (hi < 0 || lo < 0 || hi >= lo) ok = false;
    parts.push(`seed ${MASH_SEEDS[i]} L9 ${hi}f vs L1 ${lo}f`);
  }
  return {
    name: 'w. a level 9 CPU mashes out of a grab faster than a level 1 CPU',
    pass: ok,
    detail: parts.join(', '),
  };
}

// ---------------------------------------------------------------------------
// Projectile block wave: the CPU answers an inbound shot with a quicker shot of
// its own so the two clash in the air. Both fighters are pinned to a fixed gap,
// so the spam can only be blocked, dodged or shot down, and the harness can
// count exactly how often it was shot down.
// ---------------------------------------------------------------------------

const BLOCK_SEEDS = [5, 17, 23];
/**
 * Gap between the pinned fighters on each seed, spanning 100-160 px. It starts at SPAM_RANGE
 * because the scripted spammer only throws from outside that range.
 */
const BLOCK_GAPS = [SPAM_RANGE, 135, 160];
const BLOCK_FRAMES = 1800;
/** Enough stocks that a KO never ends a scenario early. */
const BLOCK_STOCKS = 9;
/** Share of the spammer's thrown shots a level 9 CPU has to shoot down. */
const BLOCK_SHARE = 0.25;
/** Clash events a level 1 CPU may still produce by accident across every seed. */
const BLOCK_LOW_CAP = 2;

/** Projectile defs that only ever spawn as another shot's burst, never thrown by a move. */
const BURST_IDS: Record<string, boolean> = (() => {
  const out: Record<string, boolean> = {};
  const chars = Object.keys(CHARACTER_DEFS).sort();
  for (let c = 0; c < chars.length; c++) {
    const moves = CHARACTER_DEFS[chars[c]].moves;
    const ids = Object.keys(moves);
    for (let i = 0; i < ids.length; i++) {
      const list = moves[ids[i] as MoveId].projectiles;
      if (list === undefined) continue;
      for (let p = 0; p < list.length; p++) if (list[p].spawnFrame < 0) out[list[p].id] = true;
    }
  }
  return out;
})();

interface BlockRun {
  spawned: number;   // shots the spammer threw, bursts excluded
  clashes: number;   // projectileClash events with the CPU as one owner
  blocked: number;   // distinct thrown spammer shots that died in a frame with such a clash
  damage: number;    // percent the CPU took from the spammer, whose only hitboxes are its shots
}

/**
 * One pinned spam scenario. A shot counts as blocked when it was alive before a frame and gone
 * after it, on a frame with a clash involving the CPU; the count per frame is capped by the
 * clashes, so a shot that simply expired or hit on a quiet frame never counts. The burst an orb
 * leaves behind clashes a second time, which is why events and blocked shots are kept apart.
 */
function runBlockScenario(level: number, index: number): BlockRun {
  const cpuSlot = index % 2;
  const spamSlot = 1 - cpuSlot;
  const state = createGameState(cpuConfig(cpuSlot === 0 ? level : 0, cpuSlot === 0 ? 0 : level, BLOCK_SEEDS[index], BLOCK_STOCKS));
  const rand = () => nextFloat(state.rng);
  const idle: InputFrame = { held: 0, pressed: 0, released: 0 };
  const inputs: InputFrame[] = [idle, idle];
  for (let i = 0; i < 30; i++) stepGame(state, inputs);
  const cpu = state.fighters[cpuSlot];
  const spam = state.fighters[spamSlot];
  const cpuX = (cpuSlot === 0 ? -1 : 1) * BLOCK_GAPS[index] / 2;
  const mem: SpamMem = { aim: 0, timer: 0, volley: 0, prevHeld: 0 };
  const spamFrame: InputFrame = { held: 0, pressed: 0, released: 0 };
  const watched: number[] = [];
  const out: BlockRun = { spawned: 0, clashes: 0, blocked: 0, damage: 0 };
  for (let i = 0; i < BLOCK_FRAMES; i++) {
    // Pinned horizontally only: the CPU can still shield, dodge, jump and shoot, never close the gap.
    if (cpu.action !== 'dead' && cpu.action !== 'respawn') { cpu.x = cpuX; cpu.vx = 0; }
    if (spam.action !== 'dead' && spam.action !== 'respawn') { spam.x = -cpuX; spam.vx = 0; }
    watched.length = 0;
    for (let p = 0; p < state.projectiles.length; p++) {
      const pr = state.projectiles[p];
      if (pr.alive && pr.owner === spamSlot && BURST_IDS[pr.defId] !== true) watched.push(pr.id);
    }

    inputs[cpuSlot] = cpuInput(state, cpuSlot, level, rand);
    inputs[spamSlot] = spammerInput(state, spamSlot, mem, spamFrame);
    stepGame(state, inputs);

    let clashes = 0;
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'projectileSpawn' && ev.slot === spamSlot && BURST_IDS[ev.defId] !== true) out.spawned++;
      else if (ev.type === 'projectileClash' && (ev.ownerA === cpuSlot || ev.ownerB === cpuSlot)) clashes++;
      else if (ev.type === 'hit' && ev.attacker === spamSlot && ev.victim === cpuSlot) out.damage += ev.damage;
    }
    if (clashes === 0) continue;
    out.clashes += clashes;
    let gone = 0;
    for (let w = 0; w < watched.length; w++) {
      let alive = false;
      for (let p = 0; p < state.projectiles.length; p++) {
        const pr = state.projectiles[p];
        if (pr.alive && pr.id === watched[w]) { alive = true; break; }
      }
      if (!alive) gone++;
    }
    out.blocked += Math.min(gone, clashes);
  }
  return out;
}

function sumBlockRuns(level: number): BlockRun {
  const total: BlockRun = { spawned: 0, clashes: 0, blocked: 0, damage: 0 };
  for (let i = 0; i < BLOCK_SEEDS.length; i++) {
    const r = runBlockScenario(level, i);
    total.spawned += r.spawned;
    total.clashes += r.clashes;
    total.blocked += r.blocked;
    total.damage += r.damage;
  }
  return total;
}

function testProjectileBlock(): TestResult {
  const hi = sumBlockRuns(9);
  const lo = sumBlockRuns(1);
  let off: BlockRun;
  setCpuProjBlockOverrideForTest(0);
  try {
    off = sumBlockRuns(9);
  } finally {
    setCpuProjBlockOverrideForTest(null);
  }
  const share = hi.spawned === 0 ? 0 : hi.blocked / hi.spawned;
  const fails: string[] = [];
  if (hi.spawned === 0 || share < BLOCK_SHARE) fails.push(`L9 shot down ${(share * 100).toFixed(0)}% < ${(BLOCK_SHARE * 100).toFixed(0)}%`);
  // Under the strength-tier clash rule a clash no longer means a shot came down: a jab bead (tier 1)
  // meeting an orb (tier 2 and up) dies alone. "Almost never shoots down" is counted on shots down.
  if (lo.blocked > BLOCK_LOW_CAP) fails.push(`L1 shot down ${lo.blocked} > ${BLOCK_LOW_CAP}`);
  if (hi.damage >= off.damage) fails.push(`L9 damage ${hi.damage.toFixed(1)} not under ${off.damage.toFixed(1)} with the counter off`);
  return {
    name: `x. level 9 CPU shoots down at least ${(BLOCK_SHARE * 100).toFixed(0)}% of pinned spam, level 1 almost never`,
    pass: fails.length === 0,
    detail: `L9 shot down ${hi.blocked}/${hi.spawned} (${(share * 100).toFixed(1)}%, ${hi.clashes} clash events),` +
      ` damage taken ${hi.damage.toFixed(1)} vs ${off.damage.toFixed(1)} with projBlock 0` +
      ` (${off.clashes} clash events) | L1 shot down ${lo.blocked}, ${lo.clashes} clash events over ${lo.spawned} shots` +
      (fails.length === 0 ? '' : ` | ${fails.join('; ')}`),
  };
}

// ---------------------------------------------------------------------------
// Wave 2: techs and the Final Smash. The tech scenario launches the CPU straight
// into the floor with tumble knockback, so every trial ends in exactly one tumble
// landing while hitstun still runs: a tech, or a knockdown.
// ---------------------------------------------------------------------------

const TECH_SEEDS = [5, 17, 23];
/** Tumble landings per seed. */
const TECH_TRIALS = 12;
/** Launch spots across the whole main stage, edges included, so the edge rule for the roll runs. */
const TECH_XS = [-150, -100, -50, 0, 50, 100, 150, -130, -25, 25, 130, 75];
/** Height above the stage each trial is launched from, px. */
const TECH_HEIGHTS = [30, 60, 90, 120];
/** Local launch angles, all into the floor: straight down and either side of it. */
const TECH_ANGLES = [290, 270, 250, 300];
/** Frames a trial is given to land and resolve before it counts as neither. */
const TECH_RESOLVE_CAP = 120;
const TECH_HI_RATE = 0.6;
const TECH_LO_RATE = 0.25;
/** Share of trials that must resolve at all, so a broken scenario cannot pass on a tiny sample. */
const TECH_RESOLVE_SHARE = 0.8;

interface TechRun { techs: number; rolls: number; downed: number; trials: number }

/**
 * One seed of tumble landings for a CPU of `level`. The opponent is an idle dummy parked on the
 * far side of the stage. Each trial resets the CPU into the air, clears its tech timers, and
 * applies a real tumble hit pointing into the floor; the trial ends on a 'tech' event or on
 * entering 'downed'.
 */
function runTechScenario(level: number, seed: number): TechRun {
  const state = createGameState(cpuConfig(level, 0, seed, 3));
  const rand = () => nextFloat(state.rng);
  const idle: InputFrame = { held: 0, pressed: 0, released: 0 };
  const inputs: InputFrame[] = [idle, idle];
  for (let i = 0; i < 30; i++) stepGame(state, inputs);
  const fighters = simFighters(state);
  const cpu = fighters[0];
  const dummy = fighters[1];
  const out: TechRun = { techs: 0, rolls: 0, downed: 0, trials: TECH_TRIALS };
  for (let t = 0; t < TECH_TRIALS; t++) {
    const x = TECH_XS[t % TECH_XS.length];
    dummy.x = x < 0 ? 165 : -165;
    dummy.vx = 0;
    setAction(cpu, 'air');
    cpu.x = x;
    cpu.y = -TECH_HEIGHTS[t % TECH_HEIGHTS.length];
    cpu.prevY = cpu.y;
    cpu.vx = 0; cpu.vy = 0; cpu.onGround = false; cpu.fastFalling = false; cpu.jumpsLeft = 2;
    cpu.hitstun = 0; cpu.hitlag = 0; cpu.invuln = 0; cpu.percent = 70; cpu.ledge = -1;
    cpu.techWindow = 0; cpu.techLockout = 0;
    clearBuffer(cpu);
    const facing = t % 2 === 0 ? 1 : -1;
    applyHit(state, cpu, 1, facing, 10, TECH_ANGLES[t % TECH_ANGLES.length], 80, 50, 1, 0, cpu.x, cpu.y - 20);
    let resolved = false;
    for (let i = 0; i < TECH_RESOLVE_CAP && !resolved; i++) {
      inputs[0] = cpuInput(state, 0, level, rand);
      inputs[1] = idle;
      stepGame(state, inputs);
      for (let e = 0; e < state.events.length; e++) {
        const ev = state.events[e];
        if (ev.type === 'tech' && ev.slot === 0) {
          out.techs++;
          if (ev.roll) out.rolls++;
          resolved = true;
        }
      }
      if (!resolved && cpu.action === 'downed') { out.downed++; resolved = true; }
    }
  }
  return out;
}

function sumTechRuns(level: number): TechRun {
  const total: TechRun = { techs: 0, rolls: 0, downed: 0, trials: 0 };
  for (let i = 0; i < TECH_SEEDS.length; i++) {
    const r = runTechScenario(level, TECH_SEEDS[i]);
    total.techs += r.techs;
    total.rolls += r.rolls;
    total.downed += r.downed;
    total.trials += r.trials;
  }
  return total;
}

function techLine(label: string, r: TechRun): string {
  const landings = r.techs + r.downed;
  const rate = landings === 0 ? 0 : r.techs / landings;
  return `${label} teched ${r.techs}/${landings} (${(rate * 100).toFixed(0)}%, ${r.rolls} rolls, ${r.downed} downed, ${r.trials} trials)`;
}

function testCpuTechs(): TestResult {
  const hi = sumTechRuns(9);
  const lo = sumTechRuns(1);
  const fails: string[] = [];
  const check = (label: string, r: TechRun, ok: (rate: number) => boolean): void => {
    const landings = r.techs + r.downed;
    if (landings < r.trials * TECH_RESOLVE_SHARE) fails.push(`${label} only ${landings}/${r.trials} landings resolved`);
    else if (!ok(r.techs / landings)) fails.push(`${label} rate out of bounds`);
  };
  check('L9', hi, (rate) => rate >= TECH_HI_RATE);
  check('L1', lo, (rate) => rate <= TECH_LO_RATE);
  return {
    name: `y. level 9 techs at least ${(TECH_HI_RATE * 100).toFixed(0)}% of tumble landings, level 1 at most ${(TECH_LO_RATE * 100).toFixed(0)}%`,
    pass: fails.length === 0,
    detail: `${techLine('L9', hi)} | ${techLine('L1', lo)}` + (fails.length === 0 ? '' : ` | ${fails.join('; ')}`),
  };
}

const FS_SEEDS = [5, 17, 23];
/** Frames a level 9 CPU with a full meter gets to start its Final Smash. */
const FS_START_CAP = 120;
/** Frames a started Final Smash is followed for, past its own 152-frame launch. */
const FS_FOLLOW = 200;
/** Frames a CPU with a forced full meter is watched for when the rule is off. */
const FS_OFF_FRAMES = 600;

interface FsRun { start: number; caught: boolean; launched: boolean; starts: number }

/**
 * A CPU of `level` 60 px left of an idle dummy, facing it, with its meter forced full every frame
 * until a Final Smash starts. `rule` is written into the config as given (undefined leaves the
 * field out). Records the first frame the CPU entered 'finalSmash', whether the dummy was caught,
 * and whether the launch reached the dummy.
 */
function runFsScenario(level: number, seed: number, rule: boolean | undefined, frames: number): FsRun {
  const cfg = cpuConfig(level, 0, seed, 3);
  if (rule !== undefined) cfg.finalSmash = rule;
  const state = createGameState(cfg);
  const rand = () => nextFloat(state.rng);
  const idle: InputFrame = { held: 0, pressed: 0, released: 0 };
  const inputs: InputFrame[] = [idle, idle];
  for (let i = 0; i < 30; i++) stepGame(state, inputs);
  const fighters = simFighters(state);
  const cpu = fighters[0];
  const dummy = fighters[1];
  cpu.x = -30; cpu.vx = 0; cpu.facing = 1;
  dummy.x = 30; dummy.vx = 0; dummy.facing = -1; dummy.invuln = 0;
  const out: FsRun = { start: -1, caught: false, launched: false, starts: 0 };
  for (let i = 0; i < frames; i++) {
    if (out.start < 0) cpu.fsMeter = FS_METER.max;
    inputs[0] = cpuInput(state, 0, level, rand);
    inputs[1] = idle;
    stepGame(state, inputs);
    if (cpu.action === 'finalSmash' && out.start < 0) out.start = i + 1;
    if (dummy.action === 'finalSmashVictim') out.caught = true;
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type !== 'finalSmash' || ev.attacker !== 0) continue;
      if (ev.phase === 'start') out.starts++;
      else if (ev.phase === 'launch' && ev.victim === 1) out.launched = true;
    }
    if (out.start >= 0 && i + 1 - out.start >= FS_FOLLOW) break;
  }
  return out;
}

function testCpuFinalSmash(): TestResult {
  const parts: string[] = [];
  let ok = true;
  for (let i = 0; i < FS_SEEDS.length; i++) {
    const on = runFsScenario(9, FS_SEEDS[i], true, FS_START_CAP + FS_FOLLOW);
    const off = runFsScenario(9, FS_SEEDS[i], undefined, FS_OFF_FRAMES);
    const started = on.start > 0 && on.start <= FS_START_CAP;
    if (!started || !on.caught || !on.launched) ok = false;
    if (off.start >= 0 || off.starts > 0) ok = false;
    parts.push(`seed ${FS_SEEDS[i]} rule on: start ${on.start < 0 ? 'never' : `${on.start}f`} caught=${on.caught}` +
      ` launched=${on.launched} | rule off: starts ${off.starts}`);
  }
  return {
    name: `z. with the rule on a level 9 CPU starts its Final Smash within ${FS_START_CAP} frames and it connects; off, never`,
    pass: ok,
    detail: parts.join('; '),
  };
}

/**
 * The rule off, two ways: the whole matrix (finalSmash left out of the config) never starts one
 * and never fills a meter, and a forced full meter under an explicit `false` never starts one at
 * the low, middle or top profile either.
 */
function testNoFsWhenRuleOff(): TestResult {
  if (matrix.length === 0) return { name: 'aa. no Final Smash with the rule off', pass: false, detail: 'matrix missing' };
  let starts = 0;
  let meter = 0;
  for (let i = 0; i < matrix.length; i++) {
    const runs = matrix[i].runs;
    for (let r = 0; r < runs.length; r++) {
      starts += runs[r].fsStarts;
      if (runs[r].maxMeter > meter) meter = runs[r].maxMeter;
    }
  }
  const levels = [1, 5, 9];
  const forced: string[] = [];
  let forcedStarts = 0;
  for (let i = 0; i < levels.length; i++) {
    const r = runFsScenario(levels[i], 41, false, FS_OFF_FRAMES);
    const n = r.start >= 0 ? Math.max(1, r.starts) : r.starts;
    forcedStarts += n;
    forced.push(`L${levels[i]} ${n}`);
  }
  return {
    name: 'aa. with the rule off no CPU ever starts a Final Smash, even with a forced full meter',
    pass: starts === 0 && meter === 0 && forcedStarts === 0,
    detail: `matrix starts ${starts}, highest meter ${meter} | forced full meter, rule false: ${forced.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Level 0: a dummy, not a difficulty. Never fights; stands still unless the
// cpuZeroMoves rule turns it into a wanderer.
// ---------------------------------------------------------------------------

const ZERO_SEEDS = [1, 2, 3];
/** Frames a level 0 is watched for under the rule. */
const ZERO_FRAMES = 3600;
/** Frames a level 0 is watched for with the rule off, standing still. */
const ZERO_STILL_FRAMES = 600;
/** Frames the spawn drop is given before a standing level 0 is held to standing still. */
const ZERO_SETTLE = 60;
/** Distance a wandering level 0 has to cover for the rule to count as having done anything. */
const ZERO_TRAVEL = 40;
/** Stocks for the level 0 vs level 9 sweep: enough that the match cannot end inside the cap. */
const ZERO_DEEP_STOCKS = 99;
const ZERO_STOCKS = 3;
/**
 * Every button a level 0 must never press, rule on or off. Down is in here too: it fast falls,
 * drops through platforms and spot dodges, none of which a dummy is allowed to do.
 */
const ZERO_FORBIDDEN = Btn.Attack | Btn.Special | Btn.Grab | Btn.Shield | Btn.Dodge | Btn.Taunt |
  Btn.CUp | Btn.CDown | Btn.CLeft | Btn.CRight | Btn.Down;

interface ZeroRun {
  frames: number;       // frames slot 0's input was read on
  badBits: number;      // every forbidden bit ever seen in held|pressed on slot 0
  directs: number;      // frames slot 0 asked for a direct move or command
  startX: number;       // slot 0's x once the spawn had settled
  maxDist: number;      // furthest slot 0 got from there
  movedFrames: number;  // frames its x differed from the settled x at all
  airFrames: number;    // frames it was off the ground after the settle window
  jumps: number;        // 'jump' events it produced
  nonIdle: string;      // first action other than 'idle' after the settle window, '' if none
  stocks: number[];
  longestDowned: number; // longest run of consecutive frames slot 0's action was 'downed', -1 if never downed
}

/** Drives a level 0 in slot 0 against `levelB` in slot 1, watching everything slot 0 does. */
function runZeroMatch(
  levelB: number, seed: number, frames: number, zeroMoves: boolean | undefined, stocks: number,
): ZeroRun {
  const state = createGameState(cpuConfig(0, levelB, seed, stocks, zeroMoves));
  const rand = () => nextFloat(state.rng);
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0 },
    { held: 0, pressed: 0, released: 0 },
  ];
  const out: ZeroRun = {
    frames: 0, badBits: 0, directs: 0, startX: 0, maxDist: 0, movedFrames: 0,
    airFrames: 0, jumps: 0, nonIdle: '', stocks: [0, 0], longestDowned: -1,
  };
  let downedStreak = 0;
  for (let i = 0; i < frames; i++) {
    const zero = cpuInput(state, 0, 0, rand);
    out.badBits |= (zero.held | zero.pressed) & ZERO_FORBIDDEN;
    if (zero.direct !== undefined && zero.direct !== 0) out.directs++;
    out.frames++;
    inputs[0] = zero;
    inputs[1] = cpuInput(state, 1, levelB, rand);
    stepGame(state, inputs);

    const f = state.fighters[0];
    if (f.action === 'downed') {
      downedStreak++;
      if (downedStreak > out.longestDowned) out.longestDowned = downedStreak;
    } else {
      downedStreak = 0;
    }
    if (i === ZERO_SETTLE) out.startX = f.x;
    if (i >= ZERO_SETTLE) {
      const d = Math.abs(f.x - out.startX);
      if (d > out.maxDist) out.maxDist = d;
      if (d > 0) out.movedFrames++;
      if (!f.onGround) out.airFrames++;
      if (f.action !== 'idle' && out.nonIdle === '') out.nonIdle = f.action;
    }
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'jump' && ev.slot === 0) out.jumps++;
    }
    if (state.finished) break;
  }
  out.stocks = [state.fighters[0].stocks, state.fighters[1].stocks];
  return out;
}

/** A level 0 is a punching bag: it never presses a button that could hurt anyone, including itself. */
function testZeroNeverFights(): TestResult {
  const fails: string[] = [];
  let checked = 0;
  for (let i = 0; i < ZERO_SEEDS.length; i++) {
    const r = runZeroMatch(9, ZERO_SEEDS[i], ZERO_FRAMES, true, ZERO_DEEP_STOCKS);
    checked += r.frames;
    if (r.badBits !== 0) fails.push(`seed ${ZERO_SEEDS[i]} pressed 0x${r.badBits.toString(16)}`);
    if (r.directs !== 0) fails.push(`seed ${ZERO_SEEDS[i]} sent ${r.directs} direct codes`);
  }
  return {
    name: 'ab. a level 0 CPU never attacks, shields or dodges, even next to a level 9',
    pass: fails.length === 0,
    detail: fails.length === 0
      ? `${checked} frames checked over ${ZERO_SEEDS.length} seeds, no forbidden button, no direct code`
      : fails.join('; '),
  };
}

/** The rule off is a statue; the rule on is a wanderer that covers ground and stays alive. */
function testZeroWanders(): TestResult {
  const fails: string[] = [];
  const still = runZeroMatch(0, 7, ZERO_STILL_FRAMES, false, ZERO_STOCKS);
  if (still.movedFrames !== 0) {
    fails.push(`rule off: moved on ${still.movedFrames}f, up to ${still.maxDist.toFixed(2)}px`);
  }
  if (still.nonIdle !== '') fails.push(`rule off: action went to '${still.nonIdle}'`);

  const parts: string[] = [`rule off: x fixed at ${still.startX.toFixed(2)}, action idle throughout`];
  for (let i = 0; i < ZERO_SEEDS.length; i++) {
    const r = runZeroMatch(0, ZERO_SEEDS[i], ZERO_FRAMES, true, ZERO_STOCKS);
    parts.push(`seed ${ZERO_SEEDS[i]} travelled ${r.maxDist.toFixed(1)}px jumps ${r.jumps}` +
      ` air ${r.airFrames}f stocks ${r.stocks[0]}-${r.stocks[1]}`);
    if (r.maxDist < ZERO_TRAVEL) fails.push(`seed ${ZERO_SEEDS[i]} only travelled ${r.maxDist.toFixed(1)}px`);
    if (r.jumps === 0 && r.airFrames === 0) fails.push(`seed ${ZERO_SEEDS[i]} never left the ground`);
    if (r.stocks[0] !== ZERO_STOCKS || r.stocks[1] !== ZERO_STOCKS) {
      fails.push(`seed ${ZERO_SEEDS[i]} lost a stock: ${r.stocks[0]}-${r.stocks[1]}`);
    }
  }
  return {
    name: `ac. a level 0 stands still by default and wanders at least ${ZERO_TRAVEL}px under the rule, never self-destructing`,
    pass: fails.length === 0,
    detail: parts.join(' | ') + (fails.length === 0 ? '' : ` || ${fails.join('; ')}`),
  };
}

/** Seeds test ad replays: the first two of ZERO_SEEDS, against a level 9 that actually lands hits. */
const DOWNED_SEEDS = [ZERO_SEEDS[0], ZERO_SEEDS[1]];
/** Longest a wandering level 0 may lie downed before its own get-up press takes over. */
const DOWNED_STREAK_CAP = 40;

/**
 * A level 0 that tumbles into a landing without teching used to lie downed for the full
 * KNOCKDOWN.maxFrames (120), because dummyInput never pressed anything while downed. With the
 * wander rule on it now presses Jump at most once every WANDER_JUMP_CD frames while downed, so any
 * downed streak should end well inside that: the get-up itself then takes a few more frames.
 */
function testZeroGetsUp(): TestResult {
  const fails: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < DOWNED_SEEDS.length; i++) {
    const seed = DOWNED_SEEDS[i];
    const r = runZeroMatch(9, seed, ZERO_FRAMES, true, ZERO_DEEP_STOCKS);
    if (r.badBits !== 0) fails.push(`seed ${seed} pressed 0x${r.badBits.toString(16)}`);
    if (r.longestDowned < 0) {
      parts.push(`seed ${seed}: never knocked down in ${ZERO_FRAMES}f`);
    } else {
      parts.push(`seed ${seed}: longest downed streak ${r.longestDowned}f`);
      if (r.longestDowned > DOWNED_STREAK_CAP) {
        fails.push(`seed ${seed} stayed downed ${r.longestDowned}f (cap ${DOWNED_STREAK_CAP})`);
      }
    }
  }
  return {
    name: `ad. a wandering level 0 stands back up after a knockdown`,
    pass: fails.length === 0,
    detail: parts.join(', ') + (fails.length === 0 ? '' : ` || ${fails.join('; ')}`),
  };
}

// ---------------------------------------------------------------------------
// Level 10: Aevalmere, the search-based brain (src/ai/aevalmere.ts). Played against the
// legacy ladder on the same seeds and sides as the matrix, and measured for true combos (hits
// landed while the victim is still in hitstun or hitlag from the last one), self-destructs,
// determinism, the per-call time budget and the reaction floor.
// ---------------------------------------------------------------------------

/** Lowest share of Lv10-vs-Lv9 matches Lv10 has to take, and the most stocks it may lose per match. */
const L10_WIN_FLOOR = 0.9;
const L10_LOST_CAP = 0.5;
/** 3+ hit true combos Lv10 has to land per match against Lv9, on average. */
const L10_COMBO_FLOOR = 1;
/** Mean milliseconds one level 10 cpuInput call may cost, over a 3000-frame match. */
const L10_MS_CAP = 1.5;
const L10_BUDGET_FRAMES = 3000;
/** Opponent levels in the level 10 sweep, each on every seed and both sides. 10 is the mirror. */
const L10_SWEEP = [9, 5, 1, 10];

interface L10Run {
  state: GameState;
  frames: number;
  l10Slot: number;
  sd: number;            // self-destructs of a level 10 slot
  longestCombo: number;  // longest true combo landed by the level 10 slot
  combos3: number;       // true combos that reached 3 hits
  earlyShields: number;  // fresh Shield presses by a grounded level 10 while an opponent's move was 0 or 1 frames old
  ms: number;            // time spent inside the level 10 cpuInput calls
  calls: number;
  decisions: number;
  alternates: number;
}

/** One match with level 10 on slot 0 when levelA is 10, else on slot 1 (both play level 10 in the mirror). */
function runL10Match(levelA: number, levelB: number, seed: number, stocks: number, maxFrames: number, stageId = 'tidegate'): L10Run {
  const state = createGameState(cpuConfig(levelA, levelB, seed, stocks, undefined, stageId));
  const rand = () => nextFloat(state.rng);
  const levels = [levelA, levelB];
  const l10Slot = levelA >= 10 ? 0 : 1;
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0, direct: 0 },
    { held: 0, pressed: 0, released: 0, direct: 0 },
  ];
  let combo = 0;
  let longest = 0;
  let combos3 = 0;
  let early = 0;
  let ms = 0;
  let calls = 0;
  let sd = 0;
  let frame = 0;
  for (; frame < maxFrames; frame++) {
    for (let s = 0; s < 2; s++) {
      const t0 = performance.now();
      const out = cpuInput(state, s, levels[s], rand);
      if (levels[s] >= 10) { ms += performance.now() - t0; calls++; }
      inputs[s].held = out.held;
      inputs[s].pressed = out.pressed;
      inputs[s].released = out.released;
      inputs[s].direct = out.direct;
      if (levels[s] >= 10 && (out.pressed & Btn.Shield) !== 0) {
        const me = state.fighters[s];
        const opp = state.fighters[1 - s];
        if (me.onGround && me.hitstun === 0 && opp.action === 'attack' && opp.actionFrame <= 1 && opp.hitlag === 0) early++;
      }
    }
    const victim = state.fighters[1 - l10Slot];
    const held = victim.hitstun > 0 || victim.hitlag > 0;
    stepGame(state, inputs);
    let hitNow = false;
    for (let i = 0; i < state.events.length; i++) {
      const ev = state.events[i];
      if (ev.type === 'hit' && ev.attacker === l10Slot && ev.victim === 1 - l10Slot && ev.kb > 0) {
        combo = held || hitNow ? combo + 1 : 1;
        hitNow = true;
        if (combo > longest) longest = combo;
        if (combo === 3) combos3++;
      } else if (ev.type === 'ko') {
        const f = state.fighters[ev.slot];
        if (f && f.lastHitBy === -1 && levels[ev.slot] >= 10) sd++;
      }
    }
    if (!hitNow && victim.hitstun === 0 && victim.hitlag === 0) combo = 0;
    if (state.finished) { frame++; break; }
  }
  // The sim's own results record counts a KO without recent KO credit as an SD too; take whichever is higher.
  let sdStats = 0;
  for (let i = 0; i < 2; i++) if (levels[i] >= 10) sdStats += state.fighters[i].stats.sds;
  if (sdStats > sd) sd = sdStats;
  const st = aevalmereStats(l10Slot);
  return {
    state, frames: frame, l10Slot, sd, longestCombo: longest, combos3, earlyShields: early, ms, calls,
    decisions: st.decisions, alternates: st.alternates,
  };
}

interface L10Summary {
  opp: number;
  matches: number;
  wins: number;
  stocksLost: number;
  sd: number;
  longestSum: number;
  combos3: number;
  earlyShields: number;
  decisions: number;
  alternates: number;
  frames: number;
  unfinished: number;
}

const l10Runs: L10Summary[] = [];

/** Level 10 against `opp` on every seed and both sides, run once and cached. */
function l10Summary(opp: number): L10Summary {
  for (let i = 0; i < l10Runs.length; i++) if (l10Runs[i].opp === opp) return l10Runs[i];
  const out: L10Summary = {
    opp, matches: 0, wins: 0, stocksLost: 0, sd: 0, longestSum: 0, combos3: 0, earlyShields: 0,
    decisions: 0, alternates: 0, frames: 0, unfinished: 0,
  };
  for (let i = 0; i < SEEDS.length; i++) {
    for (let side = 0; side < 2; side++) {
      const run = side === 0
        ? runL10Match(10, opp, SEEDS[i], MATRIX_STOCKS, MATCH_CAP)
        : runL10Match(opp, 10, SEEDS[i], MATRIX_STOCKS, MATCH_CAP);
      out.matches++;
      if (run.state.winner === run.l10Slot) out.wins++;
      out.stocksLost += MATRIX_STOCKS - run.state.fighters[run.l10Slot].stocks;
      out.sd += run.sd;
      out.longestSum += run.longestCombo;
      out.combos3 += run.combos3;
      out.earlyShields += run.earlyShields;
      out.decisions += run.decisions;
      out.alternates += run.alternates;
      out.frames += run.frames;
      if (!run.state.finished) out.unfinished++;
    }
  }
  l10Runs.push(out);
  return out;
}

function l10Line(m: L10Summary): string {
  return `  L10 vs L${m.opp}: L10 wins ${m.wins}/${m.matches} (${((m.wins / m.matches) * 100).toFixed(0)}%)` +
    ` stocks lost/match ${(m.stocksLost / m.matches).toFixed(2)} sd ${m.sd}` +
    ` longest combo avg ${(m.longestSum / m.matches).toFixed(2)} 3+ combos/match ${(m.combos3 / m.matches).toFixed(2)}` +
    ` early shields ${m.earlyShields} safe alternates ${(m.decisions > 0 ? (m.alternates / m.decisions) * 100 : 0).toFixed(1)}%` +
    ` avg ${Math.round(m.frames / m.matches)}f unfinished ${m.unfinished}`;
}

function testL10BeatsL9(): TestResult {
  const m = l10Summary(9);
  const rate = m.wins / m.matches;
  const lost = m.stocksLost / m.matches;
  return {
    name: `ae. level 10 beats level 9 in at least ${L10_WIN_FLOOR * 100}% of matches, losing under ${L10_LOST_CAP} stocks per match`,
    pass: rate >= L10_WIN_FLOOR && lost < L10_LOST_CAP,
    detail: `won ${m.wins}/${m.matches} (${(rate * 100).toFixed(0)}%), stocks lost per match ${lost.toFixed(2)}`,
  };
}

function testL10Combos(): TestResult {
  const m = l10Summary(9);
  const per = m.combos3 / m.matches;
  return {
    name: `af. level 10 lands a 3+ hit true combo on level 9 at least ${L10_COMBO_FLOOR}x per match on average`,
    pass: per >= L10_COMBO_FLOOR,
    detail: `${m.combos3} combos of 3+ hits over ${m.matches} matches (${per.toFixed(2)}/match),` +
      ` longest per match avg ${(m.longestSum / m.matches).toFixed(2)}`,
  };
}

function testL10NoSelfDestruct(): TestResult {
  let sd = 0;
  let matches = 0;
  let unfinished = 0;
  const parts: string[] = [];
  for (let i = 0; i < L10_SWEEP.length; i++) {
    const m = l10Summary(L10_SWEEP[i]);
    sd += m.sd;
    matches += m.matches;
    unfinished += m.unfinished;
    parts.push(`vs L${m.opp} sd ${m.sd}`);
  }
  return {
    name: 'ag. level 10 never self-destructs, and every level 10 match finishes, across the sweep',
    pass: sd === 0 && unfinished === 0,
    detail: `${matches} matches: ${parts.join(', ')}, unfinished ${unfinished}`,
  };
}

function testL10Determinism(): TestResult {
  const a = runL10Match(10, 9, 23, MATRIX_STOCKS, MATCH_CAP);
  const b = runL10Match(10, 9, 23, MATRIX_STOCKS, MATCH_CAP);
  const c = runL10Match(10, 10, 41, MATRIX_STOCKS, MATCH_CAP);
  const d = runL10Match(10, 10, 41, MATRIX_STOCKS, MATCH_CAP);
  const same1 = JSON.stringify(a.state) === JSON.stringify(b.state);
  const same2 = JSON.stringify(c.state) === JSON.stringify(d.state);
  return {
    name: 'ah. level 10: the same seed twice gives an identical final state',
    pass: same1 && same2,
    detail: `L10vL9 seed 23 ${same1 ? 'identical' : 'DIVERGED'} (${a.frames}f),` +
      ` L10vL10 seed 41 ${same2 ? 'identical' : 'DIVERGED'} (${c.frames}f)`,
  };
}

let l10MsPerCall = 0;

function testL10Budget(): TestResult {
  // Enough stocks that the match is still running when the window closes.
  const run = runL10Match(10, 9, 17, 9, L10_BUDGET_FRAMES);
  const per = run.calls > 0 ? run.ms / run.calls : 0;
  l10MsPerCall = per;
  return {
    name: `ai. a level 10 cpuInput call costs under ${L10_MS_CAP} ms on average over a ${L10_BUDGET_FRAMES}-frame match`,
    pass: per < L10_MS_CAP,
    detail: `${per.toFixed(3)} ms per call over ${run.calls} calls (${run.frames}f), ${run.decisions} decisions`,
  };
}

function testL10ReactionFloor(): TestResult {
  let early = 0;
  let matches = 0;
  for (let i = 0; i < L10_SWEEP.length; i++) {
    const m = l10Summary(L10_SWEEP[i]);
    early += m.earlyShields;
    matches += m.matches;
  }
  return {
    name: 'aj. level 10 never presses shield with 0 or 1 frames of an opponent startup elapsed',
    pass: early === 0,
    detail: `${early} early shield presses over ${matches} matches`,
  };
}

// ---------------------------------------------------------------------------
// Teams rule: a level 10 and a level 9 on team 0 against a level 9 on team 1. The team-0 CPUs must
// treat each other as allies: they win every match, they never land a hit on each other, and they
// never start an attack when the nearest fighter is their own teammate while every enemy is more
// than TEAM_FAR px away and off the teammate's line (an attack thrown at a friend, since friendly
// fire lands nothing). The line check keeps juggles on an enemy launched high under the raised
// Tidegate ceiling and ranged moves past a friend from counting as swings at the friend.
// ---------------------------------------------------------------------------

const TEAM_SEEDS = [5, 17, 23, 41, 97];
const TEAM_STOCKS = 2;
const TEAM_FAR = 200;

/** Horizontal px either side of a fighter that count as straight above or below it. */
const TEAM_LINE_X = 24;

function teamSide(dx: number): number {
  return Math.abs(dx) <= TEAM_LINE_X ? 0 : Math.sign(dx);
}

interface TeamRun { winnerTeam: number; finished: boolean; frames: number; mateHits: number; mateAttacks: number }

function runTeamMatch(seed: number): TeamRun {
  const cfg: MatchConfig = {
    stageId: 'tidegate',
    players: [
      { slot: 0, charId: 'aeval', cpu: true, cpuLevel: 10, team: 0 },
      { slot: 1, charId: 'aeval', cpu: true, cpuLevel: 9, team: 0 },
      { slot: 2, charId: 'aeval', cpu: true, cpuLevel: 9, team: 1 },
    ],
    stocks: TEAM_STOCKS,
    timeLimitSec: 0,
    seed,
    teams: true,
  };
  const state = createGameState(cfg);
  const rand = () => nextFloat(state.rng);
  const inputs: InputFrame[] = [];
  for (let i = 0; i < 3; i++) inputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  const prevAction: string[] = ['', '', ''];
  const prevMove: (string | null)[] = [null, null, null];
  let mateHits = 0;
  let mateAttacks = 0;
  let frame = 0;
  for (; frame < MATCH_CAP; frame++) {
    for (let s = 0; s < 3; s++) {
      const out = cpuInput(state, s, cfg.players[s].cpuLevel, rand);
      inputs[s].held = out.held; inputs[s].pressed = out.pressed; inputs[s].released = out.released; inputs[s].direct = out.direct;
    }
    stepGame(state, inputs);
    for (let i = 0; i < state.events.length; i++) {
      const ev = state.events[i];
      if (ev.type === 'hit' && ev.attacker !== ev.victim && ev.attacker <= 1 && ev.victim <= 1) mateHits++;
    }
    for (let s = 0; s < 2; s++) {
      const f = state.fighters[s];
      const started = f.action === 'attack' && (prevAction[s] !== 'attack' || f.moveId !== prevMove[s]);
      prevAction[s] = f.action;
      prevMove[s] = f.moveId;
      if (!started) continue;
      const mate = state.fighters[1 - s];
      const foe = state.fighters[2];
      if (mate.stocks <= 0 || mate.action === 'dead') continue;
      const dMate = Math.hypot(mate.x - f.x, mate.y - f.y);
      const foeGone = foe.stocks <= 0 || foe.action === 'dead';
      const dFoe = foeGone ? Infinity : Math.hypot(foe.x - f.x, foe.y - f.y);
      // A swing only counts as thrown at the teammate when the enemy is not in the same line:
      // straight above or below (a juggle on an enemy launched toward the tall Tidegate ceiling)
      // or on the teammate's side (a projectile or dash that passes the friend on its way).
      const foeSide = foeGone ? NaN : teamSide(foe.x - f.x);
      // A shot thrown the way the enemy is (nspecial, sspecial) is aimed at the enemy even when the
      // teammate stands right beside the thrower, where its side would read as "in line" with neither.
      const shot = f.moveId === 'nspecial' || f.moveId === 'sspecial';
      // An up special started off the stage is a recovery, not a swing at anyone.
      if (f.moveId === 'uspecial' && harnessOffstage(state, f)) continue;
      const foeInLine = foeSide === 0 || foeSide === teamSide(mate.x - f.x) || (shot && foeSide === f.facing);
      if (dMate < dFoe && dFoe > TEAM_FAR && !foeInLine) mateAttacks++;
    }
    if (state.finished) { frame++; break; }
  }
  const winnerTeam = state.winner < 0 ? -1 : (cfg.players[state.winner].team ?? state.winner);
  return { winnerTeam, finished: state.finished, frames: frame, mateHits, mateAttacks };
}

function testTeams(): TestResult {
  let wins = 0;
  let mateHits = 0;
  let mateAttacks = 0;
  const parts: string[] = [];
  for (let i = 0; i < TEAM_SEEDS.length; i++) {
    const r = runTeamMatch(TEAM_SEEDS[i]);
    if (r.finished && r.winnerTeam === 0) wins++;
    mateHits += r.mateHits;
    mateAttacks += r.mateAttacks;
    parts.push(`seed ${TEAM_SEEDS[i]} winner team ${r.winnerTeam} ${r.frames}f mate attacks ${r.mateAttacks}`);
  }
  return {
    name: 'ak. Teams: L10 + L9 on team 0 beat an L9 on team 1 every match, never hitting or swinging at each other',
    pass: wins === TEAM_SEEDS.length && mateHits === 0 && mateAttacks === 0,
    detail: `team 0 won ${wins}/${TEAM_SEEDS.length}, teammate hits ${mateHits}, attacks at a teammate with every enemy past ${TEAM_FAR}px ${mateAttacks} | ${parts.join(', ')}`,
  };
}


// ---------------------------------------------------------------------------
// Kill speed: level 10 against a level 0 dummy. A standing dummy (cpuZeroMoves off) has to lose its
// first stock inside KILL_FIRST_CAP frames and all three inside KILL_ALL_CAP; a wandering one (rule
// on) its first inside KILL_WANDER_CAP. The timeline (KO frames, damage per second, damage by move)
// is kept for the printout, since a slow kill is diagnosed from where the damage went.
// ---------------------------------------------------------------------------

const KILL_SEEDS = [5, 17, 23];
const KILL_STOCKS = 3;
const KILL_FIRST_CAP = 1200;
const KILL_ALL_CAP = 3600;
const KILL_WANDER_CAP = 1800;

interface KillRun {
  seed: number;
  wander: boolean;
  koFrames: number[];
  koSides: string[];
  koPcts: number[];
  frames: number;
  damage: number;
  byMove: Record<string, number>;
}

/** Level 10 on slot 0 against a level 0 on slot 1, until the dummy is out of stocks or `cap` runs out. */
function runKillMatch(seed: number, wander: boolean, cap: number): KillRun {
  const l10Slot = 0;
  const state = createGameState(cpuConfig(10, 0, seed, KILL_STOCKS, wander));
  const rand = () => nextFloat(state.rng);
  const vi = 1 - l10Slot;
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0, direct: 0 },
    { held: 0, pressed: 0, released: 0, direct: 0 },
  ];
  const out: KillRun = { seed, wander, koFrames: [], koSides: [], koPcts: [], frames: 0, damage: 0, byMove: {} };
  let lastPct = 0;
  let frame = 0;
  for (; frame < cap; frame++) {
    for (let s = 0; s < 2; s++) {
      const o = cpuInput(state, s, s === l10Slot ? 10 : 0, rand);
      inputs[s].held = o.held; inputs[s].pressed = o.pressed; inputs[s].released = o.released; inputs[s].direct = o.direct;
    }
    stepGame(state, inputs);
    for (let i = 0; i < state.events.length; i++) {
      const ev = state.events[i];
      if (ev.type === 'hit' && ev.attacker === l10Slot && ev.victim === vi) {
        // What the level 10 was doing when its hit landed; a hit while it is not in a move is a projectile.
        const f = state.fighters[l10Slot];
        const label = f.action === 'throw' && simView(f).activeThrowId !== null ? String(simView(f).activeThrowId)
          : f.action === 'attack' && f.moveId !== null ? f.moveId : 'projectile';
        out.byMove[label] = (out.byMove[label] ?? 0) + ev.damage;
        out.damage += ev.damage;
      } else if (ev.type === 'ko' && ev.slot === vi) {
        out.koFrames.push(state.frame);
        out.koSides.push(ev.side);
        out.koPcts.push(Math.round(lastPct));
      }
    }
    lastPct = state.fighters[vi].percent;
    if (state.finished) { frame++; break; }
  }
  out.frames = frame;
  return out;
}

function killLine(r: KillRun): string {
  const moves = Object.keys(r.byMove).sort((a, b) => r.byMove[b] - r.byMove[a])
    .map((k) => `${k} ${r.byMove[k].toFixed(0)}`).join(', ');
  const kos = r.koFrames.map((f, i) => `${f}f (${(f / 60).toFixed(1)}s, ${r.koSides[i]}, ~${r.koPcts[i]}%)`).join(' ');
  return `  ${r.wander ? 'wandering' : 'standing'} seed ${r.seed}: KOs ${kos || 'none'} | ${r.frames}f,` +
    ` ${(r.damage / (r.frames / 60)).toFixed(1)}%/s | by move: ${moves}`;
}

const killRuns: KillRun[] = [];

function testL10KillSpeed(): TestResult {
  const fails: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < KILL_SEEDS.length; i++) {
    const r = runKillMatch(KILL_SEEDS[i], false, KILL_ALL_CAP);
    killRuns.push(r);
    const first = r.koFrames.length > 0 ? r.koFrames[0] : -1;
    parts.push(`standing ${KILL_SEEDS[i]} first ${first}f all ${r.koFrames.length === KILL_STOCKS ? r.koFrames[KILL_STOCKS - 1] : -1}f`);
    if (first < 0 || first > KILL_FIRST_CAP) fails.push(`standing seed ${KILL_SEEDS[i]} first KO ${first}f`);
    if (r.koFrames.length < KILL_STOCKS) fails.push(`standing seed ${KILL_SEEDS[i]} only ${r.koFrames.length} KOs in ${KILL_ALL_CAP}f`);
  }
  for (let i = 0; i < KILL_SEEDS.length; i++) {
    const r = runKillMatch(KILL_SEEDS[i], true, KILL_ALL_CAP);
    killRuns.push(r);
    const first = r.koFrames.length > 0 ? r.koFrames[0] : -1;
    parts.push(`wandering ${KILL_SEEDS[i]} first ${first}f`);
    if (first < 0 || first > KILL_WANDER_CAP) fails.push(`wandering seed ${KILL_SEEDS[i]} first KO ${first}f`);
  }
  return {
    name: `al. level 10 kills a level 0 fast: standing, first KO by ${KILL_FIRST_CAP}f and ${KILL_STOCKS} stocks by ${KILL_ALL_CAP}f; wandering, first KO by ${KILL_WANDER_CAP}f`,
    pass: fails.length === 0,
    detail: `${parts.join(', ')}${fails.length > 0 ? ` | FAIL: ${fails.join('; ')}` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Wave 2 (E6): Aevalmere on both arenas. L10 vs L9 strictly (every match, no stock lost), six
// scripted archetypes standing in for the kinds of human the owner described, profile persistence,
// kill routing against a standing dummy, the time budget with a host warm-up, and determinism with
// an empty and a fixed profile store. Every archetype is a fixed policy fed through the same input
// path a CPU slot uses; its slot is a human one (cpu false, a typed name), so the profile store is
// exercised exactly as it would be for a person.
// ---------------------------------------------------------------------------

const STAGES = ['tidegate', 'hearthmoor'] as const;

/** Strict L10 vs L9 on every stage: this many seeds, both sides each. */
const STRICT_SEEDS = SEEDS;

interface StrictSummary { stage: string; matches: number; wins: number; stocksLost: number; sd: number; unfinished: number; frames: number }
const strictRuns: StrictSummary[] = [];

function strictSummary(stage: string): StrictSummary {
  for (let i = 0; i < strictRuns.length; i++) if (strictRuns[i].stage === stage) return strictRuns[i];
  const out: StrictSummary = { stage, matches: 0, wins: 0, stocksLost: 0, sd: 0, unfinished: 0, frames: 0 };
  for (let i = 0; i < STRICT_SEEDS.length; i++) {
    for (let side = 0; side < 2; side++) {
      const run = side === 0
        ? runL10Match(10, 9, STRICT_SEEDS[i], MATRIX_STOCKS, MATCH_CAP, stage)
        : runL10Match(9, 10, STRICT_SEEDS[i], MATRIX_STOCKS, MATCH_CAP, stage);
      out.matches++;
      if (run.state.winner === run.l10Slot) out.wins++;
      out.stocksLost += MATRIX_STOCKS - run.state.fighters[run.l10Slot].stocks;
      out.sd += run.sd;
      out.frames += run.frames;
      if (!run.state.finished) out.unfinished++;
    }
  }
  strictRuns.push(out);
  return out;
}

function testL10StrictBothStages(): TestResult {
  const parts: string[] = [];
  let pass = true;
  for (let i = 0; i < STAGES.length; i++) {
    const m = strictSummary(STAGES[i]);
    parts.push(`${m.stage} won ${m.wins}/${m.matches} stocks lost ${m.stocksLost} sd ${m.sd} avg ${Math.round(m.frames / m.matches)}f`);
    if (m.wins !== m.matches || m.stocksLost !== 0 || m.sd !== 0 || m.unfinished !== 0) pass = false;
  }
  return {
    name: 'am. level 10 beats level 9 in every match with 0 stocks lost and 0 SDs, on tidegate and hearthmoor',
    pass,
    detail: parts.join(' | '),
  };
}

// Scripted archetypes -------------------------------------------------------

type ArchKind = 'rushdown' | 'turtle' | 'camper' | 'roller' | 'ledge' | 'jumper';
const ARCHETYPES: readonly ArchKind[] = ['rushdown', 'turtle', 'camper', 'roller', 'ledge', 'jumper'];
const ARCH_NAMES: Record<ArchKind, string> = {
  rushdown: 'Rushdown', turtle: 'Turtle', camper: 'Camper', roller: 'Roller', ledge: 'LedgeCamp', jumper: 'Jumper',
};
const ARCH_SEEDS = [5, 17, 23];
const ARCH_STOCKS = 2;
const ARCH_CAP = 9000;
/** Accuracy checkpoints: the first 30 s (and 15 s for the profile gate). */
const ARCH_ACC_FRAME = 1800;

const DCODES = DIRECT_CODES as readonly string[];
function dcode(name: string): number { return DCODES.indexOf(name) + 1; }

interface ArchMem { prevHeld: number; step: number; timer: number; phase: number; hang: number; jumpHold: number; mash: number; relL: number; relR: number }

function newArchMem(): ArchMem {
  return { prevHeld: 0, step: 0, timer: 0, phase: 0, hang: 0, jumpHold: 0, mash: 0, relL: -99, relR: -99 };
}

function archFree(f: FighterState): boolean {
  if (f.hitlag > 0) return false;
  return f.action === 'idle' || f.action === 'walk' || f.action === 'dash' || f.action === 'run' ||
    f.action === 'turn' || f.action === 'crouch';
}

/**
 * One frame of a scripted archetype. Shared plumbing first (respawn, grabbed, downed, ledge,
 * recovery), then the archetype's own habit. No randomness: the same state always gives the
 * same input, which is what makes the predictor's job measurable.
 */
function archInput(kind: ArchKind, state: GameState, slot: number, mem: ArchMem, out: InputFrame): InputFrame {
  let held = 0;
  let direct = 0;
  let me: FighterState | null = null;
  let foe: FighterState | null = null;
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    if (f.slot === slot) me = f; else if (foe === null || f.stocks > 0) foe = f;
  }
  if (mem.timer > 0) mem.timer--;
  if (me !== null && foe !== null && me.stocks > 0 && me.action !== 'dead') {
    const stage = STAGE_DEFS[state.stageId];
    let minX = 0; let maxX = 0;
    for (let i = 0; i < stage.platforms.length; i++) {
      const p = stage.platforms[i];
      if (p.solid) { minX = p.x; maxX = p.x + p.w; break; }
    }
    const cx = (minX + maxX) / 2;
    const dx = foe.x - me.x;
    const adx = Math.abs(dx);
    const toward = dx < 0 ? Btn.Left : Btn.Right;
    const away = dx < 0 ? Btn.Right : Btn.Left;
    const home = me.x < cx ? Btn.Right : Btn.Left;
    const facingFoe = (me.facing === 1) === (dx > 0);
    const off = !me.onGround && (me.x < minX - 2 || me.x > maxX + 2 || me.y > 6);
    if (me.action === 'respawn') {
      if (me.actionFrame > 30) held = Btn.Down;
    } else if (me.action === 'grabbed') {
      mem.mash ^= 1;
      held = mem.mash === 0 ? (Btn.Left | Btn.Jump) : (Btn.Right | Btn.Attack);
    } else if (me.action === 'downed') {
      held = (mem.prevHeld & Btn.Up) === 0 ? Btn.Up : 0;
    } else if (me.action === 'ledgeHang') {
      if (kind === 'ledge') {
        mem.hang++;
        const wait = 40 + (mem.step % 3) * 12;
        if (mem.hang >= wait) {
          const opts = ['ledgeGetUp', 'ledgeAttack', 'ledgeRoll', 'ledgeGetUp', 'ledgeJump'];
          direct = dcode(opts[mem.step % opts.length]);
          mem.step++;
          mem.hang = 0;
          mem.phase = 1;
          mem.timer = 50;
        }
      } else if (me.actionFrame > 8) {
        direct = dcode('ledgeGetUp');
      }
    } else if (off && !(kind === 'ledge' && mem.phase === 0 && me.y < 40)) {
      // Recovery: head home, double jump once falling, geyser when out of jumps.
      held = home;
      if (me.action === 'air') {
        if (me.jumpsLeft > 0 && me.vy > 0.5) { if ((mem.prevHeld & Btn.Jump) === 0) held |= Btn.Jump; }
        else if (me.jumpsLeft === 0 && me.vy > 0) direct = dcode('uspecial');
      }
    } else {
      switch (kind) {
        case 'rushdown': {
          // Always in their face, mashing a fixed string of grounded moves.
          held = toward;
          if (!me.onGround || !archFree(me) || adx > 40) break;
          const string = ['jab', 'ftilt', 'dtilt', 'jab', 'usmash'];
          direct = dcode(string[mem.step % string.length]);
          mem.step++;
          break;
        }
        case 'turtle': {
          // Shield anything that comes close; grab out of shield the moment the attacker is stuck.
          if (!me.onGround) { held = home; break; }
          const foeBusy = foe.action === 'attack' || foe.action === 'land' || foe.action === 'shieldStun';
          const foeCommitted = foe.action === 'attack' && foe.actionFrame > 8;
          if (me.action === 'shield' && adx < 44 && foeCommitted) { held = Btn.Shield | ((mem.prevHeld & Btn.Attack) === 0 ? Btn.Attack : 0); break; }
          if (adx < 110 && (foeBusy || Math.abs(foe.vx) > 1.2 || foe.action === 'air')) { held = Btn.Shield; mem.timer = 12; break; }
          if (mem.timer > 0 && me.action === 'shield') { held = Btn.Shield; break; }
          if (!archFree(me)) break;
          if (adx > 100) held = toward | Btn.Walk;
          break;
        }
        case 'camper': {
          // Keep 170 to 260 px away and throw a shot every 40 frames.
          if (!me.onGround) { held = home; break; }
          if (!archFree(me)) break;
          const nearEdge = me.x < minX + 40 || me.x > maxX - 40;
          // Retreat until well out of reach (200 px) once pressed inside 170: no dithering at the line.
          if (!nearEdge && (adx < 170 || (mem.phase === 1 && adx < 200))) { held = away; mem.phase = 1; break; }
          mem.phase = 0;
          if (adx < 90 && nearEdge) { held = toward | Btn.Jump; break; }
          if (adx > 260) { held = toward; break; }
          if (!facingFoe) { held = toward; break; }
          if (mem.timer === 0) {
            direct = dcode(mem.step % 2 === 0 ? 'nspecial' : 'sspecial');
            mem.step++;
            mem.timer = 40;
          }
          break;
        }
        case 'roller': {
          // Rolls whenever anyone comes close, then jabs if the roll left it next to them.
          if (!me.onGround) { held = home; break; }
          if (!archFree(me)) break;
          if (adx < 90 && mem.timer === 0) {
            // Two rolls in (through them), then one away: a habit told relative to the opponent.
            const rollIn = mem.step % 3 !== 2;
            direct = dcode(rollIn === facingFoe ? 'rollForward' : 'rollBack');
            mem.step++;
            mem.timer = 34;
            break;
          }
          if (adx < 36) { direct = dcode('jab'); break; }
          if (adx > 120) held = toward;
          break;
        }
        case 'ledge': {
          // Lives on the ledge: walks off to hang, takes a ledge option, comes back after a beat.
          const leftSide = me.x < cx;
          const edge = leftSide ? minX : maxX;
          const outBit = leftSide ? Btn.Left : Btn.Right;
          const inBit = leftSide ? Btn.Right : Btn.Left;
          if (mem.phase === 1) {
            if (!me.onGround) { held = home; break; }
            if (!archFree(me)) break;
            if (adx < 36) { direct = dcode('jab'); break; }
            if (mem.timer === 0) mem.phase = 0;
            break;
          }
          if (me.onGround) { if (archFree(me) || me.action === 'land') held = outBit; break; }
          held = me.vy > 0 && Math.abs(me.x - edge) < 30 ? inBit : outBit;
          if (me.y > 30 || Math.abs(me.x - edge) > 40) held = inBit;
          break;
        }
        case 'jumper': {
          // Full hops at the opponent, an aerial near the top, a double jump on the way down.
          held = toward;
          if (me.onGround) {
            if (archFree(me) || me.action === 'land') { held |= Btn.Jump; mem.jumpHold = 5; }
            break;
          }
          if (mem.jumpHold > 0) { held |= Btn.Jump; mem.jumpHold--; }
          if (me.action === 'air' && me.vy > -1.5 && me.vy < 1 && adx < 80 && mem.timer === 0) {
            direct = dcode(facingFoe ? 'fair' : 'nair');
            mem.timer = 30;
          } else if (me.action === 'air' && me.vy > 2 && me.jumpsLeft > 0 && (mem.prevHeld & Btn.Jump) === 0 && adx > 30) {
            held |= Btn.Jump;
          }
          break;
        }
        default: break;
      }
    }
  }
  // A person with a habit does not roll by accident: a direction released less than a roll-tap
  // window ago is not pressed again on the ground (the sim would read the second tap as a roll).
  if (me !== null && me.onGround) {
    if ((held & Btn.Left) !== 0 && (mem.prevHeld & Btn.Left) === 0 && state.frame - mem.relL <= 14) held &= ~Btn.Left;
    if ((held & Btn.Right) !== 0 && (mem.prevHeld & Btn.Right) === 0 && state.frame - mem.relR <= 14) held &= ~Btn.Right;
  }
  if ((mem.prevHeld & Btn.Left) !== 0 && (held & Btn.Left) === 0) mem.relL = state.frame;
  if ((mem.prevHeld & Btn.Right) !== 0 && (held & Btn.Right) === 0) mem.relR = state.frame;
  out.held = held;
  out.pressed = held & ~mem.prevHeld;
  out.released = mem.prevHeld & ~held;
  out.direct = direct;
  mem.prevHeld = held;
  return out;
}

interface ArchRun {
  kind: ArchKind;
  stage: string;
  seed: number;
  l10Slot: number;
  stocksLost: number;
  sd: number;
  firstKo: number;         // frame of the archetype's first lost stock, -1 none
  won: boolean;
  frames: number;
  accAt30: number;         // top-guess accuracy over the last 30 guesses made by 30 s (the ao gate)
  accCum30: number;        // over every guess made in the first 30 s, cold start included
  obs30: number;
  accAt15: number;         // the same over the first 15 s
  obs15: number;
  accTotal: number;        // over the whole match
  obs: number;
  kosChain: number;        // archetype KOs whose last hit was the 2nd+ hit of a true combo
  kosSpike: number;        // ... a downward launch (240 to 300 degrees) landed off the stage
  kosEdge: number;         // ... any other hit landed while the victim was off the stage
  kosRaw: number;          // ... a single hit on the stage
  kosOther: number;        // no hit of ours before the KO (a self-destruct)
  finalJson: string;
}

/** Off the stage by the harness's own reading of the live solid platform. */
function harnessOffstage(state: GameState, f: FighterState): boolean {
  if (f.onGround || f.action === 'ledgeHang') return false;
  const stage = STAGE_DEFS[state.stageId];
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (!p.solid) continue;
    return f.x < p.x - 2 || f.x > p.x + p.w + 2 || f.y > p.y + 6;
  }
  return false;
}

/**
 * Level 10 against archetype `kind`. The level 10 sits on slot 0 or 1 (`l10Slot`), the archetype on
 * the other as a named human. `store` is installed as the profile store for the match and the
 * profiles are flushed to it at the end. `stopAtKo` ends the match at the archetype's first KO.
 */
function runArchMatch(kind: ArchKind, stage: string, seed: number, l10Slot: number, store: ProfileStore, stopAtKo: boolean): ArchRun {
  const aSlot = 1 - l10Slot;
  const players: MatchConfig['players'] = [];
  for (let s = 0; s < 2; s++) {
    players.push(s === l10Slot
      ? { slot: s, charId: 'aeval', cpu: true, cpuLevel: 10 }
      : { slot: s, charId: 'aeval', cpu: false, cpuLevel: 0, name: ARCH_NAMES[kind] });
  }
  const cfg: MatchConfig = { stageId: stage, players, stocks: ARCH_STOCKS, timeLimitSec: 0, seed };
  setAevalmereProfileStore(store);
  const state = createGameState(cfg);
  const rand = () => nextFloat(state.rng);
  const amem = newArchMem();
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0, direct: 0 },
    { held: 0, pressed: 0, released: 0, direct: 0 },
  ];
  const tmp: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
  let firstKo = -1;
  let acc30 = -1; let n30 = 0; let acc15 = -1; let n15 = 0; let roll30 = -1;
  let combo = 0;
  let lastType = 4;        // 0 chain, 1 spike, 2 edgeguard, 3 raw, 4 no hit yet
  const koTypes = [0, 0, 0, 0, 0];
  let frame = 0;
  for (; frame < ARCH_CAP; frame++) {
    const victim = state.fighters[aSlot];
    const held = victim.hitstun > 0 || victim.hitlag > 0;
    const wasOff = harnessOffstage(state, victim);
    const o = cpuInput(state, l10Slot, 10, rand);
    inputs[l10Slot].held = o.held; inputs[l10Slot].pressed = o.pressed; inputs[l10Slot].released = o.released; inputs[l10Slot].direct = o.direct;
    const a = archInput(kind, state, aSlot, amem, tmp);
    inputs[aSlot].held = a.held; inputs[aSlot].pressed = a.pressed; inputs[aSlot].released = a.released; inputs[aSlot].direct = a.direct;
    stepGame(state, inputs);
    if (state.frame === ARCH_ACC_FRAME || state.frame === ARCH_ACC_FRAME / 2) {
      const ps = aevalmerePredictorStats(l10Slot, aSlot);
      const a = ps.total > 0 ? ps.hits / ps.total : 0;
      if (state.frame === ARCH_ACC_FRAME) { acc30 = a; n30 = ps.total; roll30 = ps.recent; } else { acc15 = a; n15 = ps.total; }
    }
    let ko = false;
    let hitNow = false;
    for (let i = 0; i < state.events.length; i++) {
      const ev = state.events[i];
      if (ev.type === 'hit' && ev.attacker === l10Slot && ev.victim === aSlot && ev.kb > 0) {
        combo = held || hitNow ? combo + 1 : 1;
        hitNow = true;
        const spike = ev.angle >= 240 && ev.angle <= 300 && wasOff;
        lastType = combo >= 2 ? 0 : spike ? 1 : wasOff ? 2 : 3;
      } else if (ev.type === 'ko' && ev.slot === aSlot) {
        if (firstKo < 0) firstKo = state.frame;
        ko = true;
        koTypes[lastType]++;
        lastType = 4;
        combo = 0;
      }
    }
    if (!hitNow && victim.hitstun === 0 && victim.hitlag === 0) combo = 0;
    if (state.finished || (stopAtKo && ko)) { frame++; break; }
  }
  // A match that ended before a checkpoint is read at its end.
  const psEnd = aevalmerePredictorStats(l10Slot, aSlot);
  const aEnd = psEnd.total > 0 ? psEnd.hits / psEnd.total : 0;
  if (acc30 < 0) { acc30 = aEnd; n30 = psEnd.total; roll30 = psEnd.recent; }
  if (acc15 < 0) { acc15 = aEnd; n15 = psEnd.total; }
  flushAevalmereProfiles();
  const ps = aevalmerePredictorStats(l10Slot, aSlot);
  const l10 = state.fighters[l10Slot];
  return {
    kind, stage, seed, l10Slot,
    stocksLost: ARCH_STOCKS - l10.stocks,
    sd: l10.stats.sds,
    firstKo, won: state.winner === l10Slot, frames: frame,
    accAt30: roll30, accCum30: acc30, obs30: n30, accAt15: acc15, obs15: n15, accTotal: ps.total > 0 ? ps.hits / ps.total : 0, obs: ps.total,
    kosChain: koTypes[0], kosSpike: koTypes[1], kosEdge: koTypes[2], kosRaw: koTypes[3], kosOther: koTypes[4],
    finalJson: JSON.stringify(state),
  };
}

const archRuns: ArchRun[] = [];

function runArchSweep(): void {
  if (archRuns.length > 0) return;
  for (let st = 0; st < STAGES.length; st++) {
    for (let k = 0; k < ARCHETYPES.length; k++) {
      for (let i = 0; i < ARCH_SEEDS.length; i++) {
        // Every match on a fresh store: this sweep measures in-match learning only.
        archRuns.push(runArchMatch(ARCHETYPES[k], STAGES[st], ARCH_SEEDS[i], i % 2, new MemoryProfileStore(), false));
      }
    }
  }
}

function archLine(kind: ArchKind, stage: string): string {
  let wins = 0; let lost = 0; let n = 0; let accBest = 0; let accTot = 0; let obs = 0; let worst = 1;
  const kos: number[] = [];
  for (let i = 0; i < archRuns.length; i++) {
    const r = archRuns[i];
    if (r.kind !== kind || r.stage !== stage) continue;
    n++;
    if (r.won) wins++;
    lost += r.stocksLost;
    kos.push(r.firstKo);
    accBest += r.accAt30;
    if (r.accAt30 < worst) worst = r.accAt30;
    accTot += r.accTotal;
    obs += r.obs;
  }
  return `  ${stage} ${kind}: wins ${wins}/${n} stocks lost ${lost} first KO ${kos.map((f) => (f < 0 ? '-' : `${f}f`)).join('/')}` +
    ` accuracy at 30 s mean ${(accBest / Math.max(1, n) * 100).toFixed(0)}% worst ${(worst * 100).toFixed(0)}%` +
    ` (whole match ${(accTot / Math.max(1, n) * 100).toFixed(0)}%, ${Math.round(obs / Math.max(1, n))} obs)`;
}

function testArchetypesNoLoss(): TestResult {
  runArchSweep();
  let lost = 0; let sd = 0;
  const bad: string[] = [];
  for (let i = 0; i < archRuns.length; i++) {
    const r = archRuns[i];
    lost += r.stocksLost;
    sd += r.sd;
    if (r.stocksLost > 0 || r.sd > 0) bad.push(`${r.stage} ${r.kind} seed ${r.seed} lost ${r.stocksLost}`);
  }
  return {
    name: `an. level 10 loses no stock to any scripted archetype (${ARCHETYPES.join(', ')}), ${ARCH_SEEDS.length} seeds each, both stages`,
    pass: lost === 0 && sd === 0,
    detail: `${archRuns.length} matches, stocks lost ${lost}, sd ${sd}${bad.length > 0 ? ` | ${bad.join('; ')}` : ''}`,
  };
}

/**
 * ao is informational (coordinator decision, 2026-09-29): it prints, per archetype with both stages
 * pooled (6 matches), the mean of the cumulative top-guess accuracy over the first 30 s and the
 * worst match, against a 50% / 40% reference, and never fails the suite. The camper and the roller
 * act on a beat after long stretches of drifting, and every match starts with nothing learned, so
 * 30 s of guesses is too small and too cold a sample to gate on. The substantive gates are an (no
 * stock lost) and ap (profile transfer).
 */
const ARCH_ACC_MEAN = 0.5;
const ARCH_ACC_WORST = 0.4;

function testArchetypePrediction(): TestResult {
  runArchSweep();
  const parts: string[] = [];
  let pass = true;
  for (let k = 0; k < ARCHETYPES.length; k++) {
    let sum = 0; let n = 0; let worst = 1;
    for (let i = 0; i < archRuns.length; i++) {
      const r = archRuns[i];
      if (r.kind !== ARCHETYPES[k]) continue;
      sum += r.accCum30; n++;
      if (r.accCum30 < worst) worst = r.accCum30;
    }
    const mean = n > 0 ? sum / n : 0;
    const ok = mean >= ARCH_ACC_MEAN && worst >= ARCH_ACC_WORST;
    if (!ok) pass = false;
    parts.push(`${ARCHETYPES[k]} ${(mean * 100).toFixed(0)}%/${(worst * 100).toFixed(0)}%${ok ? '' : ' (below reference)'}`);
  }
  return {
    info: true,
    name: `ao. predictor top-guess accuracy, cumulative over the first ${ARCH_ACC_FRAME / 60} s, both stages pooled (reference: mean of 6 matches ${Math.round(ARCH_ACC_MEAN * 100)}%, every match ${Math.round(ARCH_ACC_WORST * 100)}%)`,
    pass,
    detail: `mean/worst: ${parts.join(', ')}`,
  };
}

// Profile persistence -------------------------------------------------------
// The profile's job is to know the player from the first second. Each pair plays the same match
// (archetype, stage, seed) twice: once with an empty store, once with the profile a previous full
// match against that archetype saved. The measure is the predictor's top-guess accuracy over the
// first 15 s of each.

function median(xs: number[]): number {
  const v = xs.slice().sort((a, b) => a - b);
  return v.length === 0 ? -1 : v[Math.floor(v.length / 2)];
}

const PROFILE_GAIN = 0.08;
const PROFILE_WORST = -0.05;

interface ProfilePair { kind: ArchKind; stage: string; seed: number; empty: number; loaded: number; keyOk: boolean }
const profilePairs: ProfilePair[] = [];

function runProfilePairs(): void {
  if (profilePairs.length > 0) return;
  for (let st = 0; st < STAGES.length; st++) {
    for (let k = 0; k < ARCHETYPES.length; k++) {
      for (let i = 0; i < ARCH_SEEDS.length; i++) {
        const kind = ARCHETYPES[k]; const stage = STAGES[st]; const seed = ARCH_SEEDS[i];
        const store = new MemoryProfileStore();
        // The empty-store match doubles as the one that teaches the profile.
        const a = runArchMatch(kind, stage, seed, 0, store, false);
        const keyOk = store.load(PROFILE_PREFIX + ARCH_NAMES[kind]) !== null && store.keys().length === 1;
        const b = runArchMatch(kind, stage, seed, 0, store, false);
        profilePairs.push({ kind, stage, seed, empty: a.accAt15, loaded: b.accAt15, keyOk });
      }
    }
  }
}

function testProfilePersistence(): TestResult {
  runProfilePairs();
  let sum = 0; let worst = 1; let keyOk = true; let worstLabel = '';
  const perStage: number[] = [0, 0];
  const perStageN: number[] = [0, 0];
  const parts: string[] = [];
  for (let k = 0; k < ARCHETYPES.length; k++) {
    let ks = 0; let kn = 0;
    for (let i = 0; i < profilePairs.length; i++) {
      const r = profilePairs[i];
      if (r.kind !== ARCHETYPES[k]) continue;
      ks += r.loaded - r.empty; kn++;
    }
    parts.push(`${ARCHETYPES[k]} ${ks / Math.max(1, kn) >= 0 ? '+' : ''}${((ks / Math.max(1, kn)) * 100).toFixed(0)}`);
  }
  for (let i = 0; i < profilePairs.length; i++) {
    const r = profilePairs[i];
    const d = r.loaded - r.empty;
    sum += d;
    if (d < worst) { worst = d; worstLabel = `${r.stage} ${r.kind} seed ${r.seed} ${(r.empty * 100).toFixed(0)}->${(r.loaded * 100).toFixed(0)}`; }
    const si = STAGES.indexOf(r.stage as typeof STAGES[number]);
    perStage[si] += d; perStageN[si]++;
    if (!r.keyOk) keyOk = false;
  }
  const mean = sum / Math.max(1, profilePairs.length);
  const m0 = perStage[0] / Math.max(1, perStageN[0]);
  const m1 = perStage[1] / Math.max(1, perStageN[1]);
  const pass = mean >= PROFILE_GAIN && m0 >= PROFILE_GAIN && m1 >= PROFILE_GAIN && worst >= PROFILE_WORST && keyOk;
  return {
    name: `ap. a saved profile raises the predictor's first-15 s accuracy by >= ${PROFILE_GAIN * 100} points on the mean (overall and on each stage's 18 pairs), never lower by more than ${-PROFILE_WORST * 100} in any pair`,
    pass,
    detail: `mean gain ${(mean * 100).toFixed(1)} points over ${profilePairs.length} pairs (tidegate ${(m0 * 100).toFixed(1)}, hearthmoor ${(m1 * 100).toFixed(1)}), worst pair ${(worst * 100).toFixed(1)} (${worstLabel}); per archetype ${parts.join(', ')}; one key per player under ${PROFILE_PREFIX}<name>: ${keyOk ? 'yes' : 'NO'}`,
  };
}

// Kill speed and kill routing -----------------------------------------------

const KR_SEEDS = [5, 17, 23, 41, 97];
const KR_FIRST_MEDIAN = 720;

interface KillRouteRun { stage: string; seed: number; koFrames: number[]; routed: number; kos: number }
const killRouteRuns: KillRouteRun[] = [];

/**
 * Level 10 against a standing level 0 on `stage`, 3 stocks. A KO counts as routed when the last hit
 * the level 10 landed on the dummy before it was KO'd was the 2nd or later hit of a true combo (it
 * landed while the victim was still in hitstun or hitlag from the one before), or a spike (a
 * downward launch, 240 to 300 degrees, off the stage).
 */
function runKillRoute(stage: string, seed: number): KillRouteRun {
  const cfg = cpuConfig(10, 0, seed, KILL_STOCKS, false, stage);
  const state = createGameState(cfg);
  const rand = () => nextFloat(state.rng);
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0, direct: 0 },
    { held: 0, pressed: 0, released: 0, direct: 0 },
  ];
  const out: KillRouteRun = { stage, seed, koFrames: [], routed: 0, kos: 0 };
  let combo = 0;
  let lastRouted = false;
  for (let frame = 0; frame < KILL_ALL_CAP; frame++) {
    for (let s = 0; s < 2; s++) {
      const o = cpuInput(state, s, s === 0 ? 10 : 0, rand);
      inputs[s].held = o.held; inputs[s].pressed = o.pressed; inputs[s].released = o.released; inputs[s].direct = o.direct;
    }
    const v = state.fighters[1];
    const held = v.hitstun > 0 || v.hitlag > 0;
    stepGame(state, inputs);
    let hitNow = false;
    for (let i = 0; i < state.events.length; i++) {
      const ev = state.events[i];
      if (ev.type === 'hit' && ev.attacker === 0 && ev.victim === 1 && ev.kb > 0) {
        combo = held || hitNow ? combo + 1 : 1;
        hitNow = true;
        const spike = ev.angle >= 240 && ev.angle <= 300 && ev.y > -10;
        lastRouted = combo >= 2 || spike;
      } else if (ev.type === 'ko' && ev.slot === 1) {
        out.koFrames.push(state.frame);
        out.kos++;
        if (lastRouted) out.routed++;
        lastRouted = false;
        combo = 0;
      }
    }
    if (!hitNow && v.hitstun === 0 && v.hitlag === 0) combo = 0;
    if (state.finished) break;
  }
  return out;
}

const KR_ROUTED_SHARE = 0.4;

function testKillRouting(): TestResult {
  // Opponents that recover: every KO of the 36 archetype matches, by how it came.
  runArchSweep();
  let chain = 0; let spike = 0; let edge = 0; let raw = 0; let other = 0;
  for (let i = 0; i < archRuns.length; i++) {
    const r = archRuns[i];
    chain += r.kosChain; spike += r.kosSpike; edge += r.kosEdge; raw += r.kosRaw; other += r.kosOther;
  }
  const kos = chain + spike + edge + raw + other;
  const share = kos > 0 ? (chain + spike + edge) / kos : 0;
  // Kill speed stays a separate assertion, against the standing dummy.
  const firsts: number[] = [];
  const parts: string[] = [];
  for (let st = 0; st < STAGES.length; st++) {
    for (let i = 0; i < KR_SEEDS.length; i++) {
      const r = runKillRoute(STAGES[st], KR_SEEDS[i]);
      killRouteRuns.push(r);
      firsts.push(r.koFrames.length > 0 ? r.koFrames[0] : KILL_ALL_CAP);
      parts.push(`${r.stage} ${r.seed} ${r.koFrames.length > 0 ? r.koFrames[0] : -1}f`);
    }
  }
  const med = median(firsts);
  killBreakdown = `${kos} KOs: chain ${chain}, spike ${spike}, edgeguard ${edge}, single hit on stage ${raw}, no hit ${other}`;
  return {
    name: `aq. against the archetypes at least ${KR_ROUTED_SHARE * 100}% of KOs come from a 2+ hit true combo, a spike or an edgeguard hit; against a standing dummy the median first KO is under ${KR_FIRST_MEDIAN / 60} s (both stages)`,
    pass: share >= KR_ROUTED_SHARE && med < KR_FIRST_MEDIAN,
    detail: `routed ${(share * 100).toFixed(0)}% (${killBreakdown}) | standing dummy median first KO ${med}f (${(med / 60).toFixed(1)}s): ${parts.join(', ')}`,
  };
}

let killBreakdown = '';

// Budget with a host warm-up ------------------------------------------------

const E6_MEAN_MS = 0.3;
const E6_P99_MS = 4;
const E6_FIRST_MS = 40;

interface BudgetRun { stage: string; mean: number; p99: number; first: number; calls: number }
const budgetRuns: BudgetRun[] = [];

function runBudget(stage: string): BudgetRun {
  const cfg = cpuConfig(10, 9, 17, 9, undefined, stage);
  const state = createGameState(cfg);
  const rand = () => nextFloat(state.rng);
  // The host warms the level 10 before frame 0, as main.ts may; the first real call is timed after it.
  warmAevalmere(state.config);
  const inputs: InputFrame[] = [
    { held: 0, pressed: 0, released: 0, direct: 0 },
    { held: 0, pressed: 0, released: 0, direct: 0 },
  ];
  const times: number[] = [];
  for (let frame = 0; frame < L10_BUDGET_FRAMES; frame++) {
    for (let s = 0; s < 2; s++) {
      const t0 = performance.now();
      const o = cpuInput(state, s, s === 0 ? 10 : 9, rand);
      if (s === 0) times.push(performance.now() - t0);
      inputs[s].held = o.held; inputs[s].pressed = o.pressed; inputs[s].released = o.released; inputs[s].direct = o.direct;
    }
    stepGame(state, inputs);
    if (state.finished) break;
  }
  const first = times[0];
  let sum = 0;
  for (let i = 0; i < times.length; i++) sum += times[i];
  const sorted = times.slice().sort((a, b) => a - b);
  return { stage, mean: sum / times.length, p99: sorted[Math.floor(sorted.length * 0.99)], first, calls: times.length };
}

function testE6Budget(): TestResult {
  let pass = true;
  const parts: string[] = [];
  for (let st = 0; st < STAGES.length; st++) {
    const r = runBudget(STAGES[st]);
    budgetRuns.push(r);
    parts.push(`${r.stage} mean ${r.mean.toFixed(3)} ms p99 ${r.p99.toFixed(2)} ms first ${r.first.toFixed(2)} ms over ${r.calls} calls`);
    if (!(r.mean < E6_MEAN_MS && r.p99 < E6_P99_MS && r.first < E6_FIRST_MS)) pass = false;
  }
  return {
    name: `ar. level 10 cpuInput: mean under ${E6_MEAN_MS} ms, p99 under ${E6_P99_MS} ms, first call after a host warm-up under ${E6_FIRST_MS} ms, both stages`,
    pass,
    detail: parts.join(' | '),
  };
}

// Determinism with the profile store ----------------------------------------

function testDeterminismWithStore(): TestResult {
  // Empty store, twice.
  const a = runArchMatch('roller', 'hearthmoor', 23, 0, new MemoryProfileStore(), false);
  const b = runArchMatch('roller', 'hearthmoor', 23, 0, new MemoryProfileStore(), false);
  // A fixed profile: learned once, then copied into two fresh stores.
  const seedStore = new MemoryProfileStore();
  runArchMatch('turtle', 'tidegate', 41, 1, seedStore, false);
  const key = PROFILE_PREFIX + ARCH_NAMES.turtle;
  const text = seedStore.load(key);
  const s1 = new MemoryProfileStore();
  const s2 = new MemoryProfileStore();
  if (text !== null) { s1.save(key, text); s2.save(key, text); }
  const c = runArchMatch('turtle', 'tidegate', 17, 1, s1, false);
  const d = runArchMatch('turtle', 'tidegate', 17, 1, s2, false);
  const same1 = a.finalJson === b.finalJson;
  const same2 = c.finalJson === d.finalJson && text !== null;
  return {
    name: 'as. level 10 against a human slot: the same seed gives an identical final state, with an empty store and with a fixed profile',
    pass: same1 && same2,
    detail: `empty store ${same1 ? 'identical' : 'DIVERGED'} (${a.frames}f), fixed profile ${same2 ? 'identical' : 'DIVERGED'} (${c.frames}f, profile ${text === null ? 'missing' : `${text.length} chars`})`,
  };
}

/** The wave 2 level 10 gates alone (am to as), for a quick run while tuning. */
/**
 * at. The profile store is capped (review R19): saving 20 names through CappedProfileStore on an
 * in-memory backend keeps PROFILE_CAP profiles, the newest ones, and the index lists exactly those.
 * A backend whose next write throws (a full quota) evicts the oldest profile and retries once.
 */
function testProfileCap(): TestResult {
  const mem = new MemoryProfileStore();
  const store = new CappedProfileStore(mem);
  const N = 20;
  for (let i = 0; i < N; i++) store.save(`${PROFILE_PREFIX}p${i}`, `{"n":${i}}`);
  const kept = mem.keys().filter((k) => k.startsWith(PROFILE_PREFIX));
  let newestKept = true;
  for (let i = N - PROFILE_CAP; i < N; i++) if (mem.load(`${PROFILE_PREFIX}p${i}`) === null) newestKept = false;
  const indexed = store.indexedKeys();
  const indexOk = indexed.length === PROFILE_CAP && mem.load(PROFILE_INDEX_KEY) !== null &&
    indexed[0] === `${PROFILE_PREFIX}p${N - PROFILE_CAP}` && indexed[PROFILE_CAP - 1] === `${PROFILE_PREFIX}p${N - 1}`;
  // Quota: the next write of a profile throws once; the oldest is evicted and the retry lands.
  let failNext = true;
  const flaky = new MemoryProfileStore();
  const quota = new CappedProfileStore({
    load: (k) => flaky.load(k),
    save: (k, v) => {
      if (failNext && k !== PROFILE_INDEX_KEY && k.endsWith('late')) { failNext = false; throw new Error('QuotaExceededError'); }
      flaky.save(k, v);
    },
    remove: (k) => flaky.remove(k),
  });
  quota.save(`${PROFILE_PREFIX}early`, '{}');
  quota.save(`${PROFILE_PREFIX}late`, '{}');
  const retryOk = flaky.load(`${PROFILE_PREFIX}late`) !== null && flaky.load(`${PROFILE_PREFIX}early`) === null;
  return {
    name: `at. the profile store keeps at most ${PROFILE_CAP} profiles (the newest), indexed under ${PROFILE_INDEX_KEY}, and a quota error evicts the oldest and retries once`,
    pass: kept.length === PROFILE_CAP && newestKept && indexOk && retryOk,
    detail: `saved ${N}, kept ${kept.length}, newest ${PROFILE_CAP} kept ${newestKept}, index ok ${indexOk}, quota retry ${retryOk}`,
  };
}

export function runAevalmereWave2Tests(which: string[]): TestResult[] {
  const all: Record<string, () => TestResult> = {
    am: testL10StrictBothStages, an: testArchetypesNoLoss, ao: testArchetypePrediction, ap: testProfilePersistence,
    aq: testKillRouting, ar: testE6Budget, as: testDeterminismWithStore,
  };
  const out: TestResult[] = [];
  for (let i = 0; i < which.length; i++) { const f = all[which[i]]; if (f !== undefined) out.push(f()); }
  return out;
}

export function runAiSelfTest(): TestResult[] {
  const a = testL1v1();
  const b = testMatrix();
  const c = testMonotonic();
  const d = testLedgeApproach();
  const e = testAerialCooldown();
  runVerticalSweep();
  runSpamSweep();
  const f = testNoSelfDestruct();
  const g = testVertAbove();
  const h = testVertBelow();
  const i = testVertNoStall();
  const j = testSpamBeaten();
  const k = testSpamShield();
  const l = testOptionsUsed();
  const m = testOptionsScale();
  const n = testDeterminism();
  const o = testKitCoverage();
  const p = testNoTaunt();
  const q = testMovementMechanics();
  const r = testShortHopScaling();
  const s = testChargedSmashes();
  const t = testKitScaling();
  const u = testNoAccidentalRoll();
  const v = testCpuGrabs();
  const w = testMashOut();
  const x = testProjectileBlock();
  const y = testCpuTechs();
  const z = testCpuFinalSmash();
  const aa = testNoFsWhenRuleOff();
  const ab = testZeroNeverFights();
  const ac = testZeroWanders();
  const ad = testZeroGetsUp();
  const ae = testL10BeatsL9();
  const af = testL10Combos();
  const ag = testL10NoSelfDestruct();
  const ah = testL10Determinism();
  const ai = testL10Budget();
  const aj = testL10ReactionFloor();
  const ak = testTeams();
  const al = testL10KillSpeed();
  const am = testL10StrictBothStages();
  const an = testArchetypesNoLoss();
  const ao = testArchetypePrediction();
  const ap = testProfilePersistence();
  const aq = testKillRouting();
  const ar = testE6Budget();
  const as = testDeterminismWithStore();
  const at = testProfileCap();
  return [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z, aa, ab, ac, ad, ae, af, ag, ah, ai, aj, ak, al,
    am, an, ao, ap, aq, ar, as, at];
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('aitest.ts')) {
  const results = runAiSelfTest();
  process.stdout.write(
    `difficulty matrix (${SEEDS.length} seeds x both sides, ${MATRIX_STOCKS} stocks):\n`);
  for (let i = 0; i < matrix.length; i++) process.stdout.write(`${summaryLine(matrix[i])}\n`);

  process.stdout.write(`\nstacked-opponent scenarios (${VERT_SEEDS.length} seeds x both slots` +
    ` x dy ${VERT_DYS.join('/')} x dx ${VERT_DXS.join('/')}):\n`);
  process.stdout.write(`${vertGroupLine('opponent above', vertAbove)}\n`);
  process.stdout.write(`${vertGroupLine('opponent below', vertBelow)}\n`);

  process.stdout.write(`\nprojectile spammer (level 9 CPU vs scripted spam, ${SPAM_STOCKS} stocks):\n`);
  for (let i = 0; i < spamRuns.length; i++) {
    const r = spamRuns[i];
    process.stdout.write(`  ${r.label}: winner=${r.winnerIsCpu ? 'CPU' : 'SPAMMER'}` +
      ` stocks ${r.cpuStocks}-${r.spamStocks} volleys ${r.volleys}` +
      ` shieldHp low ${r.minShield.toFixed(2)}/60 sub-${SHIELD_LOW_WATER} run ${r.worstLowRun}f` +
      ` broken=${r.broke} ${r.frames}f\n`);
  }

  const hiOpt = optionsForLevels(9, 9);
  const loOpt = optionsForLevels(1, 2);
  process.stdout.write('\ndefensive option usage (whole matrix sweep):\n');
  process.stdout.write(`  level 9:   ${optionsLine(hiOpt.counts)} over ${hiOpt.frames}f | ${ratesLine(hiOpt.counts, hiOpt.frames)}\n`);
  process.stdout.write(`  level 1-2: ${optionsLine(loOpt.counts)} over ${loOpt.frames}f | ${ratesLine(loOpt.counts, loOpt.frames)}\n`);

  const hiKit = kitForLevels(9, 9);
  const loKit = kitForLevels(1, 2);
  process.stdout.write('\nkit coverage, uses (per 1k frames) over the whole matrix sweep:\n');
  process.stdout.write(`  level 9   moves: ${kitTable(hiKit.counts, hiKit.frames)}\n`);
  process.stdout.write(`  level 9   movement: ${movementLine(hiKit.counts, hiKit.frames)}\n`);
  process.stdout.write(`  level 1-2 moves: ${kitTable(loKit.counts, loKit.frames)}\n`);
  process.stdout.write(`  level 1-2 movement: ${movementLine(loKit.counts, loKit.frames)}\n\n`);

  const combo = aevalmereComboSummary('tidegate');
  process.stdout.write(`level 10 (Aevalmere), ${SEEDS.length} seeds x both sides, ${MATRIX_STOCKS} stocks:\n`);
  for (let i = 0; i < l10Runs.length; i++) process.stdout.write(`${l10Line(l10Runs[i])}\n`);
  process.stdout.write(`  budget: ${l10MsPerCall.toFixed(3)} ms per level 10 cpuInput call\n`);
  process.stdout.write(`  kill speed against a level 0 (${KILL_STOCKS} stocks):\n`);
  for (let i = 0; i < killRuns.length; i++) process.stdout.write(`${killLine(killRuns[i])}\n`);
  process.stdout.write(`  combo table: ${combo.entries} starter entries, ${combo.chains3} open 3+ hit chains,` +
    ` ${combo.chains4} open 4-hit chains, ${combo.kills} end in a KO; e.g. ${combo.example}\n`);
  for (let i = 0; i < STAGES.length; i++) {
    const cs = aevalmereComboSummary(STAGES[i]);
    process.stdout.write(`  ${STAGES[i]} combo table: ${cs.entries} entries, ${cs.chains3} 3+ hit, ${cs.chains4} 4-hit, ${cs.kills} KO chains\n`);
    process.stdout.write(`  ${STAGES[i]} kill confirms (lowest bracket): ${aevalmereKillConfirms(STAGES[i])}\n`);
  }
  process.stdout.write('\nlevel 10 vs level 9, strict, both stages:\n');
  for (let i = 0; i < strictRuns.length; i++) {
    const m = strictRuns[i];
    process.stdout.write(`  ${m.stage}: won ${m.wins}/${m.matches} stocks lost ${m.stocksLost} sd ${m.sd} avg ${Math.round(m.frames / m.matches)}f\n`);
  }
  process.stdout.write(`\nlevel 10 vs scripted archetypes (${ARCH_SEEDS.length} seeds, ${ARCH_STOCKS} stocks, fresh profile store each):\n`);
  for (let st = 0; st < STAGES.length; st++) for (let k = 0; k < ARCHETYPES.length; k++) process.stdout.write(`${archLine(ARCHETYPES[k], STAGES[st])}\n`);
  process.stdout.write('\nprofile transfer (predictor accuracy over the first 15 s, empty store -> saved profile):\n');
  for (let k = 0; k < ARCHETYPES.length; k++) {
    const ps = profilePairs.filter((r) => r.kind === ARCHETYPES[k]);
    process.stdout.write(`  ${ARCHETYPES[k]}: ${ps.map((r) => `${(r.empty * 100).toFixed(0)}->${(r.loaded * 100).toFixed(0)}`).join(' ')}\n`);
  }
  process.stdout.write(`\nkill routing vs the archetypes: ${killBreakdown}\n`);
  process.stdout.write('kill speed vs a standing dummy:\n');
  for (let i = 0; i < killRouteRuns.length; i++) {
    const r = killRouteRuns[i];
    process.stdout.write(`  ${r.stage} seed ${r.seed}: KOs ${r.koFrames.join('/')}\n`);
  }
  process.stdout.write('\nbudget with a host warm-up:\n');
  for (let i = 0; i < budgetRuns.length; i++) {
    const r = budgetRuns[i];
    process.stdout.write(`  ${r.stage}: mean ${r.mean.toFixed(3)} ms, p99 ${r.p99.toFixed(2)} ms, first call ${r.first.toFixed(2)} ms, ${r.calls} calls\n`);
  }
  process.stdout.write('\n');

  let passed = 0;
  let hard = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.info === true) {
      process.stdout.write(`INFO ${r.name}: ${r.detail}\n`);
      continue;
    }
    hard++;
    if (r.pass) passed++;
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
  }
  process.stdout.write(`${passed}/${hard} pass (${results.length - hard} info)\n`);
  if (passed !== hard) process.exitCode = 1;
}


