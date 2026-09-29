import { TUNING } from '../core/constants';
import { clamp, lerp } from '../core/math';
import type { Rect } from '../core/types';
import { VIEW_H, VIEW_W } from '../core/types';
import { liveView } from './scale';

/**
 * Camera that frames every live fighter plus a margin, zooms and smooths with
 * the live TUNING.camera values, leads slightly in the direction the framed
 * group is moving, and never shows outside the stage bounds except for the
 * head room above them.
 *
 * Framing rules (docs/WAVE_ARENA_BALANCE.md, Worker A step 5):
 * - The fit box holds every live fighter's full extent (hurtbox half width
 *   each side, feet to head) plus TUNING.camera.margin, plus HEAD_ROOM above
 *   the highest head, plus the main walk line (world y = 0), so the stage
 *   stays in frame while a fighter flies up.
 * - zoomMin 0.6 shows 1067x600 world px, enough to hold a fighter at the top
 *   blast line together with the stage floor.
 * - The clamp rect is the stage's cameraBounds extended upward by TOP_ROOM,
 *   so a fighter launched up is never cut off before the blast line (blast
 *   top is 48 px above the bounds, the head another 44), and by SIDE_ROOM
 *   (48 px, the side blast pad) left and right, so a fighter in the last
 *   48 px before a side KO stays on screen. On an axis where the
 *   view is at least as big as the clamp rect, the camera centres that axis
 *   instead of fighting the fit.
 *
 * Every TUNING field is read at the moment it is used. Nothing here caches one
 * at import time, so the debug sliders take effect on the next render frame.
 */

/** Vertical extent of a fighter above its feet, used to keep heads in frame. */
const BODY_HEIGHT = 44;
/** Screen pixels of lead per px/frame of average group speed. */
const LEAD_PER_VX = 6;
/** Hard cap on the lead so fast play never throws the framing off. */
const LEAD_MAX = 24;
/** Half the fighter's width, so the fit holds the whole body, not the feet point. */
const BODY_HALF_W = 13;
/** Extra world px kept above the highest head, relative to the base view height. */
const HEAD_ROOM = Math.round(VIEW_H * 0.1);
/** World px the camera may look above cameraBounds (covers blast top + head + head room). */
const TOP_ROOM = Math.round(VIEW_H * 0.4);
/** World px the camera may look past cameraBounds on the left and right (the blast pad). */
const SIDE_ROOM = 48;
/** Main platform walk line (contract 1: world y = 0). Kept inside the fit box. */
const STAGE_FLOOR_Y = 0;

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  targetX: number;
  targetY: number;
  targetZoom: number;
}

export function createCamera(): CameraState {
  return { x: 0, y: 0, zoom: 1, targetX: 0, targetY: 0, targetZoom: 1 };
}

function computeTarget(
  cam: CameraState,
  posX: Float32Array,
  posY: Float32Array,
  velX: Float32Array,
  live: Uint8Array,
  count: number,
  bounds: Rect
): void {
  const margin = TUNING.camera.margin;
  const zoomMin = TUNING.camera.zoomMin;
  const zoomMax = TUNING.camera.zoomMax;

  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  let sumVx = 0;
  let found = 0;

  for (let i = 0; i < count; i++) {
    if (live[i] === 0) continue;
    const fx = posX[i];
    const feet = posY[i];
    const head = feet - BODY_HEIGHT;
    if (found === 0) {
      minX = fx - BODY_HALF_W;
      maxX = fx + BODY_HALF_W;
      minY = head;
      maxY = feet;
    } else {
      if (fx - BODY_HALF_W < minX) minX = fx - BODY_HALF_W;
      if (fx + BODY_HALF_W > maxX) maxX = fx + BODY_HALF_W;
      if (head < minY) minY = head;
      if (feet > maxY) maxY = feet;
    }
    sumVx += velX[i];
    found++;
  }

  if (found === 0) {
    cam.targetX = bounds.x + bounds.w / 2;
    cam.targetY = bounds.y + bounds.h / 2;
    cam.targetZoom = zoomMin;
    return;
  }

  minX -= margin;
  maxX += margin;
  minY -= margin + HEAD_ROOM;
  maxY += margin;
  // Keep the stage floor in the box, so a fighter flying up never takes the
  // camera away from the arena.
  if (maxY < STAGE_FLOOR_Y + margin) maxY = STAGE_FLOOR_Y + margin;
  if (minY > STAGE_FLOOR_Y - margin) minY = STAGE_FLOOR_Y - margin;

  const needW = maxX - minX;
  const needH = maxY - minY;
  // Framing uses the fixed 640x360 base view, so a bigger window shows more
  // world around the same framing instead of zooming in further.
  const zoomFit = Math.min(VIEW_W / needW, VIEW_H / needH);
  const lead = clamp((sumVx / found) * LEAD_PER_VX, -LEAD_MAX, LEAD_MAX);

  cam.targetX = (minX + maxX) / 2 + lead;
  cam.targetY = (minY + maxY) / 2;
  cam.targetZoom = clamp(zoomFit, zoomMin, zoomMax);
}

function clampToBounds(cam: CameraState, bounds: Rect): void {
  const halfW = liveView.w / (2 * cam.zoom);
  const halfH = liveView.h / (2 * cam.zoom);
  // The clamp rect is the bounds plus TOP_ROOM of head room above them and
  // SIDE_ROOM past each side.
  const top = bounds.y - TOP_ROOM;
  const h = bounds.h + TOP_ROOM;
  const left = bounds.x - SIDE_ROOM;
  const w = bounds.w + 2 * SIDE_ROOM;
  if (halfW * 2 >= w) {
    cam.x = left + w / 2;
  } else {
    cam.x = clamp(cam.x, left + halfW, left + w - halfW);
  }
  if (halfH * 2 >= h) {
    cam.y = top + h / 2;
  } else {
    cam.y = clamp(cam.y, top + halfH, top + h - halfH);
  }
}

export function updateCamera(
  cam: CameraState,
  posX: Float32Array,
  posY: Float32Array,
  velX: Float32Array,
  live: Uint8Array,
  count: number,
  bounds: Rect
): void {
  computeTarget(cam, posX, posY, velX, live, count, bounds);
  const smooth = TUNING.camera.lerp;
  cam.zoom = lerp(cam.zoom, cam.targetZoom, smooth);
  cam.x = lerp(cam.x, cam.targetX, smooth);
  cam.y = lerp(cam.y, cam.targetY, smooth);
  clampToBounds(cam, bounds);
}

/** Jump straight to the target. Used when a match starts so frame one is framed. */
export function snapCamera(
  cam: CameraState,
  posX: Float32Array,
  posY: Float32Array,
  velX: Float32Array,
  live: Uint8Array,
  count: number,
  bounds: Rect
): void {
  computeTarget(cam, posX, posY, velX, live, count, bounds);
  cam.zoom = cam.targetZoom;
  cam.x = cam.targetX;
  cam.y = cam.targetY;
  clampToBounds(cam, bounds);
}
