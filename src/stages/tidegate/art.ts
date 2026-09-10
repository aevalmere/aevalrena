import type { ParallaxLayer, Platform, StageArt, StageDef } from '../../core/types';
import { VIEW_H, VIEW_W } from '../../core/types';
import { tidegateDef } from './data';

/**
 * Tidegate art: dusk over a flooded ruin. Every parallax layer is painted once
 * into an offscreen canvas sized to cover the camera bounds at its own parallax
 * factor plus a full view at the smallest zoom the camera can reach, then
 * blitted with one drawImage under a whole-pixel translate and a camera-zoom
 * scale, so the background grows with the fighters instead of staying at 1x.
 * Only the ocean highlight row and the platform drips move, and both switch
 * between two frames driven by `t`.
 *
 * Palette is SPEC section 6. Everything is fillRect at whole pixels: no
 * gradient API, no arcs, no per-frame pixel work.
 */

const INK = '#1a1b26';
const STONE_DARK = '#2b2d42';
const STONE = '#3a4a6b';
const STONE_LIGHT = '#6e7a94';
const HAZE = '#9aa5b8';
const PALE = '#c9d1e0';
const CREAM = '#f0ead6';
const DEEP_BLUE = '#5b7fbf';
const GLOW = '#7fb2ff';
const GLOW_BRIGHT = '#b8e3ff';
const WINE = '#5a2e3e';

const BOUNDS = tidegateDef.cameraBounds;
const CENTER_X = BOUNDS.x + BOUNDS.w / 2;
const CENTER_Y = BOUNDS.y + BOUNDS.h / 2;

/** Screen row the sky meets the water when the camera sits at the bounds center. */
const HORIZON_Y = 190;

/**
 * Smallest zoom the layers are sized to cover. It sits below the camera's own
 * zoomMin so lowering that floor at runtime still cannot expose a layer edge at
 * any point inside the camera bounds.
 */
const MIN_COVERED_ZOOM = 0.6;

/** Slack that absorbs the whole-pixel rounding of the layer translate. */
const COVER_PAD = 4;

interface BakedLayer extends ParallaxLayer {
  bake(): void;
}

/** Deterministic scatter so a rebake paints the same sky twice. */
function makeRand(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Layer row for a screen row, when the camera sits at the bounds center. */
function layerY(screenY: number, h: number): number {
  return Math.round(screenY + h / 2 - VIEW_H / 2);
}

/**
 * Layer canvas size. A layer drawn at zoom z covers `size * z` screen pixels
 * and slides by `bounds * parallax * z`, so covering the view at every camera
 * position needs `view / MIN_COVERED_ZOOM + bounds * parallax` pixels.
 */
function layerSize(extent: number, view: number, parallax: number): number {
  return Math.ceil(extent * parallax) + Math.ceil(view / MIN_COVERED_ZOOM) + COVER_PAD;
}

function createLayer(
  parallax: number,
  scaleWithZoom: boolean,
  frameCount: number,
  framesPerSecond: number,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number, frame: number) => void
): BakedLayer {
  const canvases: HTMLCanvasElement[] = [];
  let w = 0;
  let h = 0;

  function bake(): void {
    w = layerSize(BOUNDS.w, VIEW_W, parallax);
    h = layerSize(BOUNDS.h, VIEW_H, parallax);
    canvases.length = 0;
    for (let f = 0; f < frameCount; f++) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      paint(context2d(canvas), w, h, f);
      canvases.push(canvas);
    }
  }

  return {
    parallax,
    bake,
    draw(ctx, camX, camY, zoom, t): void {
      if (canvases.length === 0) bake();
      let index = 0;
      if (frameCount > 1) {
        index = Math.floor(t * framesPerSecond) % frameCount;
        if (index < 0) index = 0;
      }
      const canvas = canvases[index];

      if (!scaleWithZoom) {
        const flatX = Math.round(VIEW_W / 2 - (camX - CENTER_X) * parallax - w / 2);
        const flatY = Math.round(VIEW_H / 2 - (camY - CENTER_Y) * parallax - h / 2);
        ctx.drawImage(canvas, flatX, flatY);
        return;
      }

      const ox = Math.round(VIEW_W / 2 - (camX - CENTER_X) * parallax * zoom - (w * zoom) / 2);
      const oy = Math.round(VIEW_H / 2 - (camY - CENTER_Y) * parallax * zoom - (h * zoom) / 2);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(zoom, zoom);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();
    },
  };
}

