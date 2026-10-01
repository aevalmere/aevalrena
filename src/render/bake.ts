import type { ImageSheetData } from '../core/types';
import { WHITE } from './colors';
import { VARIANT_COUNT as COLOUR_VARIANTS, paletteOf, remapHex, remapPixels, hslToRgb, remapRgb, rgbToHsl } from './palette';

/**
 * Sprite baker. A character ships one packed PNG atlas; at load we decode it
 * once, read its pixels once, and cut every frame into its own offscreen
 * canvas so a fighter draw is a single drawImage.
 *
 * Four variants per frame (normal, flipped, white silhouette, flipped white)
 * plus optional 1 px outline canvases tinted per player colour. Everything is
 * derived from the frame's raw pixels rather than by re-drawing with a
 * transform, so a flipped sprite is an exact mirror with no resampling.
 *
 * Lookups go through nested Maps keyed by strings that already exist, so the
 * per-frame path never builds a key string.
 */

const VARIANT_FLIP = 1;
const VARIANT_WHITE = 2;
const VARIANT_COUNT = 4;

interface FrameEntry {
  variants: (HTMLCanvasElement | null)[];
  /** Anchor inside the frame, in frame pixels, for the unflipped frame. */
  ax: number;
  ay: number;
  w: number;
  outlines: Map<string, (HTMLCanvasElement | null)[]>;
  /**
   * Echo shadow copies, index colourVariant * 2 + flipped, baked on first request
   * (getShadowFrame). Null until then; shared by the base sheet and its colour variants.
   */
  shadows: (HTMLCanvasElement | null)[] | null;
}

const sheets = new Map<string, Map<string, FrameEntry>>();

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w > 0 ? w : 1;
  c.height = h > 0 ? h : 1;
  return c;
}

function context2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('canvas 2d context unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const WHITE_RGB = parseHex(WHITE);

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => resolve(img);
    img.onerror = (): void => reject(new Error('sprite atlas failed to decode'));
    img.src = url;
  });
}

/** One frame's pixels lifted out of the atlas, tightly packed RGBA. */
function cutFrame(
  atlas: Uint8ClampedArray,
  atlasW: number,
  x: number,
  y: number,
  w: number,
  h: number
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * atlasW + x) * 4;
    out.set(atlas.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

function canvasFrom(pixels: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): HTMLCanvasElement {
  const canvas = makeCanvas(w, h);
  context2d(canvas).putImageData(new ImageData(pixels, w, h), 0, 0);
  return canvas;
}

function mirrored(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const from = row + x * 4;
      const to = row + (w - 1 - x) * 4;
      out[to] = pixels[from];
      out[to + 1] = pixels[from + 1];
      out[to + 2] = pixels[from + 2];
      out[to + 3] = pixels[from + 3];
    }
  }
  return out;
}

/** Every opaque pixel forced to one colour: the hit flash. */
function silhouette(pixels: Uint8ClampedArray<ArrayBuffer>): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a === 0) continue;
    out[i] = WHITE_RGB[0];
    out[i + 1] = WHITE_RGB[1];
    out[i + 2] = WHITE_RGB[2];
    out[i + 3] = a;
  }
  return out;
}

function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

function ignoreSet(colors: string[] | undefined): Set<number> | null {
  if (colors === undefined || colors.length === 0) return null;
  const out = new Set<number>();
  for (const hex of colors) {
    const rgb = parseHex(hex);
    out.add(packRgb(rgb[0], rgb[1], rgb[2]));
  }
  return out;
}

/**
 * Solid for outline purposes: fully opaque (alpha 255), and not a colour the
 * ring skips. Water in the crops is capped at alpha 254, so it never counts.
 */
function isSolid(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  x: number,
  y: number,
  ignore: Set<number> | null
): boolean {
  if (x < 0 || x >= w || y < 0 || y >= h) return false;
  const i = (y * w + x) * 4;
  if (pixels[i + 3] !== 255) return false;
  if (ignore === null) return true;
  return !ignore.has(packRgb(pixels[i], pixels[i + 1], pixels[i + 2]));
}

/**
 * Mark the frame's largest run of connected solid pixels: the fighter's own
 * body. Everything else a frame contains is spray -- droplets, sparkles, the
 * tail of a sweep -- and the player-colour ring has no business tracing it,
 * whatever colour it happens to have snapped to.
 */
