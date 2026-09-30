import { CHARACTER_DEFS } from '../characters/registry';
import { TUNING } from '../core/constants';
import type { CharacterDef, GameState, InputFrame, MatchConfig, MoveDef, MoveId } from '../core/types';
import { createGameState, stepGame } from './index';
import { enterBranch, startMove } from './moves';
import { simFighters, type SimFighter } from './state';

/**
 * Knockout calibration harness. Aeval against Aeval by default; `--char <id>` picks the
 * attacker and `--victim <id>` the victim (default: the attacker's own character).
 *
 * P1 stands at x -20 facing right, P2 (no input) stands to its right at
 * center stage. For every move with a hitbox or a projectile the harness binary
 * searches the lowest victim percent at which the move kills inside 240 frames.
 * Aerials start on the first airborne frame, 30 px above the stage.
 *
 * Some moves cannot reach a victim 40 px away (the vertical normals and the
 * whirlpool are centered on the attacker), so the harness probes closer spots
 * and prints the gap and the lift it ended up using.
 *
 * Crits are switched off while measuring (an attacker with `crit` is measured without it), so
 * every number is the base hit. A counter move (Trekmore's dspecial) is measured on its branch
 * as if it had just absorbed a hit: 'ko %' repays its minDamage, 'full ko %' its maxDamage.
 */

declare const process: {
  argv: string[];
  stdout: { write(text: string): void };
  exitCode?: number;
};

const DEFAULT_CHAR = 'aeval';
const ATTACKER_X = -20;
/**
 * Victim placements tried in order; the first one the move can reach is used.
 * gap is px to the right of the attacker, lift is px above the attacker's feet.
 * The upward normals are centered on the attacker and cannot touch a victim
 * standing 40 px away, so the harness closes the gap and finally lifts the
 * victim overhead for the anti-airs.
 */
const PLACEMENTS: { gap: number; lift: number }[] = [
  { gap: 40, lift: 0 },
  { gap: 26, lift: 0 },
  { gap: 0, lift: 0 },
  { gap: 0, lift: 44 },
];
const KO_FRAMES = 240;
const MAX_PERCENT = 300;
const AIR_HEIGHT = 30;
const SETTLE_FRAMES = 10;

const NONE: InputFrame = { held: 0, pressed: 0, released: 0 };
const PAIR: InputFrame[] = [NONE, NONE];

/** Moves whose knockback is tuned against a target. dair is a spike, it sends down. */
const AERIALS: MoveId[] = ['nair', 'fair', 'bair', 'uair', 'dair'];

export interface MoveReport {
  move: MoveId;
  gap: number;
  lift: number;
  koPercent: number;        // -1 when it never kills at or below MAX_PERCENT
  chargedKoPercent: number; // -1 when the move is not chargeable
  kbAt100: number;
}

/** Attacker and victim character ids for one calibration run. */
interface Matchup { atk: string; vic: string }

function matchConfig(m: Matchup): MatchConfig {
  return {
    stageId: 'tidegate',
    players: [
      { slot: 0, charId: m.atk, cpu: false, cpuLevel: 0 },
      { slot: 1, charId: m.vic, cpu: false, cpuLevel: 0 },
    ],
    stocks: 3,
    timeLimitSec: 0,
    seed: 1,
  };
}

function place(f: SimFighter, x: number, y: number, grounded: boolean): void {
  f.x = x;
  f.y = y;
  f.prevY = y;
  f.vx = 0;
  f.vy = 0;
  f.onGround = grounded;
  f.action = grounded ? 'idle' : 'air';
  f.actionFrame = 0;
  f.moveId = null;
  f.charge = 0;
  f.charging = false;
  f.hitGroups = 0;
  f.hitstun = 0;
  f.hitlag = 0;
  f.invuln = 0;
  f.kbSpeed = 0;
  f.kbFall = 0;
  f.fastFalling = false;
}

interface Trial { ko: boolean; hit: boolean; maxKb: number }

/** One run of one move against a victim at the given percent. */
function trial(move: MoveId, percent: number, charge: boolean, spot: { gap: number; lift: number }, m: Matchup): Trial {
  const state: GameState = createGameState(matchConfig(m));
  for (let i = 0; i < SETTLE_FRAMES; i++) stepGame(state, PAIR);

  const fighters = simFighters(state);
  const atk = fighters[0];
  const vic = fighters[1];
  const def = CHARACTER_DEFS[m.atk];
  const airborne = AERIALS.indexOf(move) >= 0;

  place(atk, ATTACKER_X, airborne ? -AIR_HEIGHT : 0, !airborne);
  atk.facing = 1;
  atk.jumpsLeft = def.jumps;
  const vicY = spot.lift === 0 ? 0 : (airborne ? -AIR_HEIGHT : 0) - spot.lift;
  place(vic, ATTACKER_X + spot.gap, vicY, spot.lift === 0);
  vic.facing = -1;
  vic.percent = percent;

  startMove(state, atk, def, move);
  const mv = def.moves[move];
  if (mv.counter !== undefined && mv.branch !== undefined) {
    // A counter repays what it absorbed: min on the plain run, max on the "charged" one.
    atk.counterDamage = charge ? mv.counter.maxDamage : mv.counter.minDamage;
    enterBranch(state, atk, mv);
  } else if (charge) {
    atk.charge = TUNING.input.chargeMax;
  }

  const out: Trial = { ko: false, hit: false, maxKb: 0 };
  for (let i = 0; i < KO_FRAMES; i++) {
    stepGame(state, PAIR);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'hit' && ev.victim === 1) {
        out.hit = true;
        if (ev.kb > out.maxKb) out.maxKb = ev.kb;
      }
      if (ev.type === 'ko' && ev.slot === 1) out.ko = true;
    }
    if (out.ko) break;
  }
  return out;
}