// ---------------- sky ----------------

const SKY_BANDS: readonly { y: number; h: number; color: string }[] = [
  { y: 0, h: 40, color: INK },
  { y: 40, h: 42, color: STONE_DARK },
  { y: 82, h: 38, color: STONE },
  { y: 120, h: 32, color: WINE },
  { y: 152, h: 22, color: STONE_LIGHT },
  { y: 174, h: 10, color: HAZE },
  { y: 184, h: 6, color: PALE },
  { y: 190, h: 5, color: CREAM },
];

function paintSky(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const top = layerY(0, h);
  for (let i = 0; i < SKY_BANDS.length; i++) {
    const band = SKY_BANDS[i];
    ctx.fillStyle = band.color;
    ctx.fillRect(0, top + band.y, w, band.h);
  }
  ctx.fillStyle = STONE_DARK;
  ctx.fillRect(0, top + 195, w, h - (top + 195));

  const rand = makeRand(0x51ed);
  for (let i = 0; i < 70; i++) {
    const sx = Math.floor(rand() * w);
    const sy = top + Math.floor(rand() * 140);
    ctx.fillStyle = rand() < 0.25 ? CREAM : PALE;
    ctx.fillRect(sx, sy, 1, 1);
  }
}

// ---------------- distant mountains ----------------

function paintRidge(
  ctx: CanvasRenderingContext2D,
  w: number,
  base: number,
  color: string,
  amplitude: number,
  bias: number,
  seed: number,
  skirt: number
): void {
  const rand = makeRand(seed);
  ctx.fillStyle = color;
  for (let x = 0; x < w; x += 4) {
    const wave =
      Math.sin(x * 0.011 + bias) * amplitude +
      Math.sin(x * 0.037 + bias * 2) * (amplitude * 0.45) +
      rand() * 5;
    const peak = Math.round(amplitude * 0.6 + wave);
    const top = base - (peak > 0 ? peak : 0);
    ctx.fillRect(x, top, 4, base - top + skirt);
  }
}

function paintMountains(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const base = layerY(HORIZON_Y, h);
  paintRidge(ctx, w, base - 4, STONE, 26, 0.6, 0x2f11, 30);
  paintRidge(ctx, w, base, STONE_DARK, 16, 2.1, 0x77c3, 30);
}

// ---------------- ruined arches and towers ----------------

function paintTower(
  ctx: CanvasRenderingContext2D,
  x: number,
  base: number,
  width: number,
  height: number,
  rand: () => number
): void {
  ctx.fillStyle = INK;
  ctx.fillRect(x, base - height, width, height + 24);
  for (let b = 0; b < width; b += 6) {
    ctx.fillRect(x + b, base - height - 5, 4, 5);
  }
  ctx.fillStyle = CREAM;
  for (let wy = base - height + 10; wy < base - 8; wy += 14) {
    if (rand() < 0.4) continue;
    const wx = x + 3 + Math.floor(rand() * (width - 7));
    ctx.fillRect(wx, wy, 2, 2);
  }
}

function paintArch(ctx: CanvasRenderingContext2D, x: number, base: number, span: number): void {
  ctx.fillStyle = INK;
  const pierH = 34;
  ctx.fillRect(x, base - pierH, 7, pierH + 24);
  ctx.fillRect(x + span - 7, base - pierH, 7, pierH + 24);
  ctx.fillRect(x, base - pierH - 5, span, 5);
  ctx.fillRect(x + 6, base - pierH + 1, 4, 4);
  ctx.fillRect(x + span - 10, base - pierH + 1, 4, 4);
  ctx.fillRect(x + 10, base - pierH + 5, 3, 3);
  ctx.fillRect(x + span - 13, base - pierH + 5, 3, 3);
}