function bodyMask(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  ignore: Set<number> | null
): Uint8Array {
  const label = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let best = -1;
  let bestSize = 0;
  let next = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (label[start] !== -1 || !isSolid(pixels, w, h, x, y, ignore)) continue;
      const id = next++;
      let head = 0;
      let tail = 0;
      label[start] = id;
      queue[tail++] = start;
      while (head < tail) {
        const at = queue[head++];
        const ax = at % w;
        const ay = (at - ax) / w;
        for (let d = 0; d < 4; d++) {
          const nx = ax + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const ny = ay + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const to = ny * w + nx;
          if (label[to] !== -1 || !isSolid(pixels, w, h, nx, ny, ignore)) continue;
          label[to] = id;
          queue[tail++] = to;
        }
      }
      if (tail > bestSize) {
        bestSize = tail;
        best = id;
      }
    }
  }
  const mask = new Uint8Array(w * h);
  if (best < 0) return mask;
  for (let i = 0; i < mask.length; i++) {
    if (label[i] === best) mask[i] = 1;
  }
  return mask;
}

function inMask(mask: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  if (x < 0 || x >= w || y < 0 || y >= h) return false;
  return mask[y * w + x] === 1;
}

/** A 1 px ring around the silhouette, on a canvas 1 px larger on every side. */
function bakeOutline(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  color: string,
  mask: Uint8Array
): HTMLCanvasElement {
  const rgb = parseHex(color);
  const ow = w + 2;
  const oh = h + 2;
  const out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(ow * oh * 4);
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      if (inMask(mask, w, h, x, y)) continue;
      const touches =
        inMask(mask, w, h, x - 1, y) ||
        inMask(mask, w, h, x + 1, y) ||
        inMask(mask, w, h, x, y - 1) ||
        inMask(mask, w, h, x, y + 1);
      if (!touches) continue;
      const i = ((y + 1) * ow + (x + 1)) * 4;
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = 255;
    }
  }
  return canvasFrom(out, ow, oh);
}

/**
 * Decode a character's atlas and cut every frame out of it. `outlineColors`
 * bakes a tinted outline copy per colour; pass an empty array for effect
 * sheets, which never need one.
 */
export async function bakeSheet(
  sheetId: string,
  sheet: ImageSheetData,
  outlineColors: readonly string[]
): Promise<void> {
  const ignore = ignoreSet(sheet.outlineIgnore);
  const img = await loadImage(sheet.url);
  const scratch = makeCanvas(img.width, img.height);
  const sctx = context2d(scratch);
  sctx.drawImage(img, 0, 0);
  const atlas = sctx.getImageData(0, 0, img.width, img.height).data;


  const frames = new Map<string, FrameEntry>();
  for (const frameName in sheet.frames) {
    const rect = sheet.frames[frameName];
    const x = rect[0];
    const y = rect[1];
    const w = rect[2];
    const h = rect[3];
    const ax = rect.length === 6 ? rect[4] : w / 2;
    const ay = rect.length === 6 ? rect[5] : sheet.origin === 'center' ? h / 2 : h;
    if (w <= 0 || h <= 0) {
      throw new Error(`sprite frame "${frameName}" in sheet "${sheetId}" has an empty rect`);
    }
    if (x < 0 || y < 0 || x + w > img.width || y + h > img.height) {
      throw new Error(`sprite frame "${frameName}" in sheet "${sheetId}" falls outside the atlas`);
    }
    const normal = cutFrame(atlas, img.width, x, y, w, h);
    const flipped = mirrored(normal, w, h);

    const variants: (HTMLCanvasElement | null)[] = new Array(VARIANT_COUNT).fill(null);
    variants[0] = canvasFrom(normal, w, h);
    variants[VARIANT_FLIP] = canvasFrom(flipped, w, h);
    variants[VARIANT_WHITE] = canvasFrom(silhouette(normal), w, h);
    variants[VARIANT_WHITE | VARIANT_FLIP] = canvasFrom(silhouette(flipped), w, h);

    const outlines = new Map<string, (HTMLCanvasElement | null)[]>();
    if (outlineColors.length > 0) {
      const maskNormal = bodyMask(normal, w, h, ignore);
      const maskFlipped = bodyMask(flipped, w, h, ignore);
      for (const color of outlineColors) {
        outlines.set(color, [
          bakeOutline(normal, w, h, color, maskNormal),
          bakeOutline(flipped, w, h, color, maskFlipped),
        ]);
      }
    }
    frames.set(frameName, { variants, outlines, ax, ay, w, shadows: null });
  }
  sheets.set(sheetId, frames);
}

/** True once `sheetId` has been baked. */
export function hasSheet(sheetId: string): boolean {
  return sheets.has(sheetId);
}

/**
 * Colour variant of an already baked sheet (src/render/palette.ts): every frame's pixels
 * read back from the base bake, remapped, and stored under `variantId`. The white hit-flash
 * silhouettes and any outline rings do not depend on the palette, so they are shared with the
 * base sheet. Synchronous and run once per variant in use; a match with only the base colour
 * never calls it. Returns false when the base sheet is not baked.
 */
