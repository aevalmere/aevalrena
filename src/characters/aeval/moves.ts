import type { CharacterDef, HitboxDef, MoveDef, MoveId, ProjectileDef } from '../../core/types';

/**
 * Aeval frame data (SPEC section 5).
 *
 * Frame numbers are 0-based move frames. Frame 0 is the first frame of the move,
 * counted after any smash charge hold. Hitbox offsets are fighter-local with the
 * fighter facing right: x grows forward, y is negative above the feet, so the body
 * center sits at y -20 and the head around y -36.
 */

/** Sakurai angle marker. The sim picks a weak or strong angle from the knockback. */
const SAKURAI = 361;

function box(
  id: number, start: number, end: number,
  x: number, y: number, r: number,
  damage: number, angle: number, bkb: number, kbg: number, group: number,
): HitboxDef {
  return { id, start, end, x, y, r, damage, angle, bkb, kbg, group };
}

/** Geyser: one launch on frame 8, then a shrinking rise for the active window. */
function geyserVelocity(): NonNullable<MoveDef['velocity']> {
  const out: NonNullable<MoveDef['velocity']> = [{ frame: 8, vy: -6.5, setY: true }];
  for (let frame = 9; frame <= 20; frame++) out.push({ frame, vy: 0.3 });
  return out;
}

const waterOrb: ProjectileDef = {
  id: 'orb',
  spawnFrame: 18,
  x: 18, y: -20,
  vx: 3.5, vy: 0,
  gravity: 0,
  lifetime: 90,
  r: 8,
  damage: 6, angle: 40, bkb: 24, kbg: 48,
  destroyOnHit: true,
  sprite: 'orb',
  animFps: 12,
};

const tidalCrescent: ProjectileDef = {
  id: 'crescent',
  spawnFrame: 12,
  x: 20, y: -18,
  vx: 5, vy: 0,
  gravity: 0,
  lifetime: 45,
  r: 13,
  damage: 9, angle: SAKURAI, bkb: 27, kbg: 48,
  destroyOnHit: false,
  sprite: 'crescent',
  animFps: 10,
};

/** Whirlpool: four pulling hits in 8-frame windows, then a launching fifth. */
const whirlpoolHits: HitboxDef[] = [
  box(1, 10, 17, 4, -20, 18, 2, 90, 6, 10, 1),
  box(2, 18, 25, 4, -20, 18, 2, 90, 6, 10, 2),
  box(3, 26, 33, 4, -20, 18, 2, 90, 6, 10, 3),
  box(4, 34, 41, 4, -20, 18, 2, 90, 6, 10, 4),
  box(5, 42, 46, 4, -20, 20, 2, 60, 68, 153, 5),
];

