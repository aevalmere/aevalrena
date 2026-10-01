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

/**
 * Centre of the overhead crescent (the uspec_g_12..17 swing) that utilt, usmash and uair share.
 * Round 2 QA (owner): the up attacks are back on this art, so these are the polish-wave hitboxes.
 */
const ARC_CX = 6;
const ARC_CY = -34;
/** The drawn crescent runs from up-behind (120 degrees) over the top to in front and slightly down (-20). */
const ARC_FROM = 120;
const ARC_TO = -20;
/**
 * Per-move spans (polish balance pass). utilt keeps the whole drawn crescent. usmash stops at 75
 * degrees: to -20 at radius 50 it reached 67 px forward and the CPU used it as a forward kill move
 * (41 to 46 percent of his KOs); to 75 it is an anti-air again (front edge x 33, about 20 percent).
 * uair runs 140 to 20, overhead.
 */
const UT_FROM = ARC_FROM, UT_TO = ARC_TO, UT_KBG = 80;
const US_FROM = ARC_FROM, US_TO = 75;
const UA_FROM = 140, UA_TO = 20;

/**
 * The overhead crescent as circles of radius `r` on a circle of radius `radius` around
 * (ARC_CX, ARC_CY), one every `r` px of arc from `from` to `to` degrees (0 = forward,
 * 90 = straight up), both ends included. Same window and group, so a target is hit once.
 * Centres are rounded to whole px at module load, so the sim never sees a trig result
 * (an ulp of cos that differs between engines cannot move a hitbox).
 */
function overheadArc(
  firstId: number, start: number, end: number, radius: number, r: number, from: number, to: number,
  damage: number, angle: number, bkb: number, kbg: number, group: number,
): HitboxDef[] {
  const span = ((from - to) * Math.PI) / 180;
  const n = Math.max(1, Math.ceil((span * radius) / r));
  const out: HitboxDef[] = [];
  for (let i = 0; i <= n; i++) {
    const deg = from - ((from - to) * i) / n;
    const a = (deg * Math.PI) / 180;
    const x = Math.round(ARC_CX + Math.cos(a) * radius);
    const y = Math.round(ARC_CY - Math.sin(a) * radius);
    out.push(box(firstId + i, start, end, x, y, r, damage, angle, bkb, kbg, group));
  }
  return out;
}

/**
 * The shadow echo every normal and aerial carries: half damage, group 1 unless noted. Round 2:
 * offsetX is px along his travel at move frame 0 (his facing when nearly still), and every offset
 * is positive so the shadow strikes from in front of him. Each was picked in 10 to 24 from an echo
 * connect sweep (spacing, height, percent, standing and drifting): larger offsets follow a victim
 * the owner's hit pushed away, so every move's rate rises with the offset up to about 20.
 */
function echo(delayFrames: number, offsetX: number, groups: number[] = [1]): EchoDef {
  return { delayFrames, damageScale: 0.5, offsetX, groups };
}

/**
 * Shadow Ascent: the sword is thrown up on frames 0 to 9, then one launch on frame 10 (vy -6.85
 * set, a 1.2 px/frame drift forward set) and a shrinking rise to frame 30. Aeval's geyser is
 * -6.5 at 8 and +0.3 to 20. The plan's -7.2 rose 102.5 px against Aeval's 82.3 (1.245x); -6.85
 * rises 91.2 px, the plan's 1.1x height target (selftest "Trekmore uspecial" prints it).
 */
/**
 * ascentSword flight (polish wave), measured on the ground from the move's start point. The body
 * (ascentVelocity above, unchanged) is still until frame 10 and stands at (12.4, -69.6) after
 * frame 22's step; his raised hand there is (+8, -60) from the feet, so (20.4, -129.6). The sword
 * spawns on frame 8 at the throwing hand (4, -50), is stepped 14 times (lifetime 14, it dies on
 * frame 21's step) and moves 14 * vy + 91 * gravity vertically: -7.3 and 0.25 give -79.45, dying
 * at (20.8, -129.45), within 0.4 px of the hand. Gravity 0.25 is the body's own rise deceleration,
 * so after the body launches the sword stays 4 px above the hand the whole way up (it leads), and
 * its last step (-4.05) matches the body's (-4.1 to -3.85), so he rematerializes out of it without
 * a jump. In the air the body falls about 9 px before frame 10, so the meeting point is 9 px low.
 */
const ASC_X = 4;
const ASC_Y = -50;
const ASC_VY = -7.3;
const ASC_G = 0.25;

