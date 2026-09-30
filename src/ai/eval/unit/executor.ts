/**
 * Unit check for the executor and reflexes (W2.13).
 * Run: npx --yes tsx src/ai/eval/unit/executor.ts
 *
 * Every scenario drives the real sim through the executor with an input queue of `inputDelay`
 * frames, the way the harness runner and the LAN host do.
 */
import { Btn } from '../../../core/types';
import type { GameState, InputFrame, MatchConfig, MoveId } from '../../../core/types';
import { TUNING } from '../../../core/constants';
import { createGameState, stepGame } from '../../../sim';
import { MASH_CREDIT_FRAMES } from '../../../sim/grab';
import { setAction, type SimFighter } from '../../../sim/state';
import { getAiProfile } from '../../charprofile/derive';
import type { DecisionView, Intent, LevelVector, PlanCtx, PlanInstance } from '../../contracts';
import {
  CpuExecutor, MOVE_CODE, followUpTick, fullHop, shortHop, smashFlick, type SpacingResult,
} from '../../executor';
import { levelVector } from '../../levels';
import { lastReflex, runReflexes } from '../../reflexes';

declare const process: { stdout: { write(text: string): void }; exitCode?: number };

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? `: ${detail}` : ''}\n`);
}
function info(name: string, detail: string): void { process.stdout.write(`INFO ${name}: ${detail}\n`); }

const STAGE = 'tidegate';
const GOD = levelVector(1, true);
const L1 = levelVector(0, false);
const L2 = levelVector(0.25, false);
const L3 = levelVector(0.5, false);
const L4 = levelVector(0.75, false);
const L5 = levelVector(1, false);

function config(seed: number): MatchConfig {
  return {
    stageId: STAGE, stocks: 3, timeLimitSec: 0, seed,
    players: [{ slot: 0, charId: 'aeval', cpu: true, cpuLevel: 9 }, { slot: 1, charId: 'aeval', cpu: true, cpuLevel: 9 }],
  };
}

const NEUTRAL: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };

/** Fresh match with both fighters standing; fighter 1 moved `oppDx` px from fighter 0. */
function freshState(seed: number, oppDx: number): GameState {
  const s = createGameState(config(seed));
  for (let i = 0; i < 40; i++) stepGame(s, [NEUTRAL, NEUTRAL]);
  const a = s.fighters[0], b = s.fighters[1];
  b.x = a.x + oppDx;
  b.facing = oppDx >= 0 ? -1 : 1;
  a.facing = oppDx >= 0 ? 1 : -1;
  for (let i = 0; i < 5; i++) stepGame(s, [NEUTRAL, NEUTRAL]);
  return s;
}

function copyInput(src: InputFrame, dst: InputFrame): void {
  dst.held = src.held; dst.pressed = src.pressed; dst.released = src.released; dst.direct = src.direct ?? 0;
}

/** Drives one executor slot through an input queue of `delay` frames; other slots get `other`. */
class Driver {
  readonly exec: CpuExecutor;
  private readonly queue: InputFrame[] = [];
  private readonly tmp: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
  private readonly inputs: InputFrame[] = [];
  readonly intent: Intent = { held: 0, direct: 0, mash: 0 };
  tick = 0;
  constructor(readonly meI: number, readonly delay: number) {
    this.exec = new CpuExecutor(meI, delay);
    for (let i = 0; i <= delay; i++) this.queue.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  }
  /** Emits for the current intent, then steps the sim once. Returns the frame just emitted. */
  step(s: GameState, level: LevelVector, other: InputFrame = NEUTRAL): InputFrame {
    const o = this.exec.emit(s, this.meI, this.intent, level, this.tmp);
    const qlen = this.delay + 1;
    copyInput(o, this.queue[this.tick % qlen]);
    const applied = this.queue[(this.tick + 1) % qlen];
    this.inputs.length = s.fighters.length;
    for (let i = 0; i < s.fighters.length; i++) this.inputs[i] = i === this.meI ? applied : other;
    stepGame(s, this.inputs);
    this.tick++;
    return o;
  }
}

function view(s: GameState, meI: number, level: LevelVector): DecisionView {
  return {
    p: { state: s, meI, oppI: 1 - meI, frame: s.frame, age: 0, ownDelay: 0, hyps: [], passivity: 0,
      framesSinceEdge: 0, framesSinceAttack: 0, newEvent: false },
    level, seed: s.config.seed, slot: meI,
  } as unknown as DecisionView;
}

// ---------------------------------------------------------------------------------------------
// 1. Short hop and full hop heights
// ---------------------------------------------------------------------------------------------
{
  const prof = getAiProfile('aeval', STAGE);
  const js = prof.physics.jumpSquat;
  const rise = (full: boolean, delay: number, level: LevelVector): number => {
    const s = freshState(3, 200);
    const dr = new Driver(0, delay);
    const f = s.fighters[0];
    const y0 = f.y;
    let minY = y0;
    for (let t = 0; t < 70; t++) {
      if (full) fullHop(t, js, 0, dr.intent); else shortHop(t, 0, dr.intent);
      dr.step(s, level);
      if (f.y < minY) minY = f.y;
    }
    return y0 - minY;
  };
  for (const delay of [0, 1, 2, 3]) {
    const sh = rise(false, delay, GOD);
    const fh = rise(true, delay, GOD);
    check(`short hop at inputDelay ${delay} reaches the sim's short hop height`, Math.abs(sh - prof.recovery.rise.shortHop) < 0.5,
      `${sh.toFixed(2)} vs ${prof.recovery.rise.shortHop.toFixed(2)}`);
    check(`full hop at inputDelay ${delay} reaches the sim's full hop height`, Math.abs(fh - prof.recovery.rise.fullHop) < 0.5,
      `${fh.toFixed(2)} vs ${prof.recovery.rise.fullHop.toFixed(2)}`);
  }
  // At world's best the program is jittered but a 3-frame short hop window is rarely missed.
  let ok = 0;
  const n = 40;
  for (let seed = 1; seed <= n; seed++) {
    const s = freshState(seed, 200);
    const dr = new Driver(0, 1);
    const f = s.fighters[0];
    const y0 = f.y;
    let minY = y0;
    for (let t = 0; t < 70; t++) { shortHop(t, 0, dr.intent); dr.step(s, L5); if (f.y < minY) minY = f.y; }
    if (Math.abs(y0 - minY - prof.recovery.rise.shortHop) < 0.5) ok++;
  }
  info('short hop success at world\'s best over 40 seeds', `${ok}/${n}`);
}

