import type { StageDef } from '../../core/types';

export const tidegateDef: StageDef = {
  id: 'tidegate',
  name: 'Tidegate',
  platforms: [
    { x: -180, y: 0, w: 360, h: 24, solid: true, ledgeLeft: true, ledgeRight: true },
    { x: -150, y: -72, w: 80, h: 8, solid: false, ledgeLeft: false, ledgeRight: false },
    { x: 70, y: -72, w: 80, h: 8, solid: false, ledgeLeft: false, ledgeRight: false },
    { x: -40, y: -140, w: 80, h: 8, solid: false, ledgeLeft: false, ledgeRight: false },
  ],
  blast: { x: -420, y: -300, w: 840, h: 540 },
  spawns: [
    { x: -120, y: 0 },
    { x: 120, y: 0 },
    { x: -40, y: -72 },
    { x: 40, y: -72 },
  ],
  respawn: { x: 0, y: -160 },
  cameraBounds: { x: -330, y: -260, w: 660, h: 410 },
};