function paintRuins(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const base = layerY(HORIZON_Y + 2, h);
  const rand = makeRand(0x9a13);
  let x = 6;
  while (x < w - 40) {
    if (rand() < 0.42) {
      const span = 34 + Math.floor(rand() * 20);
      paintArch(ctx, x, base, span);
      x += span + 10 + Math.floor(rand() * 22);
    } else {
      const width = 14 + Math.floor(rand() * 12);
      const height = 30 + Math.floor(rand() * 52);
      paintTower(ctx, x, base, width, height, rand);
      x += width + 12 + Math.floor(rand() * 30);
    }
  }
  ctx.fillStyle = INK;
  ctx.fillRect(0, base + 20, w, h - (base + 20));
}

// ---------------- ocean ----------------

const OCEAN_BANDS: readonly { off: number; h: number; color: string }[] = [
  { off: 0, h: 4, color: DEEP_BLUE },
  { off: 4, h: 10, color: STONE },
  { off: 14, h: 14, color: STONE_DARK },
  { off: 28, h: 18, color: STONE },
  { off: 46, h: 24, color: STONE_DARK },
];

const HIGHLIGHT_ROWS: readonly number[] = [3, 11, 22, 38, 58];

function paintOcean(ctx: CanvasRenderingContext2D, w: number, h: number, frame: number): void {
  const top = layerY(HORIZON_Y, h);
  ctx.fillStyle = STONE_DARK;
  ctx.fillRect(0, top, w, h - top);
  for (let i = 0; i < OCEAN_BANDS.length; i++) {
    const band = OCEAN_BANDS[i];
    ctx.fillStyle = band.color;
    ctx.fillRect(0, top + band.off, w, band.h);
  }
  ctx.fillStyle = INK;
  ctx.fillRect(0, top + 70, w, h - (top + 70));

  const rand = makeRand(0x3c07 + frame * 977);
  for (let r = 0; r < HIGHLIGHT_ROWS.length; r++) {
    const y = top + HIGHLIGHT_ROWS[r];
    ctx.fillStyle = r < 2 ? GLOW_BRIGHT : GLOW;
    let x = frame === 0 ? 0 : 7;
    while (x < w) {
      const dash = 3 + Math.floor(rand() * 5);
      if (rand() < 0.55) ctx.fillRect(x, y, dash, 1);
      x += dash + 6 + Math.floor(rand() * 14);
    }
  }
}

// ---------------- foreground mist ----------------

function paintMist(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = makeRand(0x6b41);
  const top = Math.round(h * 0.45);
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rand() * w);
    const y = top + Math.floor(rand() * (h - top - 4));
    const width = 30 + Math.floor(rand() * 90);
    const height = 2 + Math.floor(rand() * 3);
    ctx.globalAlpha = 0.07 + rand() * 0.07;
    ctx.fillStyle = rand() < 0.5 ? HAZE : STONE_LIGHT;
    ctx.fillRect(x, y, width, height);
  }
  ctx.globalAlpha = 1;
}

// ---------------- platforms ----------------

const RUNE_STEP = 16;
const RUNE_LEN = 8;

function drawRuneStrip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  thickness: number
): void {
  ctx.fillStyle = GLOW;
  for (let rx = x + 4; rx + RUNE_LEN <= x + w - 4; rx += RUNE_STEP) {
    ctx.fillRect(rx, y, RUNE_LEN, thickness);
  }
  ctx.fillStyle = GLOW_BRIGHT;
  for (let rx = x + 4; rx + RUNE_LEN <= x + w - 4; rx += RUNE_STEP) {
    ctx.fillRect(rx + 2, y, RUNE_LEN - 4, 1);
  }
}

