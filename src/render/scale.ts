import { VIEW_H, VIEW_W } from '../core/types';

/**
 * Integer scale fit that fills the window. The scale is the largest integer
 * multiple of the 640x360 base view that fits the window, so fighters and the
 * stage keep the same on-screen size they always had. The logical canvas then
 * grows to ceil(window / scale) on both axes, so the leftover space shows more
 * world instead of black bars. The CSS box is logical * scale, which covers
 * the window with at most scale - 1 pixels hanging past the right and bottom
 * edges; the page style sets image-rendering: pixelated.
 *
 * `liveView` is the one source of truth for the logical canvas size. Camera,
 * HUD, debug text and stage layers read it every frame. It is mutated in place
 * on resize, never reallocated.
 */

export interface LiveView {
  /** Logical canvas width in game pixels. */
  w: number;
  /** Logical canvas height in game pixels. */
  h: number;
  /** Integer CSS pixels per game pixel. */
  scale: number;
}

export const liveView: LiveView = { w: VIEW_W, h: VIEW_H, scale: 1 };

function integerScale(windowW: number, windowH: number): number {
  const s = Math.floor(Math.min(windowW / VIEW_W, windowH / VIEW_H));
  return s < 1 ? 1 : s;
}

export interface CanvasFit {
  scale: number;
  cssW: number;
  cssH: number;
}

const fit: CanvasFit = { scale: 1, cssW: VIEW_W, cssH: VIEW_H };

/**
 * Size the canvas and its CSS box. Returns the shared fit record, which is
 * mutated in place so resize never allocates. Changing canvas.width resets the
 * 2D context state, so it is only written when the logical size changes.
 */
export function fitCanvas(canvas: HTMLCanvasElement): CanvasFit {
  const w = typeof window === 'undefined' ? VIEW_W : window.innerWidth;
  const h = typeof window === 'undefined' ? VIEW_H : window.innerHeight;
  const scale = integerScale(w, h);
  const logicalW = Math.max(VIEW_W, Math.ceil(w / scale));
  const logicalH = Math.max(VIEW_H, Math.ceil(h / scale));

  if (canvas.width !== logicalW) canvas.width = logicalW;
  if (canvas.height !== logicalH) canvas.height = logicalH;

  liveView.w = logicalW;
  liveView.h = logicalH;
  liveView.scale = scale;

  fit.scale = scale;
  fit.cssW = logicalW * scale;
  fit.cssH = logicalH * scale;

  const cssW = `${fit.cssW}px`;
  const cssH = `${fit.cssH}px`;
  if (canvas.style.width !== cssW) canvas.style.width = cssW;
  if (canvas.style.height !== cssH) canvas.style.height = cssH;
  if (canvas.style.imageRendering !== 'pixelated') canvas.style.imageRendering = 'pixelated';

  return fit;
}
