import { TUNING } from '../core/constants';
import type { GameState, MatchConfig, PerfSample, SimEvent } from '../core/types';
import { frameNameFor } from './anim';
import { getFrame } from './bake';
import { createRenderer } from './index';
import { getCharVisual } from './visuals';

/**
 * Headless verification of the render effects that only show up in motion:
 * screen shake, the 2 sim frame white hit flash, per sim frame particle
 * spawning and the zoom-scaled parallax background.
 *
 * There is no DOM under tsx, so this builds a canvas and a 2D context that
 * record the calls the renderer makes and hands them back as plain data. The
 * stubs are installed on globalThis here and nowhere else: the renderer itself
 * never knows it is being watched.
 *
 * Run: npx --yes tsx src/render/rendertest.ts
 */

declare const process: {
  argv: string[];
  stdout: { write(text: string): void };
  exitCode?: number;
};

const SIM_IMPORT_RETRIES = 5;
const SIM_IMPORT_DELAY_MS = 60000;
const HIT_FRAME = 11;
const QUIET_FRAME = 10;

// ---------------- recording canvas ----------------

interface DrawRecord {
  image: object;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
}

interface CallLog {
  draws: DrawRecord[];
  fillRects: number;
  scales: number[];
  translates: number;
  transforms: number[][];
  saves: number;
  restores: number;
  fillStyles: number;
  alphas: number;
}

function createLog(): CallLog {
  return {
    draws: [],
    fillRects: 0,
    scales: [],
    translates: 0,
    transforms: [],
    saves: 0,
    restores: 0,
    fillStyles: 0,
    alphas: 0,
  };
}

function resetLog(log: CallLog): void {
  log.draws.length = 0;
  log.fillRects = 0;
  log.scales.length = 0;
  log.translates = 0;
  log.transforms.length = 0;
  log.saves = 0;
  log.restores = 0;
  log.fillStyles = 0;
  log.alphas = 0;
}

interface SizedImage {
  width: number;
  height: number;
}

class FakeContext {
  readonly log: CallLog = createLog();
  imageSmoothingEnabled = true;
  lineWidth = 1;
  strokeStyle = '';
  private fillValue = '';
  private alphaValue = 1;

  get fillStyle(): string {
    return this.fillValue;
  }

  set fillStyle(value: string) {
    this.fillValue = value;
    this.log.fillStyles++;
  }

  get globalAlpha(): number {
    return this.alphaValue;
  }

  set globalAlpha(value: number) {
    this.alphaValue = value;
    this.log.alphas++;
  }

  save(): void {
    this.log.saves++;
  }

  restore(): void {
    this.log.restores++;
  }

  translate(): void {
    this.log.translates++;
  }

  scale(x: number): void {
    this.log.scales.push(x);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.log.transforms.push([a, b, c, d, e, f]);
  }

  drawImage(image: SizedImage, ...args: number[]): void {
    const record: DrawRecord = {
      image: image as unknown as object,
      sw: image.width,
      sh: image.height,
      dw: image.width,
      dh: image.height,
    };
    if (args.length === 8) {
      record.sw = args[2];
      record.sh = args[3];
      record.dw = args[6];
      record.dh = args[7];
    }
    this.log.draws.push(record);
  }

  fillRect(): void {
    this.log.fillRects++;
  }

  strokeRect(): void {}
  beginPath(): void {}
  arc(): void {}
  fill(): void {}
  stroke(): void {}
}

class FakeCanvas {
  width = 1;
  height = 1;
  readonly style: Record<string, string> = { width: '', height: '', imageRendering: '' };
  readonly ctx = new FakeContext();

  getContext(kind: string): FakeContext | null {
    return kind === '2d' ? this.ctx : null;
  }
}

