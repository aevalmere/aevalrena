import type { PixelSheet } from '../core/types';
import { WHITE } from './colors';

/**
 * Sprite baker. Every PixelSheet frame becomes an offscreen canvas at load so a
 * fighter draw is one drawImage. Four variants per frame (normal, flipped,
 * white silhouette, flipped white silhouette) plus optional 1 px outline
 * canvases tinted per player color.
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
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

function validate(sheetId: string, frameName: string, rows: string[]): number {
  if (rows.length === 0) {
    throw new Error(`sprite frame "${frameName}" in sheet "${sheetId}" has no rows`);
  }
  const w = rows[0].length;
  if (w === 0) {
    throw new Error(`sprite frame "${frameName}" in sheet "${sheetId}" has zero width`);
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length !== w) {
      throw new Error(
        `sprite frame "${frameName}" in sheet "${sheetId}" has rows of unequal length: ` +
          `row 0 is ${w}, row ${i} is ${rows[i].length}`
      );
    }
  }
  return w;
}

function isOpaque(rows: string[], palette: Record<string, string>, x: number, y: number): boolean {
  if (y < 0 || y >= rows.length) return false;
  const row = rows[y];
  if (x < 0 || x >= row.length) return false;
  const ch = row.charAt(x);
  if (ch === '.') return false;
  return palette[ch] !== undefined;
}

/** Paint a pixel grid into ctx as run-length fillRects. */
function paintGrid(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  palette: Record<string, string>,
  w: number,
  flip: boolean,
  forceColor: string | null
): void {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    let x = 0;
    while (x < w) {
      const ch = row.charAt(x);
      const color = ch === '.' ? undefined : palette[ch];
      if (color === undefined) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < w && row.charAt(end) === ch) end++;
      ctx.fillStyle = forceColor === null ? color : forceColor;
      const dx = flip ? w - end : x;
      ctx.fillRect(dx, y, end - x, 1);
      x = end;
    }
  }
}

function bakeVariant(
  rows: string[],
  palette: Record<string, string>,
  w: number,
  flip: boolean,
  white: boolean
): HTMLCanvasElement {
  const canvas = makeCanvas(w, rows.length);
  const ctx = context2d(canvas);
  paintGrid(ctx, rows, palette, w, flip, white ? WHITE : null);
  return canvas;
}

/** A 1 px ring around the silhouette, on a canvas 1 px larger on every side. */
function bakeOutline(
  rows: string[],
  palette: Record<string, string>,
  w: number,
  flip: boolean,
  color: string
): HTMLCanvasElement {
  const h = rows.length;
  const canvas = makeCanvas(w + 2, h + 2);
  const ctx = context2d(canvas);
  ctx.fillStyle = color;
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      if (isOpaque(rows, palette, x, y)) continue;
      const touches =
        isOpaque(rows, palette, x - 1, y) ||
        isOpaque(rows, palette, x + 1, y) ||
        isOpaque(rows, palette, x, y - 1) ||
        isOpaque(rows, palette, x, y + 1);
      if (!touches) continue;
      const dx = flip ? w - 1 - x : x;
      ctx.fillRect(dx + 1, y + 1, 1, 1);
    }
  }
  return canvas;
}

/**
 * Bake every frame of a sheet. `outlineColors` bakes a tinted outline copy per
 * color; pass an empty array for effect sheets that never need one.
 */
export function bakeSheet(
  sheetId: string,
  sheet: PixelSheet,
  outlineColors: readonly string[]
): void {
  const frames = new Map<string, FrameEntry>();
  for (const frameName in sheet.frames) {
    const rows = sheet.frames[frameName];
    const w = validate(sheetId, frameName, rows);
    const variants: (HTMLCanvasElement | null)[] = new Array(VARIANT_COUNT).fill(null);
    for (let v = 0; v < VARIANT_COUNT; v++) {
      variants[v] = bakeVariant(
        rows,
        sheet.palette,
        w,
        (v & VARIANT_FLIP) !== 0,
        (v & VARIANT_WHITE) !== 0
      );
    }
    const outlines = new Map<string, (HTMLCanvasElement | null)[]>();
    for (const color of outlineColors) {
      outlines.set(color, [
        bakeOutline(rows, sheet.palette, w, false, color),
        bakeOutline(rows, sheet.palette, w, true, color),
      ]);
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