// ---------------------------------------------------------------------------------------------
// 2. Smash flick registers as a smash; a late Attack after a fresh direction stays a tilt
// ---------------------------------------------------------------------------------------------
{
  const firstMove = (prog: (t: number, out: Intent) => void, delay: number, level: LevelVector): MoveId | null => {
    const s = freshState(5, 200);
    const dr = new Driver(0, delay);
    const f = s.fighters[0];
    for (let t = 0; t < 30; t++) {
      prog(t, dr.intent);
      dr.step(s, level);
      if (f.action === 'attack') return f.moveId;
    }
    return null;
  };
  const cases: [number, MoveId, string][] = [[Btn.Right, 'fsmash', 'right'], [Btn.Left, 'fsmash', 'left'],
    [Btn.Up, 'usmash', 'up'], [Btn.Down, 'dsmash', 'down']];
  for (const [bit, want, name] of cases) {
    for (const delay of [0, 2]) {
      const got = firstMove((t, out) => { if (t < 2) smashFlick(t, bit, out); else { out.held = 0; out.direct = 0; } }, delay, GOD);
      check(`smash flick ${name} at inputDelay ${delay} registers as ${want}`, got === want, String(got));
    }
  }
  // Down pressed, Attack two frames later: the sim would read a down smash; the guard makes it a tilt.
  const tilt = firstMove((t, out) => { out.held = t >= 0 ? Btn.Down | (t >= 2 ? Btn.Attack : 0) : 0; out.direct = 0; }, 1, GOD);
  check('Attack 2 frames after a fresh Down stays a down tilt (guard adds Walk)', tilt === 'dtilt', String(tilt));
}

