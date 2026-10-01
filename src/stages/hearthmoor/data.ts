import type { StageDef } from '../../core/types';
import { HEARTHMOOR_BLAST, HEARTHMOOR_CAMERA_BOUNDS, HEARTHMOOR_PLATFORMS } from './geometry';

/**
 * Hearthmoor (day village, 2026-09-28). Everything below comes from
 * geometry.ts, which tools/stagecut/cut_stage.py hearthmoor measures on
 * art/stages/hearthmoor/source.png (1672x941):
 *
 * - Scale 1080 / 1672 = 0.64593 (contract 3), so the painting is 1080x608 world px.
 * - Main walk line = the middle depth line of the grassy island top (between
 *   the back fence line and the front grass lip), painting (820, 536) =
 *   world (0, 0). Main platform x -298..298 (w 596), ledges.
 * - Grassy side platforms, pass-through, on the middle depth line of their
 *   tops: left x -338..-128 (w 210), right x 159..362 (w 203). Painted at
 *   y -157; cut with shiftY 73 (platform, fence, vines), so art and line sit at
 *   y -84, one full hop (apex 94.5 px) above the main floor. Lowered, the left
 *   platform's right tip passes behind the banner post and the right
 *   platform's left tip behind the well roof (unshifted stage pixels draw in
 *   front of shifted ones).
 * - cameraBounds = the painting's world rect { x: -530, y: -346, w: 1080, h: 608 }.
 * - blast = cameraBounds grown 48 left/right, 101 top and 96 bottom
 *   { x: -578, y: -447, w: 1176, h: 805 }, so the top blast line sits 447 above the floor like Tidegate.
 *
 * Spawns are the Tidegate layout scaled to this main platform (360 -> 596 px).
 */
export const hearthmoorDef: StageDef = {
  id: 'hearthmoor',
  name: 'Hearthmoor',
  platforms: HEARTHMOOR_PLATFORMS.map((p) => ({ ...p })),
  blast: { ...HEARTHMOOR_BLAST },
  spawns: [
    { x: -199, y: 0 },
    { x: 199, y: 0 },
    { x: -66, y: 0 },
    { x: 66, y: 0 },
  ],
  respawn: { x: 0, y: -160 },
  cameraBounds: { ...HEARTHMOOR_CAMERA_BOUNDS },
};
