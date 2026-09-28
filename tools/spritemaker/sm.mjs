#!/usr/bin/env node
// sm.mjs: repo wrapper around the claude-code-sprite-maker engine.
// Frame contract: 80x80, faces right, centre column 40, heel line row 67.
// Source of truth is the .txt file (80 lines x 80 chars, '.' transparent,
// every other char a key in art/aeval/palette.json).
//
//   node tools/spritemaker/sm.mjs render  <dir>
//   node tools/spritemaker/sm.mjs preview <anim> [--frame N] [--fx]
//   node tools/spritemaker/sm.mjs gif     <anim> [--holds a,b,c,...] [--fx]
//   node tools/spritemaker/sm.mjs stage   <anim>
//   node tools/spritemaker/sm.mjs flip    <in.png> <out.png>
//   node tools/spritemaker/sm.mjs import  <png> <frame> [--fx] [--anchor feet|centre] [--force]
//   node tools/spritemaker/sm.mjs new     <anim>/<N> [--from <anim2>/<M>] [--fx] [--force]
//   node tools/spritemaker/sm.mjs rows    <frame> [y0 [y1]]
//   node tools/spritemaker/sm.mjs put     <frame> <y> <x> <string> [<y> <x> <string> ...]
//   node tools/spritemaker/sm.mjs fill    <frame> <x> <y> <w> <h> <char>
//   node tools/spritemaker/sm.mjs shift   <frame> <x0> <y0> <x1> <y1> <dx> <dy>
//   node tools/spritemaker/sm.mjs check   [<anim>] [--fx] [--all]