function drawMainPlatform(ctx: CanvasRenderingContext2D, p: Platform): void {
  ctx.fillStyle = STONE;
  ctx.fillRect(p.x, p.y, p.w, p.h);

  ctx.fillStyle = STONE_DARK;
  for (let sx = p.x + 24; sx < p.x + p.w; sx += 24) {
    ctx.fillRect(sx, p.y + 3, 1, p.h - 3);
  }

  ctx.fillStyle = STONE_LIGHT;
  ctx.fillRect(p.x, p.y, p.w, 1);
  for (let mx = p.x + 5; mx < p.x + p.w - 4; mx += 11) {
    if (((mx * 31) & 7) >= 4) continue;
    ctx.fillRect(mx, p.y + 3, 2, 1);
  }

  drawRuneStrip(ctx, p.x, p.y + 1, p.w, 2);

  ctx.fillStyle = STONE_DARK;
  ctx.fillRect(p.x, p.y + p.h - 8, p.w, 3);
  ctx.fillStyle = INK;
  ctx.fillRect(p.x, p.y + p.h - 5, p.w, 5);
  ctx.fillRect(p.x, p.y + 4, 1, p.h - 4);
  ctx.fillRect(p.x + p.w - 1, p.y + 4, 1, p.h - 4);
}

function drawFloatingPlatform(
  ctx: CanvasRenderingContext2D,
  p: Platform,
  index: number,
  phase: number
): void {
  ctx.fillStyle = STONE;
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.fillStyle = STONE_LIGHT;
  ctx.fillRect(p.x, p.y, p.w, 1);
  drawRuneStrip(ctx, p.x, p.y + 1, p.w, 1);
  ctx.fillStyle = STONE_DARK;
  ctx.fillRect(p.x, p.y + p.h - 3, p.w, 1);
  ctx.fillStyle = INK;
  ctx.fillRect(p.x, p.y + p.h - 2, p.w, 2);

  const dropBase = p.y + p.h;
  ctx.fillStyle = GLOW;
  const firstX = p.x + Math.round(p.w * 0.28) + (index & 1);
  const secondX = p.x + Math.round(p.w * 0.71);
  ctx.fillRect(firstX, dropBase + 1 + phase * 6, 1, 2);
  ctx.fillRect(secondX, dropBase + 4 + ((phase + 1) & 1) * 6, 1, 2);
  ctx.fillStyle = GLOW_BRIGHT;
  ctx.fillRect(firstX, dropBase, 1, 1);
  ctx.fillRect(secondX, dropBase, 1, 1);
}

// ---------------- assembled art ----------------

// The sky is a full-screen banded gradient fixed to the view, so it stays at
// 1x; everything with depth scales with the camera.
const skyLayer = createLayer(0, false, 1, 0, paintSky);
const mountainLayer = createLayer(0.1, true, 1, 0, paintMountains);
const ruinLayer = createLayer(0.3, true, 1, 0, paintRuins);
const oceanLayer = createLayer(0.5, true, 2, 2, paintOcean);
const mistLayer = createLayer(1.15, true, 1, 0, paintMist);

const bakedLayers: readonly BakedLayer[] = [
  skyLayer,
  mountainLayer,
  ruinLayer,
  oceanLayer,
  mistLayer,
];

/**
 * StageArt plus the bake hook the renderer calls during load. The extra method
 * is optional on the renderer side, so this still satisfies StageArt.
 */
export interface PreparableStageArt extends StageArt {
  prepare(): void;
}

export const tidegateArt: PreparableStageArt = {
  layers: [skyLayer, mountainLayer, ruinLayer, oceanLayer],
  foreground: [mistLayer],

  /** Rebake every layer at the size the current bounds and zoom floor need. */
  prepare(): void {
    for (let i = 0; i < bakedLayers.length; i++) bakedLayers[i].bake();
  },

  drawPlatforms(ctx: CanvasRenderingContext2D, stage: StageDef, t: number): void {
    const phase = Math.floor(t * 4) & 1;
    for (let i = 0; i < stage.platforms.length; i++) {
      const platform = stage.platforms[i];
      if (platform.solid) {
        drawMainPlatform(ctx, platform);
      } else {
        drawFloatingPlatform(ctx, platform, i, phase);
      }
    }
  },
};