/** The first placement the move can actually connect from. */
function pickSpot(move: MoveId, m: Matchup): { gap: number; lift: number } {
  for (let i = 0; i < PLACEMENTS.length; i++) {
    if (trial(move, 0, false, PLACEMENTS[i], m).hit) return PLACEMENTS[i];
  }
  return PLACEMENTS[0];
}

function lowestKoPercent(move: MoveId, charge: boolean, spot: { gap: number; lift: number }, m: Matchup): number {
  if (!trial(move, MAX_PERCENT, charge, spot, m).ko) return -1;
  let lo = 0;
  let hi = MAX_PERCENT;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trial(move, mid, charge, spot, m).ko) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function hasOutput(mv: MoveDef): boolean {
  if (mv.hitboxes.length > 0) return true;
  return mv.projectiles !== undefined && mv.projectiles.length > 0;
}

/**
 * Runs `fn` with the attacker's crit switched off, restoring the registered def after, so a
 * crit roll never moves a measured knockout percent.
 */
function withoutCrit<T>(charId: string, fn: () => T): T {
  const def: CharacterDef = CHARACTER_DEFS[charId];
  if (def.crit === undefined) return fn();
  CHARACTER_DEFS[charId] = { ...def, crit: undefined };
  try {
    return fn();
  } finally {
    CHARACTER_DEFS[charId] = def;
  }
}

/** Full report for one move: placement, knockout percents, launch kb at 100 percent. */
export function measure(move: MoveId, charId = DEFAULT_CHAR, victimId = charId): MoveReport {
  const m: Matchup = { atk: charId, vic: victimId };
  return withoutCrit(charId, () => {
    const mv = CHARACTER_DEFS[charId].moves[move];
    const spot = pickSpot(move, m);
    const twoRuns = mv.chargeable === true || mv.counter !== undefined;
    return {
      move,
      gap: spot.gap,
      lift: spot.lift,
      koPercent: lowestKoPercent(move, false, spot, m),
      chargedKoPercent: twoRuns ? lowestKoPercent(move, true, spot, m) : -1,
      kbAt100: trial(move, 100, false, spot, m).maxKb,
    };
  });
}

export function calibrate(charId = DEFAULT_CHAR, victimId = charId): MoveReport[] {
  const def = CHARACTER_DEFS[charId];
  const ids = Object.keys(def.moves) as MoveId[];
  const out: MoveReport[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!hasOutput(def.moves[ids[i]])) continue;
    out.push(measure(ids[i], charId, victimId));
  }
  return out;
}

function pad(text: string, width: number): string {
  let s = text;
  while (s.length < width) s += ' ';
  return s;
}

function padLeft(text: string, width: number): string {
  let s = text;
  while (s.length < width) s = ` ${s}`;
  return s;
}

function cell(value: number): string {
  return value < 0 ? 'none' : String(value);
}

export function formatTable(rows: MoveReport[]): string {
  let out = `${pad('move', 10)}${padLeft('gap', 5)}${padLeft('lift', 6)}${padLeft('ko %', 8)}${padLeft('full ko %', 11)}${padLeft('kb at 100', 11)}\n`;
  out += `${'-'.repeat(51)}\n`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    out += pad(r.move, 10);
    out += padLeft(String(r.gap), 5);
    out += padLeft(String(r.lift), 6);
    out += padLeft(cell(r.koPercent), 8);
    out += padLeft(r.chargedKoPercent < 0 ? '-' : cell(r.chargedKoPercent), 11);
    out += padLeft(r.kbAt100.toFixed(1), 11);
    out += '\n';
  }
  return out;
}

/** The value after `flag` on the command line, or undefined. */
function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('calibrate.ts')) {
  const charId = argValue(process.argv, '--char') ?? DEFAULT_CHAR;
  const victimId = argValue(process.argv, '--victim') ?? charId;
  if (CHARACTER_DEFS[charId] === undefined || CHARACTER_DEFS[victimId] === undefined) {
    process.stdout.write(`unknown character: ${CHARACTER_DEFS[charId] === undefined ? charId : victimId}\n`);
    process.exitCode = 1;
  } else {
    if (charId !== DEFAULT_CHAR || victimId !== charId) process.stdout.write(`${charId} vs ${victimId}\n`);
    process.stdout.write(formatTable(calibrate(charId, victimId)));
  }
}
