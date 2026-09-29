import type { StageDef } from '../../core/types';
import { TIDEGATE_BLAST, TIDEGATE_CAMERA_BOUNDS, TIDEGATE_PLATFORMS } from './geometry';

/**
 * Tidegate (night repaint, 2026-09-28). Everything below comes from
 * geometry.ts, which tools/stagecut/cut_stage.py tidegate measures on
 * art/stages/tidegate/source.png (1672x941):
 *
 * - Scale 1080 / 1672 = 0.64593 (contract 3), so the painting is 1080x608 world px.
 * - Main walk line = the middle depth line of the main disc top, painting
 *   (852, 617) = world (0, 0). Main platform x -248..248 (w 496), ledges.
 * - Side discs, pass-through, on the middle depth line of their tops:
 *   left x -234..-100, right x 101..235. Painted at y -105; both discs (and
 *   their waterfalls) are cut with shiftY 21, so art and line sit at y -84,
 *   one full hop (apex 94.5 px) above the main floor.
 * - cameraBounds = the painting's world rect { x: -550, y: -399, w: 1080, h: 608 }.
 * - blast = cameraBounds grown 48 left/top/right and 96 bottom
 *   { x: -598, y: -447, w: 1176, h: 752 }.
 *
 * Spawns keep the old layout scaled to the wider main platform (360 -> 496 px).
 */
export const tidegateDef: StageDef = {
  id: 'tidegate',
  name: 'Tidegate',
  platforms: TIDEGATE_PLATFORMS.map((p) => ({ ...p })),
  blast: { ...TIDEGATE_BLAST },
  spawns: [
    { x: -165, y: 0 },
    { x: 165, y: 0 },
    { x: -55, y: 0 },
    { x: 55, y: 0 },
  ],
  respawn: { x: 0, y: -160 },
  cameraBounds: { ...TIDEGATE_CAMERA_BOUNDS },
};
