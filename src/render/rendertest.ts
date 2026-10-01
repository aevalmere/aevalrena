import { TUNING } from '../core/constants';
import type { GameState, MatchConfig, PerfSample, SimEvent } from '../core/types';
import { animFrameIndex, frameNameFor } from './anim';
import { CHARACTER_DEFS } from '../characters/registry';
import type { MoveDef } from '../core/types';
import { ECHO_PAD, echoClone, getFrame, getFrameAnchor, getShadowFrame } from './bake';
import { COUNTER_DIM_FRAMES } from './fx';
import { createRenderer } from './index';
import { PALETTES, VARIANT_COUNT, VARIANT_NAMES, remapHex, remapRgb, rgbToHsl, variantNames } from './palette';
import { getCharVisual, getProjectileVisual } from './visuals';

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
  dx: number;
  dy: number;
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
  /** Fills covering most of the view: the background clear and any screen dim. */
  bigFills: number;
}

const BIG_FILL = 200;

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
    bigFills: 0,
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
  log.bigFills = 0;
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

  rotate(): void {}

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
      dx: args.length === 8 ? args[4] : args[0],
      dy: args.length === 8 ? args[5] : args[1],
    };
    if (args.length === 4) {
      record.dw = args[2];
      record.dh = args[3];
    }
    if (args.length === 8) {
      record.sw = args[2];
      record.sh = args[3];
      record.dw = args[6];
      record.dh = args[7];
    }
    this.log.draws.push(record);
  }

  fillRect(_x: number, _y: number, w: number, h: number): void {
    this.log.fillRects++;
    if (w >= BIG_FILL && h >= BIG_FILL) this.log.bigFills++;
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
const DEBUG_FRAME_DATA = { hitboxes: false, frameData: true, perf: false };
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

function hitEvent(victim: number, kb = 80, crit = false): SimEvent {
  return { type: 'hit', x: 0, y: -20, attacker: 0, victim, damage: 8, kb, angle: 45, crit };
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
  copy.bigFills = log.bigFills;
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

/**
 * Aeval band 1 regression: these 12 colours and their remap per variant were recorded from the
 * single-band palette.ts before the per-character rewrite (2026-09-30). Saturated blues, the
 * outline navy, skin, white and grey; none of them is in the coat band.
 */
const AEVAL_PINS: readonly [string, readonly string[]][] = [
  ['#3f8fe6', ['#3f8fe6', '#b835f0', '#bcc0c4', '#ea5a85']],
  ['#7fb2ff', ['#7fb2ff', '#de7fff', '#d7d9dd', '#ff91ad']],
  ['#b8e3ff', ['#b8e3ff', '#e5b8ff', '#e9ebec', '#ffc2d8']],
  ['#1f5fb0', ['#1f5fb0', '#8b16b9', '#a2a7ac', '#d42556']],
  ['#2a7fd0', ['#2a7fd0', '#a020da', '#b0b4b8', '#d94574']],
  ['#5ac8f0', ['#5ac8f0', '#b251f9', '#c7ccce', '#f271a8']],
  ['#0a1030', ['#0a1030', '#0a1030', '#0a1030', '#0a1030']],
  ['#e8b89a', ['#e8b89a', '#e8b89a', '#e8b89a', '#e8b89a']],
  ['#ffffff', ['#ffffff', '#ffffff', '#ffffff', '#ffffff']],
  ['#808080', ['#808080', '#808080', '#808080', '#808080']],
  ['#9fd4ff', ['#9fd4ff', '#df9fff', '#e1e3e5', '#ffacc8']],
  ['#c07a60', ['#c07a60', '#c07a60', '#c07a60', '#c07a60']],
];

function hslOfHex(hex: string, out: number[]): void {
  rgbToHsl(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), out);
}

function hueDist(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Per character palettes: Aeval band 1 pinned, Aeval's coat tints part way, Trekmore's red,
 * white and gold land in their bands and his ink never moves.
 */
export function characterPaletteChecks(): RenderTestResult[] {
  const out: RenderTestResult[] = [];
  const hsl = [0, 0, 0];
  const base = [0, 0, 0];

  let pinFails = 0;
  let firstFail = '';
  for (const [hex, want] of AEVAL_PINS) {
    for (let v = 0; v < VARIANT_COUNT; v++) {
      const got = remapHex(hex, v, 'aeval');
      if (got !== want[v]) {
        pinFails++;
        if (firstFail === '') firstFail = hex + ' v' + v + ' got ' + got + ' want ' + want[v];
      }
    }
  }
  out.push({
    name: 'Aeval band 1 output unchanged on 12 pinned colours',
    pass: pinFails === 0,
    detail: pinFails === 0 ? '48 of 48 match' : pinFails + ' mismatches, first ' + firstFail,
  });

  // Coat: a mid, low-saturation blue grey in the middle of the coat band.
  const coat = '#4a5a78';
  const coatBand = PALETTES.aeval.bands[1];
  hslOfHex(coat, base);
  const v0Same = remapHex(coat, 0, 'aeval') === coat;
  hslOfHex(remapHex(coat, 1, 'aeval'), hsl);
  const targetHue = 280 + (base[0] - coatBand.hueCenter) * 0.5;
  const before = hueDist(base[0], targetHue);
  const after = hueDist(hsl[0], targetHue);
  const moved = (before - after) / before;
  const s = coatBand.strength;
  out.push({
    name: 'Aeval coat pixel tints toward purple by the coat strength, variant 0 leaves it',
    pass: v0Same && Math.abs(moved - s) < 0.1 && hsl[1] >= base[1] - 0.02,
    detail:
      coat + ' hue ' + base[0].toFixed(1) + ' -> ' + hsl[0].toFixed(1) + ' (target ' + targetHue.toFixed(1) +
      '), moved ' + (moved * 100).toFixed(0) + '% of the way, strength ' + s + ', variant 0 unchanged ' + v0Same,
  });

  // Trekmore samples: three glow violets, three cloth violets.
  const samples = ['#8a4dff', '#b070ff', '#6a30c0', '#3a2060', '#2a1648', '#4a2a78'];
  const rows: string[] = [];
  let redOk = true;
  let whiteOk = true;
  let goldOk = true;
  for (const hex of samples) {
    hslOfHex(hex, base);
    hslOfHex(remapHex(hex, 1, 'trekmore'), hsl);
    if (hueDist(hsl[0], 348) > 10 || hsl[1] < 0.35 || Math.abs(hsl[2] - base[2]) > 0.08) redOk = false;
    const red = hsl[0].toFixed(0);
    hslOfHex(remapHex(hex, 2, 'trekmore'), hsl);
    if (hsl[1] > base[1] * 0.5 || hsl[2] <= base[2]) whiteOk = false;
    const white = hsl[1].toFixed(2) + '/' + hsl[2].toFixed(2);
    const goldHex = remapHex(hex, 3, 'trekmore');
    hslOfHex(goldHex, hsl);
    // Hue 28..52 covers the bronze deep shade; saturation high; mid tones lifted.
    if (hsl[0] < 28 || hsl[0] > 52 || hsl[1] < 0.55 || hsl[2] <= base[2]) goldOk = false;
    rows.push(hex + ' red h' + red + ' white s/l ' + white + ' gold ' + goldHex + ' h' + hsl[0].toFixed(0));
  }
  out.push({ name: 'Trekmore red keeps lightness and lands near crimson hue 348', pass: redOk, detail: rows.join('; ') });
  out.push({ name: 'Trekmore white desaturates and lifts', pass: whiteOk, detail: samples.length + ' samples' });
  out.push({ name: 'Trekmore gold lands in the metal band and lifts lightness', pass: goldOk, detail: samples.length + ' samples' });

  // Gold on a mid glow purple: the gold band proper (40..48), saturated, lifted.
  const glow = '#6a30c0';
  hslOfHex(glow, base);
  hslOfHex(remapHex(glow, 3, 'trekmore'), hsl);
  const ink = ['#0e0816', '#08060c', '#000000'];
  let inkOk = true;
  for (const hex of ink) {
    for (let v = 0; v < VARIANT_COUNT; v++) if (remapHex(hex, v, 'trekmore') !== hex) inkOk = false;
  }
  out.push({
    name: 'Trekmore gold turns a purple pixel into the gold band and leaves near-black alone',
    pass: hsl[0] >= 40 && hsl[0] <= 48 && hsl[1] >= 0.6 && hsl[2] > base[2] && inkOk,
    detail:
      glow + ' -> ' + remapHex(glow, 3, 'trekmore') + ' hue ' + hsl[0].toFixed(1) + ' sat ' + hsl[1].toFixed(2) +
      ' light ' + base[2].toFixed(2) + ' -> ' + hsl[2].toFixed(2) + '; ink ' + ink.join(' ') + ' unchanged ' + inkOk,
  });

  const names = variantNames('trekmore').join(' ');
  out.push({
    name: 'variant names per character',
    pass: names === 'Purple Red White Gold' && variantNames('aeval').join(' ') === 'Blue Purple White Pink',
    detail: 'trekmore: ' + names + '; aeval: ' + variantNames('aeval').join(' ') + '; unknown: ' + variantNames('nobody').join(' '),
  });
  return out;
}

/**
 * The clone bake is a darkened copy, not a silhouette: a row of [dark armour, lighter armour,
 * empty, bright violet, cutter-marked glow at alpha 254]. Both armour pixels go dark at about 0.9
 * alpha and the lighter plate stays lighter (the shading survives); both glow pixels stay violet;
 * the rim rings the whole opaque mask, the glow included.
 */
export function cloneBakeChecks(): RenderTestResult[] {
  const src = new Uint8ClampedArray([
    0x3a, 0x20, 0x60, 255,
    0x6a, 0x4a, 0x90, 255,
    0, 0, 0, 0,
    0xb0, 0x70, 0xff, 255,
    0x6a, 0x30, 0xc0, 254,
  ]);
  const shadow: [number, number, number] = [0x2a, 0x16, 0x40];
  const rim: [number, number, number] = [0xb0, 0x70, 0xff];
  const out = echoClone(src, 5, 1, shadow, rim, 0, 'trekmore');
  const W = 7;
  const px = (x: number, y: number): number[] => {
    const o = (y * W + x) * 4;
    return [out[o], out[o + 1], out[o + 2], out[o + 3]];
  };
  const hsl = [0, 0, 0];
  const lightOf = (p: number[]): number => {
    rgbToHsl(p[0], p[1], p[2], hsl);
    return hsl[2];
  };
  const dark = px(1, 1);
  const lighter = px(2, 1);
  const glow = px(4, 1);
  const marked = px(5, 1);
  const darkOk =
    lightOf(dark) < 0.22 && lightOf(lighter) < 0.3 && lightOf(lighter) > lightOf(dark) &&
    dark[3] === 230 && lighter[3] === 230;
  const glowOk = glow[2] > 150 && glow[2] > glow[1] && glow[3] === 217 && marked[2] > 100 && marked[3] === 216;
  const rimOk = px(0, 1)[3] > 0 && px(3, 1)[3] > 0 && px(4, 0)[3] > 0 && px(6, 1)[3] > 0 && px(0, 0)[3] === 0;
  return [{
    name: 'clone bake is a darkened copy that keeps shading and glow, rimmed all round',
    pass: darkOk && glowOk && rimOk,
    detail:
      'armour ' + dark.join(',') + ' (light ' + lightOf(dark).toFixed(2) + '), lighter plate ' + lighter.join(',') +
      ' (light ' + lightOf(lighter).toFixed(2) + '), glow ' + glow.join(',') + ', marked glow ' + marked.join(',') +
      ', rim left/gap/above glow/right a=' + px(0, 1)[3] + '/' + px(3, 1)[3] + '/' + px(4, 0)[3] + '/' + px(6, 1)[3],
  }];
}

// ---------------- Trekmore: clone, hidden frames, sprite particles ----------------

function drawOf(log: CallLog, image: object | null): DrawRecord | null {
  if (image === null) return null;
  for (let i = 0; i < log.draws.length; i++) if (log.draws[i].image === image) return log.draws[i];
  return null;
}

/** MoveDef.hiddenFrames read structurally (the SIM worker owns the field). */
interface HiddenMove { hiddenFrames?: [number, number] }

/**
 * Fighter 0 as Trekmore: the shadow clone darts out of his body to its latched point and then
 * plays there, from a baked clone 1 px larger on each side (the rim); a move's hiddenFrames skip
 * the body; a swing's sprite particles spawn once per sim frame (not again on a repeat render);
 * a Trekmore counter draws no counter flash.
 */
function trekmoreChecks(
  state: GameState,
  renderFrame: (frame: number, events: SimEvent[]) => CallLog,
  at: number
): RenderTestResult[] {
  const out: RenderTestResult[] = [];
  const f = state.fighters[0];
  const savedChar = f.charId;
  f.charId = 'trekmore';
  f.x = 0;
  f.y = 0;
  f.facing = 1;
  f.action = 'idle';
  f.actionFrame = 0;
  f.moveId = null;
  f.echoMove = null;
  const def = CHARACTER_DEFS.trekmore;
  const visual = getCharVisual('trekmore', 0);
  if (def === undefined || visual === null) {
    f.charId = savedChar;
    return [{ name: 'Trekmore render checks', pass: false, detail: 'no Trekmore def or visual' }];
  }

  // Clone: utilt's echo, latched 30 px in front of him (the sim's travel-direction latch). One
  // frame into its delay it is darting out of his body (between him and the point, still near
  // him), then playing on the point (age 4).
  const utilt = def.moves.utilt;
  const delay = utilt.echo === undefined ? 0 : utilt.echo.delayFrames;
  const anim = visual.sprites.anims[visual.sprites.animFor('attack', 'utilt', f)];
  const echoX = 30;
  f.echoMove = 'utilt';
  f.echoX = echoX;
  f.echoY = 0;
  f.echoFacing = 1;
  f.echoAge = -delay + 1;
  const firstName = anim === undefined ? '' : anim.frames[animFrameIndex(anim, 0)];
  const glideCanvas = getShadowFrame(visual.baseBodySheetId, firstName, false, 0, 'trekmore');
  const plain = getFrame(visual.baseBodySheetId, firstName, false, false);
  const anchor = getFrameAnchor(visual.baseBodySheetId, firstName, false);
  const ax = anchor === null ? 0 : anchor.ax;
  const gliding = renderFrame(at, []);
  const glide = drawOf(gliding, glideCanvas as unknown as object);
  const glideX = glide === null ? NaN : glide.dx + ax + ECHO_PAD;
  f.echoAge = 4;
  const playName = anim === undefined ? '' : anim.frames[animFrameIndex(anim, 4)];
  const playCanvas = getShadowFrame(visual.baseBodySheetId, playName, false, 0, 'trekmore');
  const playAnchor = getFrameAnchor(visual.baseBodySheetId, playName, false);
  const playAx = playAnchor === null ? 0 : playAnchor.ax;
  const playing = renderFrame(at + 1, []);
  const play = drawOf(playing, playCanvas as unknown as object);
  // The sim moves the point with him: he and the point both 50 px on, the clone follows.
  const MOVED = 50;
  f.x = MOVED;
  f.echoX = MOVED + echoX;
  const movedLog = renderFrame(at + 2, []);
  const moved = drawOf(movedLog, playCanvas as unknown as object);
  f.echoAge = -delay + 1;
  const movedGlide = drawOf(renderFrame(at + 3, []), glideCanvas as unknown as object);
  const movedGlideX = movedGlide === null ? NaN : movedGlide.dx + ax + ECHO_PAD;
  f.x = 0;
  f.echoX = echoX;
  out.push({
    name: 'Trekmore clone darts out of his body to its point in front, plays there, and moves with him',
    pass:
      glide !== null && play !== null && plain !== null && glideCanvas !== null &&
      glideCanvas.width === plain.width + 2 * ECHO_PAD && glideCanvas.height === plain.height + 2 * ECHO_PAD &&
      delay > 1 && glideX > 1 && glideX < echoX - 1 &&
      play.dx === Math.round(echoX - playAx - ECHO_PAD) &&
      moved !== null && moved.dx === Math.round(MOVED + echoX - playAx - ECHO_PAD) &&
      Math.abs(movedGlideX - MOVED - glideX) < 1.01,
    detail:
      'dart at x ' + glideX.toFixed(1) + ' between 0 (his body) and ' + echoX + ' (his point) on delay frame 1 of ' + delay + '; moved ' + MOVED + ' px with him: dart at ' +
      movedGlideX.toFixed(1) + ', playing at dx ' + (moved === null ? 'none' : moved.dx) + '; clone ' +
      (glideCanvas === null ? 'none' : glideCanvas.width + 'x' + glideCanvas.height) + ' for frame ' +
      (plain === null ? 'none' : plain.width + 'x' + plain.height) + ', playing at dx ' + (play === null ? 'none' : play.dx),
  });
  f.echoMove = null;

  // Hidden frames: uspecial's body is skipped inside hiddenFrames.
  const uspecial = def.moves.uspecial as MoveDef & HiddenMove;
  const patched = uspecial.hiddenFrames === undefined;
  if (patched) uspecial.hiddenFrames = [10, 21];
  const range = uspecial.hiddenFrames as [number, number];
  f.action = 'attack';
  f.moveId = 'uspecial';
  f.onBranch = false;
  f.actionFrame = range[0] + 2;
  const hiddenBody = bodyCanvasFor(state, 0, false);
  const hiddenLog = renderFrame(at + 2, []);
  f.actionFrame = range[1] + 12;
  const shownBody = bodyCanvasFor(state, 0, false);
  const shownLog = renderFrame(at + 3, []);
  if (patched) delete uspecial.hiddenFrames;
  out.push({
    name: 'hiddenFrames skip the body draw',
    pass: hiddenBody !== null && !drewCanvas(hiddenLog, hiddenBody) && drewCanvas(shownLog, shownBody),
    detail:
      'frames ' + range[0] + ' to ' + range[1] + (patched ? ' (patched in: the move has none yet)' : '') +
      ', body drawn at ' + (range[0] + 2) + ': ' + drewCanvas(hiddenLog, hiddenBody) + ', at ' + (range[1] + 12) + ': ' +
      drewCanvas(shownLog, shownBody),
  });

  // Aim hold: nspecial held on its hold frame (charging, aimDir up) draws a faint ghost of the
  // sword; the same frame not held (a tap) draws none.
  const nspecial = def.moves.nspecial as MoveDef & { holdAim?: boolean };
  const aimPatched = nspecial.holdAim === undefined;
  if (aimPatched) nspecial.holdAim = true;
  const swordVisual = getProjectileVisual('shadowSword');
  const swordName =
    swordVisual === null ? '' : swordVisual.anim !== null && swordVisual.anim.frames.length > 0 ? swordVisual.anim.frames[0] : swordVisual.frames.length > 0 ? swordVisual.frames[0] : '';
  const swordCanvas = swordVisual === null ? null : getFrame(swordVisual.owner.fxSheetId, swordName, false, false);
  f.action = 'attack';
  f.moveId = 'nspecial';
  f.onBranch = false;
  f.actionFrame = 8;
  f.charging = true;
  f.charge = 10;
  f.aimDir = 2;
  const heldLog = renderFrame(at + 4, []);
  f.charging = false;
  f.charge = 0;
  const tapLog = renderFrame(at + 5, []);
  if (aimPatched) delete nspecial.holdAim;
  const heldGhost = swordCanvas !== null && drewCanvas(heldLog, swordCanvas as unknown as object);
  const tapGhost = swordCanvas !== null && drewCanvas(tapLog, swordCanvas as unknown as object);
  out.push({
    name: 'nspecial aim hold draws a ghost sword, a tap does not',
    pass: heldGhost && !tapGhost,
    detail:
      'sword frame ' + (swordName === '' ? 'none' : swordName) + (aimPatched ? ' (holdAim patched in: the move has none yet)' : '') +
      ', held (aim up): ' + heldGhost + ', not held: ' + tapGhost,
  });

  // Swing particles: utilt's first active frame spawns; a repeat render spawns nothing more.
  f.action = 'idle';
  f.moveId = null;
  f.actionFrame = 0;
  const quiet = renderFrame(at + 40, []);
  let firstActive = -1;
  for (const hb of utilt.hitboxes) if (firstActive < 0 || hb.start < firstActive) firstActive = hb.start;
  f.action = 'attack';
  f.moveId = 'utilt';
  f.actionFrame = firstActive;
  const swing = renderFrame(at + 41, []);
  const again = renderFrame(at + 41, []);
  const cost = (l: CallLog): number => l.draws.length + l.fillRects;
  out.push({
    name: 'Trekmore swing particles spawn once per sim frame',
    pass: cost(swing) > cost(quiet) + 1 && cost(again) === cost(swing),
    detail: cost(quiet) + ' draws+fills idle, ' + cost(swing) + ' on utilt frame ' + firstActive + ', ' + cost(again) + ' on a repeat render',
  });

  // Dash attack impact: its first active frame bursts at the thrust tip (spikes, shards, motes,
  // the flash), far more than the frame before it.
  f.moveId = 'dashatk';
  f.actionFrame = 10;
  const preImpact = renderFrame(at + 42, []);
  f.actionFrame = 11;
  const impact = renderFrame(at + 43, []);
  f.action = 'idle';
  f.moveId = null;
  f.actionFrame = 0;
  out.push({
    name: 'Trekmore dash attack bursts at the thrust tip on its first active frame',
    pass: cost(impact) >= cost(preImpact) + 20,
    detail: cost(preImpact) + ' draws+fills on dashatk frame 10, ' + cost(impact) + ' on frame 11',
  });

  // Blink: none inside the counter branch's invuln window (an attack's own window); an idle
  // fighter with the same invuln still blinks.
  const dspecial = def.moves.dspecial;
  const invWin = dspecial.invuln;
  let branchDrawn = 0;
  let idleDrawn = 0;
  const BLINK_RENDERS = 8;
  if (invWin !== undefined) {
    f.action = 'attack';
    f.moveId = 'dspecial';
    f.onBranch = true;
    f.actionFrame = invWin[0] + 4;
    f.invuln = 10;
    const branchBody = bodyCanvasFor(state, 0, false);
    for (let k = 0; k < BLINK_RENDERS; k++) if (drewCanvas(renderFrame(at + 70 + k, []), branchBody)) branchDrawn++;
    f.action = 'idle';
    f.moveId = null;
    f.onBranch = false;
    f.actionFrame = 0;
    const idleBody = bodyCanvasFor(state, 0, false);
    for (let k = 0; k < BLINK_RENDERS; k++) if (drewCanvas(renderFrame(at + 80 + k, []), idleBody)) idleDrawn++;
    f.invuln = 0;
  }
  out.push({
    name: 'no invuln blink inside an attack own invuln window, blink elsewhere',
    pass: invWin !== undefined && branchDrawn === BLINK_RENDERS && idleDrawn < BLINK_RENDERS && idleDrawn > 0,
    detail:
      'counter branch frame ' + (invWin === undefined ? '?' : invWin[0] + 4) + ' with invuln: body on ' + branchDrawn + '/' +
      BLINK_RENDERS + ' renders; idle with invuln: ' + idleDrawn + '/' + BLINK_RENDERS,
  });

  // Counter: no counter flash canvas for Trekmore.
  f.action = 'idle';
  f.moveId = null;
  const flashes: object[] = [];
  const clip = visual.clips.get('counterFlash');
  if (clip !== undefined) {
    for (const name of clip.frames) {
      const c = getFrame(visual.fxSheetId, name, false, false);
      if (c !== null) flashes.push(c as unknown as object);
    }
  }
  const counter: SimEvent[] = [{ type: 'counter', x: 0, y: -20, slot: 0, attacker: 1 }];
  // His sheet has no counterFlash any more, so also count draws: the counter frames must issue
  // exactly the drawImage calls of a quiet frame (no clip, no stand-in of any kind). Particle pools
  // age per render, so render quiet frames until the swing particles above have all died.
  let quietDraws = -1;
  let steady = 0;
  for (let q = 0; q < 240 && steady < 8; q++) {
    const n = renderFrame(at + 100 + q, []).draws.length;
    steady = n === quietDraws ? steady + 1 : 0;
    quietDraws = n;
  }
  let flashed = false;
  const counterDraws: number[] = [];
  for (let k = 0; k <= 3; k++) {
    const log = renderFrame(at + 400 + k, k === 0 ? counter : []);
    counterDraws.push(log.draws.length);
    for (const c of flashes) if (drewCanvas(log, c)) flashed = true;
  }
  const extraDraws = counterDraws.some((n) => n !== quietDraws);
  out.push({
    name: 'a Trekmore counter draws no counter flash',
    pass: !flashed && !extraDraws,
    detail:
      flashes.length + ' counterFlash frames in his fx sheet, drawn: ' + flashed +
      '; draws quiet ' + quietDraws + ', on the counter and after ' + counterDraws.join(','),
  });

  f.charId = savedChar;
  f.action = 'idle';
  f.moveId = null;
  f.actionFrame = 0;
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

  // Echo: a hand-built echo of jab on fighter 0, ECHO_AGE frames in, at a latched point.
  const ECHO_AGE = 5;
  const noEcho = renderFrame(lastFrame + 2, noEvents);
  const owner = state.fighters[0];
  owner.echoMove = 'jab';
  owner.echoAge = ECHO_AGE;
  owner.echoX = -30;
  owner.echoY = 0;
  owner.echoFacing = 1;
  const withEcho = renderFrame(lastFrame + 3, noEvents);
  const withEchoAgain = renderFrame(lastFrame + 4, noEvents);
  const ownerVisual = getCharVisual(owner.charId, 0);
  let expectedEcho: object | null = null;
  let echoFrameName = '';
  if (ownerVisual !== null) {
    const anim = ownerVisual.sprites.anims[ownerVisual.sprites.animFor('attack', 'jab', owner)];
    if (anim !== undefined) {
      echoFrameName = anim.frames[animFrameIndex(anim, ECHO_AGE)];
      expectedEcho = getShadowFrame(ownerVisual.baseBodySheetId, echoFrameName, false, owner.variant, owner.charId);
    }
  }
  const ownerFrame = ownerVisual === null ? null : frameNameFor(ownerVisual.sprites, owner);
  owner.echoAge = -3;
  const waiting = renderFrame(lastFrame + 5, noEvents);
  owner.echoMove = null;

  // Crit: the same knockback shakes harder with crit set. Each hit is rendered after the
  // previous shake has decayed.
  const quietGap = TUNING.camera.shakeFrames + 2;
  const plainAt = lastFrame + 6 + quietGap;
  renderFrame(plainAt - 1, noEvents);
  const plainHit = renderFrame(plainAt, [hitEvent(1, 20, false)]);
  const critAt = plainAt + quietGap;
  renderFrame(critAt - 1, noEvents);
  const critHit = renderFrame(critAt, [hitEvent(1, 20, true)]);

  // Counter and teleport events: the counter dims the screen (one full-view fill) unless the
  // frame data view is on; a teleport with no step trail art draws nothing and does not throw.
  const counterAt = critAt + quietGap;
  const quietBeforeCounter = renderFrame(counterAt - 1, noEvents);
  const counter: SimEvent[] = [{ type: 'counter', x: 0, y: -20, slot: 1, attacker: 0 }];
  const onCounter = renderFrame(counterAt, counter);
  const teleport: SimEvent[] = [{ type: 'teleport', slot: 0, fromX: 0, fromY: 0, x: 60, y: 0, kind: 'step' }];
  renderFrame(counterAt + COUNTER_DIM_FRAMES + 1, teleport);
  function renderDebugFrame(frame: number, events: SimEvent[]): CallLog {
    state.frame = frame;
    state.events.length = 0;
    for (let i = 0; i < events.length; i++) state.events.push(events[i]);
    resetLog(log);
    renderer.render(state, null, 1, DEBUG_FRAME_DATA, PERF);
    return copyLog(log);
  }
  const debugQuiet = renderDebugFrame(counterAt + 20, noEvents);
  const debugCounter = renderDebugFrame(counterAt + 21, counter);

  const shadow = trekmoreChecks(state, renderFrame, counterAt + 40);

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
      name: 'echo draw issues one extra drawImage of the cached shadow at the delayed frame',
      pass:
        expectedEcho !== null &&
        withEcho.draws.length === noEcho.draws.length + 1 &&
        drewCanvas(withEcho, expectedEcho) &&
        drewCanvas(withEchoAgain, expectedEcho) &&
        waiting.draws.length === noEcho.draws.length,
      detail:
        noEcho.draws.length + ' draws without, ' + withEcho.draws.length + ' with the echo (jab frame ' +
        echoFrameName + ' at age ' + ECHO_AGE + ', owner on ' + ownerFrame + '), same canvas next render: ' +
        drewCanvas(withEchoAgain, expectedEcho) + ', ' + waiting.draws.length + ' while echoAge < 0',
    },
    {
      name: 'a crit hit shakes harder than a normal hit of the same knockback',
      pass: shakeOffset(critHit) > shakeOffset(plainHit) && shakeOffset(plainHit) > 0,
      detail: 'normal ' + shakeOffset(plainHit) + ' px, crit ' + shakeOffset(critHit) + ' px',
    },
    {
      name: 'a counter event dims the screen, not with the frame data view on',
      pass: onCounter.bigFills === quietBeforeCounter.bigFills + 1 && debugCounter.bigFills === debugQuiet.bigFills,
      detail:
        quietBeforeCounter.bigFills + ' full-view fills quiet, ' + onCounter.bigFills + ' on the counter; frame data view ' +
        debugQuiet.bigFills + ' quiet, ' + debugCounter.bigFills + ' on the counter',
    },
    ...shadow,
    {
      name: 'parallax layers scale with camera zoom',
      pass: baseline.scales.length > 0 && Math.abs(zoomScale - zoomMax) < 1e-6,
      detail:
        baseline.scales.length + ' scaled layer draws at ' + zoomScale + 'x, zoomMax ' + zoomMax,
    },
  ];
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('rendertest.ts')) {
  const results = [...paletteChecks(), ...characterPaletteChecks(), ...cloneBakeChecks(), ...(await runRenderTest())];
  let passed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.pass) passed++;
    process.stdout.write((r.pass ? 'PASS' : 'FAIL') + ' ' + r.name + ': ' + r.detail + '\n');
  }
  process.stdout.write(passed + '/' + results.length + ' pass\n');
  if (passed !== results.length) process.exitCode = 1;
}
