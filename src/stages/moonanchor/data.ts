import type { StageDef } from '../../core/types';
import { MOONANCHOR_BLAST, MOONANCHOR_CAMERA_BOUNDS, MOONANCHOR_PLATFORMS } from './geometry';

/**
 * Moonanchor (eclipse over the void, 2026-10-01), Trekmore's home stage.
 * Everything below comes from geometry.ts, which tools/stagecut/cut_stage.py
 * moonanchor measures on art/stages/moonanchor/source.png (1536x1024):
 *
 * - Scale 1080 / 1536 = 0.70313 (contract 3), so the painting is 1080x720 world px.
 * - Main walk line = the middle depth line of the spiked island's deck (between
 *   the back rim and the front lip), painting (764, 697) = world (0, 0). Main
 *   platform x -246..246 (w 492), ledges. The spiked underside is art only; the
 *   collision is the usual 24 px thick rectangle, so a fighter rising into it
 *   near an edge slides out past the corner like on the other stages.
 * - Three thin floating platforms, pass-through, on their deck lines:
 *   left x -205..-85 and right x 91..208, painted at y -70 and cut with
 *   shiftY -14 so art and line sit at y -84 (one full hop, as on the other
 *   stages); centre x -85..80, painted at y -110 and cut with shiftY -30 so it
 *   sits at y -140, one short hop above the side platforms.
 * - cameraBounds = the painting's world rect { x: -537, y: -490, w: 1080, h: 720 }.
 * - blast = cameraBounds grown 48 left/right and 96 bottom, and pulled 50 in at
 *   the top (the painting is taller than the other two), so the top blast line
 *   sits 440 above the floor, just under Tidegate and Hearthmoor (447).
 *
 * Spawns are the Tidegate layout (main platform 496 px, this one 492 px). The
 * respawn point sits above the centre platform.
 */
export const moonanchorDef: StageDef = {
  id: 'moonanchor',
  name: 'Moonanchor',
  platforms: MOONANCHOR_PLATFORMS.map((p) => ({ ...p })),
  blast: { ...MOONANCHOR_BLAST },
  spawns: [
    { x: -165, y: 0 },
    { x: 165, y: 0 },
    { x: -55, y: 0 },
    { x: 55, y: 0 },
  ],
  respawn: { x: 0, y: -200 },
  cameraBounds: { ...MOONANCHOR_CAMERA_BOUNDS },
};
