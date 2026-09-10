import { clamp, lerp } from '../core/math';
import type { Rect } from '../core/types';
import { VIEW_H, VIEW_W } from '../core/types';

/**
 * Camera that frames every live fighter plus a margin, zooms between 1.0 and
 * 1.8, smooths with a fixed lerp, and never shows outside the stage bounds.
 */

const CAMERA_MARGIN = 60;
const ZOOM_MIN = 1.0;
const ZOOM_MAX = 1.8;
const CAMERA_LERP = 0.12;
/** Vertical extent of a fighter above its feet, used to keep heads in frame. */
const BODY_HEIGHT = 44;

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
  live: Uint8Array,
  count: number,
  bounds: Rect
): void {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
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
    found++;
  }

  if (found === 0) {
    cam.targetX = bounds.x + bounds.w / 2;
    cam.targetY = bounds.y + bounds.h / 2;
    cam.targetZoom = ZOOM_MIN;
    return;
  }

  minX -= CAMERA_MARGIN;
  maxX += CAMERA_MARGIN;
  minY -= CAMERA_MARGIN;
  maxY += CAMERA_MARGIN;

  const needW = maxX - minX;
  const needH = maxY - minY;
  const zoomFit = Math.min(VIEW_W / needW, VIEW_H / needH);

  cam.targetX = (minX + maxX) / 2;
  cam.targetY = (minY + maxY) / 2;
  cam.targetZoom = clamp(zoomFit, ZOOM_MIN, ZOOM_MAX);
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
  live: Uint8Array,
  count: number,
  bounds: Rect
): void {
  computeTarget(cam, posX, posY, live, count, bounds);
  cam.zoom = lerp(cam.zoom, cam.targetZoom, CAMERA_LERP);
  cam.x = lerp(cam.x, cam.targetX, CAMERA_LERP);
  cam.y = lerp(cam.y, cam.targetY, CAMERA_LERP);
  clampToBounds(cam, bounds);
}

/** Jump straight to the target. Used when a match starts so frame one is framed. */
export function snapCamera(
  cam: CameraState,
  posX: Float32Array,
  posY: Float32Array,
  live: Uint8Array,
  count: number,
  bounds: Rect
): void {
  computeTarget(cam, posX, posY, live, count, bounds);
  cam.zoom = cam.targetZoom;
  cam.x = cam.targetX;
  cam.y = cam.targetY;
  clampToBounds(cam, bounds);
}
