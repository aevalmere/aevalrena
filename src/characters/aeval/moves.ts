import { BURST_ONLY } from '../../core/types';
import type { CharacterDef, FinalSmashDef, HitboxDef, MoveDef, MoveId, ProjectileDef } from '../../core/types';

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

/**
 * Up-javelin column (utilt, usmash, uair all show uptilt_spike_2, the mid javelin).
 * Measured on that crop against the heel anchor, game px: the javelin runs up x 7 to
 * a tip at y -106. Circles every `r` px from just above the head circle (y -44) to
 * the tip, active for the same window and in the same group as that circle, so a
 * target is hit once.
 */
function javelinColumn(
  firstId: number, start: number, end: number, r: number,
  damage: number, angle: number, bkb: number, kbg: number, group: number,
): HitboxDef[] {
  const out: HitboxDef[] = [];
  let id = firstId;
  for (let y = -44 - r; y >= JAVELIN_TIP - r / 2; y -= r) {
    out.push(box(id++, start, end, JAVELIN_X, y, r, damage, angle, bkb, kbg, group));
  }
  return out;
}
const JAVELIN_X = 7;
const JAVELIN_TIP = -106;

/** Geyser: one launch on frame 8, then a shrinking rise for the active window. */
function geyserVelocity(): NonNullable<MoveDef['velocity']> {
  const out: NonNullable<MoveDef['velocity']> = [{ frame: 8, vy: -6.5, setY: true }];
  for (let frame = 9; frame <= 20; frame++) out.push({ frame, vy: 0.3 });
  return out;
}

/** The orb's payload: it bursts on contact and again if it runs out of range. */
const orbBurst: ProjectileDef = {
  id: 'orbBurst',
  spawnFrame: BURST_ONLY,
  x: 0, y: 0,
  vx: 0, vy: 0,
  gravity: 0,
  lifetime: 10,
  r: 17,
  damage: 8, angle: 50, bkb: 32, kbg: 62,
  destroyOnHit: false,
  sprite: 'burst',
  animFps: 14,
};

/**
 * The orb is a mid-range poke, not a full-stage wall: 48 frames at 3.5 px/frame
 * is 168 px of travel from a spawn 18 px in front of the feet, so it reaches
 * about 186 px out and bursts there. Roughly a third of the stage.
 *
 * It leaves her hands on frame 15 so the shot comes out a little sooner, and
 * nspecial runs 52 frames, which leaves a longer recovery behind the shot.
 */
const waterOrb: ProjectileDef = {
  id: 'orb',
  spawnFrame: 15,
  x: 18, y: -20,
  vx: 3.5, vy: 0,
  gravity: 0,
  lifetime: 48,
  r: 8,
  damage: 6, angle: 40, bkb: 24, kbg: 48,
  destroyOnHit: true,
  sprite: 'orb',
  animFps: 12,
  burstId: orbBurst.id,
};

/** Jab throws a bead of water rather than a fist. Short-lived, so short-ranged. */
const jabDrop: ProjectileDef = {
  id: 'jabDrop',
  spawnFrame: 5,
  x: 18, y: -19,
  vx: 5.5, vy: 0,
  gravity: 0,
  lifetime: 7,
  r: 9,
  damage: 2, angle: SAKURAI, bkb: 14, kbg: 22,
  destroyOnHit: true,
  sprite: 'orb',
  animFps: 16,
};

/**
 * The crescent flies out, turns around on frame 31 and sweeps back through the
 * thrower for half damage. Out: 20 px spawn offset plus 31 frames at 4.25 px/frame
 * is about 152 px ahead. Back: the remaining 51 frames cover about 217 px, so it
 * crosses the thrower on frame 67 and dies about 65 px behind them. 82 frames at
 * 4.25 px/frame is 348 px of travel, 25% more than the old 56 at 5 (280 px).
 */
