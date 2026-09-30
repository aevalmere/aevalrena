import { BURST_ONLY } from '../../core/types';
import type { CharacterDef, EchoDef, GrabKit, HitboxDef, MoveDef, MoveId, ProjectileDef } from '../../core/types';

/**
 * Trekmore frame data (docs/TREKMORE_PLAN.md section D).
 *
 * Same conventions as Aeval's file: frame numbers are 0-based move frames counted after any
 * smash charge hold, hitbox offsets are fighter-local facing right, y negative above the feet.
 * Trekmore stands 55 px (Aeval 48), so his body centre sits near y -26 and his head near -52.
 *
 * Every first active frame lands on the start of the drawn slash frame in
 * art/trekmore/sheetmap.json (the frame marked "hit at" in plan A.4), so the art and the sim agree.
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
 * A forward sword reach: circles of radius `r` every `r` px from xFrom out to xTo, and one more
 * on xTo when the step lands short of it, same window and group so a target is hit once. Pass
 * xTo = tip - r so the outer edge sits on the drawn blade tip.
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

/** The raised sword's column (utilt, usmash): x of the blade over the heel. */
const SWORD_X = 4;

/**
 * An upward sword column: `r` circles every `r` px from the top of the head circle (fromY) up,
 * the last one placed so its top edge sits exactly on `top`. Same window and group as the head
 * circle, so a target is hit once.
 */
function swordColumn(
  firstId: number, start: number, end: number, fromY: number, r: number, top: number,
  damage: number, angle: number, bkb: number, kbg: number, group: number,
): HitboxDef[] {
  const out: HitboxDef[] = [];
  let id = firstId;
  let y = fromY;
  for (; y - r > top; y -= r) out.push(box(id++, start, end, SWORD_X, y, r, damage, angle, bkb, kbg, group));
  out.push(box(id, start, end, SWORD_X, top + r, r, damage, angle, bkb, kbg, group));
  return out;
}

/** The shadow echo every normal and aerial carries: half damage, group 1 unless noted. */
function echo(delayFrames: number, offsetX: number, groups: number[] = [1]): EchoDef {
  return { delayFrames, damageScale: 0.5, offsetX, groups };
}

/**
 * Shadow Ascent: the sword is thrown up on frames 0 to 9, then one launch on frame 10 (vy -6.85
 * set, a 1.2 px/frame drift forward set) and a shrinking rise to frame 30. Aeval's geyser is
 * -6.5 at 8 and +0.3 to 20. The plan's -7.2 rose 102.5 px against Aeval's 82.3 (1.245x); -6.85
 * rises 91.2 px, the plan's 1.1x height target (selftest "Trekmore uspecial" prints it).
 */
function ascentVelocity(): NonNullable<MoveDef['velocity']> {
  const out: NonNullable<MoveDef['velocity']> = [{ frame: 10, vx: 1.2, setX: true, vy: -6.85, setY: true }];
  for (let frame = 11; frame <= 30; frame++) out.push({ frame, vy: 0.25 });
  return out;
}

/**
 * The sword's burst: where the sword dies (a hit or the end of its flight) a spike of shadow
 * erupts. It skips a fighter the sword already hit, so it only catches a dodge or a second body.
 */
const shadowBurst: ProjectileDef = {
  id: 'shadowBurst',
  spawnFrame: BURST_ONLY,
  x: 0, y: 0,
  vx: 0, vy: 0,
  gravity: 0,
  lifetime: 12,
  r: 22,
  damage: 5, angle: 60, bkb: 30, kbg: 50,
  strength: 3,
  charged: { damage: 9 },
  destroyOnHit: false,
  sprite: 'shadowBurst',
  animFps: 18,
};

/**
 * Shadow Sword (plan D.5). Aimed on the release frame (forward, up-forward, up, down-forward,
 * down), fixed size at every charge. Charged kbg 43 (plan 62, which killed at 73): 119. Tap: leaves on frame 14 of 30, 28 frames at 5 px/frame is
 * 140 px of travel. Full charge (chargeCastFrames 8): leaves on 22 of 38, 62 frames at 6 px/frame
 * is 372 px. One at a time: while it flies, a second Special press is the recall.
 */
