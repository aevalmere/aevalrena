/**
 * Shared fixtures for the unit files in this folder (plan wave 2: "unit checks run on cloned states
 * built by src/ai/eval/unit/fixtures.ts"). Not a test itself: cases/legacy.ts skips this file when
 * it runs the unit folder.
 *
 * Every fixture is built by the real sim: a match is created, stepped past the spawn frames, then
 * fighters are placed with charprofile's `place` (the same reset the profile probes use) or driven
 * into a state by stepping with inputs, so a fixture never holds a combination the sim cannot reach.
 * Take a `clone` before mutating a shared fixture.
 */
import { CHARACTER_DEFS } from '../../../characters/registry';
import type { FighterState, GameState, InputFrame, MatchConfig, Platform, StageDef } from '../../../core/types';
import { Btn, DIRECT_CODES } from '../../../core/types';
import { cloneGameState, createGameState, stepGame } from '../../../sim';
import type { SimFighter } from '../../../sim/state';
import { STAGE_DEFS } from '../../../stages/registry';
import { place } from '../../charprofile/probeHit';
import { isOffstage } from '../replay';

declare const process: { stdout: { write(text: string): void }; exitCode?: number };

export const FIX_STAGE = 'tidegate';
export const FIX_CHAR = 'aeval';
/** Frames stepped with no input after creation, past the spawn invulnerability. */
export const SETTLE_FRAMES = 90;

export interface FixtureOptions {
  stageId?: string;
  charIds?: readonly string[];
  stocks?: number;
  seed?: number;
  /** Team per slot; any value turns the Teams rule on. */
  teams?: readonly number[];
  /** CPU level written into the config per slot (the brain under test does not read it). */
  cpuLevel?: number;
  settle?: number;
}

/** A settled match of `n` fighters (default two Aevals on tidegate, 3 stocks, seed 777). */
export function makeState(n = 2, o: FixtureOptions = {}): GameState {
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < n; i++) {
    const p: MatchConfig['players'][number] = { slot: i, charId: o.charIds?.[i] ?? FIX_CHAR, cpu: true, cpuLevel: o.cpuLevel ?? 10 };
    if (o.teams !== undefined) p.team = o.teams[i];
    players.push(p);
  }
  const cfg: MatchConfig = {
    stageId: o.stageId ?? FIX_STAGE, players, stocks: o.stocks ?? 3, timeLimitSec: 0, seed: o.seed ?? 777,
    teams: o.teams !== undefined,
  };
  const s = createGameState(cfg);
  step(s, o.settle ?? SETTLE_FRAMES);
  return s;
}

export function clone(s: GameState): GameState { return cloneGameState(s); }

export function stageOfState(s: GameState): StageDef { return STAGE_DEFS[s.stageId]; }

/** The first solid platform (the main stage on every arena). */
export function mainPlatform(s: GameState): Platform {
  const st = stageOfState(s);
  for (const p of st.platforms) if (p.solid) return p;
  return st.platforms[0];
}

/** Main platform geometry: left and right edge x, top y, centre x. */
export function stageBox(s: GameState): { left: number; right: number; top: number; cx: number } {
  const p = mainPlatform(s);
  return { left: p.x, right: p.x + p.w, top: p.y, cx: p.x + p.w / 2 };
}

function fighter(s: GameState, i: number): SimFighter { return s.fighters[i] as SimFighter; }

/** Grounded, idle, on the main platform at `x`. */
export function put(s: GameState, i: number, x: number, facing: 1 | -1 = 1, percent = 0): FighterState {
  const f = fighter(s, i);
  place(f, CHARACTER_DEFS[f.charId], x, mainPlatform(s).y, true);
  f.facing = facing;
  f.percent = percent;
  f.inputHeld = 0;
  return f;
}

/** Airborne and idle at (x, y) with a velocity; jumps and air dodge restored. */
export function putAir(s: GameState, i: number, x: number, y: number, vx = 0, vy = 0, percent = 0): FighterState {
  const f = fighter(s, i);
  place(f, CHARACTER_DEFS[f.charId], x, y, false);
  f.vx = vx;
  f.vy = vy;
  f.percent = percent;
  f.inputHeld = 0;
  return f;
}

/** Puts two fighters facing each other `gap` px apart around the stage centre. */
export function faceOff(s: GameState, gap: number, a = 0, b = 1, pctA = 0, pctB = 0): void {
  const { cx } = stageBox(s);
  put(s, a, cx - gap / 2, 1, pctA);
  put(s, b, cx + gap / 2, -1, pctB);
}

export const NO_INPUT: InputFrame = { held: 0, pressed: 0, released: 0 };

function frame(held: number, prevHeld: number): InputFrame {
  return { held, pressed: held & ~prevHeld, released: prevHeld & ~held };
}

