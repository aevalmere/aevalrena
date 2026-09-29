/**
 * One parallax layer cut from a stage painting by tools/stagecut/cut_stage.py.
 * Every painted stage ships a generated `<id>/layers.ts` array of these, back
 * to front: sky 0.15, far 0.35, mid 0.6, stage 1.0.
 */
export interface StageLayerData {
  name: string;
  /** 0 = fixed to the screen, 1 = locked to world coordinates. */
  parallax: number;
  width: number;
  height: number;
  /** Layer pixel that sits on anchorWorld when the camera centre is there. */
  anchorX: number;
  anchorY: number;
  anchorWorldX: number;
  anchorWorldY: number;
  /** Edges whose outermost pixels are clamped outward at runtime: left, top, right, bottom. */
  clamp: readonly [boolean, boolean, boolean, boolean];
  src: string;
}