const moves: Record<MoveId, MoveDef> = {
  // Ground normals. Jab is fast and safe, tilts commit a little more.
  jab: {
    id: 'jab', totalFrames: 18, iasa: 14, groundOnly: true,
    hitboxes: [box(1, 4, 7, 20, -18, 9, 3, SAKURAI, 20, 40, 1)],
  },
  ftilt: {
    id: 'ftilt', totalFrames: 26, iasa: 22, groundOnly: true,
    hitboxes: [box(1, 8, 12, 24, -18, 11, 8, SAKURAI, 19, 51, 1)],
  },
  utilt: {
    id: 'utilt', totalFrames: 24, iasa: 20, groundOnly: true,
    hitboxes: [box(1, 6, 11, 2, -44, 12, 7, 90, 37, 90, 1)],
  },
  dtilt: {
    id: 'dtilt', totalFrames: 22, iasa: 18, groundOnly: true,
    hitboxes: [box(1, 5, 9, 10, -4, 9, 6, 80, 34, 95, 1)],
  },
  dashatk: {
    id: 'dashatk', totalFrames: 32, groundOnly: true,
    hitboxes: [box(1, 6, 16, 20, -16, 12, 9, 60, 32, 50, 1)],
    velocity: [{ frame: 4, vx: 3 }],
  },

  // Smashes. Slow, chargeable, the reward for a hard read.
  fsmash: {
    id: 'fsmash', totalFrames: 44, chargeable: true, groundOnly: true,
    hitboxes: [box(1, 16, 21, 26, -18, 16, 15, SAKURAI, 19, 46, 1)],
  },
  usmash: {
    id: 'usmash', totalFrames: 40, chargeable: true, groundOnly: true,
    hitboxes: [box(1, 12, 18, 2, -44, 15, 14, 88, 30, 74, 1)],
  },
  dsmash: {
    id: 'dsmash', totalFrames: 42, chargeable: true, groundOnly: true,
    hitboxes: [
      box(1, 12, 15, 18, -6, 14, 12, 30, 21, 52, 1),
      box(2, 12, 15, -18, -6, 14, 12, 30, 21, 52, 1),
    ],
  },

  // Aerials. Every one pays landing lag.
  nair: {
    id: 'nair', totalFrames: 34, landingLag: 8, airOnly: true,
    hitboxes: [box(1, 5, 22, 6, -20, 16, 7, 60, 21, 63, 1)],
  },
  fair: {
    id: 'fair', totalFrames: 30, landingLag: 12, airOnly: true,
    hitboxes: [box(1, 9, 13, 22, -20, 13, 10, 45, 18, 54, 1)],
  },
  bair: {
    id: 'bair', totalFrames: 28, landingLag: 12, airOnly: true,
    hitboxes: [box(1, 7, 10, -22, -20, 12, 11, SAKURAI, 21, 56, 1)],
  },
  uair: {
    id: 'uair', totalFrames: 26, landingLag: 9, airOnly: true,
    hitboxes: [box(1, 6, 10, 2, -44, 12, 9, 85, 26, 79, 1)],
  },
  dair: {
    id: 'dair', totalFrames: 36, landingLag: 16, airOnly: true,
    hitboxes: [box(1, 12, 16, 4, -2, 12, 12, 270, 30, 85, 1)],
  },

  // Specials. Two projectiles, a rising recovery, a multi-hit trap.
  nspecial: {
    id: 'nspecial', totalFrames: 40,
    hitboxes: [],
    projectiles: [waterOrb],
  },
  sspecial: {
    id: 'sspecial', totalFrames: 42,
    hitboxes: [],
    projectiles: [tidalCrescent],
    velocity: [{ frame: 8, vx: 2 }],
  },
  uspecial: {
    id: 'uspecial', totalFrames: 48, helplessAfter: true,
    hitboxes: [box(1, 8, 20, 2, -44, 14, 8, 80, 55, 66, 1)],
    velocity: geyserVelocity(),
  },
  dspecial: {
    id: 'dspecial', totalFrames: 50,
    hitboxes: whirlpoolHits,
  },

  // Utility.
  taunt: { id: 'taunt', totalFrames: 90, hitboxes: [] },
  ledgeatk: {
    id: 'ledgeatk', totalFrames: 40, invuln: [0, 17],
    hitboxes: [box(1, 18, 24, 20, -14, 12, 8, SAKURAI, 20, 47, 1)],
  },
  getupatk: {
    id: 'getupatk', totalFrames: 34, invuln: [0, 13],
    hitboxes: [
      box(1, 14, 20, 18, -10, 12, 7, SAKURAI, 22, 51, 1),
      box(2, 14, 20, -18, -10, 12, 7, SAKURAI, 22, 51, 1),
    ],
  },
};

export const aevalDef: CharacterDef = {
  id: 'aeval',
  name: 'Aeval',
  weight: 88,
  walkSpeed: 1.3,
  runSpeed: 2.6,
  dashSpeed: 2.8,
  dashFrames: 12,
  groundAccel: 0.35,
  groundFriction: 0.22,
  airSpeed: 1.7,
  airAccel: 0.12,
  airFriction: 0.03,
  gravity: 0.15,
  maxFall: 3.2,
  fastFall: 5.0,
  jumpVel: 5.4,
  shortHopVel: 3.5,
  doubleJumpVel: 5.0,
  jumps: 2,
  jumpSquat: 3,
  hurtbox: { w: 26, h: 40 },
  crouchHurtbox: { w: 26, h: 26 },
  ledgeGrabBox: { w: 20, h: 24, yOff: -30 },
  moves,
};