function ascentVelocity(): NonNullable<MoveDef['velocity']> {
  const out: NonNullable<MoveDef['velocity']> = [{ frame: 10, vx: 1.2, setX: true, vy: -6.85, setY: true }];
  for (let frame = 11; frame <= 30; frame++) out.push({ frame, vy: 0.25 });
  return out;
}

/**
 * Sword Ascent's thrown sword (polish wave). Spawns on move frame 8 at the throwing hand and flies
 * straight up with the body's 1.2 px/frame forward drift, decelerating, so it leads the body the
 * whole way and dies (lifetime 14) where his raised hand is on frame 22: he rematerializes out of
 * it (numbers at ASC_X above). It carries the old rising drag hit.
 */
const ascentSword: ProjectileDef = {
  id: 'ascentSword',
  spawnFrame: 8,
  x: ASC_X, y: ASC_Y,
  vx: 1.2, vy: ASC_VY,
  gravity: ASC_G,
  lifetime: 14,
  r: 16,
  damage: 3, angle: 90, bkb: 60, kbg: 30,
  strength: 2,
  destroyOnHit: false,
  sprite: 'swordUp',
  animFps: 12,
  fixedScale: true,
};

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
  damage: 4, angle: 60, bkb: 30, kbg: 50,
  strength: 3,
  destroyOnHit: false,
  sprite: 'shadowBurst',
  animFps: 18,
};

/**
 * Shadow Sword (plan D.5, polish wave). A fast cast that no longer charges: aimed on the start
 * frame (forward, up-forward, up, down-forward, down), it leaves on frame 9 of 34 and flies 45
 * frames at 8 px/frame, 360 px. Damage grows with the distance flown: 4 at the hand, +1 per 36 px,
 * capped at 11 (reached at 252 px; 13 in the contract, trimmed in the balance pass), and bkb 30
 * gains 0.05 per px (48 at the full 360). kbg 43 is
 * the old full-charge value, which killed a fresh Aeval near 119 with 12 damage and bkb 40.
 * One at a time: while it flies, a second Special press is the recall.
 */
const shadowSword: ProjectileDef = {
  id: 'shadowSword',
  spawnFrame: 9,
  x: 20, y: -26,
  vx: 8.0, vy: 0,
  gravity: 0,
  lifetime: 45,
  r: 10,
  damage: 4, angle: 40, bkb: 30, kbg: 43,
  strength: 3,
  distanceScale: { damagePerPx: 1 / 36, maxDamage: 11, bkbPerPx: 0.05 },
  destroyOnHit: true,
  sprite: 'shadowSword',
  animFps: 15,
  burstId: shadowBurst.id,
  aim: true,
  fixedScale: true,
  onePerOwner: true,
  // Round 2 QA: a down or down-forward throw on the ground used to fly through the floor.
  dieOnGround: true,
};