function installDom(): FakeCanvas {
  const globals = globalThis as unknown as {
    document?: { createElement(tag: string): FakeCanvas };
    window?: { innerWidth: number; innerHeight: number };
  };
  globals.document = {
    createElement(tag: string): FakeCanvas {
      if (tag !== 'canvas') throw new Error('fake document only makes canvases, asked for ' + tag);
      return new FakeCanvas();
    },
  };
  globals.window = { innerWidth: 1280, innerHeight: 720 };
  return new FakeCanvas();
}

// ---------------- fixtures ----------------

function matchConfig(): MatchConfig {
  return {
    stageId: 'tidegate',
    players: [
      { slot: 0, charId: 'aeval', cpu: false, cpuLevel: 0 },
      { slot: 1, charId: 'aeval', cpu: false, cpuLevel: 0 },
    ],
    stocks: 3,
    timeLimitSec: 0,
    seed: 7,
  };
}

const DEBUG_OFF = { hitboxes: false, frameData: false, perf: false };
const PERF: PerfSample = { simMs: 0, renderMs: 0, fps: 0 };

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The sim is another worker's file, so a mid-edit import failure is retried. */
async function loadCreateGameState(): Promise<(config: MatchConfig) => GameState> {
  for (let attempt = 1; attempt <= SIM_IMPORT_RETRIES; attempt++) {
    try {
      const mod = await import('../sim');
      return mod.createGameState;
    } catch (err) {
      if (attempt === SIM_IMPORT_RETRIES) throw err;
      process.stdout.write('sim import failed (attempt ' + attempt + '), retrying in 60s\n');
      await sleep(SIM_IMPORT_DELAY_MS);
    }
  }
  throw new Error('unreachable');
}

function hitEvent(victim: number): SimEvent {
  return { type: 'hit', x: 0, y: -20, attacker: 0, victim, damage: 8, kb: 80, angle: 45 };
}

/** Body canvas the renderer would pick for a fighter, normal or white silhouette. */
function bodyCanvasFor(state: GameState, index: number, white: boolean): object | null {
  const fighter = state.fighters[index];
  const visual = getCharVisual(fighter.charId);
  if (visual === null) return null;
  const name = frameNameFor(visual.sprites, fighter);
  if (name === null) return null;
  const canvas = getFrame(visual.bodySheetId, name, fighter.facing === -1, white);
  return canvas === null ? null : (canvas as unknown as object);
}

function drewCanvas(log: CallLog, image: object | null): boolean {
  if (image === null) return false;
  for (let i = 0; i < log.draws.length; i++) {
    if (log.draws[i].image === image) return true;
  }
  return false;
}

/** Largest whole-pixel offset of an unscaled setTransform, which is the shake. */
function shakeOffset(log: CallLog): number {
  let max = 0;
  for (let i = 0; i < log.transforms.length; i++) {
    const t = log.transforms[i];
    if (t[0] !== 1 || t[3] !== 1) continue;
    const ax = t[4] < 0 ? -t[4] : t[4];
    const ay = t[5] < 0 ? -t[5] : t[5];
    if (ax > max) max = ax;
    if (ay > max) max = ay;
  }
  return max;
}

function copyLog(log: CallLog): CallLog {
  const copy = createLog();
  copy.fillRects = log.fillRects;
  copy.saves = log.saves;
  copy.restores = log.restores;
  copy.translates = log.translates;
  copy.fillStyles = log.fillStyles;
  copy.alphas = log.alphas;
  for (let i = 0; i < log.draws.length; i++) copy.draws.push(log.draws[i]);
  for (let i = 0; i < log.scales.length; i++) copy.scales.push(log.scales[i]);
  for (let i = 0; i < log.transforms.length; i++) copy.transforms.push(log.transforms[i]);
  return copy;
}

// ---------------- the test ----------------

export interface RenderTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runRenderTest(): Promise<RenderTestResult[]> {
  const canvas = installDom();
  const createGameState = await loadCreateGameState();

  const renderer = createRenderer(canvas as unknown as HTMLCanvasElement);
  await renderer.load();
  renderer.setStage('tidegate');

