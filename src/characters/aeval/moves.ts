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

/**
 * A forward reach: circles of radius `r` every `r` px along y from xFrom out to xTo, and one
 * more on xTo itself when the step lands short of it, same window and same group so a target
 * is hit once. Pass xTo = tip - r to make the outer edge of the chain sit on the tip.
 */
function forwardChain(
  firstId: number, start: number, end: number,
  xFrom: number, xTo: number, y: number, r: number,
  damage: number, angle: number, bkb: number, kbg: number, group: number,
): HitboxDef[] {
  const out: HitboxDef[] = [];
  let id = firstId;
  let x = xFrom;
  for (; x < xTo; x += r) out.push(box(id++, start, end, x, y, r, damage, angle, bkb, kbg, group));
  out.push(box(id, start, end, xTo, y, r, damage, angle, bkb, kbg, group));
  return out;
}

/**
 * Water reach measured on the crops each anim shows during its active frames, game px from
 * the heel anchor (ax) to the rightmost opaque pixel, sprite facing right:
 *   ftilt   ground_spikeMed_2 80, ground_spikeMed_3 62  -> tip 80
 *   dashatk / fsmash  ground_sweepF_2 102, ground_sweepF_3 92 -> tip 102
 * Each chain's outer circle edge sits on the tip. Aeval is mid range: the reach is the
 * point and the extra startup is its price.
 */
const FTILT_TIP = 80;
const SWEEP_TIP = 102;

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
  damage: 2, angle: 50, bkb: 32, kbg: 62,
  // Same tier as the orb that spawned it (2 + 8c, driven by the inherited scale), so a burst
  // can never out-rank its orb.
  strength: 2,
  // Chips for 2 from a tap orb, 8 from a full one, on the inherited scale like its strength.
  charged: { damage: 8, strength: 10 },
  destroyOnHit: false,
  sprite: 'burst',
  animFps: 14,
};

/**
 * The orb has two lives. The charge position c runs 0 at a tap to 1 at full charge on the
 * exponential curve (c = (scale - 0.6) / 0.9, scale = 0.6 * 2.5 ** (charge / 60)), so half
 * a charge is only c 0.39 and three quarters c 0.66: the last quarter matters most. Every
 * `charged` field is base + (full - base) * c.
 *
 * Charging never touches power: a def with `charged` spawns at power 1, so the lerp above is
 * the only charge scaling of damage, knockback and strength. `scale` (0.6 to 1.5) still sizes
 * the hit circle and sprite on top of the lerped r.
 *
 * Tap: leaves her hands on frame 11 of a 40-frame move. 48 frames at 3.5 px/frame is 168 px
 * of travel from a spawn 18 px ahead, so it bursts about 186 px out. Damage 4, bkb 14, kbg 30,
 * r 8 times scale 0.6 = 4.8 px: a slow chip that holds space.
 *
 * Full charge: chargeCastFrames 16 adds 16 frames to both, so it fires on frame 27 of a
 * 56-frame move. 34 frames at 9.5 px/frame is 323 px of travel, a bullet that bursts about
 * 341 px out. Damage 16, bkb 40, kbg 36 (full-charge KO about 108 percent on Tidegate
 * calibrate), r 12 times scale 1.5 = 18 px.
 *
 * The burst inherits the orb's power (1) and scale, and skips every fighter the orb already
 * hit, so a direct hit deals the orb's damage alone (4 tap, 16 full) and its launch is never
 * overridden. The burst's own damage (2 on a tap up to 8 at full, the same lerp) lands only
 * on fighters the orb missed.
 *
 * Clash strength (projectile tiers, compared alone): jabDrop 1, orb 2 + 8c (2 on a tap, 10 at
 * full), burst the same 2 + 8c as its orb, crescent 4. The orb passes the crescent at c 0.25,
 * which is about 21 of the 60 charge frames; at 20 or fewer it still loses to one.
 */
const waterOrb: ProjectileDef = {
  id: 'orb',
  spawnFrame: 11,
  x: 18, y: -20,
  vx: 3.5, vy: 0,
  gravity: 0,
  lifetime: 48,
  r: 8,
  damage: 4, angle: 40, bkb: 14, kbg: 30,
  strength: 2,
  charged: { vx: 9.5, lifetime: 34, damage: 16, bkb: 40, kbg: 36, r: 12, strength: 10 },
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
  strength: 1,
  destroyOnHit: true,
  sprite: 'orb',
  animFps: 16,
};