const moves: Record<MoveId, MoveDef> = {
  // Ground normals. Each starts 2 to 4 frames after Aeval's and hits 1.4x to 1.6x as hard; the
  // shadow repeats the swing from where it started.
  //
  // jab: circles r 10 from x 16 to 40 at y -24, frames 7 to 9. The echo stands 12 px ahead (the
  // plan's -6 put it behind): 4.5 damage at bkb 24 slides a standing Aeval about 20 px before the
  // echo's frame 15, and from 6 px behind the replayed chain reached her only inside 35 px. From
  // +12 the echo lands at every spacing up to 56 px between centres (the jab reaches 63); the last
  // 7 px of the tip are jab only. Measured by the selftest "Trekmore jab echo connects". Round 2:
  // +20 (echoes stand in front along his travel); the jab plus echo now reaches the jab's 63 px.
  jab: {
    id: 'jab', totalFrames: 26, iasa: 22, groundOnly: true,
    hitboxes: forwardChain(1, 7, 9, 16, 40, -24, 10, 4.5, SAKURAI, 24, 42, 1),
    echo: echo(8, 20),
  },
  // ftilt: circles r 11 from x 14 to 62 at y -26 (edge on the 72 px crescent tip), frames 13 to 17.
  // kbg 48 (plan 58): at 58 it killed a fresh Aeval at 110, below the 130 to 170 tilt band.
  ftilt: {
    id: 'ftilt', totalFrames: 38, iasa: 34, groundOnly: true,
    hitboxes: forwardChain(1, 13, 17, 14, 62, -26, 11, 12, SAKURAI, 22, 48, 1),
    echo: echo(10, 20),
  },
  // utilt: the head circle (the hilt, so an adjacent standing target is hit: the crescent's ring
  // passes over it) plus the overhead crescent (radius 40, circles r 12, 120 to -20 degrees, top
  // edge y -86), frames 13 to 18; the polish-wave hitboxes, back with the crescent art (round 2 QA).
  // kbg 80: with an echo that no longer softens a launch, 98 killed at 119; 80 kills at 152.
  utilt: {
    id: 'utilt', totalFrames: 38, iasa: 34, groundOnly: true,
    hitboxes: [box(1, 13, 18, 2, -52, 13, 10.5, 90, 38, UT_KBG, 1), ...overheadArc(2, 13, 18, 40, 12, UT_FROM, UT_TO, 10.5, 90, 38, UT_KBG, 1)],
    // Round 2 fix: the shadow strikes 4 frames behind, 20 px ahead, and follows through: utilt
    // launches straight up faster than the half-damage replay would, so a plain echo always passed
    // through (0 connects). followThrough lands its 5.25 damage and hit on the rising victim and
    // leaves the launch as it is: on the crescent it connects at every spacing the utilt reaches,
    // 0 to 60 percent, at any offset 5 to 22, and the KO stays 152 echo included.
    echo: { ...echo(4, 20), followThrough: true },
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
  // dashatk: a lunge pushed on frame 6, frames 11 to 18. Round 2: it draws the twin_strike thrust
  // and impact burst, so circles r 12 from x 14 to 50 at y -22 carry the blade into an impact
  // circle r 18 on x 68 (front edge 86 px, was 92).
  dashatk: {
    id: 'dashatk', totalFrames: 44, groundOnly: true,
    hitboxes: [...forwardChain(1, 11, 18, 14, 50, -22, 12, 13, 55, 36, 58, 1), box(6, 11, 18, 68, -22, 18, 13, 55, 36, 58, 1)],
    velocity: [{ frame: 6, vx: 3.5 }],
    // Round 2 QA: 32 px ahead so the shadow thrusts clear of his body (18 overlapped it); it lands
    // on a 0 percent victim (11 of 19 spacings); above that the thrust has launched her out of reach.
    echo: echo(10, 32),
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
  // usmash: the head circle (hilt) plus the big overhead crescent from 120 to 75 degrees (radius 50,
  // circles r 14, top edge y -98), frames 21 to 26 (polish wave, back in round 2 QA). kbg 63 (plan
  // 76, which killed at 83 and 48 charged): 107 uncharged, 65 charged.
  usmash: {
    id: 'usmash', totalFrames: 56, chargeable: true, groundOnly: true,
    hitboxes: [box(1, 21, 26, 2, -52, 15, 20, 88, 32, 63, 1), ...overheadArc(2, 21, 26, 50, 14, US_FROM, US_TO, 20, 88, 32, 63, 1)],
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
    echo: echo(8, 16),
  },
  // fair: kbg 42 (plan 62, which killed at 71): 119. Round 2: it draws the fsmash crescent
  // (heavy_slash_3/4 on 12 to 17), which runs from over his head (x 10 to 40, y -56) down the
  // front to x 59 at y -34 to -12, so three circles follow it out to a 60 px front edge (was 51).
  fair: {
    id: 'fair', totalFrames: 40, landingLag: 16, airOnly: true,
    hitboxes: [
      box(1, 12, 16, 22, -42, 14, 16, 45, 24, 42, 1),
      box(2, 12, 16, 40, -32, 14, 16, 45, 24, 42, 1),
      box(3, 12, 16, 46, -16, 14, 16, 45, 24, 42, 1),
    ],
    echo: echo(10, 20),
  },
  // bair: he turns and thrusts back. The echo stands 12 px ahead along his travel. kbg 53
  // (plan 64): a thrust into a grounded Aeval 40 px behind him kills at 104 (81 at 64).
  bair: {
    id: 'bair', totalFrames: 36, landingLag: 15, airOnly: true,
    hitboxes: [
      box(1, 10, 13, -28, -24, 14, 17, SAKURAI, 26, 53, 1),
      box(2, 10, 13, -40, -24, 12, 17, SAKURAI, 26, 53, 1),
    ],
    echo: echo(8, 12),
  },
  // uair: bkb 20 kbg 95 and an echo delay of 5 (plan 30, 82, 10). The plan's echo replayed 10
  // frames late where he started, and a victim above 0 percent had already risen out of it. With
  // less base knockback and the shorter delay it lands on a just-launched Aeval up to about 60.
  // Balance loop 1: kbg 95 to 90, his top KO move at every CPU level (20 to 23 percent of KOs).
  // Polish wave (back in round 2 QA): the crescent from 140 to 20 degrees (radius 40, circles r 12).
  // KO 136 at 40 px (calibrate). Echoes no longer soften a launch (hits.ts resolveEcho).
  uair: {
    id: 'uair', totalFrames: 42, landingLag: 14, airOnly: true,
    hitboxes: overheadArc(1, 16, 21, 40, 12, UA_FROM, UA_TO, 12, 80, 20, 90, 1),
    echo: echo(5, 10),
  },
  // dair: a stall-free downward stab, no dive, no bounce. The tip spikes on 14 to 18 (group 1),
  // the late body hit on 19 to 24 (group 2). Only the late hit is echoed: an echoed spike would be
  // a free second meteor. Balance loop 1 and 2: landing lag 24 to 18 to 14; landing was the top
  // state Aeval opened him in at UI 10 and the god CPU throws dair more than any other aerial.
  // Round 2: it draws the dsmash art (parry_counter_0..8). The spike (14 to 18, parry_counter_4/5)
  // sits where the arc comes down in front of and below him; the late hit (19 to 24,
  // parry_counter_6) is the eruption under his feet, spread a little forward like the drawn spikes.
  dair: {
    id: 'dair', totalFrames: 48, landingLag: 14, airOnly: true, hitsLedge: true,
    hitboxes: [
      box(1, 14, 18, 26, 0, 15, 16, 270, 40, 78, 1),
      box(2, 19, 24, 4, 4, 17, 11, 70, 30, 60, 2),
      box(3, 19, 24, 32, -2, 13, 11, 70, 30, 60, 2),
    ],
    echo: echo(10, 10, [2]),
  },

  // Specials.
  // Shadow Sword: a fast cast (polish wave: no charge; 34 frames, raised from 22 in the balance pass
  // so the throw is committal, UI 7 vs Aeval 78 to about 60-66 percent); press again while the sword flies to
  // teleport to it. The recall starts the branch (frames 40 to 53, 14 frames of reappear lag, the
  // first 12 invulnerable).
  // Round 2: hold Special to aim (holdAim): still held on frame 8 pauses the throw for up to 45
  // frames while the aim follows the stick; the release frame throws. Nothing grows with the hold,
  // and a press released before frame 8 is the same 34-frame cast as before.
  nspecial: {
    id: 'nspecial', totalFrames: 34, chargeable: true, chargeButton: 'special', holdAim: true,
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
  // Sword Ascent (polish wave): the sword is thrown up on frame 8 (ascentSword, which carries the
  // old rising drag hit), he phases out on 10 to 21 (hidden and invulnerable) and rematerializes
  // out of the sword at the top, then the swing (40 to 46) sends a dragged victim off.
  uspecial: {
    id: 'uspecial', totalFrames: 56, helplessAfter: true, invuln: [10, 21], hiddenFrames: [10, 21],
    hitboxes: [
      box(2, 40, 46, 20, -30, 22, 14, 50, 42, 80, 2),
      box(3, 40, 46, 34, -14, 16, 14, 50, 42, 80, 2),
    ],
    projectiles: [ascentSword],
    velocity: ascentVelocity(),
  },
  // Moon Parry: frames 4 to 30 (polish wave; was 5 to 22) absorb any melee hit or projectile (not a grab) and jump to the
  // branch, 60 to 103: invulnerable 60 to 72, an arc on 70 to 73 and an eruption on 78 to 81 that
  // repay 1.3x the absorbed damage (10 to 20), one group so one of them lands. A whiff ends at 50.
  // Balance loop 0: cap 20 (plan 30), bkb 20 and kbg 61 (plan 60, 70). The plan's counter killed
  // a fresh Aeval at 0 percent at its cap and at 46 at its floor; now the floor (a countered jab)
  // kills at 130 and the cap (a countered Aeval fsmash, 15 x 1.3 = 19.5) at about 57.
  // Polish wave: a whiff ends at 56 (was 50).
  dspecial: {
    id: 'dspecial', totalFrames: 56, invuln: [60, 72],
    hitboxes: [
      { ...box(1, 70, 73, 24, -34, 20, 0, 45, 20, 61, 1), fromCounter: true, noCrit: true },
      { ...box(2, 78, 81, 38, -8, 18, 0, 45, 20, 61, 1), fromCounter: true, noCrit: true },
    ],
    counter: { windowStart: 4, windowEnd: 30, scale: 1.3, minDamage: 10, maxDamage: 20, attackerFreeze: 14 },
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