/** Steps `frames` frames with no input for every fighter. */
export function step(s: GameState, frames: number): void {
  const empty = s.fighters.map(() => NO_INPUT);
  for (let k = 0; k < frames; k++) stepGame(s, empty);
}

/**
 * Steps with a scripted input per fighter: `script(i, t)` returns the held bits of fighter `i` on
 * frame `t` (pressed and released are derived). Stops early when `until` returns true.
 */
export function stepWith(s: GameState, frames: number, script: (i: number, t: number) => number,
  until?: (s: GameState, t: number) => boolean): number {
  const prev = s.fighters.map((f) => f.inputHeld);
  for (let t = 0; t < frames; t++) {
    const ins = s.fighters.map((_f, i) => frame(script(i, t), prev[i]));
    for (let i = 0; i < ins.length; i++) prev[i] = ins[i].held;
    stepGame(s, ins);
    if (until !== undefined && until(s, t)) return t + 1;
  }
  return frames;
}

/** 1-based direct code of a named move (DIRECT_CODES order), 0 when unknown. */
export function directCode(name: string): number {
  return (DIRECT_CODES as readonly string[]).indexOf(name) + 1;
}

/**
 * Fighter `i` starts a move by its direct code this frame (others idle) and the sim steps once, so
 * the returned state has the move at actionFrame 1. Returns false when the move did not start.
 */
export function startMove(s: GameState, i: number, move: string): boolean {
  const code = directCode(move);
  if (code === 0) return false;
  const ins: InputFrame[] = s.fighters.map(() => ({ ...NO_INPUT }));
  ins[i].direct = code;
  stepGame(s, ins);
  const f = s.fighters[i];
  return f.action === 'attack' && f.moveId === move;
}

/** Fighter `i` holds shield for `frames` frames (the others idle). */
export function holdShield(s: GameState, i: number, frames = 4): void {
  stepWith(s, frames, (j) => (j === i ? Btn.Shield : 0));
}

/**
 * Drops fighter `i` just outside a ledge of the main platform (side -1 left, +1 right) and steps
 * with no input until the sim snaps it to the ledge. Returns true when it hangs.
 */
export function hangOnLedge(s: GameState, i: number, side: -1 | 1 = 1): boolean {
  const b = stageBox(s);
  const x = side > 0 ? b.right + 8 : b.left - 8;
  const f = putAir(s, i, x, b.top + 10, 0, 1);
  f.facing = side > 0 ? -1 : 1;
  const n = stepWith(s, 40, () => 0, (st) => st.fighters[i].action === 'ledgeHang');
  return n < 40 || s.fighters[i].action === 'ledgeHang';
}

/**
 * Fighter `i` offstage by `out` px past an edge and `below` px under the stage top, falling, with
 * its double jump available when `jump` is true.
 */
export function putOffstage(s: GameState, i: number, side: -1 | 1, out: number, below: number, jump = true, percent = 60): FighterState {
  const b = stageBox(s);
  const x = side > 0 ? b.right + out : b.left - out;
  const f = putAir(s, i, x, b.top + below, 0, 2, percent);
  f.facing = side > 0 ? -1 : 1;
  if (!jump) f.jumpsLeft = 0;
  return f;
}

/**
 * Fighter `att` hits fighter `vic` with `move` from `gap` px, both grounded and facing each other;
 * steps until `vic` is in hitstun or tumble (at most 40 frames). Returns true when the hit landed.
 */
export function launch(s: GameState, att: number, vic: number, move: string, gap = 20, vicPct = 80): boolean {
  const { cx } = stageBox(s);
  put(s, att, cx - gap / 2, 1);
  put(s, vic, cx + gap / 2, -1, vicPct);
  if (!startMove(s, att, move)) return false;
  const hurt = (st: GameState): boolean => st.fighters[vic].action === 'hitstun' || st.fighters[vic].action === 'tumble';
  stepWith(s, 40, () => 0, (st) => hurt(st));
  return hurt(s);
}

export function offstage(s: GameState, i: number): boolean { return isOffstage(stageOfState(s), s.fighters[i]); }

// ---- a tiny check harness the unit files can share ----

export interface Checker { check(name: string, ok: boolean, detail?: string): void; done(label: string): void; readonly failures: number }

/** PASS / FAIL lines on stdout; `done` prints the summary and sets a non-zero exit code on failure. */
export function checker(): Checker {
  let failures = 0;
  let checks = 0;
  return {
    get failures() { return failures; },
    check(name: string, ok: boolean, detail = ''): void {
      checks++;
      if (!ok) failures++;
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? `: ${detail}` : ''}\n`);
    },
    done(label: string): void {
      process.stdout.write(`${label}: ${checks - failures}/${checks} pass\n`);
      if (failures > 0) process.exitCode = 1;
    },
  };
}