/**
 * The crescent flies out, turns around on frame 57 and sweeps back through the
 * thrower for half damage. Out: 20 px spawn offset plus 57 frames at 3.2 px/frame
 * is about 202 px ahead of where she threw it (4/3 of the old 152). Back: the
 * remaining 89 frames cover about 285 px, so it crosses its launch point on age 121
 * and dies about 82 px behind it. 146 frames at 3.2 px/frame is 467 px of travel,
 * 4/3 of the old 82 at 4.25 (348 px). sspecial no longer moves her (the old +2 vx on frame 8 is
 * gone), so these distances are from where she stands.
 */
const tidalCrescent: ProjectileDef = {
  id: 'crescent',
  spawnFrame: 10,
  x: 20, y: -18,
  vx: 3.2, vy: 0,
  gravity: 0,
  lifetime: 146,
  r: 13,
  damage: 9, angle: SAKURAI, bkb: 24, kbg: 44,
  // 2/5 of a full-charge orb (10): it breaks a tap orb (2), loses to one charged past c 0.25.
  strength: 4,
  destroyOnHit: false,
  sprite: 'crescent',
  animFps: 10,
  returnFrame: 57,
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
  // ftilt: circles r 10 from x 12 to 70 at y -18 (edge on the 80 px tip), frames 10 to 14.
  ftilt: {
    id: 'ftilt', totalFrames: 30, iasa: 26, groundOnly: true,
    hitboxes: forwardChain(1, 10, 14, 12, FTILT_TIP - 10, -18, 10, 8, SAKURAI, 19, 51, 1),
  },
  utilt: {
    id: 'utilt', totalFrames: 24, iasa: 20, groundOnly: true,
    hitboxes: [box(1, 6, 11, 2, -44, 12, 7, 90, 37, 90, 1), ...javelinColumn(2, 6, 11, 10, 7, 90, 37, 90, 1)],
  },
  dtilt: {
    id: 'dtilt', totalFrames: 22, iasa: 18, groundOnly: true,
    hitboxes: [box(1, 5, 9, 10, -4, 9, 6, 80, 34, 95, 1)],
  },
  // dashatk: circles r 11 from x 14 to 91 at y -16 (edge on the 102 px tip), frames 8 to 18.
  dashatk: {
    id: 'dashatk', totalFrames: 36, groundOnly: true,
    hitboxes: forwardChain(1, 8, 18, 14, SWEEP_TIP - 11, -16, 11, 9, 60, 32, 50, 1),
    velocity: [{ frame: 4, vx: 3 }],
  },

  // Smashes. Slow, chargeable, the reward for a hard read.
  // fsmash: circles r 13 from x 16 to 89 at y -18 (edge on the 102 px tip), frames 18 to 23.
  fsmash: {
    id: 'fsmash', totalFrames: 48, chargeable: true, groundOnly: true,
    hitboxes: forwardChain(1, 18, 23, 16, SWEEP_TIP - 13, -18, 13, 15, SAKURAI, 19, 46, 1),
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
  // uair: slower than the other aerials on purpose, active 8-12, 30 frames, landing lag 11.
  uair: {
    id: 'uair', totalFrames: 30, landingLag: 11, airOnly: true,
    hitboxes: [box(1, 8, 12, 2, -44, 12, 9, 85, 26, 79, 1), ...javelinColumn(2, 8, 12, 10, 9, 85, 26, 79, 1)],
  },
  dair: {
    id: 'dair', totalFrames: 36, landingLag: 16, airOnly: true,
    hitboxes: [box(1, 12, 16, 4, -2, 12, 12, 270, 30, 85, 1)],
  },

  // Specials. Two projectiles, a rising recovery, a multi-hit trap.
  // Hold special to swell the orb before the throw. 40 frames with no iasa on a tap;
  // a full charge adds 16 (chargeCastFrames) to both the throw and the move, 56 in all.
  nspecial: {
    id: 'nspecial', totalFrames: 40, chargeable: true, chargeButton: 'special', chargeCastFrames: 16,
    hitboxes: [],
    projectiles: [waterOrb, orbBurst],
  },
  sspecial: {
    id: 'sspecial', totalFrames: 42,
    hitboxes: [],
    // Not a movement move: she throws from where she stands.
    projectiles: [tidalCrescent],
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
  // Invulnerable for move frames 0-21, so the get-up is covered until 3 frames before the swing.
  ledgeatk: {
    id: 'ledgeatk', totalFrames: 40, invuln: [0, 21],
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
