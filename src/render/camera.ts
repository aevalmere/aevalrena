import { TUNING } from '../core/constants';
import { clamp, lerp } from '../core/math';
import type { Rect } from '../core/types';
import { VIEW_H, VIEW_W } from '../core/types';

/**
 * Camera that frames every live fighter plus a margin, zooms and smooths with
 * the live TUNING.camera values, leads slightly in the direction the framed
 * group is moving, and never shows outside the stage bounds.
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
      minX = fx;
      maxX = fx;
      minY = head;
      maxY = feet;
    } else {
      if (fx < minX) minX = fx;
      if (fx > maxX) maxX = fx;
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
  minY -= margin;
  maxY += margin;

  const needW = maxX - minX;
  const needH = maxY - minY;
  const zoomFit = Math.min(VIEW_W / needW, VIEW_H / needH);
  const lead = clamp((sumVx / found) * LEAD_PER_VX, -LEAD_MAX, LEAD_MAX);

  cam.targetX = (minX + maxX) / 2 + lead;
  cam.targetY = (minY + maxY) / 2;
  cam.targetZoom = clamp(zoomFit, zoomMin, zoomMax);
}

function clampToBounds(cam: CameraState, bounds: Rect): void {
  const halfW = VIEW_W / (2 * cam.zoom);
  const halfH = VIEW_H / (2 * cam.zoom);
  if (halfW * 2 >= bounds.w) {
    cam.x = bounds.x + bounds.w / 2;
  } else {
    cam.x = clamp(cam.x, bounds.x + halfW, bounds.x + bounds.w - halfW);
  }
  if (halfH * 2 >= bounds.h) {
    cam.y = bounds.y + bounds.h / 2;
  } else {
    cam.y = clamp(cam.y, bounds.y + halfH, bounds.y + bounds.h - halfH);
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