// ---------------------------------------------------------------------------------------------
// 3. Tech reflex: techs a scripted knockdown at god, misses it at level 1 and under the floor
// ---------------------------------------------------------------------------------------------
{
  const DELAY = 1;
  /** Puts fighter 0 into a tumble `h` px above the floor, falling, hitstun 3. */
  const knock = (s: GameState, h: number): void => {
    const f = s.fighters[0] as SimFighter;
    f.y -= h; f.onGround = false; f.vx = 0; f.vy = 0;
    setAction(f, 'tumble');
    f.hitstun = 3; f.kbSpeed = 0; f.kbFall = 0; f.kbDirX = 0; f.kbDirY = 0;
  };
  const landSteps = (h: number): number => {
    const s = freshState(9, 220);
    knock(s, h);
    for (let t = 1; t <= 120; t++) { stepGame(s, [NEUTRAL, NEUTRAL]); if (s.fighters[0].onGround) return t; }
    return -1;
  };
  const heightFor = (steps: number): number => {
    for (let h = 2; h < 400; h++) if (landSteps(h) === steps) return h;
    return -1;
  };
  const run = (h: number, level: LevelVector): string => {
    const s = freshState(9, 220);
    knock(s, h);
    const dr = new Driver(0, DELAY);
    const f = s.fighters[0];
    for (let t = 0; t < 120; t++) {
      if (!runReflexes(view(s, 0, level), dr.exec, dr.intent)) { dr.intent.held = 0; dr.intent.direct = 0; dr.intent.mash = 0; }
      dr.step(s, level);
      if (f.action === 'tech' || f.action === 'techRoll') return 'tech';
      if (f.action === 'downed') return 'downed';
    }
    return f.action;
  };
  const hShort = heightFor(9);
  const hLong = heightFor(34);
  check('found knockdown heights landing in 9 and 34 frames', hShort > 0 && hLong > 0, `${hShort}, ${hLong}`);
  check('god techs a knockdown landing 9 frames after the launch', run(hShort, GOD) === 'tech', run(hShort, GOD));
  check('level 1 misses it (no tech in its vocabulary, reaction floor 10)', run(hShort, L1) === 'downed', run(hShort, L1));
  check('level 2 misses the 9-frame landing under its reaction floor', run(hShort, L2) === 'downed', run(hShort, L2));
  check('level 2 techs a knockdown landing 34 frames after the launch', run(hLong, L2) === 'tech', run(hLong, L2));
  check('level 1 still misses the 34-frame landing (vocabulary)', run(hLong, L1) === 'downed', run(hLong, L1));
  // No Shield or Dodge press while launched, from either the plan or the reflex.
  {
    const s = freshState(9, 220);
    knock(s, hLong);
    const dr = new Driver(0, DELAY);
    let bad = 0;
    for (let t = 0; t < 60; t++) {
      const f = s.fighters[0];
      const launched = f.action === 'tumble' || f.action === 'hitstun';
      if (!runReflexes(view(s, 0, L3), dr.exec, dr.intent)) { dr.intent.held = Btn.Shield | Btn.Attack; dr.intent.direct = 0; }
      else dr.intent.held |= Btn.Shield | Btn.Dodge | Btn.Attack;   // a leaky plan layered over the reflex
      const o = dr.step(s, L3);
      if (launched && ((o.pressed & (Btn.Shield | Btn.Dodge)) !== 0 || (f.hitstun > 0 && (o.pressed & Btn.Attack) !== 0))) bad++;
    }
    check('no Shield or Dodge press while launched, no Attack in hitstun', bad === 0, `${bad} bad frames`);
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Input-rate cap
// ---------------------------------------------------------------------------------------------
{
  const BITS = [Btn.Jump, Btn.Attack, Btn.Left, Btn.Special, Btn.Right, Btn.Grab];
  const count = (level: LevelVector, frames: number): number[] => {
    const s = freshState(11, 200);
    const dr = new Driver(0, 1);
    const ev: number[] = [];
    for (let t = 0; t < frames; t++) {
      dr.intent.held = BITS[t % BITS.length];
      dr.intent.direct = 0;
      const o = dr.step(s, level);
      ev.push(o.pressed !== 0 || (o.direct ?? 0) !== 0 ? 1 : 0);
      if (s.finished) break;
    }
    return ev;
  };
  const worstWindow = (ev: number[], w: number): number => {
    let sum = 0, worst = 0;
    for (let i = 0; i < ev.length; i++) {
      sum += ev[i];
      if (i >= w) sum -= ev[i - w];
      if (i >= w - 1 && sum > worst) worst = sum;
    }
    return worst;
  };
  for (const [name, lv] of [['level 1', L1], ['level 2', L2], ['level 3', L3], ['world\'s best', L5]] as [string, LevelVector][]) {
    const ev = count(lv, 1800);
    const cap = lv.eventsPerSec * 10;
    const w = worstWindow(ev, 600);
    check(`${name}: input events in any 600-frame window stay under ${cap} (guide cap)`, w <= cap, `${w}`);
  }
  const godEv = worstWindow(count(GOD, 600), 600);
  check('god is uncapped (mash aside)', godEv > 55, `${godEv}`);
}

// ---------------------------------------------------------------------------------------------
// 5. Mash: never faster than the level rate or the sim credit
// ---------------------------------------------------------------------------------------------
{
  const grabbedState = (victimI: number): GameState | null => {
    const s = freshState(13, victimI === 0 ? 18 : -18);
    const holderI = 1 - victimI;
    const grab: InputFrame = { held: Btn.Grab, pressed: Btn.Grab, released: 0, direct: 0 };
    const ins: InputFrame[] = [NEUTRAL, NEUTRAL];
    for (let t = 0; t < 30; t++) {
      ins[holderI] = t === 0 ? grab : NEUTRAL;
      ins[victimI] = NEUTRAL;
      stepGame(s, ins);
      if (s.fighters[victimI].action === 'grabbed') return s;
    }
    return null;
  };
  const run = (victimI: number, level: LevelVector, delay: number) => {
    const s = grabbedState(victimI);
    if (s === null) return null;
    const holder = s.fighters[1 - victimI] as SimFighter;
    const dr = new Driver(victimI, delay);
    const pressAt: number[] = [];
    const creditAt: number[] = [];
    let prevTimer = holder.grabTimer;
    let frames = 0;
    for (let t = 0; t < 400; t++) {
      if (s.fighters[victimI].action !== 'grabbed') break;
      if (!runReflexes(view(s, victimI, level), dr.exec, dr.intent)) { dr.intent.held = 0; dr.intent.direct = 0; dr.intent.mash = 0; }
      const o = dr.step(s, level);
      frames++;
      if (o.pressed !== 0) pressAt.push(t);
      const timer = holder.grabTimer;
      if (prevTimer - timer > 1.5) creditAt.push(t);
      prevTimer = timer;
    }
    const minGap = (a: number[]): number => { let m = Infinity; for (let i = 1; i < a.length; i++) m = Math.min(m, a[i] - a[i - 1]); return m; };
    return { presses: pressAt.length, credits: creditAt.length, pressGap: minGap(pressAt), creditGap: minGap(creditAt), frames,
      reflex: lastReflex(dr.exec) };
  };
  for (const victimI of [0, 1]) {
    for (const [name, lv] of [['god', GOD], ['world\'s best', L5], ['level 3', L3]] as [string, LevelVector][]) {
      const r = run(victimI, lv, 1);
      if (r === null) { check(`mash ${name} (victim ${victimI}): grab set up`, false); continue; }
      const gap = Math.max(lv.mashEvery, MASH_CREDIT_FRAMES);
      check(`mash ${name} (victim index ${victimI}): presses at least ${gap} frames apart, credits at least ${gap} apart`,
        r.presses > 0 && r.pressGap >= gap && (r.credits < 2 || r.creditGap >= gap),
        `presses ${r.presses}, credits ${r.credits}, press gap ${r.pressGap}, credit gap ${r.creditGap}, out in ${r.frames}`);
      check(`mash ${name} (victim index ${victimI}): every press is credited (parity aligned)`, r.credits >= r.presses - 1,
        `${r.credits}/${r.presses}`);
    }
    const r1 = run(victimI, L1, 1);
    check(`mash level 1 (victim index ${victimI}): no mash at all`, r1 !== null && r1.presses === 0, r1 === null ? 'no grab' : `${r1.presses}`);
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Tap mirror: repeated same-direction taps never roll, at any input delay
// ---------------------------------------------------------------------------------------------
{
  let rolls = 0, runs = 0;
  for (const lv of [GOD, L4]) {
    for (let delay = 1; delay <= 4; delay++) {
      for (let seed = 1; seed <= 25; seed++) {
        const s = freshState(seed, 250);
        const dr = new Driver(0, delay);
        const f = s.fighters[0];
        let spot = 0;
        for (let t = 0; t < 200; t++) {
          const phase = (t + seed) % (5 + (seed % 4));
          dr.intent.held = phase < 2 ? (seed % 2 === 0 ? Btn.Right : Btn.Left) : phase === 3 && seed % 3 === 0 ? Btn.Down : 0;
          dr.intent.direct = 0;
          dr.step(s, lv);
          if (f.action === 'roll') rolls++;
          if (f.action === 'spotDodge') spot++;
        }
        rolls += spot;
        runs++;
      }
    }
  }
  check('no accidental rolls or spot dodges from tapping (inputDelay 1 to 4, 200 runs)', rolls === 0, `${rolls} frames in ${runs} runs`);
}

// ---------------------------------------------------------------------------------------------
// 7. Pre-buffered follow-up fires on the first interruptible frame
// ---------------------------------------------------------------------------------------------
{
  const jabPlan = (): PlanInstance => ({
    family: 'poke', name: 'jab', move: null, param: 0, minFrames: 1, horizon: 20, flags: 0, bonus: 0, priority: 0,
    script(t: number, _self, _ctx, out: Intent): void { out.held = 0; out.direct = t === 0 ? MOVE_CODE.jab : 0; out.mash = 0; },
  });
  for (const delay of [0, 1, 3]) {
    for (const k of [0, 2, 5]) {
      const s = freshState(17, 250);
      const dr = new Driver(0, delay);
      const f = s.fighters[0];
      const ctx = { dir: 1, home: 1, edgeX: 0, fireAt: 0, param: 0, startFrame: s.frame, frame: s.frame } as unknown as PlanCtx;
      dr.exec.setPlan(jabPlan(), ctx);
      const starts: number[] = [];
      let prevAf = -1, prevAction = f.action;
      let queued = false;
      for (let t = 0; t < 60 && starts.length < 2; t++) {
        dr.exec.stepPlan(s, 0, dr.intent);
        dr.step(s, GOD);
        if (f.action === 'attack' && (prevAction !== 'attack' || f.actionFrame < prevAf)) starts.push(s.frame);
        prevAf = f.actionFrame; prevAction = f.action;
        if (!queued && f.action === 'attack') { dr.exec.prebuffer(jabPlan(), followUpTick(s, f, delay, k)); queued = true; }
      }
      const iasa = 14;
      check(`follow-up at iasa - ${k} (inputDelay ${delay}) starts on the first interruptible frame`,
        starts.length === 2 && starts[1] - starts[0] === iasa, starts.join(','));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 8. Determinism
// ---------------------------------------------------------------------------------------------
{
  const trace = (exec: CpuExecutor | null, seed: number): string => {
    const s = freshState(seed, 120);
    const dr = new Driver(0, 2);
    const ex = exec ?? dr.exec;
    let h = 2166136261;
    const tmp: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
    for (let t = 0; t < 600; t++) {
      if (!runReflexes(view(s, 0, L2), ex, dr.intent)) {
        const r = (Math.imul(t + 1, 2654435761) >>> 0) % 97;
        dr.intent.held = r < 30 ? Btn.Right : r < 50 ? Btn.Left | Btn.Attack : r < 60 ? Btn.Jump : r < 70 ? Btn.Down : 0;
        dr.intent.direct = r > 93 ? MOVE_CODE.ftilt : 0;
      }
      const o = ex.emit(s, 0, dr.intent, L2, tmp);
      for (const v of [o.held, o.pressed, o.released, o.direct ?? 0]) { h ^= v; h = Math.imul(h, 16777619) >>> 0; }
      stepGame(s, [o, NEUTRAL]);
    }
    return h.toString(16);
  };
  const a = trace(null, 21), b = trace(null, 21);
  const shared = new CpuExecutor(0, 2);
  const c = trace(shared, 21);
  shared.reset();
  const d = trace(shared, 21);
  check('executor output stream is deterministic (fresh, repeated, after reset)', a === b && b === c && c === d, `${a} ${b} ${c} ${d}`);
}

// ---------------------------------------------------------------------------------------------
// 9. Perfect ground spacing: stop error at most 2 px in 95% of cases
// ---------------------------------------------------------------------------------------------
{
  const errs: number[] = [];
  const res: SpacingResult = { k: 0, walk: false, dirBit: 0, err: 0, steps: 0 };
  let steps = 0;
  const n = 60;
  for (let i = 0; i < n; i++) {
    const s = freshState(23 + (i % 3), 300);
    const ex = new CpuExecutor(0, 0);
    const side = i % 2 === 0 ? 1 : -1;
    const x0 = s.fighters[0].x;
    // Keep left-hand targets on the stage: fighter 0 spawns near the left edge.
    const dx = 12 + (i >> 1) * 6.37;
    ex.planSpacing(s, 0, side > 0 ? x0 + dx : x0 + Math.min(dx, 60), res);
    errs.push(res.err);
    steps = Math.max(steps, res.steps);
  }
  errs.sort((x, y) => x - y);
  const p95 = errs[Math.floor(n * 0.95) - 1];
  check('spacing stop error at most 2 px in 95% of 60 targets (12 to 200 px)', p95 <= 2,
    `median ${errs[n >> 1].toFixed(2)}, p95 ${p95.toFixed(2)}, max ${errs[n - 1].toFixed(2)}, max steps ${steps}`);
  void TUNING;
}

process.stdout.write(failures === 0 ? 'executor: all checks passed\n' : `executor: ${failures} check(s) failed\n`);
if (failures > 0) process.exitCode = 1;
