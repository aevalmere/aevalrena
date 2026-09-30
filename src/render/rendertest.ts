import { TUNING } from '../core/constants';
import type { GameState, MatchConfig, PerfSample, SimEvent } from '../core/types';
import { frameNameFor } from './anim';
import { getFrame } from './bake';
import { createRenderer } from './index';
import { VARIANT_COUNT, VARIANT_NAMES, remapRgb, rgbToHsl } from './palette';
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
  putImageData(): void {}

  /** Blank pixels: the atlas contents never matter to these checks. */
  getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(w * h * 4) };
  }

  createImageData(w: number, h: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(w * h * 4) };
  }

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

/** Width and height from a base64 PNG data URL's IHDR chunk. */
function pngSize(url: string): SizedImage {
  const comma = url.indexOf(',');
  const b64 = url.slice(comma + 1, comma + 1 + 44);
  const bin = atob(b64);
  const at = (i: number): number => bin.charCodeAt(i);
  const width = ((at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19)) >>> 0;
  const height = ((at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23)) >>> 0;
  return { width, height };
}

/** An Image that "decodes" a PNG data URL by reading its size, then fires onload. */
class FakeImage {
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(url: string) {
    const size = pngSize(url);
    this.width = size.width;
    this.height = size.height;
    setTimeout(() => {
      if (this.onload !== null) this.onload();
    }, 0);
  }
}

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number
  ) {}
}

function installDom(): FakeCanvas {
  const globals = globalThis as unknown as {
    document?: { createElement(tag: string): FakeCanvas };
    window?: { innerWidth: number; innerHeight: number };
    Image?: unknown;
    ImageData?: unknown;
  };
  globals.Image = FakeImage;
  globals.ImageData = FakeImageData;
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
  const visual = getCharVisual(fighter.charId, fighter.variant);
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

// ---------------- colour variants ----------------

/** Target band per variant for a sample blue pixel: [hue min, hue max, sat max] (-1 = any hue). */
const VARIANT_BANDS: readonly [number, number, number][] = [
  [200, 215, 1],   // blue: unchanged
  [275, 285, 1],   // purple
  [-1, -1, 0.12],  // white: near zero saturation
  [335, 345, 1],   // pink
];

/**
 * The bake-time remap (src/render/palette.ts): a near-black outline pixel never moves, and a
 * sample of Aeval's water blue lands in each variant's hue band (white: desaturated and lighter,
 * not flattened to pure white).
 */
export function paletteChecks(): RenderTestResult[] {
  const out: RenderTestResult[] = [];
  const rgb = [0, 0, 0];
  const hsl = [0, 0, 0];
  // The sheet's commonest outline colour, and a saturated navy that is still near black.
  const darks: [number, number, number][] = [[0x1b, 0x19, 0x2b], [0x0a, 0x10, 0x30]];
  let darkOk = true;
  for (const dark of darks) {
    for (let v = 0; v < VARIANT_COUNT; v++) {
      remapRgb(dark[0], dark[1], dark[2], v, rgb);
      if (rgb[0] !== dark[0] || rgb[1] !== dark[1] || rgb[2] !== dark[2]) darkOk = false;
    }
  }
  out.push({
    name: 'colour variants leave near-black outline pixels unchanged',
    pass: darkOk,
    detail: '#1b192b and #0a1030 through all ' + VARIANT_COUNT + ' variants',
  });
  const blue: [number, number, number] = [0x3f, 0x8f, 0xe6];
  rgbToHsl(blue[0], blue[1], blue[2], hsl);
  const baseL = hsl[2];
  for (let v = 0; v < VARIANT_COUNT; v++) {
    remapRgb(blue[0], blue[1], blue[2], v, rgb);
    rgbToHsl(rgb[0], rgb[1], rgb[2], hsl);
    const band = VARIANT_BANDS[v];
    const hueOk = band[0] < 0 || (hsl[0] >= band[0] && hsl[0] <= band[1]);
    const satOk = hsl[1] <= band[2];
    const whiteOk = band[0] >= 0 || (hsl[2] > baseL && hsl[2] < 0.97);
    out.push({
      name: 'sample blue remaps into the ' + VARIANT_NAMES[v].toLowerCase() + ' band',
      pass: hueOk && satOk && whiteOk,
      detail: 'hue ' + hsl[0].toFixed(1) + ' sat ' + hsl[1].toFixed(2) + ' light ' + hsl[2].toFixed(2),
    });
  }
  return out;
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

  // Colour variant: the same fighter in purple draws a canvas from its own lazily baked sheet.
  const baseBody = bodyCanvasFor(state, 1, false);
  state.fighters[1].variant = 1;
  const tinted = renderFrame(lastFrame + 1, noEvents);
  const purpleBody = bodyCanvasFor(state, 1, false);
  state.fighters[1].variant = 0;

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
      name: 'a fighter in a colour variant draws its variant sheet',
      pass: purpleBody !== null && purpleBody !== baseBody && drewCanvas(tinted, purpleBody) && !drewCanvas(tinted, baseBody),
      detail: 'variant canvas drawn: ' + drewCanvas(tinted, purpleBody) + ', base canvas drawn: ' + drewCanvas(tinted, baseBody),
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
  const results = [...paletteChecks(), ...(await runRenderTest())];
  let passed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.pass) passed++;
    process.stdout.write((r.pass ? 'PASS' : 'FAIL') + ' ' + r.name + ': ' + r.detail + '\n');
  }
  process.stdout.write(passed + '/' + results.length + ' pass\n');
  if (passed !== results.length) process.exitCode = 1;
}
