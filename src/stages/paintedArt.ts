import type { ParallaxLayer, StageArt, StageDef } from '../core/types';
import { liveView } from '../render/scale';
import type { StageLayerData } from './layers';

/**
 * Stage art for a painting cut into parallax layers by
 * tools/stagecut/cut_stage.py. Back to front: sky 0.15, far 0.35, mid 0.6,
 * stage 1.0. The stage layer is locked to world coordinates, so its painted
 * surfaces line up with the collision lines in the stage's geometry.ts. The
 * back layers are baked at the stage scale and anchored on the painting
 * centre, so at the reference camera the layers recompose the painting.
 *
 * Each layer is one image drawn with one drawImage under a whole-pixel
 * translate and a camera-zoom scale. Where the live view reaches past a
 * layer's baked pad (a wide window at zoomMin, or the camera head room above
 * the painting), the outermost row or column is stretched outward (the
 * generator marks which edges carry content), so a layer edge never shows.
 * Nothing here allocates per frame.
 */

/** Screen pixels of slack past the view edge, covers shake and rounding. */
const EDGE_SLACK = 8;
/** Clamp strips overlap the image by this many layer pixels, so no seam shows. */
const STRIP_OVERLAP = 1;

interface ImageLayer extends ParallaxLayer {
  load(): Promise<void>;
}

function createImageLayer(data: StageLayerData): ImageLayer {
  let image: HTMLImageElement | null = null;
  let loading: Promise<void> | null = null;
  const w = data.width;
  const h = data.height;
  const ix = -data.anchorX;
  const iy = -data.anchorY;
  const clampL = data.clamp[0];
  const clampT = data.clamp[1];
  const clampR = data.clamp[2];
  const clampB = data.clamp[3];

  function load(): Promise<void> {
    if (loading !== null) return loading;
    loading = new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = (): void => {
        image = img;
        resolve();
      };
      img.onerror = (): void => {
        reject(new Error('stage layer ' + data.name + ' failed to decode'));
      };
      img.src = data.src;
    });
    return loading;
  }

  return {
    parallax: data.parallax,
    load,
    draw(ctx, camX, camY, zoom): void {
      const img = image;
      if (img === null) return;
      const vw = liveView.w;
      const vh = liveView.h;
      const p = data.parallax;
      const ox = Math.round(vw / 2 + (data.anchorWorldX - camX) * p * zoom);
      const oy = Math.round(vh / 2 + (data.anchorWorldY - camY) * p * zoom);

      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(zoom, zoom);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, ix, iy);

      // View rectangle in layer-local pixels.
      const slack = EDGE_SLACK / zoom;
      const vx0 = -ox / zoom - slack;
      const vy0 = -oy / zoom - slack;
      const vx1 = (vw - ox) / zoom + slack;
      const vy1 = (vh - oy) / zoom + slack;
      const right = ix + w;
      const bottom = iy + h;
      const o = STRIP_OVERLAP;
      const needL = clampL && vx0 < ix;
      const needR = clampR && vx1 > right;
      const needT = clampT && vy0 < iy;
      const needB = clampB && vy1 > bottom;

      if (needL) ctx.drawImage(img, 0, 0, 1, h, vx0, iy, ix - vx0 + o, h);
      if (needR) ctx.drawImage(img, w - 1, 0, 1, h, right - o, iy, vx1 - right + o, h);
      if (needT) ctx.drawImage(img, 0, 0, w, 1, ix, vy0, w, iy - vy0 + o);
      if (needB) ctx.drawImage(img, 0, h - 1, w, 1, ix, bottom - o, w, vy1 - bottom + o);
      if (needL && needT) ctx.drawImage(img, 0, 0, 1, 1, vx0, vy0, ix - vx0 + o, iy - vy0 + o);
      if (needR && needT) ctx.drawImage(img, w - 1, 0, 1, 1, right - o, vy0, vx1 - right + o, iy - vy0 + o);
      if (needL && needB) ctx.drawImage(img, 0, h - 1, 1, 1, vx0, bottom - o, ix - vx0 + o, vy1 - bottom + o);
      if (needR && needB) {
        ctx.drawImage(img, w - 1, h - 1, 1, 1, right - o, bottom - o, vx1 - right + o, vy1 - bottom + o);
      }
      ctx.restore();
    },
  };
}

/**
 * StageArt plus the load hook the renderer awaits during load. The extra
 * method is optional on the renderer side, so this still satisfies StageArt.
 */
export interface PreparableStageArt extends StageArt {
  prepare(): Promise<void>;
}

export function createPaintedStageArt(layers: readonly StageLayerData[]): PreparableStageArt {
  const imageLayers: ImageLayer[] = [];
  for (let i = 0; i < layers.length; i++) imageLayers.push(createImageLayer(layers[i]));
  return {
    // Back to front, all behind the fighters. The stage layer is last and is
    // the painted platforms themselves.
    layers: imageLayers,
    foreground: [],

    async prepare(): Promise<void> {
      const pending: Promise<void>[] = [];
      for (let i = 0; i < imageLayers.length; i++) pending.push(imageLayers[i].load());
      await Promise.all(pending);
    },

    /** The platforms are painted into the stage layer; nothing extra to draw. */
    drawPlatforms(_ctx: CanvasRenderingContext2D, _stage: StageDef, _t: number): void {},
  };
}