const shadowSword: ProjectileDef = {
  id: 'shadowSword',
  spawnFrame: 14,
  x: 20, y: -26,
  vx: 5.0, vy: 0,
  gravity: 0,
  lifetime: 28,
  r: 10,
  damage: 7, angle: 40, bkb: 30, kbg: 55,
  strength: 3,
  charged: { vx: 6.0, lifetime: 62, damage: 12, bkb: 40, kbg: 43, strength: 6 },
  destroyOnHit: true,
  sprite: 'shadowSword',
  animFps: 15,
  burstId: shadowBurst.id,
  aim: true,
  fixedScale: true,
  onePerOwner: true,
};

const moves: Record<MoveId, MoveDef> = {
  // Ground normals. Each starts 2 to 4 frames after Aeval's and hits 1.4x to 1.6x as hard; the
  // shadow repeats the swing from where it started.
  //
  // jab: circles r 10 from x 16 to 40 at y -24, frames 7 to 9. The echo stands 12 px ahead (the
  // plan's -6 put it behind): 4.5 damage at bkb 24 slides a standing Aeval about 20 px before the
  // echo's frame 15, and from 6 px behind the replayed chain reached her only inside 35 px. From
  // +12 the echo lands at every spacing up to 56 px between centres (the jab reaches 63); the last
  // 7 px of the tip are jab only. Measured by the selftest "Trekmore jab echo connects".
  jab: {
    id: 'jab', totalFrames: 26, iasa: 22, groundOnly: true,
    hitboxes: forwardChain(1, 7, 9, 16, 40, -24, 10, 4.5, SAKURAI, 24, 42, 1),
    echo: echo(8, 12),
  },
  // ftilt: circles r 11 from x 14 to 62 at y -26 (edge on the 72 px crescent tip), frames 13 to 17.
  // kbg 48 (plan 58): at 58 it killed a fresh Aeval at 110, below the 130 to 170 tilt band.
  ftilt: {
    id: 'ftilt', totalFrames: 38, iasa: 34, groundOnly: true,
    hitboxes: forwardChain(1, 13, 17, 14, 62, -26, 11, 12, SAKURAI, 22, 48, 1),
    echo: echo(10, -8),
  },
  // utilt: head circle plus the raised sword up to y -118, frames 13 to 18. kbg 98 (plan 92) pulls
  // the KO from 177 into the tilt band.
  utilt: {
    id: 'utilt', totalFrames: 38, iasa: 34, groundOnly: true,
    hitboxes: [box(1, 13, 18, 2, -52, 13, 10.5, 90, 38, 98, 1), ...swordColumn(2, 13, 18, -65, 11, -118, 10.5, 90, 38, 98, 1)],
    echo: echo(10, -6),
  },
  // dtilt: a low sweep that reaches a ledge hanger and beats rolls. Balance loop 0: the plan's 75
  // degree launch (bkb 36) lifted a fresh Aeval about 40 px before the echo's frame, so the echo
  // never landed. At 10 degrees and bkb 20 the hit slides her along the floor below 80 kb, and the
  // echo, 4 frames behind and 20 px ahead of the start, sweeps her again (every spacing at 0
  // percent). Past 80 kb it launches low and flat; kbg 100 keeps the KO near 160.
  dtilt: {
    id: 'dtilt', totalFrames: 30, iasa: 26, groundOnly: true, hitsLedge: true,
    hitboxes: [
      { ...box(1, 8, 12, 18, -5, 12, 9, 10, 20, 100, 1), low: true },
      { ...box(2, 8, 12, 34, -5, 10, 9, 10, 20, 100, 1), low: true },
    ],
    echo: echo(4, 20),
  },
  // dashatk: a lunge, circles r 12 from x 14 to 80 at y -20, frames 11 to 18, pushed on frame 6.
  dashatk: {
    id: 'dashatk', totalFrames: 44, groundOnly: true,
    hitboxes: forwardChain(1, 11, 18, 14, 80, -20, 12, 13, 55, 36, 58, 1),
    velocity: [{ frame: 6, vx: 3.5 }],
    echo: echo(10, -10),
  },

  // Smashes: no echo, chargeable, 4 to 6 frames slower than Aeval's.
  // fsmash: circles r 14 from x 16 to 94 at y -24 (edge on the 108 px crescent), frames 23 to 27.
  // kbg 35 (plan 50, W1-char 30): KO on a fresh Aeval from centre at 96 uncharged and 56 at full
  // charge. With 22 damage the charged hit is fixed at about 40 percent under the uncharged one
  // whatever the bkb and kbg, so the balance loop pins the uncharged 95 and takes 56 charged.
  // Balance loop 2: damage 22 to 19 and kbg 35 to 40 (KO 98, 59 charged). The UI 5 CPU leaned on
  // it (11 percent of his starts against 5 at UI 10), so less damage per landed read.
  fsmash: {
    id: 'fsmash', totalFrames: 58, chargeable: true, groundOnly: true,
    hitboxes: forwardChain(1, 23, 27, 16, 94, -24, 14, 19, 40, 26, 40, 1),
  },
  // usmash: the sword flung up as a column to y -128 and caught, frames 21 to 26. kbg 63 (plan 76,
  // which killed at 83 and 48 charged): 107 uncharged, 65 charged.
  usmash: {
    id: 'usmash', totalFrames: 56, chargeable: true, groundOnly: true,
    hitboxes: [box(1, 21, 26, 2, -52, 15, 20, 88, 32, 63, 1), ...swordColumn(2, 21, 26, -67, 13, -128, 20, 88, 32, 63, 1)],
  },
  // dsmash: the counter's art. A front arc on 17 to 20, then an eruption on 24 to 27 in the same
  // group, so a victim takes one of them: the front spike launches up, the back one behind him.
  // kbg cut to 0.54x of the plan (68, 70, 64 to 37, 38, 35): the plan's numbers killed a fresh
  // Aeval at 47 (22 charged); now 110 (69 charged).
  dsmash: {
    id: 'dsmash', totalFrames: 60, chargeable: true, groundOnly: true, hitsLedge: true,
    hitboxes: [
      box(1, 17, 20, 26, -34, 18, 18, 45, 30, 37, 1),
      box(2, 24, 27, 38, -8, 16, 16, 80, 34, 38, 1),
      box(3, 24, 27, -26, -6, 12, 12, 150, 30, 35, 1),
    ],
  },

  // Aerials: every one pays long landing lag; all but the dair spike are echoed.
  // nair: a ring spin around the body. Clean 6-9 deals 12, late 10-18 deals 7, one group.
  nair: {
    id: 'nair', totalFrames: 40, landingLag: 9, airOnly: true,
    hitboxes: [
      box(1, 6, 9, 0, -26, 26, 12, 60, 22, 52, 1),
      box(2, 10, 18, 0, -26, 24, 7, 55, 14, 42, 1),
    ],
    echo: echo(8, 0),
  },
  // fair: kbg 42 (plan 62, which killed at 71): 119.
  fair: {
    id: 'fair', totalFrames: 40, landingLag: 16, airOnly: true,
    hitboxes: [
      box(1, 12, 16, 26, -26, 15, 16, 45, 24, 42, 1),
      box(2, 12, 16, 38, -22, 13, 16, 45, 24, 42, 1),
    ],
    echo: echo(10, -6),
  },
  // bair: he turns and thrusts back. The echo stands 6 px ahead, which is behind the thrust. kbg 53
  // (plan 64): a thrust into a grounded Aeval 40 px behind him kills at 104 (81 at 64).
  bair: {
    id: 'bair', totalFrames: 36, landingLag: 15, airOnly: true,
    hitboxes: [
      box(1, 10, 13, -28, -24, 14, 17, SAKURAI, 26, 53, 1),
      box(2, 10, 13, -40, -24, 12, 17, SAKURAI, 26, 53, 1),
    ],
    echo: echo(8, 6),
  },
  // uair: bkb 20 kbg 95 and an echo delay of 5 (plan 30, 82, 10). The plan's echo replayed 10
  // frames late where he started, and a victim above 0 percent had already risen out of it. With
  // less base knockback and the shorter delay it lands on a just-launched Aeval up to about 60.
  // Balance loop 1: kbg 95 to 90, his top KO move at every CPU level (20 to 23 percent of KOs).
  uair: {
    id: 'uair', totalFrames: 42, landingLag: 14, airOnly: true,
    hitboxes: [
      box(1, 16, 21, -10, -56, 16, 12, 80, 20, 90, 1),
      box(2, 16, 21, 10, -60, 16, 12, 80, 20, 90, 1),
      box(3, 16, 21, 24, -42, 12, 12, 80, 20, 90, 1),
    ],
    echo: echo(5, 0),
  },
  // dair: a stall-free downward stab, no dive, no bounce. The tip spikes on 14 to 18 (group 1),
  // the late body hit on 19 to 24 (group 2). Only the late hit is echoed: an echoed spike would be
  // a free second meteor. Balance loop 1 and 2: landing lag 24 to 18 to 14; landing was the top
  // state Aeval opened him in at UI 10 and the god CPU throws dair more than any other aerial.
  dair: {
    id: 'dair', totalFrames: 48, landingLag: 14, airOnly: true, hitsLedge: true,
    hitboxes: [
      box(1, 14, 18, 4, 10, 13, 16, 270, 40, 78, 1),
      box(2, 19, 24, 4, -6, 16, 11, 70, 30, 60, 2),
    ],
    echo: echo(10, 0, [2]),
  },

  // Specials.
  // Shadow Sword: hold Special to charge; press again while the sword flies to teleport to it.
  // The recall starts the branch (frames 40 to 53, 14 frames of reappear lag, the first 12
  // invulnerable).
  nspecial: {
    id: 'nspecial', totalFrames: 30, chargeable: true, chargeButton: 'special', chargeCastFrames: 8,
    hitboxes: [],
    projectiles: [shadowSword, shadowBurst],
    recall: { projectileId: shadowSword.id, footOffsetY: 26, invulnFrames: 12, oncePerAir: true },
    branch: { start: 40, end: 54 },
  },
  // Shadow Step: vanish on 6, travel 96 px in 6 frames from frame 8, reappear (turned around if
  // he passed the opponent) and backstrike on 19 to 24. On the ground it stops at the edge; in the
  // air it is once per airborne period and leaves him actionable. kbg 48 (plan 60, KO 81): 108.
  // Balance loop 1: invulnerable from frame 3 (plan 6); its startup was a top opening at UI 10.
  sspecial: {
    id: 'sspecial', totalFrames: 46,
    hitboxes: forwardChain(1, 19, 24, 14, 52, -26, 16, 13, 40, 40, 48, 1),
    shadowStep: {
      startFrame: 8, travelFrames: 6, distance: 96, invuln: [3, 16], turnIfPassed: true, stopAtEdge: true, oncePerAir: true,
    },
  },
  // Shadow Ascent: the rising hitbox (12 to 30) drags a victim up into the top swing (40 to 46).
  uspecial: {
    id: 'uspecial', totalFrames: 56, helplessAfter: true, invuln: [10, 14],
    hitboxes: [
      box(1, 12, 30, 0, -44, 16, 3, 90, 60, 30, 1),
      box(2, 40, 46, 20, -30, 22, 14, 50, 42, 80, 2),
      box(3, 40, 46, 34, -14, 16, 14, 50, 42, 80, 2),
    ],
    velocity: ascentVelocity(),
  },
  // Moon Parry: frames 5 to 22 absorb any melee hit or projectile (not a grab) and jump to the
  // branch, 60 to 103: invulnerable 60 to 72, an arc on 70 to 73 and an eruption on 78 to 81 that
  // repay 1.3x the absorbed damage (10 to 20), one group so one of them lands. A whiff ends at 50.
  // Balance loop 0: cap 20 (plan 30), bkb 20 and kbg 61 (plan 60, 70). The plan's counter killed
  // a fresh Aeval at 0 percent at its cap and at 46 at its floor; now the floor (a countered jab)
  // kills at 130 and the cap (a countered Aeval fsmash, 15 x 1.3 = 19.5) at about 57.
  dspecial: {
    id: 'dspecial', totalFrames: 50, invuln: [60, 72],
    hitboxes: [
      { ...box(1, 70, 73, 24, -34, 20, 0, 45, 20, 61, 1), fromCounter: true, noCrit: true },
      { ...box(2, 78, 81, 38, -8, 18, 0, 45, 20, 61, 1), fromCounter: true, noCrit: true },
    ],
    counter: { windowStart: 5, windowEnd: 22, scale: 1.3, minDamage: 10, maxDamage: 20, attackerFreeze: 14 },
    branch: { start: 60, end: 104 },
  },

  // Utility.
  taunt: { id: 'taunt', totalFrames: 90, hitboxes: [] },
  taunt2: { id: 'taunt2', totalFrames: 90, hitboxes: [] },
  taunt3: { id: 'taunt3', totalFrames: 90, hitboxes: [] },
  ledgeatk: {
    id: 'ledgeatk', totalFrames: 44, invuln: [0, 24],
    hitboxes: [box(1, 22, 26, 24, -16, 14, 10, SAKURAI, 22, 48, 1)],
  },
  getupatk: {
    id: 'getupatk', totalFrames: 38, invuln: [0, 15],
    hitboxes: [
      box(1, 16, 21, 22, -12, 13, 9, SAKURAI, 24, 52, 1),
      box(2, 16, 21, -22, -12, 13, 9, SAKURAI, 24, 52, 1),
    ],
  },
};

