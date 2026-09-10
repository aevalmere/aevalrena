import { VIEW_H, VIEW_W } from '../core/types';

/**
 * Integer scale fit. The canvas backing store stays at VIEW_W x VIEW_H and the
 * CSS box is the largest integer multiple that fits the window. The page style
 * centers it and sets image-rendering: pixelated.
 */

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
 * mutated in place so resize never allocates.
 */
export function fitCanvas(canvas: HTMLCanvasElement): CanvasFit {
  if (canvas.width !== VIEW_W) canvas.width = VIEW_W;
  if (canvas.height !== VIEW_H) canvas.height = VIEW_H;

  const w = typeof window === 'undefined' ? VIEW_W : window.innerWidth;
  const h = typeof window === 'undefined' ? VIEW_H : window.innerHeight;
  const scale = integerScale(w, h);

  fit.scale = scale;
  fit.cssW = VIEW_W * scale;
  fit.cssH = VIEW_H * scale;

  const cssW = `${fit.cssW}px`;
  const cssH = `${fit.cssH}px`;
  if (canvas.style.width !== cssW) canvas.style.width = cssW;
  if (canvas.style.height !== cssH) canvas.style.height = cssH;
  if (canvas.style.imageRendering !== 'pixelated') canvas.style.imageRendering = 'pixelated';

  return fit;
}