import {
  readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync,
} from 'node:fs';
import {
  join, dirname, basename, resolve, relative, isAbsolute, sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const W = 80;
const H = 80;
const HEEL_ROW = 67;
const CENTRE_COL = 40;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const artRoot = join(repoRoot, 'art', 'aeval');
const framesRoot = join(artRoot, 'frames');
const fxRoot = join(artRoot, 'fx');
const sheetsRoot = join(artRoot, 'sheets');
const palettePath = join(artRoot, 'palette.json');
const animsJsonPath = join(artRoot, 'anims.json');

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- plugin load

const configPath = join(here, 'config.json');
if (!existsSync(configPath)) fail(`missing ${configPath}`);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const pluginRoot = config.pluginRoot;
if (!pluginRoot || !existsSync(pluginRoot)) {
  fail(`pluginRoot '${pluginRoot}' from config.json does not exist. Clone and build the plugin first (see README.md).`);
}
for (const rel of ['build/lib/frame-store.js', 'build/lib/gif-maker.js', 'build/lib/spritesheet.js', 'package.json']) {
  if (!existsSync(join(pluginRoot, rel))) fail(`plugin is not built: missing ${join(pluginRoot, rel)} (run npm install && npm run build in ${pluginRoot})`);
}

const frameStore = await import(pathToFileURL(join(pluginRoot, 'build/lib/frame-store.js')).href);
const gifLib = await import(pathToFileURL(join(pluginRoot, 'build/lib/gif-maker.js')).href);
const sheetLib = await import(pathToFileURL(join(pluginRoot, 'build/lib/spritesheet.js')).href);
const pluginRequire = createRequire(pathToFileURL(join(pluginRoot, 'package.json')));
const sharp = pluginRequire('sharp');
const { PNG } = pluginRequire('pngjs');

// ---------------------------------------------------------------- helpers

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`bad colour '${hex}'`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function loadPalette() {
  if (!existsSync(palettePath)) fail(`missing palette ${palettePath}`);
  const pal = JSON.parse(readFileSync(palettePath, 'utf8'));
  if (!pal.keys || typeof pal.keys !== 'object') fail(`palette.json has no "keys" object`);
  const keys = {};
  for (const [k, v] of Object.entries(pal.keys)) {
    if (k.length !== 1) fail(`palette key '${k}' is not a single character`);
    if (k === '.') fail(`palette key '.' is reserved for transparent`);
    const [r, g, b] = hexToRgb(v);
    keys[k] = { r, g, b, hex: `${v.replace('#', '').toLowerCase()}ff` };
  }
  return { ...pal, keys };
}

function trailingNumber(name) {
  const m = /(\d+)\.[^.]+$/.exec(name);
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}

function sortedByNumber(names) {
  return [...names].sort((a, b) => {
    const d = trailingNumber(a) - trailingNumber(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

function resolveDir(p) {
  const a = resolve(process.cwd(), p);
  if (existsSync(a)) return a;
  const b = resolve(repoRoot, p);
  if (existsSync(b)) return b;
  fail(`directory not found: ${p}`);
}

function animPngs(anim, fx) {
  const dir = join(fx ? fxRoot : framesRoot, anim);
  if (!existsSync(dir)) fail(`no such animation folder: ${dir}`);
  const pngs = sortedByNumber(readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')));
  if (pngs.length === 0) fail(`no .png frames in ${dir} (run render first)`);
  return pngs.map((f) => join(dir, f));
}

// Pulls named boolean and value flags out of argv, returning the leftover
// positional args plus a { flagName: value|boolean } map.
function extractFlags(argv, boolNames = [], valueNames = []) {
  let rest = [...argv];
  const flags = {};
  for (const name of boolNames) {
    const i = rest.indexOf(name);
    flags[name] = i !== -1;
    if (i !== -1) rest.splice(i, 1);
  }
  for (const name of valueNames) {
    const i = rest.indexOf(name);
    if (i === -1) { flags[name] = undefined; continue; }
    const v = rest[i + 1];
    if (v === undefined) fail(`${name} needs a value`);
    flags[name] = v;
    rest.splice(i, 2);
  }
  return { rest, flags };
}

function relPath(p) {
  return relative(repoRoot, p).split(sep).join('/');
}

// Refuses to resolve a path outside art/aeval/.
function ensureInsideArt(p) {
  const rel = relative(artRoot, p);
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`path escapes art/aeval/: ${relPath(p)}`);
  return p;
}

// `<anim>/<N>` -> art/aeval/frames/<anim>/<anim><N>.txt (or fx/ with fx=true).
// A path with a slash that ends in .txt is used as given, relative to the repo root.
function resolveFramePath(argPath, fx) {
  if (!argPath) fail('missing frame path');
  let resolved;
  if (argPath.includes('/') && argPath.toLowerCase().endsWith('.txt')) {
    resolved = resolve(repoRoot, argPath);
  } else {
    const parts = argPath.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) fail(`bad frame path '${argPath}' (expected <anim>/<N>)`);
    const [anim, n] = parts;
    if (!/^\d+$/.test(n)) fail(`bad frame path '${argPath}' (N must be a number)`);
    resolved = join(fx ? fxRoot : framesRoot, anim, `${anim}${n}.txt`);
  }
  return ensureInsideArt(resolved);
}

function readTxtLines(path) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // one trailing newline is fine
  return lines;
}

// Shape-only check (80x80), used by `new --from`. No palette involved.
function validateShape(lines, label) {
  const problems = [];
  if (lines.length !== H) problems.push(`${label}: ${lines.length} lines (need ${H})`);
  lines.forEach((line, li) => {
    if (line.length !== W) problems.push(`${label} line ${li + 1}: ${line.length} chars (need ${W})`);
  });
  return problems;
}

// Full grid validation (shape + palette keys), shared by `render` and `check`.
// Reports through the `problem(msg)` callback, same format both callers use.
function validateGridFile(filePath, label, pal, problem) {
  const raw = readFileSync(filePath, 'utf8');
  if (raw.includes('\t')) problem(`${label}: contains a tab character`);
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let ok = true;
  if (lines.length !== H) {
    problem(`${label}: ${lines.length} lines (need ${H})`);
    ok = false;
  }
  lines.forEach((line, li) => {
    if (line.length !== W) {
      problem(`${label} line ${li + 1}: ${line.length} chars (need ${W})`);
      ok = false;
    }
    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      if (ch !== '.' && !pal.keys[ch]) {
        problem(`${label} line ${li + 1} col ${x}: unknown key '${ch}'`);
        ok = false;
      }
    }
  });
  return { ok, lines };
}

function parseIntStrict(s, label) {
  const n = Number(s);
  if (!Number.isInteger(n)) fail(`bad ${label} '${s}' (expected integer)`);
  return n;
}

// Frame i's inclusive [start, end] sim-frame span, from cumulative holds.
function frameSpans(holds) {
  const spans = [];
  let acc = 0;
  for (const h of holds) {
    spans.push([acc, acc + h - 1]);
    acc += h;
  }
  return spans;
}

// Fraction of the (canvas-clipped) hit circle whose pixels are palette water keys.
function circleWaterCoverage(lines, hit, pal) {
  const { col, row, r } = hit;
  const waterSet = new Set(pal.water || []);
  const r2 = r * r;
  let count = 0;
  let total = 0;
  const x0 = Math.max(0, col - r);
  const x1 = Math.min(W - 1, col + r);
  const y0 = Math.max(0, row - r);
  const y1 = Math.min(H - 1, row + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - col;
      const dy = y - row;
      if (dx * dx + dy * dy <= r2) {
        total++;
        if (waterSet.has(lines[y][x])) count++;
      }
    }
  }
  return { count, total };
}

// A raw RGBA canvas we can paint on before handing to sharp.
class Canvas {
  constructor(width, height, fill) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    if (fill) this.rect(0, 0, width, height, fill);
  }
  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = 255;
  }
  rect(x0, y0, w, h, rgb) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, rgb);
  }
  toSharp() {
    return sharp(this.data, { raw: { width: this.width, height: this.height, channels: 4 } });
  }
}

async function upscaled(pngPath, scale) {
  return sharp(pngPath).resize(W * scale, H * scale, { kernel: sharp.kernel.nearest }).png().toBuffer();
}

