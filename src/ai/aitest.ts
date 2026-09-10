import { Btn } from '../core/types';
import type { FighterState, GameState, InputFrame, MatchConfig } from '../core/types';
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

interface CpuMatchRun {
  state: GameState;
  frames: number;
  koCount: number;
  selfDestructs: number;
  aerialStarts: number[][];
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
  const aerialStarts: number[][] = [[], []];
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
      prevMoveId[s] = id;
    }

    for (let i = 0; i < state.events.length; i++) {
      const ev = state.events[i];
      if (ev.type === 'ko') {
        koCount++;
        const victim = state.fighters[ev.slot];
        if (victim && victim.lastHitBy === -1) selfDestructs++;
      }
    }

    if (state.finished) { frame++; break; }
  }
  return { state, frames: frame, koCount, selfDestructs, aerialStarts };
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
let runB: CpuMatchRun | null = null;

function testL1v1(): TestResult {
  runA = runCpuMatch(1, 1, 20000, 5, 1);
  const ok = runA.state.finished && runA.koCount >= 1;
  return {
    name: 'a. level 1 vs level 1 finishes with a KO',
    pass: ok,
    detail: `finished=${runA.state.finished} frames=${runA.frames} kos=${runA.koCount}`,
  };
}

function testL3v3(): TestResult {
  runB = runCpuMatch(3, 3, 12000, 2, 1);
  const ok = runB.state.finished;
  return {
    name: 'b. level 3 vs level 3 finishes',
    pass: ok,
    detail: `finished=${runB.state.finished} frames=${runB.frames} kos=${runB.koCount}`,
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
    name: 'c. level 2 CPU hits a ledge-hanging opponent',
    pass: ok,
    detail: `p2 max percent=${p2MaxPercent.toFixed(1)} cpuDied=${cpuDied}`,
  };
}

function testAerialCooldown(): TestResult {
  if (!runA || !runB) return { name: 'd. aerial cooldown respected', pass: false, detail: 'prior runs missing' };
  const a = aerialSpacingOk(runA.aerialStarts);
  const b = aerialSpacingOk(runB.aerialStarts);
  return {
    name: 'd. no two aerials from the same slot start within 45 frames',
    pass: a.ok && b.ok,
    detail: `l1v1: ${a.detail} | l3v3: ${b.detail}`,
  };
}

function testNoSelfDestruct(): TestResult {
  if (!runA || !runB) return { name: 'e. no self-destructs', pass: false, detail: 'prior runs missing' };
  const ok = runA.selfDestructs === 0 && runB.selfDestructs === 0;
  return {
    name: 'e. no self-destructs in l1v1 or l3v3',
    pass: ok,
    detail: `l1v1 selfDestructs=${runA.selfDestructs} l3v3 selfDestructs=${runB.selfDestructs}`,
  };
}

export function runAiSelfTest(): TestResult[] {
  const a = testL1v1();
  const b = testL3v3();
  const c = testLedgeApproach();
  const d = testAerialCooldown();
  const e = testNoSelfDestruct();
  return [a, b, c, d, e];
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('aitest.ts')) {
  const results = runAiSelfTest();
  let passed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.pass) passed++;
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
  }
  process.stdout.write(`${passed}/${results.length} pass\n`);
  if (passed !== results.length) process.exitCode = 1;
}