/**
 * Shadow hands (plan D.6): the grabs start 2 frames after the default and reach 25 percent
 * further; throws deal 1.4x the default and never crit. bthrow is his kill throw.
 */
const grabKit: GrabKit = {
  stand: { totalFrames: 34, start: 9, end: 10, x: 20, y: -24, r: 11 },
  dash: { totalFrames: 42, start: 11, end: 12, x: 28, y: -24, r: 12 },
  holdX: 14,
  holdY: 0,
  holdBase: 60,
  holdPerPercent: 0.5,
  mashFrames: 4,
  pummel: { damage: 2.2, totalFrames: 18, hitFrame: 5 },
  throws: {
    fthrow: { totalFrames: 24, releaseFrame: 10, damage: 11, angle: 40, bkb: 64, kbg: 62, holdX: 18, holdY: -4 },
    bthrow: { totalFrames: 30, releaseFrame: 14, damage: 12.5, angle: 45, bkb: 62, kbg: 74, holdX: 18, holdY: -4 },
    uthrow: { totalFrames: 28, releaseFrame: 12, damage: 10, angle: 90, bkb: 72, kbg: 58, holdX: 0, holdY: -30 },
    dthrow: { totalFrames: 26, releaseFrame: 12, damage: 8, angle: 72, bkb: 48, kbg: 38, holdX: 10, holdY: 0 },
  },
};

export const trekmoreDef: CharacterDef = {
  id: 'trekmore',
  name: 'Trekmore',
  weight: 110,
  walkSpeed: 1.3,
  runSpeed: 2.5,
  dashSpeed: 2.8,
  dashFrames: 14,
  groundAccel: 0.34,
  groundFriction: 0.24,
  airSpeed: 1.7,
  airAccel: 0.11,
  airFriction: 0.035,
  gravity: 0.17,
  maxFall: 3.7,
  fastFall: 5.75,
  jumpVel: 5.2,
  shortHopVel: 3.3,
  doubleJumpVel: 4.8,
  jumps: 2,
  jumpSquat: 4,
  hurtbox: { w: 32, h: 46 },
  crouchHurtbox: { w: 32, h: 30 },
  ledgeGrabBox: { w: 22, h: 26, yOff: -35 },
  moves,
  grabKit,
  crit: { chance: 0.12, scale: 1.3 },
};