export function bakeVariantSheet(baseId: string, variantId: string, variant: number, charId = 'aeval'): boolean {
  if (sheets.has(variantId)) return true;
  const base = sheets.get(baseId);
  if (base === undefined) return false;
  const frames = new Map<string, FrameEntry>();
  for (const [frameName, entry] of base) {
    const src = entry.variants[0];
    if (src === null) continue;
    const w = src.width;
    const h = src.height;
    const pixels = context2d(src).getImageData(0, 0, w, h).data;
    remapPixels(pixels, variant, charId);
    const variants: (HTMLCanvasElement | null)[] = new Array(VARIANT_COUNT).fill(null);
    variants[0] = canvasFrom(pixels, w, h);
    variants[VARIANT_FLIP] = canvasFrom(mirrored(pixels, w, h), w, h);
    variants[VARIANT_WHITE] = entry.variants[VARIANT_WHITE];
    variants[VARIANT_WHITE | VARIANT_FLIP] = entry.variants[VARIANT_WHITE | VARIANT_FLIP];
    frames.set(frameName, { variants, outlines: entry.outlines, ax: entry.ax, ay: entry.ay, w: entry.w, shadows: null });
  }
  sheets.set(variantId, frames);
  return true;
}

export function getFrame(
  sheetId: string,
  frameName: string,
  flipped: boolean,
  white: boolean
): HTMLCanvasElement | null {
  const frames = sheets.get(sheetId);
  if (frames === undefined) return null;
  const entry = frames.get(frameName);
  if (entry === undefined) return null;
  const v = (flipped ? VARIANT_FLIP : 0) | (white ? VARIANT_WHITE : 0);
  return entry.variants[v];
}

/**
 * Echo clone (docs/TREKMORE_POLISH.md Render 3): a darkened copy of the sprite, a shadow knight
 * whose armour plates, cape tatters and sword stay readable, swinging a real glowing slash.
 * - Dark pixels keep their relative shading: lightness scaled to ECHO_LIGHT_SCALE over a small
 *   floor, hue pulled ECHO_HUE_PULL of the way and saturation ECHO_SAT_PULL of the way toward the
 *   palette's shadow colour, at ECHO_BODY_ALPHA (edge pixels at that share of their own alpha).
 * - Bright pixels (lightness >= GLOW_MIN_LIGHT) and cutter-marked glow (alpha 254) stay glow: the
 *   pixel in the variant's colours pulled GLOW_TINT toward the glow colour, at GLOW_STRENGTH
 *   brightness and alpha. That keeps the slash arcs' bright cores.
 * - A 1 px rim in the glow colour rings the whole opaque mask.
 * Every pixel is computed from its own colour only, so there are no hard region edges.
 */
const ECHO_BODY_ALPHA = 0.9;
const ECHO_LIGHT_SCALE = 0.5;
const ECHO_LIGHT_FLOOR = 0.05;
const ECHO_HUE_PULL = 0.6;
const ECHO_SAT_PULL = 0.5;
const ECHO_RIM_ALPHA = 0.6;
const ECHO_MIN_ALPHA = 24;
/** The sheet cutter marks detached glow pixels with this alpha. */
const GLOW_MARK_ALPHA = 254;
const GLOW_MIN_LIGHT = 0.45;
const GLOW_TINT = 0.35;
const GLOW_STRENGTH = 0.85;

/** Hue `from` moved `t` of the way toward `to` along the short way round, in degrees. */
function pullHue(from: number, to: number, t: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  const h = from + d * t;
  return h < 0 ? h + 360 : h >= 360 ? h - 360 : h;
}

/**
 * The clone of `pixels` (w x h) on a buffer 2 px wider and taller: source (x, y) lands at
 * (x + 1, y + 1). `shadow` is the palette's shadow colour and `rim` the glow colour, both already
 * for the variant; `variant` and `charId` remap the source pixels.
 */