  const state = createGameState(matchConfig());
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    f.x = 0;
    f.y = 0;
    f.vx = 0;
    f.vy = 0;
    f.invuln = 0;
  }

  const log = canvas.ctx.log;
  const snapshots = new Map<number, CallLog>();
  const noEvents: SimEvent[] = [];
  const hit: SimEvent[] = [hitEvent(1)];

  function renderFrame(frame: number, events: SimEvent[]): CallLog {
    state.frame = frame;
    state.events.length = 0;
    for (let i = 0; i < events.length; i++) state.events.push(events[i]);
    resetLog(log);
    renderer.render(state, null, 1, DEBUG_OFF, PERF);
    return copyLog(log);
  }

  // Quiet baseline, then the hit frame, then a repeat render of that same sim
  // frame, then one render per sim frame to the end of the shake window.
  const baseline = renderFrame(QUIET_FRAME, noEvents);
  const onHit = renderFrame(HIT_FRAME, hit);
  const repeat = renderFrame(HIT_FRAME, hit);
  snapshots.set(HIT_FRAME, onHit);
  const lastFrame = HIT_FRAME + TUNING.camera.shakeFrames;
  for (let frame = HIT_FRAME + 1; frame <= lastFrame; frame++) {
    snapshots.set(frame, renderFrame(frame, noEvents));
  }

  const white = bodyCanvasFor(state, 1, true);
  const normal = bodyCanvasFor(state, 1, false);

  const shakeOnHit = shakeOffset(onHit);
  const shakeAfter = shakeOffset(snapshots.get(lastFrame) as CallLog);

  const whiteFrames: number[] = [];
  snapshots.forEach((snap, frame) => {
    if (drewCanvas(snap, white)) whiteFrames.push(frame);
  });
  whiteFrames.sort((a, b) => a - b);
  const afterFlash = snapshots.get(HIT_FRAME + 2) as CallLog;

  let zoomScale = 0;
  for (let i = 0; i < baseline.scales.length; i++) {
    if (baseline.scales[i] > zoomScale) zoomScale = baseline.scales[i];
  }
  const zoomMax = TUNING.camera.zoomMax;

  return [
    {
      name: 'screen shake fires on the hit frame and decays to zero',
      pass: shakeOnHit > 0 && shakeAfter === 0,
      detail:
        'offset ' + shakeOnHit + ' px on the hit frame, ' + shakeAfter +
        ' px after ' + TUNING.camera.shakeFrames + ' sim frames',
    },
    {
      name: 'white hit flash lasts exactly 2 sim frames',
      pass:
        white !== null &&
        whiteFrames.length === 2 &&
        whiteFrames[0] === HIT_FRAME &&
        whiteFrames[1] === HIT_FRAME + 1 &&
        drewCanvas(afterFlash, normal),
      detail:
        'white on frames [' + whiteFrames.join(', ') + '], normal body on frame ' +
        (HIT_FRAME + 2) + ': ' + drewCanvas(afterFlash, normal),
    },
    {
      name: 'a repeat render of one sim frame spawns no extra particles',
      pass: onHit.fillRects > baseline.fillRects && repeat.fillRects === onHit.fillRects,
      detail:
        baseline.fillRects + ' fills quiet, ' + onHit.fillRects + ' on the hit, ' +
        repeat.fillRects + ' on the repeat render',
    },
    {
      name: 'parallax layers scale with camera zoom',
      pass: baseline.scales.length > 0 && Math.abs(zoomScale - zoomMax) < 1e-6,
      detail:
        baseline.scales.length + ' scaled layer draws at ' + zoomScale + 'x, zoomMax ' + zoomMax,
    },
  ];
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('rendertest.ts')) {
  const results = await runRenderTest();
  let passed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.pass) passed++;
    process.stdout.write((r.pass ? 'PASS' : 'FAIL') + ' ' + r.name + ': ' + r.detail + '\n');
  }
  process.stdout.write(passed + '/' + results.length + ' pass\n');
  if (passed !== results.length) process.exitCode = 1;
}
