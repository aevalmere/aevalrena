import type { StageDef } from '../../core/types';
import { TIDEGATE_PLATFORMS } from './geometry';

/**
 * Collision comes from geometry.ts, which tools/stagecut/cut_tidegate.py
 * measures on the painting: the main island's walk line is the middle depth
 * line of its disc top (y = 0), the two side discs are pass-through platforms
 * on the middle depth line of their own tops. There is no top centre platform.
 */
export const tidegateDef: StageDef = {
  id: 'tidegate',
  name: 'Tidegate',
  platforms: TIDEGATE_PLATFORMS.map((p) => ({ ...p })),
  blast: { x: -483, y: -480, w: 966, h: 720 },
  spawns: [
    { x: -120, y: 0 },
    { x: 120, y: 0 },
    { x: -40, y: 0 },
    { x: 40, y: 0 },
  ],
  respawn: { x: 0, y: -160 },
  cameraBounds: { x: -380, y: -400, w: 760, h: 550 },
};
