import type { ImageSheetData } from '../core/types';
import { WHITE } from './colors';

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
  outlines: Map<string, (HTMLCanvasElement | null)[]>;
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

/** Solid for outline purposes: opaque, and not a colour the ring skips. */
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
  if (pixels[i + 3] === 0) return false;
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
    const [x, y, w, h] = rect;
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
    frames.set(frameName, { variants, outlines });
  }
  sheets.set(sheetId, frames);
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

/** Discard every baked canvas. Used when the renderer reloads its assets. */
export function clearBakes(): void {
  sheets.clear();
}
