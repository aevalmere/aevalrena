import { Btn } from '../core/types';
import type { FighterState, GameState, InputFrame, MatchConfig, MoveId } from '../core/types';
import { CHARACTER_DEFS } from '../characters/registry';
import { nextFloat } from '../core/rng';
import { createGameState, stepGame } from '../sim';
import { cpuInput } from './index';

declare const process: {
  argv: string[];
  stdout: { write(text: string): void };
  exitCode?: number;
};

interface TestResult { name: string; pass: boolean; detail: string }

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

function cpuConfig(levelA: number, levelB: number, seed: number, stocks: number): MatchConfig {
  return {
    stageId: 'tidegate',
    players: [
      { slot: 0, charId: 'aeval', cpu: true, cpuLevel: levelA },
      { slot: 1, charId: 'aeval', cpu: true, cpuLevel: levelB },
    ],
    stocks,
    timeLimitSec: 0,
    seed,
  };
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

// 'getupatk' is deliberately absent from KIT_MOVES. It has a move def and a sprite, but the sim
// has no knockdown or getup state to start it from: ActionId carries no such action, and the only
// startMove of a getup-family move is ledgeatk in src/sim/ledge.ts. No input can reach it, so the
// CPU cannot be held to using it. Add it back once a knockdown state exists.
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
}

function emptyKit(): KitCounts {
  const moves: Record<string, number> = {};
  for (let i = 0; i < KIT_MOVES.length; i++) moves[KIT_MOVES[i]] = 0;
  moves.taunt = 0;
  return {
    moves, tauntNeutral: 0, shortHop: 0, fullHop: 0, fastFall: 0, dropThrough: 0,
    smashUses: 0, chargedSmashes: 0,
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
interface SimView { shortHop: boolean; dropTimer: number }
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
        if (id === 'taunt') {
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
      }
    }

    if (state.finished) { frame++; break; }
  }
  // A smash still charging when the match ended still counted as charged.
  for (let s = 0; s < 2; s++) {
    if (chargeMove[s] !== null && maxCharge[s] >= CHARGE_MIN) kit[s].chargedSmashes++;
  }
  return { state, frames: frame, koCount, selfDestructs, sdBySlot, aerialStarts, options, kit };
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
  const stacked = vertAbove.concat(vertBelow);
  for (let i = 0; i < stacked.length; i++) scenarioSd += stacked[i].sd;
  for (let i = 0; i < spamRuns.length; i++) scenarioSd += spamRuns[i].sd;
  if (scenarioSd > 0) offenders.push(`scripted scenarios ${scenarioSd}`);
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
      if (ev.type === 'ko' && state.fighters[ev.slot].lastHitBy === -1) sd++;
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
  parts.push(`taunt=${counts.moves.taunt}`);
  return parts.join(' ');
}

function movementLine(counts: KitCounts, frames: number): string {
  return `shortHop=${counts.shortHop}(${per1k(counts.shortHop, frames).toFixed(2)})` +
    ` fullHop=${counts.fullHop} fastFall=${counts.fastFall}` +
    ` dropThrough=${counts.dropThrough}` +
    ` smashes=${counts.smashUses} charged=${counts.chargedSmashes}`;
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
  return [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t];
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

  let passed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.pass) passed++;
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
  }
  process.stdout.write(`${passed}/${results.length} pass\n`);
  if (passed !== results.length) process.exitCode = 1;
}