// Draw the grid, heel band and centre band for one frame cell into a canvas at (ox, oy).
function paintGuides(cv, ox, oy, scale) {
  const GRID = hexToRgb('#2a2d3d');
  const HEEL = hexToRgb('#6b4f2a');
  const CENTRE = hexToRgb('#2a5a6b');
  const size = W * scale;
  for (let k = 0; k <= W; k += 8) {
    const p = Math.min(k * scale, size - 1);
    cv.rect(ox + p, oy, 1, size, GRID);
    cv.rect(ox, oy + p, size, 1, GRID);
  }
  cv.rect(ox, oy + HEEL_ROW * scale, size, scale, HEEL);
  cv.rect(ox + CENTRE_COL * scale, oy, scale, size, CENTRE);
}

function svgLabels(width, height, labels, fontSize) {
  const items = labels.map(({ x, y, text }) =>
    `<text x="${x}" y="${y}" font-family="Consolas, 'Courier New', monospace" font-size="${fontSize}" fill="#c8ccd8">${text}</text>`);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${items.join('')}</svg>`);
}

// ---------------------------------------------------------------- render

function cmdRender(argv) {
  const dirArg = argv[0];
  if (!dirArg) fail('usage: render <dir>');
  const dir = resolveDir(dirArg);
  const pal = loadPalette();
  const txts = sortedByNumber(readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt')));
  if (txts.length === 0) fail(`no .txt frames in ${dir}`);

  let problems = 0;
  let written = 0;
  const problem = (msg) => { problems++; console.log(`PROBLEM ${msg}`); };

  txts.forEach((file, index) => {
    const { ok, lines } = validateGridFile(join(dir, file), file, pal, problem);
    if (!ok) return;

    const frame = frameStore.createBlankFrame('right', index, txts.length, W, H);
    const png = new PNG({ width: W, height: H, colorType: 6 });
    let set = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const ch = lines[y][x];
        const o = i << 2;
        if (ch === '.') {
          frame.pixels[i] = '00000000';
          png.data[o] = 0; png.data[o + 1] = 0; png.data[o + 2] = 0; png.data[o + 3] = 0;
        } else {
          const c = pal.keys[ch];
          frame.pixels[i] = c.hex;
          png.data[o] = c.r; png.data[o + 1] = c.g; png.data[o + 2] = c.b; png.data[o + 3] = 255;
          set++;
        }
      }
    }
    frame.metadata.pixelsSet = set;
    frame.metadata.complete = true;
    const stem = file.slice(0, -4);
    const jsonPath = join(dir, `${stem}.json`);
    const pngPath = join(dir, `${stem}.png`);
    frameStore.writeFrame(jsonPath, frame);
    writeFileSync(pngPath, PNG.sync.write(png));
    console.log(`wrote ${jsonPath}`);
    console.log(`wrote ${pngPath}`);
    written++;
  });

  if (problems > 0) {
    console.log(`${problems} problem(s); ${written}/${txts.length} frames written`);
    process.exit(1);
  }
  console.log(`OK ${written} frames`);
}

// ---------------------------------------------------------------- preview

async function cmdPreview(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx'], ['--frame']);
  const anim = rest[0];
  if (!anim) fail('usage: preview <anim> [--frame N] [--fx]');
  const fx = flags['--fx'];
  const frameArg = flags['--frame'];
  const pngs = animPngs(anim, fx);
  mkdirSync(sheetsRoot, { recursive: true });
  const BG = hexToRgb('#1b1d2b');

  if (frameArg !== undefined) {
    const n = parseInt(frameArg, 10);
    if (!Number.isInteger(n) || n < 0 || n >= pngs.length) fail(`--frame ${frameArg} out of range (0..${pngs.length - 1})`);
    const scale = 10;
    const size = W * scale;
    const cv = new Canvas(size, size, BG);
    paintGuides(cv, 0, 0, scale);
    const out = join(sheetsRoot, `${anim}${n}_big.png`);
    await cv.toSharp().composite([{ input: await upscaled(pngs[n], scale), left: 0, top: 0 }]).png().toFile(out);
    console.log(`wrote ${out}  (${basename(pngs[n])} at ${scale}x)`);
    return;
  }

  const scale = 6;
  const cell = W * scale;
  const label = 16;
  const gap = 2;
  const perRow = 4;
  const cols = Math.min(perRow, pngs.length);
  const rows = Math.ceil(pngs.length / perRow);
  const width = cols * cell + (cols - 1) * gap;
  const height = rows * (cell + label) + (rows - 1) * gap;
  const cv = new Canvas(width, height, BG);
  const composites = [];
  const labels = [];
  for (let i = 0; i < pngs.length; i++) {
    const cx = (i % perRow) * (cell + gap);
    const cy = Math.floor(i / perRow) * (cell + label + gap) + label;
    paintGuides(cv, cx, cy, scale);
    composites.push({ input: await upscaled(pngs[i], scale), left: cx, top: cy });
    labels.push({ x: cx + 4, y: cy - 4, text: basename(pngs[i], '.png') });
  }
  const out = join(sheetsRoot, `${anim}_preview.png`);
  let img = cv.toSharp().composite(composites);
  try {
    const buf = await img.png().toBuffer();
    await sharp(buf).composite([{ input: svgLabels(width, height, labels, 12), left: 0, top: 0 }]).png().toFile(out);
  } catch (e) {
    console.log(`(labels skipped: ${e.message})`);
    console.log(`frame order: ${labels.map((l) => l.text).join(', ')}`);
    await cv.toSharp().composite(composites).png().toFile(out);
  }
  console.log(`wrote ${out}  (${pngs.length} frames at ${scale}x: ${labels.map((l) => l.text).join(', ')})`);
}

// ---------------------------------------------------------------- gif

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

async function cmdGif(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx'], ['--holds']);
  const anim = rest[0];
  if (!anim) fail('usage: gif <anim> [--holds a,b,...] [--fx]');
  const fx = flags['--fx'];
  const pngs = animPngs(anim, fx);
  const holdsArg = flags['--holds'];
  let holds;
  if (holdsArg) {
    holds = holdsArg.split(',').map((s) => parseInt(s.trim(), 10));
    if (holds.some((h) => !Number.isInteger(h) || h <= 0)) fail(`bad --holds '${holdsArg}' (positive integers, comma separated)`);
    if (holds.length !== pngs.length) fail(`--holds has ${holds.length} entries but ${anim} has ${pngs.length} frames`);
  } else {
    holds = pngs.map(() => 8);
  }
  const unit = holds.reduce((a, b) => gcd(a, b));
  const totalSim = holds.reduce((a, b) => a + b, 0);
  const totalDurationMs = (totalSim / 60) * 1000;

  const scale = 4;
  const tmp = join(sheetsRoot, '.tmp', `${anim}_gif`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const BG = hexToRgb('#1b1d2b');
  const big = [];
  for (let i = 0; i < pngs.length; i++) {
    const p = join(tmp, `${i}.png`);
    // Flatten onto the review background: the plugin's encoder treats pure
    // black as the transparent colour, so an opaque frame is the safe choice.
    // ensureAlpha keeps 4 channels: the encoder unpacks RGBA, not RGB.
    const { data, info } = await sharp(await upscaled(pngs[i], scale))
      .flatten({ background: { r: BG[0], g: BG[1], b: BG[2] } })
      .ensureAlpha()
      .raw().toBuffer({ resolveWithObject: true });
    // The encoder quantises first, then maps whichever palette entry is
    // CLOSEST to #000000 to the transparent index. Ink (#0e0c16) is the
    // darkest colour in a frame, so the whole outline used to come out
    // transparent. A 1 px pure-black border gives that lookup an exact hit
    // to sacrifice, and the ink keeps its own opaque entry.
    const blackOut = (x, y) => {
      const o = (y * info.width + x) * info.channels;
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 255;
    };
    for (let x = 0; x < info.width; x++) { blackOut(x, 0); blackOut(x, info.height - 1); }
    for (let y = 0; y < info.height; y++) { blackOut(0, y); blackOut(info.width - 1, y); }
    await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .png().toFile(p);
    big.push(p);
  }
  const sequence = [];
  holds.forEach((h, i) => { for (let k = 0; k < h / unit; k++) sequence.push(big[i]); });

  const out = join(sheetsRoot, `${anim}.gif`);
  await gifLib.generateGif(sequence, out, totalDurationMs, W * scale, H * scale);
  rmSync(tmp, { recursive: true, force: true });
  const tmpRoot = join(sheetsRoot, '.tmp');
  if (existsSync(tmpRoot) && readdirSync(tmpRoot).length === 0) rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`wrote ${out}  (${pngs.length} frames, holds ${holds.join(',')}, ${sequence.length} gif frames at ${Math.round(totalDurationMs / sequence.length)} ms, loop ${Math.round(totalDurationMs)} ms)`);
}

// ---------------------------------------------------------------- stage

async function cmdStage(argv) {
  const anim = argv[0];
  if (!anim) fail('usage: stage <anim>');
  const pngs = animPngs(anim);
  const frame0 = pngs[0];
  const SW = 640;
  const SH = 360;
  const GROUND_Y = 250;
  const cv = new Canvas(SW, SH);
  const top = hexToRgb('#161e34');
  const bot = hexToRgb('#263a5c');
  for (let y = 0; y < SH; y++) {
    const t = y / (SH - 1);
    const rgb = [0, 1, 2].map((i) => Math.round(top[i] + (bot[i] - top[i]) * t));
    cv.rect(0, y, SW, 1, rgb);
  }
  cv.rect(70, GROUND_Y, 500, SH - GROUND_Y, hexToRgb('#2e3648'));
  cv.rect(70, GROUND_Y, 500, 2, hexToRgb('#60708c'));

  const flipped = await sharp(frame0).flop().png().toBuffer();
  const big = await upscaled(frame0, 3);
  const composites = [
    { input: frame0, left: 200 - CENTRE_COL, top: GROUND_Y - HEEL_ROW },
    { input: flipped, left: 440 - CENTRE_COL, top: GROUND_Y - HEEL_ROW },
    { input: big, left: SW - W * 3 - 4, top: 4 },
  ];
  mkdirSync(sheetsRoot, { recursive: true });
  const out = join(sheetsRoot, `${anim}_stage.png`);
  await cv.toSharp().composite(composites).png().toFile(out);
  console.log(`wrote ${out}  (${basename(frame0)} at 1x facing right x=200, mirrored x=440, heel on y=${GROUND_Y}; 3x copy top-right)`);
}

// ---------------------------------------------------------------- flip

async function cmdFlip(argv) {
  const [inp, out] = argv;
  if (!inp || !out) fail('usage: flip <in.png> <out.png>');
  const src = resolve(process.cwd(), inp);
  if (!existsSync(src)) fail(`no such file: ${src}`);
  const dst = resolve(process.cwd(), out);
  mkdirSync(dirname(dst), { recursive: true });
  await sharp(src).flop().png().toFile(dst);
  console.log(`wrote ${dst}`);
}

// ---------------------------------------------------------------- import

// Nearest palette key to an RGB triple by Euclidean distance ('.' is never
// a candidate: pal.keys never contains it, see loadPalette()).
function nearestKey(pal, r, g, b) {
  let bestKey = null;
  let bestDist = Infinity;
  for (const [k, c] of Object.entries(pal.keys)) {
    const dr = r - c.r;
    const dg = g - c.g;
    const db = b - c.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < bestDist) { bestDist = dist; bestKey = k; }
  }
  return { key: bestKey, dist: bestDist };
}

function cmdImport(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx', '--force'], ['--anchor']);
  const [pngArg, frameArg] = rest;
  if (!pngArg || !frameArg) fail('usage: import <png> <frame> [--fx] [--anchor feet|centre] [--force]');
  const fx = flags['--fx'];
  const force = flags['--force'];
  const anchorArg = flags['--anchor'];
  if (anchorArg !== undefined && anchorArg !== 'feet' && anchorArg !== 'centre') {
    fail(`bad --anchor '${anchorArg}' (expected feet or centre)`);
  }
  const anchor = anchorArg || (fx ? 'centre' : 'feet');

  const targetPath = resolveFramePath(frameArg, fx);
  if (existsSync(targetPath) && !force) fail(`${targetPath} exists (use --force)`);

  if (!existsSync(palettePath)) fail('missing art/aeval/palette.json');
  const pal = loadPalette();

  const pngPath = isAbsolute(pngArg) ? pngArg : resolve(repoRoot, pngArg);
  if (!existsSync(pngPath)) fail(`no such file: ${pngPath}`);
  const png = PNG.sync.read(readFileSync(pngPath));
  const pw = png.width;
  const ph = png.height;
  if (pw > 80 || ph > 80) {
    fail(`${pngArg} is ${pw}x${ph}; import needs 80x80 or smaller (generate at 80x80, do not scale)`);
  }

  // Scan opaque pixels: nearest palette key, far flag, and the bounding box.
  let x0 = Infinity; let x1 = -Infinity;
  let y0 = Infinity; let y1 = -Infinity;
  let opaque = 0;
  let far = 0;
  const keyCounts = {};
  const pixels = [];
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 4;
      if (png.data[i + 3] < 128) continue;
      opaque++;
      const { key, dist } = nearestKey(pal, png.data[i], png.data[i + 1], png.data[i + 2]);
      if (dist > 48) far++;
      keyCounts[key] = (keyCounts[key] || 0) + 1;
      pixels.push({ x, y, key });
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (opaque === 0) fail(`${pngArg} has no opaque pixels`);

  const boxW = x1 - x0 + 1;
  const boxH = y1 - y0 + 1;
  const centreX = Math.round((x0 + x1) / 2);
  const centreY = Math.round((y0 + y1) / 2);

  let shiftX;
  let shiftY;
  if (anchor === 'feet') {
    shiftX = CENTRE_COL - centreX;
    shiftY = HEEL_ROW - y1;
  } else {
    shiftX = CENTRE_COL - centreX;
    shiftY = CENTRE_COL - centreY;
  }

  const destX0 = x0 + shiftX;
  const destX1 = x1 + shiftX;
  const destY0 = y0 + shiftY;
  const destY1 = y1 + shiftY;

  const grid = Array.from({ length: H }, () => Array(W).fill('.'));
  let dropped = 0;
  for (const { x, y, key } of pixels) {
    const nx = x + shiftX;
    const ny = y + shiftY;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) { dropped++; continue; }
    grid[ny][nx] = key;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${grid.map((row) => row.join('')).join('\n')}\n`);

  console.log(`import ${pngArg} -> ${targetPath}`);
  console.log(`opaque ${opaque} pixels, box ${boxW}x${boxH}, placed at cols ${destX0}..${destX1} rows ${destY0}..${destY1}, dropped ${dropped}`);
  const sortedKeys = Object.entries(keyCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [k, count] of sortedKeys) console.log(`  ${k} ${count}`);
  const pct = Math.round((far / opaque) * 100);
  console.log(`far ${far} pixels (${pct}%)`);
  if (pct > 10) console.log(`WARN ${pct}% of pixels were far from every palette colour; fix them by hand`);
  if (dropped > 0) console.log(`WARN ${dropped} pixels fell outside the canvas`);
}