export function echoClone(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  shadow: [number, number, number],
  rim: [number, number, number],
  variant: number,
  charId: string
): Uint8ClampedArray<ArrayBuffer> {
  const W = w + 2;
  const H = h + 2;
  const out = new Uint8ClampedArray(W * H * 4);
  const rgb = [0, 0, 0];
  const hsl = [0, 0, 0];
  const sh = [0, 0, 0];
  rgbToHsl(shadow[0], shadow[1], shadow[2], sh);
  const opaque = (x: number, y: number): boolean =>
    x >= 0 && x < w && y >= 0 && y < h && pixels[(y * w + x) * 4 + 3] >= ECHO_MIN_ALPHA;
  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      const x = ox - 1;
      const y = oy - 1;
      const o = (oy * W + ox) * 4;
      if (opaque(x, y)) {
        const i = (y * w + x) * 4;
        const a = pixels[i + 3];
        remapRgb(pixels[i], pixels[i + 1], pixels[i + 2], variant, rgb, charId);
        rgbToHsl(rgb[0], rgb[1], rgb[2], hsl);
        if (a === GLOW_MARK_ALPHA || hsl[2] >= GLOW_MIN_LIGHT) {
          for (let c = 0; c < 3; c++) out[o + c] = Math.round((rgb[c] + (rim[c] - rgb[c]) * GLOW_TINT) * GLOW_STRENGTH);
          out[o + 3] = Math.round(a * GLOW_STRENGTH);
          continue;
        }
        const hue = pullHue(hsl[0], sh[0], ECHO_HUE_PULL);
        const sat = hsl[1] + (sh[1] - hsl[1]) * ECHO_SAT_PULL;
        const light = ECHO_LIGHT_FLOOR + hsl[2] * ECHO_LIGHT_SCALE;
        hslToRgb(hue, sat, light, rgb);
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
        out[o + 3] = Math.round((a === 255 ? 255 : a) * ECHO_BODY_ALPHA);
      } else if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
        out[o] = rim[0];
        out[o + 1] = rim[1];
        out[o + 2] = rim[2];
        out[o + 3] = Math.round(255 * ECHO_RIM_ALPHA);
      }
    }
  }
  return out;
}

/** Pixels an echo clone canvas extends past its frame on every side: add it to the frame anchor. */
export const ECHO_PAD = 1;

/**
 * The shadow echo clone of a frame (echoClone): a darkened copy with glowing slashes and a glow
 * rim, in `charId`'s colours for `variant`, on a canvas ECHO_PAD px larger on every side (draw it
 * at the frame anchor plus ECHO_PAD). Baked the first time a (frame, variant, flip) is asked for
 * and cached on the frame, so every later draw is one drawImage of a stored canvas. Pass the base
 * body sheet id: the variant is applied here.
 */
export function getShadowFrame(
  sheetId: string,
  frameName: string,
  flipped: boolean,
  variant: number,
  charId = 'aeval'
): HTMLCanvasElement | null {
  const frames = sheets.get(sheetId);
  if (frames === undefined) return null;
  const entry = frames.get(frameName);
  if (entry === undefined) return null;
  const v = variant > 0 && variant < COLOUR_VARIANTS ? variant : 0;
  const slot = v * 2 + (flipped ? 1 : 0);
  let list = entry.shadows;
  if (list === null) {
    list = new Array<HTMLCanvasElement | null>(COLOUR_VARIANTS * 2).fill(null);
    entry.shadows = list;
  }
  const cached = list[slot];
  if (cached !== null) return cached;
  const src = entry.variants[flipped ? VARIANT_FLIP : 0];
  if (src === null) return null;
  const pixels = context2d(src).getImageData(0, 0, src.width, src.height).data;
  const palette = paletteOf(charId);
  const shadowHex = palette.shadow[v];
  const shade = parseHex(shadowHex === undefined ? '#2a1640' : shadowHex);
  const rim = parseHex(remapHex(palette.glow, v, charId));
  const W = src.width + ECHO_PAD * 2;
  const H = src.height + ECHO_PAD * 2;
  const baked = canvasFrom(echoClone(pixels, src.width, src.height, shade, rim, v, charId), W, H);
  list[slot] = baked;
  return baked;
}

export function getOutline(
  sheetId: string,
  frameName: string,
  flipped: boolean,
  color: string
): HTMLCanvasElement | null {
  const frames = sheets.get(sheetId);
  if (frames === undefined) return null;
  const entry = frames.get(frameName);
  if (entry === undefined) return null;
  const pair = entry.outlines.get(color);
  if (pair === undefined) return null;
  return pair[flipped ? 1 : 0];
}

/** Reused result of getFrameAnchor. Read it before the next call. */
export interface FrameAnchor { ax: number; ay: number }
const anchorOut: FrameAnchor = { ax: 0, ay: 0 };

/**
 * Anchor of a baked frame in frame pixels: the point drawn at the fighter's
 * (or effect's) position. The flipped variant mirrors x to w - ax. Returns one
 * shared object, overwritten on every call, so the draw path never allocates.
 */
export function getFrameAnchor(
  sheetId: string,
  frameName: string,
  flipped: boolean
): FrameAnchor | null {
  const frames = sheets.get(sheetId);
  if (frames === undefined) return null;
  const entry = frames.get(frameName);
  if (entry === undefined) return null;
  anchorOut.ax = flipped ? entry.w - entry.ax : entry.ax;
  anchorOut.ay = entry.ay;
  return anchorOut;
}

/** Discard every baked canvas. Used when the renderer reloads its assets. */
export function clearBakes(): void {
  sheets.clear();
}