const tidalCrescent: ProjectileDef = {
  id: 'crescent',
  spawnFrame: 10,
  x: 20, y: -18,
  vx: 4.25, vy: 0,
  gravity: 0,
  lifetime: 82,
  r: 13,
  damage: 9, angle: SAKURAI, bkb: 27, kbg: 48,
  destroyOnHit: false,
  sprite: 'crescent',
  animFps: 10,
  returnFrame: 31,
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
    hitboxes: [box(1, 4, 6, 15, -18, 9, 3, SAKURAI, 20, 40, 1)],
    projectiles: [jabDrop],
  },
  ftilt: {
    id: 'ftilt', totalFrames: 26, iasa: 22, groundOnly: true,
    hitboxes: [box(1, 8, 12, 24, -18, 11, 8, SAKURAI, 19, 51, 1)],
  },
  utilt: {
    id: 'utilt', totalFrames: 24, iasa: 20, groundOnly: true,
    hitboxes: [box(1, 6, 11, 2, -44, 12, 7, 90, 37, 90, 1), ...javelinColumn(2, 6, 11, 10, 7, 90, 37, 90, 1)],
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
    hitboxes: [box(1, 12, 18, 2, -44, 15, 14, 88, 30, 74, 1), ...javelinColumn(2, 12, 18, 12, 14, 88, 30, 74, 1)],
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
    hitboxes: [box(1, 6, 10, 2, -44, 12, 9, 85, 26, 79, 1), ...javelinColumn(2, 6, 10, 10, 9, 85, 26, 79, 1)],
  },
  dair: {
    id: 'dair', totalFrames: 36, landingLag: 16, airOnly: true,
    hitboxes: [box(1, 12, 16, 4, -2, 12, 12, 270, 30, 85, 1)],
  },

  // Specials. Two projectiles, a rising recovery, a multi-hit trap.
  // Hold special to swell the orb before the throw. 48 frames with no iasa, so a
  // whiffed orb is a little more punishable than the throw it replaced.
  nspecial: {
    id: 'nspecial', totalFrames: 52, chargeable: true, chargeButton: 'special',
    hitboxes: [],
    projectiles: [waterOrb, orbBurst],
  },
  sspecial: {
    id: 'sspecial', totalFrames: 42,
    hitboxes: [],
    projectiles: [tidalCrescent],
    velocity: [{ frame: 8, vx: 2 }],
  },
  uspecial: {
    id: 'uspecial', totalFrames: 48, helplessAfter: true,
    // The water column rides the body up for the whole rise (frames 8 to 20 of
    // geyserVelocity): one circle on the head and one spout above it, same group.
    hitboxes: [
      box(1, 8, 20, 2, -44, 21, 8, 88, 72, 86, 1),
      box(2, 8, 20, 2, -76, 21, 8, 88, 72, 86, 1),
    ],
    velocity: geyserVelocity(),
  },
  dspecial: {
    id: 'dspecial', totalFrames: 50,
    hitboxes: whirlpoolHits,
  },

  // Utility.
  taunt: { id: 'taunt', totalFrames: 90, hitboxes: [] },
  taunt2: { id: 'taunt2', totalFrames: 90, hitboxes: [] },
  taunt3: { id: 'taunt3', totalFrames: 90, hitboxes: [] },
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

/**
 * Final Smash: Tidal Judgement. A command grab on the nearest opponent Aeval faces, a
 * tsunami that carries them forward and up, a tornado that spirals them higher, then a
 * launch. 15 + 20 + 10 = 45 base damage.
 *
 * Animation is pending the owner's animation overhaul: nothing here is drawn yet. The
 * phases name the tsunami and tornado segments so the future renderer can hang its
 * frames and effects on them (the sim announces each one with a 'finalSmash' event).
 */
function tornadoHits(): FinalSmashDef['hits'] {
  const out: FinalSmashDef['hits'] = [];
  for (let i = 0; i < 10; i++) out.push({ frame: 84 + i * 7, damage: 2 });
  return out;
}

export const aevalFinalSmash: FinalSmashDef = {
  target: 'nearestFacing',
  startup: 20,
  totalFrames: 170,
  path: [
    { frame: 20, x: 24, y: 0 },     // the catch
    { frame: 80, x: 70, y: -20 },   // tsunami: forward and up
    { frame: 110, x: 60, y: -50 },  // tornado: spiral up in place
    { frame: 150, x: 70, y: -80 },
  ],
  hits: [
    { frame: 26, damage: 3 },
    { frame: 38, damage: 3 },
    { frame: 50, damage: 3 },
    { frame: 62, damage: 3 },
    { frame: 74, damage: 3 },
    ...tornadoHits(),
  ],
  // Tuned on tidegate from stage center: KOs a victim who started the Final Smash at 39
  // percent or more (84 at the launch), so 0 survives and 60 dies.
  launch: { frame: 152, damage: 10, angle: 80, bkb: 50, kbg: 90 },
  phases: [
    { name: 'tsunami', start: 20, end: 80 },
    { name: 'tornado', start: 80, end: 150 },
  ],
};

export const aevalDef: CharacterDef = {
  id: 'aeval',
  name: 'Aeval',
  weight: 88,
  walkSpeed: 1.6,
  runSpeed: 3.1,
  dashSpeed: 3.4,
  dashFrames: 12,
  groundAccel: 0.42,
  groundFriction: 0.22,
  airSpeed: 2.0,
  airAccel: 0.14,
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
  finalSmash: aevalFinalSmash,
};