// ---------------------------------------------------------------- new

function cmdNew(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx', '--force'], ['--from']);
  const target = rest[0];
  if (!target) fail('usage: new <anim>/<N> [--from <anim2>/<M>] [--fx] [--force]');
  const fx = flags['--fx'];
  const force = flags['--force'];
  const targetPath = resolveFramePath(target, fx);
  if (existsSync(targetPath) && !force) fail(`${targetPath} exists (use --force)`);
  mkdirSync(dirname(targetPath), { recursive: true });

  let content;
  if (flags['--from']) {
    const sourcePath = resolveFramePath(flags['--from'], fx);
    if (!existsSync(sourcePath)) fail(`source not found: ${sourcePath}`);
    const lines = readTxtLines(sourcePath);
    const shapeProblems = validateShape(lines, basename(sourcePath));
    if (shapeProblems.length) fail(`source ${sourcePath} is invalid: ${shapeProblems[0]}`);
    content = `${lines.join('\n')}\n`;
  } else {
    content = `${Array(H).fill('.'.repeat(W)).join('\n')}\n`;
  }
  writeFileSync(targetPath, content);
  console.log(`wrote ${targetPath}`);
}

// ---------------------------------------------------------------- rows

function cmdRows(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx'], []);
  const frameArg = rest[0];
  if (!frameArg) fail('usage: rows <frame> [y0 [y1]]');
  const framePath = resolveFramePath(frameArg, flags['--fx']);
  if (!existsSync(framePath)) fail(`no such file: ${framePath}`);
  const lines = readTxtLines(framePath);

  let y0 = 0;
  let y1 = H - 1;
  if (rest[1] !== undefined) {
    y0 = parseIntStrict(rest[1], 'y0');
    y1 = y0;
  }
  if (rest[2] !== undefined) {
    y1 = parseIntStrict(rest[2], 'y1');
  }
  if (y0 < 0 || y0 > 79 || y1 < 0 || y1 > 79 || y0 > y1) fail(`bad row range ${y0}..${y1}`);

  let tens = '   ';
  let units = '   ';
  for (let x = 0; x < W; x++) {
    tens += String(Math.floor(x / 10) % 10);
    units += String(x % 10);
  }
  console.log(tens);
  console.log(units);
  for (let y = y0; y <= y1; y++) {
    const line = lines[y] !== undefined ? lines[y] : '';
    console.log(`${String(y).padStart(2, '0')}|${line}`);
  }
}

// ---------------------------------------------------------------- put

function cmdPut(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx'], []);
  const frameArg = rest[0];
  const triples = rest.slice(1);
  if (!frameArg || triples.length === 0 || triples.length % 3 !== 0) {
    fail('usage: put <frame> <y> <x> <string> [<y> <x> <string> ...]');
  }
  const framePath = resolveFramePath(frameArg, flags['--fx']);
  if (!existsSync(framePath)) fail(`no such file: ${framePath}`);
  const pal = loadPalette();
  const lines = readTxtLines(framePath);
  if (lines.length !== H) fail(`${framePath} is not ${H} lines`);

  const ops = [];
  for (let i = 0; i < triples.length; i += 3) {
    const y = parseIntStrict(triples[i], 'y');
    const x = parseIntStrict(triples[i + 1], 'x');
    const str = triples[i + 2];
    if (y < 0 || y > 79) fail(`y ${y} outside 0..79`);
    if (x < 0) fail(`x ${x} is negative`);
    if (x + str.length > W) fail(`x ${x} + string length ${str.length} exceeds ${W}`);
    for (const ch of str) {
      if (ch !== '.' && ch !== '_' && !pal.keys[ch]) fail(`unknown key '${ch}' (not in palette)`);
    }
    ops.push({ y, x, str });
  }

  for (const { y, x, str } of ops) {
    const line = lines[y];
    let newLine = line.slice(0, x);
    for (let i = 0; i < str.length; i++) {
      newLine += str[i] === '_' ? line[x + i] : str[i];
    }
    newLine += line.slice(x + str.length);
    lines[y] = newLine;
    console.log(`put ${framePath} row ${y} cols ${x}..${x + str.length - 1}`);
  }
  writeFileSync(framePath, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------- fill

function cmdFill(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx'], []);
  const [frameArg, xs, ys, ws, hs, ch] = rest;
  if (!frameArg || xs === undefined || ys === undefined || ws === undefined || hs === undefined || ch === undefined) {
    fail('usage: fill <frame> <x> <y> <w> <h> <char>');
  }
  if (ch.length !== 1) fail(`fill char must be a single character, got '${ch}'`);
  const framePath = resolveFramePath(frameArg, flags['--fx']);
  if (!existsSync(framePath)) fail(`no such file: ${framePath}`);
  const pal = loadPalette();
  if (ch !== '.' && ch !== '_' && !pal.keys[ch]) fail(`unknown key '${ch}' (not in palette)`);
  const x = parseIntStrict(xs, 'x');
  const y = parseIntStrict(ys, 'y');
  const w = parseIntStrict(ws, 'w');
  const h = parseIntStrict(hs, 'h');
  const lines = readTxtLines(framePath);
  if (lines.length !== H) fail(`${framePath} is not ${H} lines`);

  const x0 = Math.max(0, x);
  const x1 = Math.min(W - 1, x + w - 1);
  const y0 = Math.max(0, y);
  const y1 = Math.min(H - 1, y + h - 1);
  if (ch !== '_') {
    for (let yy = y0; yy <= y1; yy++) {
      const arr = lines[yy].split('');
      for (let xx = x0; xx <= x1; xx++) arr[xx] = ch;
      lines[yy] = arr.join('');
    }
  }
  writeFileSync(framePath, `${lines.join('\n')}\n`);
  console.log(`fill ${framePath} rect x=${x} y=${y} w=${w} h=${h} char='${ch}'`);
}

// ---------------------------------------------------------------- shift

function cmdShift(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx'], []);
  const [frameArg, x0s, y0s, x1s, y1s, dxs, dys] = rest;
  if (!frameArg || [x0s, y0s, x1s, y1s, dxs, dys].some((v) => v === undefined)) {
    fail('usage: shift <frame> <x0> <y0> <x1> <y1> <dx> <dy>');
  }
  const framePath = resolveFramePath(frameArg, flags['--fx']);
  if (!existsSync(framePath)) fail(`no such file: ${framePath}`);
  const x0 = parseIntStrict(x0s, 'x0');
  const y0 = parseIntStrict(y0s, 'y0');
  const x1 = parseIntStrict(x1s, 'x1');
  const y1 = parseIntStrict(y1s, 'y1');
  const dx = parseIntStrict(dxs, 'dx');
  const dy = parseIntStrict(dys, 'dy');
  if (x0 > x1 || y0 > y1) fail(`bad rect (${x0},${y0})-(${x1},${y1})`);
  const lines = readTxtLines(framePath);
  if (lines.length !== H) fail(`${framePath} is not ${H} lines`);

  const grid = lines.map((l) => l.split(''));
  const original = grid.map((row) => row.slice());
  const sx0 = Math.max(0, x0);
  const sx1 = Math.min(W - 1, x1);
  const sy0 = Math.max(0, y0);
  const sy1 = Math.min(H - 1, y1);
  for (let y = sy0; y <= sy1; y++) {
    for (let x = sx0; x <= sx1; x++) grid[y][x] = '.';
  }
  for (let y = sy0; y <= sy1; y++) {
    for (let x = sx0; x <= sx1; x++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      grid[ny][nx] = original[y][x];
    }
  }
  writeFileSync(framePath, `${grid.map((row) => row.join('')).join('\n')}\n`);
  console.log(`shift ${framePath} rect (${x0},${y0})-(${x1},${y1}) by (${dx},${dy})`);
}

// ---------------------------------------------------------------- check

// Checks one animation's frame folder against its anims.json entry.
// Returns { present, frames, problems } and prints MISSING/EXTRA/PROBLEM/cover
// lines plus the final per-animation status line.
function checkAnim(anim, def, fx, pal, animsCfg) {
  const dir = join(fx ? fxRoot : framesRoot, anim);
  const frames = def.frames;
  const expected = [];
  for (let i = 0; i < frames; i++) expected.push(`${anim}${i}.txt`);

  let dirTxts = [];
  if (existsSync(dir)) dirTxts = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt'));
  const dirSet = new Set(dirTxts);

  let present = 0;
  let problems = 0;
  const problem = (msg) => { problems++; console.log(`PROBLEM ${msg}`); };
  const linesByIndex = {};

  for (let i = 0; i < frames; i++) {
    const fname = `${anim}${i}.txt`;
    if (!dirSet.has(fname)) {
      console.log(`MISSING ${fname}`);
      continue;
    }
    present++;
    const { ok, lines } = validateGridFile(join(dir, fname), fname, pal, problem);
    if (ok) linesByIndex[i] = lines;
  }

  for (const f of dirTxts) {
    if (!expected.includes(f)) console.log(`EXTRA ${f}`);
  }

  if (!fx && def.hits) {
    const spans = frameSpans(def.holds);
    const minFrac = animsCfg.coverage.minWaterFraction;
    const minPct = Math.round(minFrac * 100);
    for (const hit of def.hits) {
      for (let i = 0; i < frames; i++) {
        if (!linesByIndex[i]) continue;
        const [fs, fe] = spans[i];
        if (!(fs <= hit.to && fe >= hit.from)) continue;
        const { count, total } = circleWaterCoverage(linesByIndex[i], hit, pal);
        const frac = total > 0 ? count / total : 0;
        const pct = Math.round(frac * 100);
        console.log(`cover ${anim}${i} hit(${hit.col},${hit.row},r${hit.r}) ${pct}%`);
        if (frac < minFrac) {
          problem(`${anim}${i}: water covers ${pct}% of hit circle (${hit.col},${hit.row},r${hit.r}), need ${minPct}%`);
        }
      }
    }
  }

  let status;
  if (problems > 0) status = `BAD ${anim}`;
  else if (present === frames) status = `OK ${anim} ${frames} frames`;
  else status = `INCOMPLETE ${anim} ${present}/${frames}`;
  console.log(status);

  return { present, frames, problems };
}

function cmdCheck(argv) {
  const { rest, flags } = extractFlags(argv, ['--fx', '--all'], []);
  const animArg = rest[0];

  if (!existsSync(palettePath)) fail('missing art/aeval/palette.json');
  const pal = loadPalette();
  const animsCfg = JSON.parse(readFileSync(animsJsonPath, 'utf8'));

  let bodyNames = [];
  let fxNames = [];

  if (animArg) {
    const table = flags['--fx'] ? animsCfg.fx : animsCfg.body;
    if (!table || !table[animArg]) fail(`unknown ${flags['--fx'] ? 'fx' : 'animation'} '${animArg}'`);
    if (flags['--fx']) fxNames = [animArg]; else bodyNames = [animArg];
  } else {
    bodyNames = Object.keys(animsCfg.body);
    if (flags['--fx'] || flags['--all']) fxNames = Object.keys(animsCfg.fx);
  }

  let anyProblem = false;
  let namedResult = null;

  let bComplete = 0;
  let bDone = 0;
  let bTotal = 0;
  for (const anim of bodyNames) {
    const res = checkAnim(anim, animsCfg.body[anim], false, pal, animsCfg);
    if (res.problems > 0) anyProblem = true;
    bTotal += res.frames;
    bDone += res.present;
    if (res.problems === 0 && res.present === res.frames) bComplete++;
    if (animArg === anim && !flags['--fx']) namedResult = res;
  }

  let fComplete = 0;
  let fDone = 0;
  let fTotal = 0;
  for (const anim of fxNames) {
    const res = checkAnim(anim, animsCfg.fx[anim], true, pal, animsCfg);
    if (res.problems > 0) anyProblem = true;
    fTotal += res.frames;
    fDone += res.present;
    if (res.problems === 0 && res.present === res.frames) fComplete++;
    if (animArg === anim && flags['--fx']) namedResult = res;
  }

  if (bodyNames.length > 0) {
    console.log(`BODY ${bComplete}/${bodyNames.length} animations complete (${bDone}/${bTotal} frames)`);
  }
  if (fxNames.length > 0) {
    console.log(`FX ${fComplete}/${fxNames.length} effects complete (${fDone}/${fTotal} frames)`);
  }

  const namedIncomplete = namedResult !== null && namedResult.present < namedResult.frames;
  if (anyProblem || namedIncomplete) process.exit(1);
}

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'render': cmdRender(rest); break;
    case 'preview': await cmdPreview(rest); break;
    case 'gif': await cmdGif(rest); break;
    case 'stage': await cmdStage(rest); break;
    case 'flip': await cmdFlip(rest); break;
    case 'import': cmdImport(rest); break;
    case 'new': cmdNew(rest); break;
    case 'rows': cmdRows(rest); break;
    case 'put': cmdPut(rest); break;
    case 'fill': cmdFill(rest); break;
    case 'shift': cmdShift(rest); break;
    case 'check': cmdCheck(rest); break;
    default:
      console.error('usage: sm.mjs render <dir> | preview <anim> [--frame N] [--fx] | gif <anim> [--holds a,b,...] [--fx] | stage <anim> | flip <in.png> <out.png> | import <png> <frame> [--fx] [--anchor feet|centre] [--force] | new <anim>/<N> [--from <anim2>/<M>] [--fx] [--force] | rows <frame> [y0 [y1]] | put <frame> <y> <x> <string> ... | fill <frame> <x> <y> <w> <h> <char> | shift <frame> <x0> <y0> <x1> <y1> <dx> <dy> | check [<anim>] [--fx] [--all]');
      process.exit(2);
  }
} catch (e) {
  fail(e && e.stack ? e.stack : String(e));
}
