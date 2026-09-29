import {
  AIR_DODGE, FOOTSTOOL, FS_METER, KNOCKDOWN, ROLL, SHIELD_DECAY, SHIELD_MAX, SHORTCUT_REPLACE_FRAMES, TUNING,
} from '../core/constants';
import { Btn, DIRECT_CODES, DIRECT_MOVES } from '../core/types';
import type {
  ActionId, CommandAction, DirectMoveId, GameState, InputFrame, MatchConfig, MoveDef, MoveId, ProjectileDef, SimEvent,
} from '../core/types';
import { CHARACTER_DEFS } from '../characters/registry';
import { STAGE_DEFS } from '../stages/registry';
import { dodgesHit } from './dodge';
import { canBeGrabbed, forceGrab } from './grab';
import { canBeHit, projectileChargeScale } from './hits';
import { cloneGameState, createGameState, stepGame } from './index';
import { koFighter } from './match';
import { startMove } from './moves';
import { PROJECTILE_DEFS, chargedStat, spawnProjectile } from './projectiles';
import { setAction, simFighters, type SimFighter } from './state';

declare const process: {
  argv: string[];
  stdout: { write(text: string): void };
  exitCode?: number;
};

export interface SelfTestResult { name: string; pass: boolean; detail: string }

const NONE: InputFrame = { held: 0, pressed: 0, released: 0 };
const PAIR: InputFrame[] = [NONE, NONE];

function inp(held: number, pressed: number): InputFrame {
  return { held, pressed, released: 0 };
}

function matchConfig(seed: number, stageId = 'tidegate'): MatchConfig {
  return {
    stageId,
    players: [
      { slot: 0, charId: 'aeval', cpu: false, cpuLevel: 0 },
      { slot: 1, charId: 'aeval', cpu: false, cpuLevel: 0 },
    ],
    stocks: 3,
    timeLimitSec: 0,
    seed,
  };
}

function step(state: GameState, a: InputFrame, b: InputFrame): void {
  PAIR[0] = a;
  PAIR[1] = b;
  stepGame(state, PAIR);
}

function settle(state: GameState, frames: number): void {
  for (let i = 0; i < frames; i++) step(state, NONE, NONE);
}

function fresh(seed: number, settleFrames: number, stageId = 'tidegate'): GameState {
  const state = createGameState(matchConfig(seed, stageId));
  settle(state, settleFrames);
  return state;
}

/** Every stage id, so edge tests run on each arena. */
const STAGE_IDS = Object.keys(STAGE_DEFS);

/** The main platform's left and right edges, read from the stage def (platforms[0]). */
function mainEdges(stageId: string): { left: number; right: number } {
  const p = STAGE_DEFS[stageId].platforms[0];
  return { left: p.x, right: p.x + p.w };
}

function testLanding(): SelfTestResult {
  const state = createGameState(matchConfig(1));
  let landedOn = -1;
  for (let i = 0; i < 60; i++) {
    step(state, NONE, NONE);
    if (landedOn < 0 && state.fighters[0].onGround && state.fighters[1].onGround) landedOn = i;
  }
  let stayed = true;
  for (let i = 0; i < 300; i++) {
    step(state, NONE, NONE);
    if (!state.fighters[0].onGround || !state.fighters[1].onGround) stayed = false;
    if (state.fighters[0].y !== 0 || state.fighters[1].y !== 0) stayed = false;
  }
  return {
    name: 'a. both fighters land and stay grounded',
    pass: landedOn >= 0 && stayed,
    detail: `landed on frame ${landedOn}, grounded for 300 frames: ${stayed}`,
  };
}

function testWalkAndJump(): SelfTestResult {
  const state = fresh(1, 10);
  const f = state.fighters[0];
  const startX = f.x;
  // Holding a direction runs now, so the walk half holds the Walk modifier with it.
  const hold = inp(Btn.Right | Btn.Walk, 0);
  for (let i = 0; i < 120; i++) step(state, hold, NONE);
  const walkedX = f.x;
  const walkOk = walkedX > startX + 100 && walkedX < mainEdges('tidegate').right && f.onGround;

  settle(state, 20);
  const groundY = f.y;
  let minY = groundY;
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  for (let i = 0; i < 80; i++) {
    step(state, inp(Btn.Jump, 0), NONE);
    if (f.y < minY) minY = f.y;
  }
  const height = groundY - minY;
  return {
    name: 'b. walk stays on stage, jump clears 90 px',
    pass: walkOk && height >= 90,
    detail: `walked ${(walkedX - startX).toFixed(1)} px to x ${walkedX.toFixed(1)}, jump height ${height.toFixed(1)}`,
  };
}

function testJab(): SelfTestResult {
  const state = fresh(1, 10);
  state.fighters[0].x = -30;
  state.fighters[1].x = 0;
  step(state, inp(Btn.Attack, Btn.Attack), NONE);
  let maxHitstun = 0;
  let sawHitstun = false;
  for (let i = 0; i < 40; i++) {
    step(state, NONE, NONE);
    if (state.fighters[1].hitstun > maxHitstun) maxHitstun = state.fighters[1].hitstun;
    if (state.fighters[1].action === 'hitstun') sawHitstun = true;
  }
  const percent = state.fighters[1].percent;
  return {
    // Jab is a 3 percent thrust plus the 2 percent bead of water it throws.
    name: 'c. jab deals 5 percent and hitstun',
    pass: percent === 5 && maxHitstun > 0 && sawHitstun,
    detail: `percent ${percent}, max hitstun ${maxHitstun}, entered hitstun: ${sawHitstun}`,
  };
}

function testFsmashKo(): SelfTestResult {
  const state = fresh(1, 10);
  state.fighters[0].x = -30;
  state.fighters[1].x = 0;
  state.fighters[1].percent = 999;
  const stocksBefore = state.fighters[1].stocks;
  const smash = Btn.Right | Btn.Attack;
  step(state, inp(smash, smash), NONE);
  let koFrame = -1;
  for (let i = 0; i < 90; i++) {
    step(state, NONE, NONE);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'ko' && ev.slot === 1 && koFrame < 0) koFrame = i;
    }
  }
  const stocksAfter = state.fighters[1].stocks;
  return {
    name: 'd. fsmash kills at 999 percent',
    pass: koFrame >= 0 && stocksAfter === stocksBefore - 1,
    detail: `ko on frame ${koFrame}, stocks ${stocksBefore} to ${stocksAfter}`,
  };
}

function testProjectile(): SelfTestResult {
  const state = fresh(1, 10);
  state.fighters[1].x = -170;
  step(state, inp(Btn.Special, Btn.Special), NONE);
  let spawnX = 0;
  let spawned = false;
  let farthestX = 0;
  let died = false;
  let dieFrame = -1;
  for (let i = 0; i < 140; i++) {
    step(state, NONE, NONE);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'projectileSpawn' && !spawned) {
        spawned = true;
        spawnX = ev.x;
      }
      if (ev.type === 'projectileDie' && !died) {
        died = true;
        dieFrame = i;
      }
    }
    if (state.projectiles.length > 0 && state.projectiles[0].alive) farthestX = state.projectiles[0].x;
  }
  const traveled = farthestX - spawnX;
  const gone = state.projectiles.length > 0 && !state.projectiles[0].alive;
  // The range is read off the def rather than written in, so retuning the orb's speed
  // or lifetime retunes the expectation with it. The check is still that the orb covers
  // its whole range before it expires, allowing the frame it dies on.
  const orb = PROJECTILE_DEFS['orb'];
  const range = orb.vx * (orb.lifetime - 1);
  return {
    name: 'e. nspecial projectile travels and expires',
    pass: spawned && died && gone && traveled >= range,
    detail: `spawned at ${spawnX.toFixed(1)}, traveled ${traveled.toFixed(1)} px of ${range.toFixed(1)}, died on frame ${dieFrame}`,
  };
}

/**
 * The orb is meant to burst whether or not it connects, so run it past a
 * victim's face and then out to the end of its range and watch for the burst
 * both times.
 */
function testOrbBurst(): SelfTestResult {
  function burstsAfter(victimX: number): boolean {
    const state = fresh(1, 10);
    state.fighters[1].x = victimX;
    step(state, inp(Btn.Special, Btn.Special), NONE);
    for (let i = 0; i < 140; i++) {
      step(state, NONE, NONE);
      for (let e = 0; e < state.events.length; e++) {
        const ev = state.events[e];
        if (ev.type === 'projectileSpawn' && ev.defId === 'orbBurst') return true;
      }
    }
    return false;
  }
  const onHit = burstsAfter(60);
  const onExpiry = burstsAfter(-170);
  return {
    name: 'i. the water orb bursts on impact and at the end of its range',
    pass: onHit && onExpiry,
    detail: `burst on impact: ${onHit}, burst at end of range: ${onExpiry}`,
  };
}

/**
 * Return pass, on a def that lives only in this test so it cannot drift with the
 * character data. The thrower stands still at x 0, the victim at x 40, and the
 * projectile crosses the victim on the way out and again on the way back. No
 * knockback, so the victim stays put and both passes land on the same body.
 */
const RETURN_FRAME = 20;
const RETURN_DEF: ProjectileDef = {
  id: 'selftestReturn',
  spawnFrame: 0,
  x: 0, y: -20,
  vx: 4, vy: 0,
  gravity: 0,
  lifetime: 60,
  r: 8,
  damage: 10, angle: 0, bkb: 0, kbg: 0,
  strength: 1,
  destroyOnHit: false,
  sprite: 'orb',
  returnFrame: RETURN_FRAME,
  returnPower: 0.5,
};

function testProjectileReturn(): SelfTestResult {
  PROJECTILE_DEFS[RETURN_DEF.id] = RETURN_DEF;
  const state = fresh(1, 60);
  const thrower = simFighters(state)[0];
  thrower.x = 0;
  thrower.facing = 1;
  state.fighters[1].x = 40;
  spawnProjectile(state, thrower, RETURN_DEF);

  const p = state.projectiles[0];
  const startFacing = p.facing;
  let turnStep = -1;
  let turnFacing: number = startFacing;
  let maxX = p.x;
  let outDamage = 0;
  let backDamage = 0;
  let percent = state.fighters[1].percent;
  for (let i = 1; i <= 40; i++) {
    step(state, NONE, NONE);
    if (p.alive && p.x > maxX) maxX = p.x;
    if (turnStep < 0 && p.vx < 0) {
      turnStep = i;
      turnFacing = p.facing;
    }
    const dealt = state.fighters[1].percent - percent;
    percent = state.fighters[1].percent;
    if (dealt > 0) {
      if (turnStep < 0) outDamage += dealt;
      else backDamage += dealt;
    }
  }

  // The flip runs before the frame's integration, so it fires on the first step that
  // sees age >= returnFrame, which is the step after the one that reached that age.
  const turnedOnTime = turnStep === RETURN_FRAME + 1;
  const mirrored = turnFacing === -startFacing;
  const halved = outDamage > 0 && Math.abs(backDamage - outDamage * 0.5) < 1e-9;
  return {
    name: 'j. a returning projectile turns around, mirrors and hits for half',
    pass: turnedOnTime && mirrored && halved && maxX > 70,
    detail: `turned on step ${turnStep} at x ${maxX.toFixed(1)}, facing ${startFacing} to ${turnFacing}, `
      + `damage out ${outDamage.toFixed(2)} back ${backDamage.toFixed(2)}`,
  };
}

function testShield(): SelfTestResult {
  const state = fresh(1, 10);
  state.fighters[0].x = -30;
  state.fighters[1].x = 0;
  const shield = inp(Btn.Shield, Btn.Shield);
  step(state, inp(Btn.Attack, Btn.Attack), shield);
  let blocked = false;
  for (let i = 0; i < 40; i++) {
    step(state, NONE, inp(Btn.Shield, 0));
    for (let e = 0; e < state.events.length; e++) {
      if (state.events[e].type === 'shieldHit') blocked = true;
    }
  }
  const victim = state.fighters[1];
  return {
    name: 'f. shield eats the jab',
    pass: victim.percent === 0 && victim.shieldHp < SHIELD_MAX && blocked,
    detail: `percent ${victim.percent}, shield ${victim.shieldHp.toFixed(2)} of ${SHIELD_MAX}, shieldHit: ${blocked}`,
  };
}

function scriptedRun(seed: number): GameState {
  const state = createGameState(matchConfig(seed));
  let lcg = 987654321;
  const nextBits = (): number => {
    lcg = (lcg * 1103515245 + 12345) & 0x7fffffff;
    return lcg >>> 8;
  };
  let prevA = 0;
  let prevB = 0;
  for (let i = 0; i < 600; i++) {
    const a = nextBits() & 0x3ff;
    const b = nextBits() & 0x3ff;
    step(state, inp(a, a & ~prevA), inp(b, b & ~prevB));
    prevA = a;
    prevB = b;
  }
  return state;
}

function testDeterminism(): SelfTestResult {
  const first = scriptedRun(1);
  const second = scriptedRun(1);
  first.events.length = 0;
  second.events.length = 0;
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  return {
    name: 'g. two identical scripted runs match',
    pass: a === b,
    detail: a === b ? `${a.length} chars identical` : 'states diverged',
  };
}

function testLedgeGrab(): SelfTestResult {
  const state = fresh(1, 10);
  const f = state.fighters[0];
  f.x = 150;
  state.fighters[1].x = -150;
  let leftGround = -1;
  // Holding a direction runs. A second tap would roll, so this is one press held.
  for (let i = 0; i < 40 && leftGround < 0; i++) {
    step(state, inp(Btn.Right, i === 0 ? Btn.Right : 0), NONE);
    if (!f.onGround) leftGround = i;
  }
  let grabbed = -1;
  for (let i = 0; i < 60 && grabbed < 0; i++) {
    step(state, inp(Btn.Left, i === 0 ? Btn.Left : 0), NONE);
    if (f.action === 'ledgeHang') grabbed = i;
  }
  return {
    name: 'h. running off the edge and drifting back grabs the ledge',
    pass: leftGround >= 0 && grabbed >= 0 && f.ledge === 1,
    detail: `left ground on frame ${leftGround}, hung on frame ${grabbed}, ledge index ${f.ledge}`,
  };
}

/**
 * Throws one orb after holding special for `holdFrames`, and reports what the orb that
 * finally spawned carries. Shared by the charge cases below so they all read the same
 * path through advanceMove rather than calling the curve directly.
 */
function throwOrb(holdFrames: number): { power: number; scale: number; damage: number; charge: number; frame: number } {
  const state = createGameState(matchConfig(7));
  const me = simFighters(state)[0];
  // Settle the spawn drop so the special comes out from a grounded, idle fighter.
  for (let i = 0; i < 40; i++) step(state, NONE, NONE);
  step(state, inp(Btn.Special, Btn.Special), NONE);
  let charge = 0;
  for (let i = 0; i < holdFrames; i++) {
    step(state, inp(Btn.Special, 0), NONE);
    if (me.charge > charge) charge = me.charge;
  }
  // Release and run until the orb reaches its spawn frame.
  let power = 0;
  let scale = 0;
  let fraction = 0;
  let frame = -1;
  for (let i = 0; i < 40 && power === 0; i++) {
    step(state, NONE, NONE);
    for (let p = 0; p < state.projectiles.length; p++) {
      const pr = state.projectiles[p];
      if (pr.alive && pr.defId === 'orb') {
        power = pr.power;
        scale = pr.scale;
        fraction = pr.charge ?? 0;
        frame = i;
      }
    }
  }
  // What this orb deals: the charged lerp of its def damage times its power.
  const damage = chargedStat(PROJECTILE_DEFS['orb'], fraction, 'damage') * power;
  return { power, scale, damage, charge, frame };
}

/**
 * Holding the special button charges the water orb. advanceMove pins the move on frame 0 while
 * the button stays down, and the orb that finally spawns carries that charge as extra damage and
 * a bigger hit circle.
 *
 * The orb has a `charged` block, so its damage comes from that lerp alone (4 on a tap, 16 at
 * full) and its power is exactly 1 at every charge: no double scaling. Its scale still rides the
 * exponential curve from 0.6 on a tap to 1.5 at full.
 */
function testChargedOrb(): SelfTestResult {
  const tap = throwOrb(0);
  const full = throwOrb(60);
  const spawned = tap.power > 0 && full.power > 0;
  // A one frame press fires on its own: nothing is held after the press and the orb
  // still comes out, on the move's own spawn frame, exactly as a charged one does. No
  // hold is needed to make the move happen at all.
  // A full charge casts chargeCastFrames later (frame 27 rather than 11).
  const orbSpawnFrame = PROJECTILE_DEFS['orb'].spawnFrame;
  const castFrames = CHARACTER_DEFS['aeval'].moves.nspecial.chargeCastFrames ?? 0;
  const instant = tap.charge === 0 && tap.frame === orbSpawnFrame && full.frame === orbSpawnFrame + castFrames
    && orbSpawnFrame === 11 && castFrames === 16;
  const tapWeakAndSmall = tap.power === 1 && tap.scale === 0.6 && Math.abs(tap.damage - 4) < 1e-9;
  const fullCharged = full.charge === 60;
  const fullStrongAndBig = full.power === 1 && full.scale === 1.5 && Math.abs(full.damage - 16) < 1e-9;
  const stronger = full.damage > tap.damage && full.scale > tap.scale;
  return {
    name: 'k. holding special charges the orb into a bigger, harder hit',
    pass: spawned && instant && tapWeakAndSmall && fullCharged && fullStrongAndBig && stronger,
    detail: `tap: charge ${tap.charge} power ${tap.power.toFixed(2)} scale ${tap.scale.toFixed(2)} damage ${tap.damage.toFixed(2)} ` +
      `spawned on move frame ${tap.frame} | full: charge ${full.charge} ` +
      `power ${full.power.toFixed(2)} scale ${full.scale.toFixed(2)} damage ${full.damage.toFixed(2)} spawned on move frame ${full.frame}`,
  };
}

/**
 * The orb curve has to be a genuine exponential, not a line: each quarter of the charge
 * must be worth more damage than the one before it, so the last quarter buys far more than
 * the first. A straight line would make every quarter worth the same. The damage lerp rides
 * (scale - 0.6) / 0.9 with scale = 0.6 * 2.5 ** t, so the last quarter is worth 2.5 ** 0.75,
 * about 1.99 times the first.
 */
function testOrbCurveIsExponential(): SelfTestResult {
  const q = [throwOrb(0), throwOrb(15), throwOrb(30), throwOrb(45), throwOrb(60)];
  const gains = [
    q[1].damage - q[0].damage,
    q[2].damage - q[1].damage,
    q[3].damage - q[2].damage,
    q[4].damage - q[3].damage,
  ];
  let rising = true;
  for (let i = 1; i < gains.length; i++) {
    if (gains[i] <= gains[i - 1]) rising = false;
  }
  // Not just rising: the last quarter must be worth nearly twice the first.
  const lastDwarfsFirst = gains[3] > gains[0] * 1.9;
  return {
    name: 'o. the orb charge curve is exponential, not linear',
    pass: rising && lastDwarfsFirst,
    detail: `damage ${q.map((r) => r.damage.toFixed(3)).join(' ')} | ` +
      `gains ${gains.map((g) => g.toFixed(3)).join(' ')}`,
  };
}

/**
 * The orb curve is the orb's alone. Melee charge stays the old straight line, so a
 * fully charged fsmash still deals its 15 percent hitbox times 1.4, exactly as it did
 * before the orb was touched, and an uncharged one still deals a flat 15.
 */
function testFsmashChargeUnchanged(): SelfTestResult {
  function fsmashDamage(holdFrames: number): number {
    const state = fresh(1, 10);
    state.fighters[0].x = -30;
    state.fighters[1].x = 0;
    const smash = Btn.Right | Btn.Attack;
    step(state, inp(smash, smash), NONE);
    for (let i = 0; i < holdFrames; i++) step(state, inp(Btn.Attack, 0), NONE);
    for (let i = 0; i < 60; i++) step(state, NONE, NONE);
    return state.fighters[1].percent;
  }
  const tap = fsmashDamage(0);
  const full = fsmashDamage(70);
  const tapOk = Math.abs(tap - 15) < 1e-9;
  const fullOk = Math.abs(full - 21) < 1e-9;
  return {
    name: 'p. a charged fsmash deals exactly what it did before the orb change',
    pass: tapOk && fullOk,
    detail: `uncharged ${tap.toFixed(4)} (want 15), full charge ${full.toFixed(4)} (want 21)`,
  };
}

/**
 * Clash defs that live only in this test, so the rule is proved against fixed numbers
 * rather than whatever the character data happens to say today. The burst carries no
 * damage and dies almost at once, so counting its spawns is a clean read on whether a
 * clash detonated. Two throwers stand 80 px apart and fire into each other; the shots
 * meet at x 40, well clear of either hurtbox, so nothing here is a fighter hit.
 */
const CLASH_BURST: ProjectileDef = {
  id: 'selftestClashBurst',
  spawnFrame: 0,
  x: 0, y: 0,
  vx: 0, vy: 0,
  gravity: 0,
  lifetime: 2,
  r: 1,
  damage: 0, angle: 0, bkb: 0, kbg: 0,
  strength: 0,
  destroyOnHit: false,
  sprite: 'orb',
};
const CLASH_DEF: ProjectileDef = {
  id: 'selftestClash',
  spawnFrame: 0,
  x: 0, y: -20,
  vx: 4, vy: 0,
  gravity: 0,
  lifetime: 60,
  r: 8,
  damage: 10, angle: 0, bkb: 0, kbg: 0,
  strength: 5,
  destroyOnHit: true,
  sprite: 'orb',
  burstId: CLASH_BURST.id,
};
/** One tier above CLASH_DEF and weaker in damage, so only strength can make it win. */
const CLASH_STRONG: ProjectileDef = { ...CLASH_DEF, id: 'selftestClashStrong', damage: 1, strength: 6 };

/** Two shots fired at each other from x 0 and x 80, run for `frames` steps. */
function clashRun(defA: ProjectileDef, defB: ProjectileDef, frames: number): { state: GameState; bursts: number } {
  PROJECTILE_DEFS[CLASH_DEF.id] = CLASH_DEF;
  PROJECTILE_DEFS[CLASH_STRONG.id] = CLASH_STRONG;
  PROJECTILE_DEFS[CLASH_BURST.id] = CLASH_BURST;
  const state = fresh(1, 60);
  const left = simFighters(state)[0];
  const right = simFighters(state)[1];
  left.x = 0;
  left.facing = 1;
  right.x = 80;
  right.facing = -1;
  spawnProjectile(state, left, defA);
  spawnProjectile(state, right, defB);
  let bursts = 0;
  for (let i = 0; i < frames; i++) {
    step(state, NONE, NONE);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'projectileSpawn' && ev.defId === CLASH_BURST.id) bursts++;
    }
  }
  return { state, bursts };
}

function testClashCancel(): SelfTestResult {
  const run = clashRun(CLASH_DEF, CLASH_DEF, 12);
  const a = run.state.projectiles[0];
  const b = run.state.projectiles[1];
  // Both slots were freed by the clash; each may now hold its own burst, which is
  // exactly what the burst count checks, so only the two clashing ids matter here.
  const bothGone = a.defId === CLASH_BURST.id || !a.alive;
  const otherGone = b.defId === CLASH_BURST.id || !b.alive;
  return {
    name: 'l. two equal-strength opposing projectiles cancel and both burst',
    pass: bothGone && otherGone && run.bursts === 2,
    detail: `slot 0 ${a.defId}/${a.alive}, slot 1 ${b.defId}/${b.alive}, bursts ${run.bursts}`,
  };
}

function testClashPlowsThrough(): SelfTestResult {
  // Strength 6 against 5, with 1 damage against 10: the tier decides, damage does not.
  const run = clashRun(CLASH_STRONG, CLASH_DEF, 12);
  let survivors = 0;
  let weaker = 0;
  let power = 0;
  for (let i = 0; i < run.state.projectiles.length; i++) {
    const p = run.state.projectiles[i];
    if (!p.alive) continue;
    if (p.defId === CLASH_STRONG.id) {
      survivors++;
      power = p.power;
    }
    if (p.defId === CLASH_DEF.id) weaker++;
  }
  // The survivor flies on untouched: power stays exactly 1.
  return {
    name: 'm. a stronger-tier projectile destroys a weaker one and flies on untouched',
    pass: survivors === 1 && weaker === 0 && power === 1 && run.bursts === 1,
    detail: `stronger alive ${survivors}, weaker alive ${weaker}, power ${power} (want 1), bursts ${run.bursts}`,
  };
}

function testClashSameOwner(): SelfTestResult {
  PROJECTILE_DEFS[CLASH_DEF.id] = CLASH_DEF;
  PROJECTILE_DEFS[CLASH_BURST.id] = CLASH_BURST;
  const state = fresh(1, 60);
  const me = simFighters(state)[0];
  state.fighters[1].x = 300;
  me.x = 0;
  me.facing = 1;
  spawnProjectile(state, me, CLASH_DEF);
  me.x = 80;
  me.facing = -1;
  spawnProjectile(state, me, CLASH_DEF);
  me.x = 0;
  let bursts = 0;
  for (let i = 0; i < 12; i++) {
    step(state, NONE, NONE);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'projectileSpawn' && ev.defId === CLASH_BURST.id) bursts++;
    }
  }
  const a = state.projectiles[0];
  const b = state.projectiles[1];
  const crossed = a.x > b.x;
  return {
    name: 'n. two projectiles from the same owner pass through each other',
    pass: a.alive && b.alive && bursts === 0 && crossed,
    detail: `both alive ${a.alive && b.alive} at x ${a.x.toFixed(1)} and ${b.x.toFixed(1)}, bursts ${bursts}`,
  };
}

function directInp(id: DirectMoveId): InputFrame {
  return { held: 0, pressed: 0, released: 0, direct: DIRECT_MOVES.indexOf(id) + 1 };
}

/** Holds `held` from idle for `frames` steps, pressing it on the first, and reports the action. */
function actionAfterHold(held: number, frames: number): ActionId {
  const state = fresh(1, 60);
  step(state, inp(held, held), NONE);
  for (let i = 1; i < frames; i++) step(state, inp(held, 0), NONE);
  return state.fighters[0].action;
}

function testRunByDefault(): SelfTestResult {
  const run = actionAfterHold(Btn.Right, 20);
  const walk = actionAfterHold(Btn.Right | Btn.Walk, 20);
  return {
    name: 'q. holding a direction runs, holding Walk with it walks',
    pass: run === 'run' && walk === 'walk',
    detail: `Right: ${run} (want run), Right+Walk: ${walk} (want walk)`,
  };
}

/**
 * Tap Right, release four frames, tap Right again: the second press rolls on that very
 * frame, and eight frames in the roll is dodging high hits without being invulnerable.
 * A single press, held or tapped outside the window, never rolls.
 */
function testDoubleTapRoll(): SelfTestResult {
  const state = fresh(1, 60);
  const f = simFighters(state)[0];
  step(state, inp(Btn.Right, Btn.Right), NONE);
  for (let i = 0; i < 4; i++) step(state, NONE, NONE);
  step(state, inp(Btn.Right, Btn.Right), NONE);
  const rolledOnTap = f.action === 'roll';
  for (let i = 0; i < 8; i++) step(state, inp(Btn.Right, 0), NONE);
  const frame8 = f.action === 'roll' && f.actionFrame === 8;
  const invuln = f.invuln;
  const highDodge = f.highDodge;

  const held = fresh(1, 60);
  let heldRolled = false;
  step(held, inp(Btn.Right, Btn.Right), NONE);
  for (let i = 0; i < 30; i++) {
    step(held, inp(Btn.Right, 0), NONE);
    if (held.fighters[0].action === 'roll') heldRolled = true;
  }

  const late = fresh(1, 60);
  let lateRolled = false;
  step(late, inp(Btn.Right, Btn.Right), NONE);
  for (let i = 0; i < 20; i++) step(late, NONE, NONE);
  for (let i = 0; i < 10; i++) {
    step(late, inp(Btn.Right, i === 0 ? Btn.Right : 0), NONE);
    if (late.fighters[0].action === 'roll') lateRolled = true;
  }

  return {
    name: 'r. a double tap rolls on the second press with highDodge, a single tap never rolls',
    pass: rolledOnTap && frame8 && invuln === 0 && highDodge > 0 && !heldRolled && !lateRolled,
    detail: `rolled on tap ${rolledOnTap}, roll frame 8 ${frame8} invuln ${invuln} highDodge ${highDodge}, `
      + `single held tap rolled ${heldRolled}, retap after 20 frames rolled ${lateRolled}`,
  };
}

function testShieldOnlyShields(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  const both = Btn.Shield | Btn.Right;
  step(state, inp(both, both), NONE);
  let left = false;
  for (let i = 0; i < 29; i++) {
    step(state, inp(both, 0), NONE);
    if (f.action !== 'shield') left = true;
  }
  return {
    name: 's. holding shield and a direction stays in shield',
    pass: f.action === 'shield' && !left,
    detail: `action after 30 frames ${f.action}, ever left shield ${left}`,
  };
}

/** A full hop, returned once the fighter is a few frames off the ground, facing right. */
function airborneState(): GameState {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  f.facing = 1;
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  for (let i = 0; i < 6; i++) step(state, inp(Btn.Jump, 0), NONE);
  return state;
}

function testAirShieldAndDodge(): SelfTestResult {
  const shielded = airborneState();
  const wasAirborne = !shielded.fighters[0].onGround;
  let shieldDodged = false;
  step(shielded, inp(Btn.Shield, Btn.Shield), NONE);
  for (let i = 0; i < 20; i++) {
    if (shielded.fighters[0].action === 'airDodge') shieldDodged = true;
    step(shielded, inp(Btn.Shield, 0), NONE);
  }
  const dodged = airborneState();
  step(dodged, inp(Btn.Dodge, Btn.Dodge), NONE);
  const action = dodged.fighters[0].action;
  return {
    // Shield in the air is an air dodge now, as in Smash; only the ground still shields.
    name: 't. shield in the air air dodges, Dodge in the air air dodges',
    pass: wasAirborne && shieldDodged && action === 'airDodge',
    detail: `airborne ${wasAirborne}, shield air dodged ${shieldDodged}, Dodge gave ${action}`,
  };
}

function testDodgeButtonAndDownTap(): SelfTestResult {
  const rolled = fresh(1, 60);
  const left = Btn.Dodge | Btn.Left;
  step(rolled, inp(left, left), NONE);
  const roll = rolled.fighters[0].action;

  const spot = fresh(1, 60);
  step(spot, inp(Btn.Dodge, Btn.Dodge), NONE);
  const spotAction = spot.fighters[0].action;

  // The spawn sits on the main platform, which is solid, so the first Down never drops.
  const tapped = fresh(1, 60);
  step(tapped, inp(Btn.Down, Btn.Down), NONE);
  for (let i = 0; i < 3; i++) step(tapped, NONE, NONE);
  step(tapped, inp(Btn.Down, Btn.Down), NONE);
  const tapAction = tapped.fighters[0].action;
  return {
    name: 'u. Dodge rolls with a direction and spot dodges without, a double tap down spot dodges',
    pass: roll === 'roll' && spotAction === 'spotDodge' && tapAction === 'spotDodge',
    detail: `Dodge+Left ${roll}, Dodge ${spotAction}, double tap down ${tapAction}`,
  };
}

/**
 * The attacker stands at x -30 facing right and fires `id` from its direct key on step 5.
 * With `roll` set the victim, starting at x 0, double taps toward the attacker so the roll
 * starts on step 5 too, which puts the tilt's active frames inside the roll's dodge window.
 * Without it the victim stands still at x -12, where the rolling body would be.
 */
function rollAgainst(id: DirectMoveId, roll: boolean): number {
  const state = fresh(1, 60);
  const atk = simFighters(state)[0];
  const vic = simFighters(state)[1];
  atk.x = -30;
  atk.facing = 1;
  vic.x = roll ? 0 : -12;
  for (let i = 0; i < 60; i++) {
    const a = i === 5 ? directInp(id) : NONE;
    let b = NONE;
    if (roll && i === 0) b = inp(Btn.Left, Btn.Left);
    if (roll && i === 5) b = inp(Btn.Left, Btn.Left);
    step(state, a, b);
  }
  return vic.percent;
}

function testRollDodgesHighNotLow(): SelfTestResult {
  const highControl = rollAgainst('ftilt', false);
  const high = rollAgainst('ftilt', true);
  const low = rollAgainst('dtilt', true);
  return {
    name: 'v. a roll dodges ftilt but not dtilt',
    pass: highControl > 0 && high === 0 && low > 0,
    detail: `ftilt on a standing victim ${highControl}, ftilt on a roll ${high}, dtilt on a roll ${low}`,
  };
}

function testDirectAndCStick(): SelfTestResult {
  const smash = fresh(1, 60);
  step(smash, directInp('fsmash'), NONE);
  const smashMove = smash.fighters[0].moveId;

  const fair = fresh(1, 60);
  step(fair, directInp('fair'), NONE);
  const fairMove = fair.fighters[0].moveId;

  const cRight = airborneState();
  step(cRight, inp(Btn.CRight, Btn.CRight), NONE);
  const cRightMove = cRight.fighters[0].moveId;

  const cLeft = airborneState();
  step(cLeft, inp(Btn.CLeft, Btn.CLeft), NONE);
  const cLeftMove = cLeft.fighters[0].moveId;
  const noTurn = cLeft.fighters[0].facing === 1;
  return {
    name: 'w. direct keys and the C-stick pick the right move on the ground and in the air',
    pass: smashMove === 'fsmash' && fairMove === 'ftilt' && cRightMove === 'fair' && cLeftMove === 'bair' && noTurn,
    detail: `direct fsmash ${smashMove}, direct fair on ground ${fairMove}, `
      + `air CRight ${cRightMove}, air CLeft ${cLeftMove} still facing right ${noTurn}`,
  };
}

function sawEvent(state: GameState, type: SimEvent['type']): boolean {
  for (let e = 0; e < state.events.length; e++) {
    if (state.events[e].type === type) return true;
  }
  return false;
}

/**
 * Grab setup shared by the grab cases: the holder stands at x 0 facing right and the
 * victim at x 30 facing it, inside the standing grab's reach.
 */
function grabPair(): GameState {
  const state = fresh(1, 60);
  const h = simFighters(state)[0];
  const v = simFighters(state)[1];
  h.x = 0;
  h.facing = 1;
  v.x = 30;
  v.facing = -1;
  return state;
}

function pressGrab(state: GameState, victim: InputFrame, victimHeld: InputFrame, frames: number): boolean {
  let caught = false;
  step(state, inp(Btn.Grab, Btn.Grab), victim);
  for (let i = 0; i < frames; i++) {
    step(state, NONE, victimHeld);
    if (sawEvent(state, 'grab')) caught = true;
  }
  return caught;
}

function testGrabCatches(): SelfTestResult {
  const state = grabPair();
  const caught = pressGrab(state, NONE, NONE, 12);
  const h = state.fighters[0].action;
  const v = state.fighters[1].action;

  const shielded = grabPair();
  const shieldCaught = pressGrab(shielded, inp(Btn.Shield, Btn.Shield), inp(Btn.Shield, 0), 12);
  const shieldVictim = shielded.fighters[1].action;

  const rolled = grabPair();
  simFighters(rolled)[1].highDodge = 60;
  const rollCaught = pressGrab(rolled, NONE, NONE, 40);
  const rollVictim = rolled.fighters[1].action;
  return {
    name: 'x. a standing grab catches an idle or shielding fighter and whiffs on a roll',
    pass: caught && h === 'grabHold' && v === 'grabbed'
      && shieldCaught && shieldVictim === 'grabbed'
      && !rollCaught && rollVictim !== 'grabbed',
    detail: `idle: event ${caught} holder ${h} victim ${v} | shield: event ${shieldCaught} victim ${shieldVictim} `
      + `| highDodge: event ${rollCaught} victim ${rollVictim}`,
  };
}

/** Frames from the catch until the victim is out of 'grabbed', with the victim mashing or not. */
function framesHeld(mash: boolean): { frames: number; maxGap: number } {
  const state = grabPair();
  pressGrab(state, NONE, NONE, 12);
  const h = state.fighters[0];
  const v = state.fighters[1];
  let maxGap = 0;
  let frames = 0;
  for (let i = 0; i < 300 && v.action === 'grabbed'; i++) {
    const gap = Math.abs(Math.abs(v.x - h.x) - 14);
    if (i < 20 && gap > maxGap) maxGap = gap;
    step(state, NONE, mash && i % 2 === 0 ? inp(Btn.Attack, Btn.Attack) : NONE);
    frames++;
  }
  return { frames, maxGap };
}

function testGrabHoldAndMash(): SelfTestResult {
  const idle = framesHeld(false);
  const mashed = framesHeld(true);
  return {
    name: 'y. the victim stays in hand for the hold, and mashing frees it sooner',
    pass: idle.maxGap <= 1 && idle.frames >= 20 && mashed.frames < idle.frames,
    detail: `hand gap over 20 frames ${idle.maxGap.toFixed(2)} px, released after ${idle.frames} idle `
      + `and ${mashed.frames} mashing`,
  };
}

/** Catches, presses `dir` once, and reports the victim the frame the throw event fires. */
function throwWith(dir: number): { id: string; vx: number; vy: number; percent: number } {
  const state = grabPair();
  pressGrab(state, NONE, NONE, 12);
  const v = state.fighters[1];
  step(state, inp(dir, dir), NONE);
  for (let i = 0; i < 40; i++) {
    step(state, NONE, NONE);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'throw') return { id: ev.throwId, vx: v.vx, vy: v.vy, percent: v.percent };
    }
  }
  return { id: 'none', vx: 0, vy: 0, percent: 0 };
}

function testThrows(): SelfTestResult {
  const f = throwWith(Btn.Right);
  const b = throwWith(Btn.Left);
  const u = throwWith(Btn.Up);
  const d = throwWith(Btn.Down);
  const want = 6 * TUNING.knockback.damageMul;
  return {
    name: 'z. forward, back, up and down throws launch the right way',
    pass: f.id === 'fthrow' && f.vx > 0
      && b.id === 'bthrow' && b.vx < 0
      && u.id === 'uthrow' && u.vy < 0
      && d.id === 'dthrow' && Math.abs(d.percent - want) < 1e-9,
    detail: `${f.id} vx ${f.vx.toFixed(2)} | ${b.id} vx ${b.vx.toFixed(2)} | ${u.id} vy ${u.vy.toFixed(2)} `
      + `| ${d.id} percent ${d.percent} (want ${want})`,
  };
}

function testPummel(): SelfTestResult {
  const state = grabPair();
  pressGrab(state, NONE, NONE, 12);
  const v = state.fighters[1];
  step(state, inp(Btn.Attack, Btn.Attack), NONE);
  let sawPummel = state.fighters[0].action === 'pummel';
  let maxSpeed = 0;
  for (let i = 0; i < 25; i++) {
    step(state, NONE, NONE);
    if (state.fighters[0].action === 'pummel') sawPummel = true;
    const speed = Math.abs(v.vx) + Math.abs(v.vy);
    if (speed > maxSpeed) maxSpeed = speed;
  }
  const want = 1.5 * TUNING.knockback.damageMul;
  return {
    name: 'aa. a pummel adds percent without launching',
    pass: sawPummel && Math.abs(v.percent - want) < 1e-9 && maxSpeed === 0 && v.action === 'grabbed'
      && state.fighters[0].action === 'grabHold',
    detail: `pummelled ${sawPummel}, percent ${v.percent} (want ${want}), victim speed ${maxSpeed}, `
      + `victim ${v.action}, holder ${state.fighters[0].action}`,
  };
}

function testThirdPartyBreaksGrab(): SelfTestResult {
  const config = matchConfig(1);
  config.players.push({ slot: 2, charId: 'aeval', cpu: false, cpuLevel: 0 });
  const state = createGameState(config);
  const trio: InputFrame[] = [NONE, NONE, NONE];
  const run = (a: InputFrame, c: InputFrame): void => {
    trio[0] = a;
    trio[1] = NONE;
    trio[2] = c;
    stepGame(state, trio);
  };
  for (let i = 0; i < 60; i++) run(NONE, NONE);
  const h = simFighters(state)[0];
  const v = simFighters(state)[1];
  const third = simFighters(state)[2];
  h.x = 0;
  h.facing = 1;
  v.x = 30;
  v.facing = -1;
  third.x = -30;
  third.facing = 1;
  run(inp(Btn.Grab, Btn.Grab), NONE);
  for (let i = 0; i < 12; i++) run(NONE, NONE);
  const held = v.action === 'grabbed';

  run(NONE, inp(Btn.Attack, Btn.Attack));
  let hitFrame = -1;
  let freedFrame = -1;
  for (let i = 0; i < 30 && freedFrame < 0; i++) {
    run(NONE, NONE);
    if (hitFrame < 0) {
      for (let e = 0; e < state.events.length; e++) {
        const ev = state.events[e];
        if (ev.type === 'hit' && ev.victim === h.slot && ev.attacker === third.slot) hitFrame = i;
      }
    } else if (v.action !== 'grabbed') {
      freedFrame = i;
    }
  }
  return {
    name: 'ab. a third party hitting the holder frees the victim within 2 frames',
    pass: held && hitFrame >= 0 && freedFrame >= 0 && freedFrame - hitFrame <= 2,
    detail: `held ${held}, holder hit on frame ${hitFrame}, victim freed on frame ${freedFrame} as ${v.action}`,
  };
}

function testForceGrab(): SelfTestResult {
  const state = grabPair();
  const h = simFighters(state)[0];
  const v = simFighters(state)[1];
  v.y = -60;
  v.onGround = false;
  setAction(v, 'air');
  const normalRefused = !canBeGrabbed(state, h, v, false);
  const caught = forceGrab(state, h, v, { force: true });
  let stayed = true;
  for (let i = 0; i < 40; i++) {
    step(state, NONE, i % 2 === 0 ? inp(Btn.Attack, Btn.Attack) : NONE);
    if (v.action !== 'grabbed') stayed = false;
  }
  return {
    name: 'ac. a force grab catches an airborne victim and mashing cannot free it',
    pass: normalRefused && caught && stayed,
    detail: `normal grab refused ${normalRefused}, force caught ${caught}, held through 40 mashed frames ${stayed}`,
  };
}

/**
 * A grab hitbox inside a move. The def lives only in this test: a shallow copy of Aeval
 * whose jab is one force-grab hitbox that throws up at once. It is removed afterwards.
 */
function testGrabHitbox(): SelfTestResult {
  const base = CHARACTER_DEFS['aeval'];
  const jab: MoveDef = {
    id: 'jab', totalFrames: 18, groundOnly: true,
    hitboxes: [{
      id: 1, start: 4, end: 6, x: 15, y: -18, r: 9,
      damage: 0, angle: 0, bkb: 0, kbg: 0, group: 1,
      grab: { force: true, throwNow: 'uthrow' },
    }],
  };
  CHARACTER_DEFS['grabtest'] = { ...base, id: 'grabtest', moves: { ...base.moves, jab } };
  try {
    const config = matchConfig(1);
    config.players[0].charId = 'grabtest';
    const state = createGameState(config);
    settle(state, 60);
    const h = simFighters(state)[0];
    const v = simFighters(state)[1];
    h.x = 0;
    h.facing = 1;
    v.x = 30;
    v.facing = -1;
    step(state, inp(Btn.Attack, Btn.Attack), NONE);
    let caught = false;
    let thrown = '';
    let vy = 0;
    for (let i = 0; i < 40 && thrown === ''; i++) {
      step(state, NONE, NONE);
      for (let e = 0; e < state.events.length; e++) {
        const ev = state.events[e];
        if (ev.type === 'grab') caught = true;
        if (ev.type === 'throw') {
          thrown = ev.throwId;
          vy = v.vy;
        }
      }
    }
    return {
      name: 'ad. a grab hitbox with throwNow catches and throws from inside a move',
      pass: caught && thrown === 'uthrow' && vy < 0,
      detail: `caught ${caught}, throw ${thrown === '' ? 'none' : thrown}, victim vy ${vy.toFixed(2)}`,
    };
  } finally {
    delete CHARACTER_DEFS['grabtest'];
  }
}

/** A command key press, with `held` and `pressed` buttons alongside it. */
function cmdInp(cmd: CommandAction, held: number, pressed: number): InputFrame {
  return { held, pressed, released: 0, direct: DIRECT_CODES.indexOf(cmd) + 1 };
}

interface DropResult { land: number; action: ActionId; invuln: number; tech: boolean; roll: boolean; state: GameState }

/**
 * Fighter 0 falls in tumble from 80 px above the main platform with fighter 1 parked far
 * away, fed `input(step)` each frame, and the run stops on the step it lands. With
 * `hitstun` 0 the tumble is on normal air physics, where any press but a tech press would
 * end it, so a tech there also proves the tech press left the tumble alone.
 */
function runDrop(hitstun: number, input: (i: number) => InputFrame): DropResult {
  const state = fresh(1, 60);
  const f = simFighters(state)[0];
  state.fighters[1].x = 150;
  f.x = 0;
  f.y = -80;
  f.vx = 0;
  f.vy = 0;
  f.onGround = false;
  f.kbDirX = 0;
  f.kbDirY = 0;
  f.kbSpeed = 0;
  f.kbFall = 0;
  f.hitstun = hitstun;
  setAction(f, 'tumble');
  let tech = false;
  let roll = false;
  for (let i = 0; i < 200; i++) {
    step(state, input(i), NONE);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'tech' && ev.slot === 0) {
        tech = true;
        roll = ev.roll;
      }
    }
    if (f.onGround) return { land: i, action: f.action, invuln: f.invuln, tech, roll, state };
  }
  return { land: -1, action: f.action, invuln: f.invuln, tech, roll, state };
}

function pressAt(at: number, bits: number): (i: number) => InputFrame {
  return (i) => (i === at ? inp(bits, bits) : NONE);
}

function testTechOnLanding(): SelfTestResult {
  const dry = runDrop(0, () => NONE);
  const inPlace = runDrop(0, pressAt(dry.land - 10, Btn.Shield));

  const dryHeld = runDrop(60, () => NONE);
  const at = dryHeld.land - 10;
  const rolled = runDrop(60, (i) => (i < at ? NONE : inp(Btn.Right | (i === at ? Btn.Shield : 0), i === at ? Btn.Shield | Btn.Right : 0)));
  const f = simFighters(rolled.state)[0];
  for (let i = 0; i < 10; i++) step(rolled.state, inp(Btn.Right, 0), NONE);
  return {
    name: 'ae. a Shield press 10 frames before a tumble landing techs in place, with a direction it tech rolls',
    pass: dry.land > 10 && inPlace.action === 'tech' && inPlace.invuln > 0 && inPlace.tech && !inPlace.roll
      && dryHeld.land === rolled.land && rolled.action === 'techRoll' && rolled.tech && rolled.roll && f.x > 0,
    detail: `landed on step ${dry.land}: ${inPlace.action} invuln ${inPlace.invuln} event ${inPlace.tech} | `
      + `held Right: ${rolled.action} event roll ${rolled.roll}, x after 10 frames ${f.x.toFixed(1)}`,
  };
}

function testKnockdown(): SelfTestResult {
  const dry = runDrop(0, () => NONE);
  const f = simFighters(dry.state)[0];
  let frames = 0;
  while (f.action === 'downed' && frames < 300) {
    step(dry.state, NONE, NONE);
    frames++;
  }
  const late = runDrop(0, pressAt(dry.land - 30, Btn.Shield));
  return {
    name: 'af. a tumble landing without a tech lies downed, then gets up; a press 30 frames early does not tech',
    pass: dry.action === 'downed' && !dry.tech && frames === KNOCKDOWN.maxFrames && f.action === 'getUp'
      && late.action === 'downed' && !late.tech,
    detail: `no press: ${dry.action}, ${frames} frames downed then ${f.action} | press 30 early: ${late.action} tech ${late.tech}`,
  };
}

function testTechLockout(): SelfTestResult {
  const dry = runDrop(0, () => NONE);
  const mash = (from: number) => (i: number): InputFrame => (i >= from ? inp(Btn.Shield, Btn.Shield) : NONE);
  const early = runDrop(0, mash(dry.land - 30));
  const inWindow = runDrop(0, mash(dry.land - 10));
  return {
    name: 'ag. mashing Shield in tumble is locked out unless the first press is inside the window',
    pass: early.action === 'downed' && !early.tech && inWindow.action === 'tech' && inWindow.tech,
    detail: `mash from 30 early: ${early.action} tech ${early.tech} | mash from 10 early: ${inWindow.action} tech ${inWindow.tech}`,
  };
}

function testDownedOptions(): SelfTestResult {
  const attacked = runDrop(0, () => NONE);
  step(attacked.state, inp(Btn.Attack, Btn.Attack), NONE);
  const atk = attacked.state.fighters[0];

  const rolled = runDrop(0, () => NONE);
  const r = rolled.state.fighters[0];
  const startX = r.x;
  step(rolled.state, inp(Btn.Right, Btn.Right), NONE);
  const rollAction = r.action;
  for (let i = 0; i < 10; i++) step(rolled.state, inp(Btn.Right, 0), NONE);

  const cmd = runDrop(0, () => NONE);
  step(cmd.state, cmdInp('getupAttack', 0, 0), NONE);
  const cmdMove = cmd.state.fighters[0].moveId;
  return {
    name: 'ah. downed + Attack or the getupAttack command get-up attacks, downed + Right rolls right',
    pass: atk.action === 'attack' && atk.moveId === 'getupatk' && cmdMove === 'getupatk'
      && rollAction === 'getUpRoll' && r.x > startX,
    detail: `Attack: ${atk.action} ${atk.moveId} | command: ${cmdMove} | Right: ${rollAction}, moved ${(r.x - startX).toFixed(1)} px`,
  };
}

/** Fighter 0 airborne and still at x 0 with feet 5 px above a standing fighter 1's head at `victimX`. */
function footstoolSetup(victimX: number): GameState {
  const state = fresh(1, 60);
  const j = simFighters(state)[0];
  const v = simFighters(state)[1];
  v.x = victimX;
  j.x = 0;
  j.y = -45;
  j.vx = 0;
  j.vy = 0;
  j.onGround = false;
  j.jumpsLeft = 1;
  setAction(j, 'air');
  return state;
}

function testFootstool(): SelfTestResult {
  const state = footstoolSetup(0);
  const j = state.fighters[0];
  const v = state.fighters[1];
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  const stooled = v.action === 'footstooled';
  const event = sawEvent(state, 'footstool');
  let frames = 1;
  while (v.action === 'footstooled' && frames < 120) {
    step(state, NONE, NONE);
    frames++;
  }

  const far = footstoolSetup(120);
  step(far, inp(Btn.Jump, Btn.Jump), NONE);
  const fj = far.fighters[0];

  const byCmd = footstoolSetup(0);
  step(byCmd, cmdInp('footstool', 0, 0), NONE);
  return {
    name: 'ai. Jump over a head footstools without spending a jump; far away it double jumps',
    pass: stooled && event && j.jumpsLeft === 1 && frames === FOOTSTOOL.victimGround
      && fj.vy < 0 && fj.jumpsLeft === 0 && !sawEvent(far, 'footstool') && far.fighters[1].action !== 'footstooled'
      && byCmd.fighters[1].action === 'footstooled',
    detail: `victim ${stooled ? 'footstooled' : v.action} for ${frames} frames, event ${event}, jumps ${j.jumpsLeft} | `
      + `far: vy ${fj.vy.toFixed(2)} jumps ${fj.jumpsLeft} | command: victim ${byCmd.fighters[1].action}`,
  };
}

function testDodgeAndTauntCommands(): SelfTestResult {
  const back = fresh(1, 60);
  back.fighters[0].facing = 1;
  step(back, cmdInp('rollBack', 0, 0), NONE);
  const b = back.fighters[0];

  const still = airborneState();
  step(still, cmdInp('airDodge', Btn.Right, 0), NONE);
  const s = still.fighters[0];

  const dir = airborneState();
  step(dir, cmdInp('dirAirDodge', Btn.Right, 0), NONE);
  const d = dir.fighters[0];

  const t3 = fresh(1, 60);
  step(t3, cmdInp('taunt3', 0, 0), NONE);
  const tDown = fresh(1, 60);
  step(tDown, inp(Btn.Taunt | Btn.Down, Btn.Taunt | Btn.Down), NONE);
  const tSide = fresh(1, 60);
  step(tSide, inp(Btn.Taunt | Btn.Right, Btn.Taunt | Btn.Right), NONE);
  const tPlain = fresh(1, 60);
  step(tPlain, inp(Btn.Taunt, Btn.Taunt), NONE);
  return {
    name: 'aj. dodge and taunt commands, and Taunt with a direction, pick the right action',
    pass: b.action === 'roll' && b.vx < 0 && b.facing === 1
      && s.action === 'airDodge' && s.vx === 0
      && d.action === 'airDodge' && d.vx > 0
      && t3.fighters[0].moveId === 'taunt3' && tDown.fighters[0].moveId === 'taunt3'
      && tSide.fighters[0].moveId === 'taunt2' && tPlain.fighters[0].moveId === 'taunt',
    detail: `rollBack ${b.action} vx ${b.vx.toFixed(2)} | airDodge+Right ${s.action} vx ${s.vx} | `
      + `dirAirDodge+Right ${d.action} vx ${d.vx.toFixed(2)} | taunt3 cmd ${t3.fighters[0].moveId}, `
      + `Taunt+Down ${tDown.fighters[0].moveId}, Taunt+Right ${tSide.fighters[0].moveId}, Taunt ${tPlain.fighters[0].moveId}`,
  };
}

function testLedgeAndStrayCommands(): SelfTestResult {
  const state = fresh(1, 10);
  const f = state.fighters[0];
  f.x = 150;
  state.fighters[1].x = -150;
  let left = false;
  for (let i = 0; i < 40 && !left; i++) {
    step(state, inp(Btn.Right, i === 0 ? Btn.Right : 0), NONE);
    left = !f.onGround;
  }
  let hung = false;
  for (let i = 0; i < 60 && !hung; i++) {
    step(state, inp(Btn.Left, i === 0 ? Btn.Left : 0), NONE);
    hung = f.action === 'ledgeHang';
  }
  step(state, cmdInp('ledgeJump', 0, 0), NONE);
  const jumped = f.action === 'air' && f.vy < 0 && f.ledge === -1;

  const stray = fresh(1, 60);
  step(stray, cmdInp('getupAttack', 0, 0), NONE);
  const ignored = stray.fighters[0].action;
  step(stray, inp(Btn.Attack, Btn.Attack), NONE);
  const next = stray.fighters[0].moveId;

  const same = fresh(1, 60);
  step(same, cmdInp('getupAttack', Btn.Attack, Btn.Attack), NONE);
  const sameFrame = same.fighters[0].moveId;
  return {
    name: 'ak. ledgeJump leaves the ledge upward; getupAttack outside downed is dropped and blocks nothing',
    pass: hung && jumped && ignored !== 'attack' && next === 'jab' && sameFrame === 'jab',
    detail: `hung ${hung}, after ledgeJump ${f.action} vy ${f.vy.toFixed(2)} ledge ${f.ledge} | `
      + `stray getupAttack left ${ignored}, next Attack ${next}, same-frame Attack ${sameFrame}`,
  };
}

function testGrabCommands(): SelfTestResult {
  const pummel = grabPair();
  pressGrab(pummel, NONE, NONE, 12);
  const heldBefore = pummel.fighters[0].action;
  step(pummel, cmdInp('pummel', 0, 0), NONE);
  const pummelAction = pummel.fighters[0].action;

  const back = grabPair();
  pressGrab(back, NONE, NONE, 12);
  step(back, cmdInp('bthrow', 0, 0), NONE);
  const h = simFighters(back)[0];
  return {
    name: 'al. the pummel command pummels and the bthrow command back throws with facing flipped',
    pass: heldBefore === 'grabHold' && pummelAction === 'pummel'
      && h.action === 'throw' && h.activeThrowId === 'bthrow' && h.facing === -1,
    detail: `held ${heldBefore}, pummel cmd ${pummelAction} | bthrow cmd ${h.action} ${h.activeThrowId} facing ${h.facing}`,
  };
}

/** Two fighters (or three) under the finalSmash rule, fighter 0 at x 0 facing right. */
function fsState(players: number, rule: boolean): GameState {
  const config = matchConfig(1);
  for (let i = 2; i < players; i++) config.players.push({ slot: i, charId: 'aeval', cpu: false, cpuLevel: 0 });
  config.finalSmash = rule;
  const state = createGameState(config);
  const idle: InputFrame[] = [];
  for (let i = 0; i < players; i++) idle.push(NONE);
  for (let i = 0; i < 60; i++) stepGame(state, idle);
  const f = simFighters(state)[0];
  f.x = 0;
  f.facing = 1;
  return state;
}

/** Steps every fighter with no input except fighter 0, which gets `first` on the first step. */
function runFs(state: GameState, first: InputFrame, frames: number, each?: (i: number) => void): SimEvent[] {
  const inputs: InputFrame[] = [];
  for (let i = 0; i < state.fighters.length; i++) inputs.push(NONE);
  const seen: SimEvent[] = [];
  for (let i = 0; i < frames; i++) {
    inputs[0] = i === 0 ? first : NONE;
    stepGame(state, inputs);
    for (let e = 0; e < state.events.length; e++) seen.push(state.events[e]);
    if (each !== undefined) each(i);
  }
  return seen;
}

const SPECIAL = inp(Btn.Special, Btn.Special);

function testFsMeterFills(): SelfTestResult {
  const meter = (rule: boolean): { atk: number; vic: number } => {
    const state = fresh(1, 10);
    state.config.finalSmash = rule;
    state.fighters[0].x = -30;
    state.fighters[1].x = 0;
    step(state, inp(Btn.Attack, Btn.Attack), NONE);
    settle(state, 40);
    return { atk: state.fighters[0].fsMeter, vic: state.fighters[1].fsMeter };
  };
  const on = meter(true);
  const off = meter(false);
  // The jab deals 5 (3 thrust + 2 bead): the attacker gains 5 * perDamageDealt, the victim 5 * perDamageTaken.
  const dmg = 5 * TUNING.knockback.damageMul;
  const wantAtk = dmg * FS_METER.perDamageDealt;
  const wantVic = dmg * FS_METER.perDamageTaken;

  const kept = fsState(2, true);
  const k = simFighters(kept)[1];
  k.fsMeter = 50;
  koFighter(kept, k, 'left');
  runFs(kept, NONE, 70);
  return {
    name: 'am. the FS meter fills from damage dealt and taken only under the rule, and survives a KO',
    pass: Math.abs(on.atk - wantAtk) < 1e-9 && Math.abs(on.vic - wantVic) < 1e-9 && off.atk === 0 && off.vic === 0
      && k.action === 'respawn' && k.fsMeter === 50,
    detail: `rule on: attacker ${on.atk} (want ${wantAtk}) victim ${on.vic} (want ${wantVic}) | `
      + `rule off: ${off.atk} ${off.vic} | after KO ${k.action} meter ${k.fsMeter}`,
  };
}

function testFsActivation(): SelfTestResult {
  const on = fsState(2, true);
  const a = simFighters(on)[0];
  simFighters(on)[1].x = 60;
  a.fsMeter = FS_METER.max;
  const events = runFs(on, SPECIAL, 1);
  let start = false;
  for (let e = 0; e < events.length; e++) {
    const ev = events[e];
    if (ev.type === 'finalSmash' && ev.phase === 'start' && ev.attacker === 0) start = true;
  }

  const off = fsState(2, false);
  const b = simFighters(off)[0];
  simFighters(off)[1].x = 60;
  b.fsMeter = FS_METER.max;
  runFs(off, SPECIAL, 1);
  return {
    name: 'an. a full meter turns Special into the Final Smash and empties it; with the rule off Special stays a special',
    pass: a.action === 'finalSmash' && a.fsMeter === 0 && start
      && b.action === 'attack' && b.moveId === 'nspecial' && b.fsMeter === FS_METER.max,
    detail: `rule on: ${a.action} meter ${a.fsMeter} start event ${start} | rule off: ${b.action} ${b.moveId} meter ${b.fsMeter}`,
  };
}

function testFsTargetPick(): SelfTestResult {
  const state = fsState(3, true);
  const a = simFighters(state)[0];
  const behind = simFighters(state)[1];
  const ahead = simFighters(state)[2];
  behind.x = -20;
  ahead.x = 60;
  a.fsMeter = FS_METER.max;
  const fs = CHARACTER_DEFS['aeval'].finalSmash;
  const startup = fs === undefined ? 0 : fs.startup;
  runFs(state, SPECIAL, startup + 2);
  return {
    name: 'ao. the Final Smash catches the nearest opponent in front and ignores a closer one behind',
    pass: ahead.action === 'finalSmashVictim' && ahead.fsAttacker === 0 && a.fsVictim === 2
      && behind.action !== 'finalSmashVictim',
    detail: `ahead ${ahead.action} fsAttacker ${ahead.fsAttacker}, behind ${behind.action}, attacker fsVictim ${a.fsVictim}`,
  };
}

function testFsWhiff(): SelfTestResult {
  const state = fsState(2, true);
  const a = simFighters(state)[0];
  const v = simFighters(state)[1];
  v.x = -100;
  a.fsMeter = FS_METER.max;
  const fs = CHARACTER_DEFS['aeval'].finalSmash;
  const total = fs === undefined ? 0 : fs.totalFrames;
  let lastFsFrame = -1;
  const events = runFs(state, SPECIAL, total + 10, (i) => {
    if (a.action === 'finalSmash') lastFsFrame = i;
  });
  let launched = false;
  let hits = 0;
  for (let e = 0; e < events.length; e++) {
    const ev = events[e];
    if (ev.type === 'finalSmash' && ev.phase === 'launch') launched = true;
    if (ev.type === 'hit') hits++;
  }
  return {
    name: 'ap. a Final Smash with nobody in front whiffs, plays out and ends cleanly',
    pass: fs !== undefined && lastFsFrame === total - 1 && (a.action === 'idle' || a.action === 'land')
      && a.fsVictim === -1 && !launched && hits === 0 && v.percent === 0 && v.action !== 'finalSmashVictim',
    detail: `in finalSmash through step ${lastFsFrame} (want ${total - 1}), then ${a.action}, launch ${launched}, `
      + `hits ${hits}, victim ${v.action} ${v.percent}%`,
  };
}

function testFsDamageAndLaunch(): SelfTestResult {
  const state = fsState(2, true);
  const a = simFighters(state)[0];
  const v = simFighters(state)[1];
  v.x = 40;
  a.fsMeter = FS_METER.max;
  let launchPercent = -1;
  // Widened by hand: it is only assigned inside the callback, which narrowing cannot see.
  let afterLaunch = 'idle' as ActionId;
  let vyAfter = 0;
  const events = runFs(state, SPECIAL, 200, () => {
    if (launchPercent >= 0 || !sawEvent(state, 'finalSmash')) return;
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type !== 'finalSmash' || ev.phase !== 'launch') continue;
      launchPercent = v.percent;
      afterLaunch = v.action;
      vyAfter = v.vy;
    }
  });
  const phases: string[] = [];
  for (let e = 0; e < events.length; e++) {
    const ev = events[e];
    if (ev.type === 'finalSmash') phases.push(ev.phase);
  }
  const want = 45 * TUNING.knockback.damageMul;
  return {
    name: 'aq. the Final Smash victim takes 45 damage (times damageMul) and is launched',
    pass: Math.abs(launchPercent - want) < 1e-9 && (afterLaunch === 'tumble' || afterLaunch === 'hitstun')
      && vyAfter < 0 && phases.join(',') === 'start,tsunami,tornado,launch' && a.action !== 'finalSmash',
    detail: `percent at launch ${launchPercent} (want ${want}), then ${afterLaunch} vy ${vyAfter.toFixed(2)}, `
      + `events ${phases.join(',')}, attacker after ${a.action}`,
  };
}

/**
 * A third fighter parks a huge, long-lived test projectile over both sides of the Final
 * Smash and also jabs the attacker point blank; neither lands. The same projectile on two
 * fighters outside a Final Smash does land, so the block is the Final Smash's doing.
 */
const FS_BLOCK_DEF: ProjectileDef = {
  id: 'selftestFsBlock',
  spawnFrame: 0,
  x: 0, y: 0,
  vx: 0, vy: 0,
  gravity: 0,
  lifetime: 100,
  r: 200,
  damage: 5, angle: 0, bkb: 0, kbg: 0,
  strength: 0,
  destroyOnHit: false,
  sprite: 'orb',
};

function testFsThirdPartyBlocked(): SelfTestResult {
  PROJECTILE_DEFS[FS_BLOCK_DEF.id] = FS_BLOCK_DEF;
  const state = fsState(3, true);
  const a = simFighters(state)[0];
  const v = simFighters(state)[1];
  const third = simFighters(state)[2];
  v.x = 40;
  third.x = -30;
  third.facing = 1;
  a.fsMeter = FS_METER.max;
  const inputs: InputFrame[] = [SPECIAL, NONE, NONE];
  let thirdHits = 0;
  let vicPercentBeforeLaunch = -1;
  for (let i = 0; i < 150; i++) {
    inputs[0] = i === 0 ? SPECIAL : NONE;
    inputs[2] = i >= 25 && i % 20 === 5 ? inp(Btn.Attack, Btn.Attack) : NONE;
    if (i === 30) spawnProjectile(state, third, FS_BLOCK_DEF);
    stepGame(state, inputs);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'hit' && ev.attacker === third.slot) thirdHits++;
    }
    if (i === 149) vicPercentBeforeLaunch = v.percent;
  }
  // Every scripted Final Smash hit lands by frame 147, and nothing else may add to it.
  const wantVic = 35 * TUNING.knockback.damageMul;

  const control = fsState(2, false);
  simFighters(control)[1].x = 40;
  spawnProjectile(control, simFighters(control)[0], FS_BLOCK_DEF);
  runFs(control, NONE, 3);
  const controlHit = control.fighters[1].percent > 0;
  return {
    name: 'ar. a third fighter cannot hit the Final Smash attacker or victim',
    pass: a.action === 'finalSmash' && v.action === 'finalSmashVictim' && thirdHits === 0
      && a.percent === 0 && Math.abs(vicPercentBeforeLaunch - wantVic) < 1e-9 && controlHit,
    detail: `attacker ${a.action} ${a.percent}%, victim ${v.action} ${vicPercentBeforeLaunch}% (want ${wantVic}), `
      + `third-party hits ${thirdHits}, control projectile hit ${controlHit}`,
  };
}

function testFsAttackerKoFreesVictim(): SelfTestResult {
  const state = fsState(2, true);
  const a = simFighters(state)[0];
  const v = simFighters(state)[1];
  v.x = 40;
  a.fsMeter = FS_METER.max;
  runFs(state, SPECIAL, 40);
  const caught = v.action === 'finalSmashVictim';
  const yCaught = v.y;
  koFighter(state, a, 'top');
  const freedAt = v.action;
  runFs(state, NONE, 5);
  return {
    name: 'as. KO of the Final Smash attacker frees the victim at once',
    pass: caught && freedAt === 'air' && v.fsAttacker === -1 && a.fsVictim === -1
      && v.action !== 'finalSmashVictim' && canBeHit(v) && v.y > yCaught,
    detail: `caught ${caught}, right after KO ${freedAt}, 5 frames later ${v.action} canBeHit ${canBeHit(v)}, `
      + `fell ${(v.y - yCaught).toFixed(2)} px`,
  };
}

function testFootstoolLanding(): SelfTestResult {
  const state = footstoolSetup(0);
  const v = simFighters(state)[1];
  simFighters(state)[0].y = -49;
  v.y = -4;
  v.onGround = false;
  setAction(v, 'air');
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  const stooled = v.action === 'footstooled';
  const landed = v.onGround;
  let frames = 1;
  while (v.action === 'footstooled' && frames < 120) {
    step(state, NONE, NONE);
    frames++;
  }
  return {
    name: 'at. an airborne footstool victim that lands stays stunned for the whole air timer',
    pass: stooled && landed && frames === FOOTSTOOL.victimAir && v.action === 'idle',
    detail: `footstooled ${stooled}, landed on the first frame ${landed}, stunned ${frames} frames `
      + `(want ${FOOTSTOOL.victimAir}), then ${v.action}`,
  };
}

function testFsSkipsRespawn(): SelfTestResult {
  const state = fsState(3, true);
  const a = simFighters(state)[0];
  const r = simFighters(state)[1];
  const ahead = simFighters(state)[2];
  setAction(r, 'respawn');
  r.x = 30;
  r.y = 0;
  ahead.x = 80;
  a.fsMeter = FS_METER.max;
  const fs = CHARACTER_DEFS['aeval'].finalSmash;
  const startup = fs === undefined ? 0 : fs.startup;
  runFs(state, SPECIAL, startup + 2);
  return {
    name: 'au. the Final Smash skips a closer respawning fighter and catches the next one in front',
    pass: r.action === 'respawn' && r.fsAttacker === -1 && ahead.action === 'finalSmashVictim' && a.fsVictim === 2,
    detail: `respawning ${r.action} fsAttacker ${r.fsAttacker}, ahead ${ahead.action}, attacker fsVictim ${a.fsVictim}`,
  };
}

/**
 * Fighter 0 catches the victim with a grab hitbox on the very frame fighter 2's jab hitbox
 * covers it too. Both defs live only in this test and are removed afterwards.
 */
function testGrabHitboxBlocksLaterHit(): SelfTestResult {
  const base = CHARACTER_DEFS['aeval'];
  const grabJab: MoveDef = {
    id: 'jab', totalFrames: 18, groundOnly: true,
    hitboxes: [{ id: 1, start: 4, end: 6, x: 15, y: -18, r: 9, damage: 0, angle: 0, bkb: 0, kbg: 0, group: 1, grab: { force: true } }],
  };
  const hitJab: MoveDef = {
    id: 'jab', totalFrames: 18, groundOnly: true,
    hitboxes: [{ id: 1, start: 4, end: 4, x: 15, y: -18, r: 9, damage: 10, angle: 0, bkb: 0, kbg: 0, group: 1 }],
  };
  CHARACTER_DEFS['grabtest2'] = { ...base, id: 'grabtest2', moves: { ...base.moves, jab: grabJab } };
  CHARACTER_DEFS['hittest2'] = { ...base, id: 'hittest2', moves: { ...base.moves, jab: hitJab } };
  const run = (grab: boolean): { percent: number; action: ActionId } => {
    const config = matchConfig(1);
    config.players[0].charId = 'grabtest2';
    config.players.push({ slot: 2, charId: 'hittest2', cpu: false, cpuLevel: 0 });
    const state = createGameState(config);
    const trio: InputFrame[] = [NONE, NONE, NONE];
    for (let i = 0; i < 60; i++) stepGame(state, trio);
    const h = simFighters(state)[0];
    const v = simFighters(state)[1];
    const third = simFighters(state)[2];
    h.x = 0;
    h.facing = 1;
    v.x = 30;
    v.facing = -1;
    third.x = 60;
    third.facing = -1;
    const press = inp(Btn.Attack, Btn.Attack);
    stepGame(state, [grab ? press : NONE, NONE, press]);
    for (let i = 0; i < 10; i++) stepGame(state, trio);
    return { percent: v.percent, action: v.action };
  };
  try {
    const caught = run(true);
    const control = run(false);
    return {
      name: 'av. a victim caught by a grab hitbox cannot be hit by a later attacker on the same frame',
      pass: caught.action === 'grabbed' && caught.percent === 0 && control.percent > 0,
      detail: `with the grab: ${caught.action} ${caught.percent}% | jab alone: ${control.action} ${control.percent}%`,
    };
  } finally {
    delete CHARACTER_DEFS['grabtest2'];
    delete CHARACTER_DEFS['hittest2'];
  }
}

/** Fighter 0 tumbling out of hitstun 80 px above the main platform, fighter 1 parked far away. */
function tumbling(): GameState {
  const state = fresh(1, 60);
  const f = simFighters(state)[0];
  state.fighters[1].x = 150;
  f.x = 0;
  f.y = -80;
  f.vx = 0;
  f.vy = 0;
  f.onGround = false;
  f.hitstun = 0;
  setAction(f, 'tumble');
  return state;
}

function testTumbleAirDodge(): SelfTestResult {
  const dodged = tumbling();
  step(dodged, inp(Btn.Dodge, Btn.Dodge), NONE);
  const d = simFighters(dodged)[0];
  const byCmd = tumbling();
  step(byCmd, cmdInp('airDodge', 0, 0), NONE);
  const shielded = tumbling();
  step(shielded, inp(Btn.Shield, Btn.Shield), NONE);
  const s = simFighters(shielded)[0];
  return {
    name: 'aw. Dodge or the airDodge command air dodges out of tumble; Shield stays a tech press',
    pass: d.action === 'airDodge' && d.techLockout > 0 && byCmd.fighters[0].action === 'airDodge'
      && s.action === 'tumble' && s.techWindow > 0,
    detail: `Dodge ${d.action} lockout ${d.techLockout} | command ${byCmd.fighters[0].action} | `
      + `Shield ${s.action} window ${s.techWindow}`,
  };
}

function testRollStopsAtEdge(): SelfTestResult {
  let pass = true;
  const parts: string[] = [];
  for (let s = 0; s < STAGE_IDS.length; s++) {
    const id = STAGE_IDS[s];
    const edge = mainEdges(id).right;
    const state = fresh(1, 60, id);
    const f = simFighters(state)[0];
    state.fighters[1].x = edge - 330;
    // 20 px inside the main platform's right edge, read from the stage def.
    f.x = edge - 20;
    f.facing = 1;
    step(state, cmdInp('rollForward', 0, 0), NONE);
    const rolled = f.action === 'roll';
    let maxX = f.x;
    let leftGround = false;
    for (let i = 0; i < ROLL.total + 5; i++) {
      step(state, NONE, NONE);
      if (f.x > maxX) maxX = f.x;
      if (!f.onGround) leftGround = true;
    }
    if (!(rolled && !leftGround && maxX <= edge && f.action === 'idle')) pass = false;
    parts.push(`${id} edge ${edge}: rolled ${rolled}, left the ground ${leftGround}, furthest x ${maxX.toFixed(2)}, then ${f.action}`);
  }
  return {
    name: 'ax. a forward roll toward the edge stops at it instead of rolling off',
    pass,
    detail: parts.join(' | '),
  };
}

function testLowHitNeedsGroundedAttacker(): SelfTestResult {
  const state = fresh(1, 60);
  const v = simFighters(state)[1];
  v.highDodge = 2;
  const nearFeet = v.y - 8;
  const aerial = dodgesHit(v, nearFeet, undefined, 'nair', false);
  const grounded = dodgesHit(v, nearFeet, undefined, 'jab', true);
  const dtilt = dodgesHit(v, v.y - 30, undefined, 'dtilt', false);
  const flagged = dodgesHit(v, v.y - 30, true, 'nair', false);
  return {
    name: 'ay. a roll dodges an aerial near its feet but not the same height from the ground, dtilt or a low flag',
    pass: aerial && !grounded && !dtilt && !flagged,
    detail: `aerial near feet dodged ${aerial}, grounded near feet dodged ${grounded}, `
      + `dtilt dodged ${dtilt}, low flag dodged ${flagged}`,
  };
}

/** A direct move key pressed with `held` buttons down alongside it. */
function directHeldInp(id: DirectMoveId, held: number): InputFrame {
  return { held, pressed: 0, released: 0, direct: DIRECT_MOVES.indexOf(id) + 1 };
}

function testAirShortcutDirection(): SelfTestResult {
  const shortcut = (held: number): string => {
    const state = airborneState();
    step(state, directHeldInp('fsmash', held), NONE);
    const f = state.fighters[0];
    return f.moveId === null ? `none(${f.action})` : f.moveId;
  };
  const back = shortcut(Btn.Left);
  const forward = shortcut(Btn.Right);
  const still = shortcut(0);
  return {
    name: 'az. an air forward shortcut is a bair with back held and a fair otherwise',
    pass: back === 'bair' && forward === 'fair' && still === 'fair',
    detail: `facing right, fsmash key: held Left ${back}, held Right ${forward}, nothing held ${still}`,
  };
}

/** Shields for five frames, then presses `press` with `held` down alongside the shield. */
function shieldThenPress(press: number, held: number): GameState {
  const state = fresh(1, 60);
  step(state, inp(Btn.Shield, Btn.Shield), NONE);
  for (let i = 0; i < 4; i++) step(state, inp(Btn.Shield, 0), NONE);
  step(state, inp(Btn.Shield | held | press, press | held), NONE);
  return state;
}

function testShieldGrab(): SelfTestResult {
  const state = shieldThenPress(Btn.Attack, 0);
  const f = state.fighters[0];
  return {
    name: 'ba. Attack out of shield grabs',
    pass: f.action === 'grab' && f.moveId === null,
    detail: `action ${f.action}, moveId ${f.moveId === null ? 'null' : f.moveId}`,
  };
}

function testShieldUpSmash(): SelfTestResult {
  const state = shieldThenPress(Btn.Attack, Btn.Up);
  const f = state.fighters[0];
  return {
    name: 'bb. Up + Attack out of shield is an up smash',
    pass: f.action === 'attack' && f.moveId === 'usmash',
    detail: `action ${f.action}, moveId ${f.moveId === null ? 'null' : f.moveId}`,
  };
}

function testShieldUpSpecial(): SelfTestResult {
  const state = shieldThenPress(Btn.Special, Btn.Up);
  const f = state.fighters[0];
  return {
    name: 'bc. Up + Special out of shield is an up special',
    pass: f.action === 'attack' && f.moveId === 'uspecial',
    detail: `action ${f.action}, moveId ${f.moveId === null ? 'null' : f.moveId}`,
  };
}

function testShieldSpecialDropped(): SelfTestResult {
  const state = shieldThenPress(Btn.Special, 0);
  const f = state.fighters[0];
  return {
    name: 'bd. Special out of shield without Up is dropped and the shield holds',
    pass: f.action === 'shield' && f.moveId === null,
    detail: `action ${f.action}, moveId ${f.moveId === null ? 'null' : f.moveId}`,
  };
}

function testAirShieldAirDodges(): SelfTestResult {
  const drift = airborneState();
  step(drift, inp(Btn.Shield | Btn.Right, Btn.Shield), NONE);
  const d = drift.fighters[0];

  const still = airborneState();
  step(still, inp(Btn.Shield, Btn.Shield), NONE);
  const s = still.fighters[0];
  return {
    name: 'be. Shield in the air air dodges, drifting toward the held direction',
    pass: d.action === 'airDodge' && d.vx > 0 && s.action === 'airDodge' && s.vx === 0,
    detail: `held Right: ${d.action} vx ${d.vx.toFixed(2)} | nothing held: ${s.action} vx ${s.vx.toFixed(2)}`,
  };
}

function testTumbleShieldStillTechs(): SelfTestResult {
  const state = tumbling();
  step(state, inp(Btn.Shield, Btn.Shield), NONE);
  const f = simFighters(state)[0];
  return {
    name: 'bf. Shield in tumble stays a tech press and does not air dodge',
    pass: f.action === 'tumble' && f.techWindow > 0,
    detail: `action ${f.action}, tech window ${f.techWindow}`,
  };
}

function testJumpCancelUpSmash(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  const squat = f.action;
  const press = Btn.Up | Btn.Attack;
  step(state, inp(Btn.Jump | press, press), NONE);
  return {
    name: 'bg. Up + Attack in jumpsquat jump-cancels into a grounded up smash',
    pass: squat === 'jumpsquat' && f.action === 'attack' && f.moveId === 'usmash' && f.onGround,
    detail: `after Jump ${squat}, then ${f.action} ${f.moveId === null ? 'null' : f.moveId}, onGround ${f.onGround}`,
  };
}

function testJumpCancelShortcut(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  const squat = f.action;
  step(state, directHeldInp('uspecial', Btn.Jump), NONE);
  return {
    // Only the up smash and up special shortcuts jump-cancel; bm covers the rest staying buffered.
    name: 'bh. an up special shortcut in jumpsquat cancels the jump into its ground move',
    pass: squat === 'jumpsquat' && f.action === 'attack' && f.moveId === 'uspecial' && f.onGround,
    detail: `after Jump ${squat}, then ${f.action} ${f.moveId === null ? 'null' : f.moveId}, onGround ${f.onGround}`,
  };
}

function testShortcutReplacesFreshAttack(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  step(state, inp(Btn.Attack, Btn.Attack), NONE);
  const started = f.moveId;
  step(state, directInp('fsmash'), NONE);
  const replaced = f.moveId;
  const frame = f.actionFrame;
  return {
    name: 'bi. a shortcut one frame after a button attack replaces it',
    pass: started === 'jab' && replaced === 'fsmash' && frame === 0,
    detail: `Attack started ${started === null ? 'null' : started}, the fsmash key gave `
      + `${replaced === null ? 'null' : replaced} on actionFrame ${frame}`,
  };
}

function testShortcutTooLateToReplace(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  const at = SHORTCUT_REPLACE_FRAMES + 3;
  step(state, inp(Btn.Attack, Btn.Attack), NONE);
  for (let i = 1; i < at; i++) step(state, NONE, NONE);
  step(state, directInp('fsmash'), NONE);
  const move = f.moveId;
  const frame = f.actionFrame;
  return {
    name: 'bj. a shortcut past the replace window leaves the attack alone',
    pass: move === 'jab' && frame === at,
    detail: `the fsmash key on jab frame ${frame} (want ${at}) left ${move === null ? 'null' : move}`,
  };
}

function testRollMatchesConstants(): SelfTestResult {
  const state = fresh(1, 60);
  const f = simFighters(state)[0];
  state.fighters[1].x = -150;
  // Mid-stage, so the platform edge never cuts the roll short.
  f.x = 0;
  // Tap Right, wait four frames, tap Right again: the second press rolls.
  step(state, inp(Btn.Right, Btn.Right), NONE);
  for (let i = 0; i < 4; i++) step(state, NONE, NONE);
  const startX = f.x;

  const dodge: number[] = [];
  let frames = 0;
  step(state, inp(Btn.Right, Btn.Right), NONE);
  const rolled = f.action === 'roll';
  while (f.action === 'roll' && frames < 120) {
    dodge[f.actionFrame] = f.highDodge;
    frames++;
    step(state, NONE, NONE);
  }
  const traveled = f.x - startX;

  let dodgingThroughout = true;
  for (let i = ROLL.invStart; i <= ROLL.invEnd; i++) {
    if (!(dodge[i] > 0)) dodgingThroughout = false;
  }
  const beforeWindow = dodge[ROLL.invStart - 1];
  return {
    name: 'bk. the roll runs for ROLL.total frames, dodges across its window and covers ROLL.distance',
    pass: rolled && frames === ROLL.total && dodgingThroughout && beforeWindow === 0
      && Math.abs(traveled - ROLL.distance) <= 3,
    detail: `rolled for ${frames} frames (want ${ROLL.total}), highDodge on frame ${ROLL.invStart - 1} `
      + `${beforeWindow}, dodging every frame ${ROLL.invStart} to ${ROLL.invEnd} ${dodgingThroughout}, `
      + `travelled ${traveled.toFixed(2)} px (want ${ROLL.distance})`,
  };
}

/**
 * Walking is a tilted stick, not a flicked one, so a direction flick with the Walk modifier
 * down can never be a smash. The control repeats the forward case without Walk, where the
 * same flick still smashes.
 */
function testWalkNeverSmashes(): SelfTestResult {
  const fwd = fresh(1, 60);
  const side = Btn.Walk | Btn.Right | Btn.Attack;
  step(fwd, inp(side, Btn.Right | Btn.Attack), NONE);
  const tilt = fwd.fighters[0].moveId;

  const control = fresh(1, 60);
  const flick = Btn.Right | Btn.Attack;
  step(control, inp(flick, flick), NONE);
  const smash = control.fighters[0].moveId;

  const up = fresh(1, 60);
  const rise = Btn.Walk | Btn.Up | Btn.Attack;
  step(up, inp(rise, Btn.Up | Btn.Attack), NONE);
  const upTilt = up.fighters[0].moveId;
  return {
    name: 'bl. Walk held turns a direction flick plus Attack into a tilt',
    pass: tilt === 'ftilt' && upTilt === 'utilt' && smash === 'fsmash',
    detail: `Walk+Right flick+Attack ${tilt === null ? 'null' : tilt}, `
      + `Walk+Up+Attack ${upTilt === null ? 'null' : upTilt}, `
      + `without Walk ${smash === null ? 'null' : smash}`,
  };
}

function testJumpsquatForwardShortcutBuffers(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  step(state, directHeldInp('fsmash', Btn.Jump), NONE);
  const stillSquat = f.action;
  let airborneAfter = -1;
  for (let i = 0; i < 10 && airborneAfter < 0; i++) {
    step(state, inp(Btn.Jump, 0), NONE);
    if (!f.onGround) airborneAfter = i + 1;
  }
  let move = 'none';
  let cameOut = -1;
  for (let i = 0; i < TUNING.input.buffer && cameOut < 0; i++) {
    step(state, inp(Btn.Jump, 0), NONE);
    if (f.moveId !== null) {
      move = f.moveId;
      cameOut = i;
    }
  }
  return {
    name: 'bm. a forward shortcut in jumpsquat stays buffered and comes out as a fair',
    pass: stillSquat === 'jumpsquat' && airborneAfter > 0 && move === 'fair' && !f.onGround,
    detail: `the frame of the shortcut ${stillSquat}, airborne ${airborneAfter} frames later, `
      + `then ${move} on buffered frame ${cameOut} (buffer ${TUNING.input.buffer})`,
  };
}

function testJumpsquatUpSmashCancels(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  const squat = f.action;
  step(state, directHeldInp('usmash', Btn.Jump), NONE);
  return {
    name: 'bn. an up smash shortcut in jumpsquat still cancels into a grounded up smash',
    pass: squat === 'jumpsquat' && f.action === 'attack' && f.moveId === 'usmash' && f.onGround,
    detail: `after Jump ${squat}, then ${f.action} ${f.moveId === null ? 'null' : f.moveId}, onGround ${f.onGround}`,
  };
}

/**
 * The F&W up smash has no Attack key in it, so the charge rides the direction the smash was
 * aimed at instead: Up holds it and letting Up go fires it.
 */
function testShortcutSmashCharges(): SelfTestResult {
  const state = fresh(1, 60);
  const f = simFighters(state)[0];
  step(state, directHeldInp('usmash', Btn.Up), NONE);
  const started = f.moveId === 'usmash' && f.charging;
  for (let i = 0; i < 30; i++) step(state, inp(Btn.Up, 0), NONE);
  const charge = f.charge;
  const heldCharging = f.charging;
  let stopped = -1;
  for (let i = 0; i < 2 && stopped < 0; i++) {
    step(state, NONE, NONE);
    if (!f.charging) stopped = i;
  }
  return {
    name: 'bo. an up smash started without Attack charges while Up is held',
    pass: started && heldCharging && charge === 30 && stopped >= 0,
    detail: `started charging ${started}, charge after 30 held frames ${charge} (still charging ${heldCharging}), `
      + `charging stopped ${stopped} frames after Up was released`,
  };
}

/** The other half of the rule: a flick smash charges on Attack alone, direction or no direction. */
function testFlickSmashChargeNeedsAttack(): SelfTestResult {
  const state = fresh(1, 60);
  const f = simFighters(state)[0];
  const smash = Btn.Right | Btn.Attack;
  step(state, inp(smash, smash), NONE);
  const started = f.moveId === 'fsmash' && f.charging;
  for (let i = 0; i < 10; i++) step(state, inp(smash, 0), NONE);
  const charge = f.charge;
  let stopped = -1;
  for (let i = 0; i < 2 && stopped < 0; i++) {
    step(state, inp(Btn.Right, 0), NONE);
    if (!f.charging) stopped = i;
  }
  return {
    name: 'bp. a flick forward smash stops charging when Attack is released even with the direction held',
    pass: started && charge === 10 && stopped >= 0,
    detail: `started charging ${started}, charge after 10 held frames ${charge}, `
      + `charging stopped ${stopped} frames after Attack was released with Right still down`,
  };
}

function testShieldDecaysWhileMashingSpecial(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  step(state, inp(Btn.Shield, Btn.Shield), NONE);
  const start = f.shieldHp;
  for (let i = 0; i < 20; i++) {
    const press = i % 2 === 0 ? Btn.Special : 0;
    step(state, inp(Btn.Shield | press, press), NONE);
  }
  const dropped = start - f.shieldHp;
  const want = 20 * SHIELD_DECAY;
  return {
    name: 'bq. shield decay keeps running while Special is mashed',
    pass: f.action === 'shield' && Math.abs(dropped - want) < 0.5,
    detail: `shield fell ${dropped.toFixed(2)} over 20 mashed frames (want ${want.toFixed(2)}), action ${f.action}`,
  };
}

function testGroundedUpSpecialRises(): SelfTestResult {
  const state = fresh(1, 60);
  const f = state.fighters[0];
  const floorY = f.y;
  const grounded = f.onGround;
  step(state, inp(Btn.Special | Btn.Up, Btn.Special), NONE);
  const started = f.action === 'attack' && f.moveId === 'uspecial';
  let guard = 0;
  while (f.action === 'attack' && f.moveId === 'uspecial' && f.actionFrame < 20 && guard < 40) {
    step(state, NONE, NONE);
    guard++;
  }
  const rise = floorY - f.y;
  return {
    name: 'bs. a grounded up special leaves the floor and rises at least 40 px by action frame 20',
    pass: grounded && started && f.actionFrame === 20 && rise >= 40 && !f.onGround,
    detail: `started ${started}, action ${f.action} frame ${f.actionFrame}, heel ${rise.toFixed(1)} px above the floor, `
      + `onGround ${f.onGround}`,
  };
}

function testCloneCopiesChargeMaskAndRule(): SelfTestResult {
  const state = fresh(1, 60);
  const f = simFighters(state)[0];
  const smash = Btn.Right | Btn.Attack;
  step(state, inp(smash, smash), NONE);
  const copy = simFighters(cloneGameState(state))[0];
  const maskOk = f.chargeMask !== 0 && copy.chargeMask === f.chargeMask;

  const config = matchConfig(1);
  config.cpuZeroMoves = true;
  const ruled = createGameState(config);
  const ruleOk = cloneGameState(ruled).config.cpuZeroMoves === true;
  return {
    name: 'br. cloneGameState copies chargeMask and the cpuZeroMoves rule',
    pass: maskOk && ruleOk,
    detail: `chargeMask ${f.chargeMask} cloned as ${copy.chargeMask}, cpuZeroMoves cloned ${ruleOk}`,
  };
}

/**
 * The airJumped flag marks only a real mid-air jump: never the ground jump's
 * rise or fall, never the return to 'air' after an aerial, and it survives a clone.
 */
function testAirJumpFlag(): SelfTestResult {
  const state = airborneState();
  const f = state.fighters[0];
  let plainAir = false;
  for (let i = 0; i < 40 && !f.onGround; i++) {
    if (f.airJumped) plainAir = true;
    step(state, NONE, NONE);
  }
  const fallClean = !plainAir;

  const aerial = airborneState();
  const a = aerial.fighters[0];
  step(aerial, inp(Btn.Attack, Btn.Attack), NONE);
  const startedAerial = a.action === 'attack';
  let afterAerial = false;
  for (let i = 0; i < 60 && a.action === 'attack'; i++) step(aerial, NONE, NONE);
  const backInAir = a.action === 'air';
  for (let i = 0; i < 5 && a.action === 'air'; i++) {
    if (a.airJumped) afterAerial = true;
    step(aerial, NONE, NONE);
  }

  const dj = airborneState();
  const d = dj.fighters[0];
  const jumpsBefore = d.jumpsLeft;
  step(dj, inp(Btn.Jump, Btn.Jump), NONE);
  const setOk = d.action === 'air' && d.airJumped && d.actionFrame === 0 && d.jumpsLeft === jumpsBefore - 1;
  step(dj, NONE, NONE);
  const cloned = cloneGameState(dj).fighters[0].airJumped === true;
  step(dj, inp(Btn.Attack, Btn.Attack), NONE);
  const clearedByAerial = d.action === 'attack' && !d.airJumped;
  return {
    name: 'bt. airJumped is set only by a mid-air jump, not by a plain fall or the air after an aerial',
    pass: fallClean && startedAerial && backInAir && !afterAerial && setOk && cloned && clearedByAerial,
    detail: `plain hop flagged ${plainAir} | aerial ${startedAerial}, back in air ${backInAir}, flagged after ${afterAerial} | `
      + `double jump: ${d.action} set ${setOk}, cloned ${cloned}, cleared by aerial ${clearedByAerial}`,
  };
}

/**
 * Results stats: a scripted 1-stock match. P1 jabs P2 (thrust plus bead, the bead lands
 * in hitstun, so a 2-hit combo), then fsmashes P2 at 999 percent for the KO. A second
 * match checks a KO with no hitter is a self-destruct. Clones must carry the stats.
 */
function testResultsStats(): SelfTestResult {
  const cfg = matchConfig(3);
  cfg.stocks = 1;
  const state = createGameState(cfg);
  settle(state, 10);
  state.fighters[0].x = -30;
  state.fighters[1].x = 0;
  step(state, inp(Btn.Attack, Btn.Attack), NONE);
  settle(state, 40);
  const a = state.fighters[0].stats;
  const b = state.fighters[1].stats;
  const comboOk = a.maxCombo >= 2 && a.totalHits >= 2 && b.hitsTaken === a.totalHits;
  const dmgOk = Math.abs(a.damageGiven - 5) < 1e-9 && Math.abs(b.damageTaken - a.damageGiven) < 1e-9;
  const jabbed = (a.mostUsedMove.jab ?? 0) === 1;

  const mid = cloneGameState(state);
  const cloneOk = JSON.stringify(mid.fighters.map((f) => f.stats)) === JSON.stringify(state.fighters.map((f) => f.stats));
  mid.fighters[0].stats.mostUsedMove.jab = 99;
  const deepOk = a.mostUsedMove.jab === 1;

  settle(state, 20);
  state.fighters[0].x = -30;
  state.fighters[1].x = 0;
  state.fighters[1].percent = 999;
  const smash = Btn.Right | Btn.Attack;
  step(state, inp(smash, smash), NONE);
  settle(state, 120);
  const koOk = a.kos === 1 && b.falls === 1 && b.sds === 0 && a.falls === 0 && a.firstBloodFrame > 0;
  const endOk = state.finished && state.endFrame > 0 && state.endFrame < state.frame;
  const peakOk = b.peakDamage === 999;

  const sd = createGameState(cfg);
  settle(sd, 10);
  sd.fighters[1].x = 100000;
  settle(sd, 5);
  const sdOk = sd.fighters[1].stats.sds === 1 && sd.fighters[1].stats.falls === 1 && sd.fighters[0].stats.kos === 0;

  const pass = comboOk && dmgOk && jabbed && cloneOk && deepOk && koOk && endOk && peakOk && sdOk;
  return {
    name: 'results stats: damage, combo, KO credit, SD, clone',
    pass,
    detail: `combo ${a.maxCombo} hits ${a.totalHits}/${b.hitsTaken} dmg ${a.damageGiven}/${b.damageTaken} ` +
      `jab ${jabbed} clone ${cloneOk}/${deepOk} kos ${a.kos} falls ${b.falls} sds ${b.sds} ` +
      `firstKO ${a.firstBloodFrame} end ${state.endFrame} peak ${b.peakDamage} sd ${sdOk}`,
  };
}

/**
 * Teams rule: slots 0 and 1 share team 0, slot 2 is alone. A teammate's jab lands nothing,
 * and KOing the solo player out of stocks ends the match with team 0 winning.
 */
function teamJab(teams: boolean): GameState {
  const config = matchConfig(1);
  config.players[0].team = 0;
  config.players[1].team = 0;
  config.players.push({ slot: 2, charId: 'aeval', cpu: false, cpuLevel: 0, team: 2 });
  config.teams = teams;
  const state = createGameState(config);
  const idle: InputFrame[] = [NONE, NONE, NONE];
  for (let i = 0; i < 10; i++) stepGame(state, idle);
  const fighters = simFighters(state);
  fighters[0].x = -30;
  fighters[0].facing = 1;
  fighters[1].x = 0;
  fighters[2].x = 120;
  stepGame(state, [inp(Btn.Attack, Btn.Attack), NONE, NONE]);
  for (let i = 0; i < 40; i++) stepGame(state, idle);
  return state;
}

function testTeams(): SelfTestResult {
  // Control: with the rule off the same shared colour is cosmetic and the jab lands.
  const offDamage = teamJab(false).fighters[1].percent;
  const state = teamJab(true);
  const idle: InputFrame[] = [NONE, NONE, NONE];
  const fighters = simFighters(state);
  const mateDamage = fighters[1].percent;
  const mateStun = fighters[1].action === 'hitstun' || fighters[1].action === 'tumble';
  const midFinished = state.finished;

  const solo = fighters[2];
  let guard = 0;
  while (solo.stocks > 0 && guard < 10) {
    koFighter(state, solo, 'left');
    guard++;
  }
  stepGame(state, idle);
  const winnerOnTeam = state.winner === 0 || state.winner === 1;
  return {
    name: 'teams: no friendly fire, last team standing wins',
    pass: offDamage > 0 && mateDamage === 0 && !mateStun && !midFinished && state.finished && winnerOnTeam
      && state.winnerTeam === 0,
    detail: `rule off percent ${offDamage}, teammate percent ${mateDamage}, stunned ${mateStun}, finished ${state.finished}, ` +
      `winner ${state.winner}, winnerTeam ${String(state.winnerTeam)}`,
  };
}

/**
 * Teams rule at time out, 2v2 (slots 0 and 1 on team 0, slots 2 and 3 on team 1) with both
 * sides still in: the side with more stocks in total wins, equal stocks go to the lower summed
 * percent, and equal stocks with equal percent is a draw (winnerTeam -1, winner -1).
 */
function teamsTimeOut(stocks: number[], percent: number[]): { state: GameState; endedAt: number } {
  const config = matchConfig(1);
  config.players.push({ slot: 2, charId: 'aeval', cpu: false, cpuLevel: 0 });
  config.players.push({ slot: 3, charId: 'aeval', cpu: false, cpuLevel: 0 });
  for (let i = 0; i < 4; i++) config.players[i].team = i < 2 ? 0 : 1;
  config.teams = true;
  config.timeLimitSec = 1;
  const state = createGameState(config);
  const idle: InputFrame[] = [NONE, NONE, NONE, NONE];
  for (let i = 0; i < 10; i++) stepGame(state, idle);
  const fighters = simFighters(state);
  for (let i = 0; i < 4; i++) {
    fighters[i].stocks = stocks[i];
    fighters[i].percent = percent[i];
  }
  let endedAt = -1;
  for (let i = 0; i < 120 && !state.finished; i++) {
    stepGame(state, idle);
    if (state.finished) endedAt = state.frame;
  }
  return { state, endedAt };
}

function testTeamsTimeOut(): SelfTestResult {
  // More stocks beats lower percent: team 0 has 4 stocks at 30%, team 1 has 3 at 0%.
  const byStocks = teamsTimeOut([3, 1, 2, 1], [10, 20, 0, 0]);
  // Equal stocks (4 each): team 0 sums 90%, team 1 sums 100%, so team 0 wins.
  const byPercent0 = teamsTimeOut([2, 2, 3, 1], [50, 40, 30, 70]);
  // Mirror: team 0 sums 110%, team 1 100%, so team 1 wins with its 3 stock member as winner.
  const byPercent1 = teamsTimeOut([2, 2, 3, 1], [60, 50, 30, 70]);
  // Equal stocks and equal summed percent (70 each) at time out: a draw.
  const draw = teamsTimeOut([2, 2, 2, 2], [30, 40, 50, 20]);
  const all = [byStocks, byPercent0, byPercent1, draw];
  let byTime = true;
  let bothIn = true;
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (!r.state.finished || r.state.timeLeft !== 0) byTime = false;
    const f = simFighters(r.state);
    if (!((f[0].stocks > 0 || f[1].stocks > 0) && (f[2].stocks > 0 || f[3].stocks > 0))) bothIn = false;
  }
  const show = (r: { state: GameState; endedAt: number }): string =>
    `team ${String(r.state.winnerTeam)} winner ${r.state.winner} at ${r.endedAt}`;
  return {
    name: 'teams: 2v2 time out goes to more stocks, then lower summed percent, else a draw',
    pass: byTime && bothIn
      && byStocks.state.winnerTeam === 0 && byStocks.state.winner === 0
      && byPercent0.state.winnerTeam === 0 && (byPercent0.state.winner === 0 || byPercent0.state.winner === 1)
      && byPercent1.state.winnerTeam === 1 && byPercent1.state.winner === 2
      && draw.state.winnerTeam === -1 && draw.state.winner === -1,
    detail: `byTime ${byTime} bothIn ${bothIn} | stocks: ${show(byStocks)} | percent 90 v 100: ${show(byPercent0)} | ` +
      `percent 110 v 100: ${show(byPercent1)} | 70 v 70: ${show(draw)}`,
  };
}

/** Two humans on one team (slots 0 and 1) under the Teams rule, settled on the stage. */
function teamPair(teams: boolean): GameState {
  const config = matchConfig(1);
  config.players[0].team = 0;
  config.players[1].team = 0;
  config.teams = teams;
  const state = createGameState(config);
  settle(state, 60);
  return state;
}

function testTeamsContact(): SelfTestResult {
  // Grab: a teammate cannot be caught, even by a force grab; with the rule off it can.
  const g = teamPair(true);
  const [g0, g1] = simFighters(g);
  g0.x = -10;
  g1.x = 10;
  const grabOn = canBeGrabbed(g, g0, g1, false) || forceGrab(g, g0, g1, { force: true });
  const gOff = teamPair(false);
  const grabOff = canBeGrabbed(gOff, simFighters(gOff)[0], simFighters(gOff)[1], false);
  // A real standing grab input on a teammate in reach whiffs; the same input with the rule off catches.
  const standGrab = (teams: boolean): boolean => {
    const s = teamPair(teams);
    const [h, v] = simFighters(s);
    h.x = 0;
    h.facing = 1;
    v.x = 30;
    v.facing = -1;
    return pressGrab(s, NONE, NONE, 12) || v.action === 'grabbed';
  };
  const standOn = standGrab(true);
  const standOff = standGrab(false);

  // Footstool: Jump over a teammate's head is a plain double jump; the same setup with the
  // rule off footstools, so the negative case is not passing on a bad setup.
  const footstool = (teams: boolean): boolean => {
    const f = teamPair(teams);
    const j = simFighters(f)[0];
    const v = simFighters(f)[1];
    v.x = 0;
    j.x = 0;
    j.y = -45;
    j.vx = 0;
    j.vy = 0;
    j.onGround = false;
    j.jumpsLeft = 1;
    setAction(j, 'air');
    step(f, inp(Btn.Jump, Btn.Jump), NONE);
    return v.action === 'footstooled' || sawEvent(f, 'footstool');
  };
  const stooled = footstool(true);
  const stooledOff = footstool(false);

  // Final Smash: the teammate in front and closer is skipped for the opponent further out.
  const config = matchConfig(1);
  config.players[0].team = 0;
  config.players[1].team = 0;
  config.players.push({ slot: 2, charId: 'aeval', cpu: false, cpuLevel: 0, team: 2 });
  config.finalSmash = true;
  config.teams = true;
  const fsGame = createGameState(config);
  const idle: InputFrame[] = [NONE, NONE, NONE];
  for (let i = 0; i < 60; i++) stepGame(fsGame, idle);
  const [a, mate, foe] = simFighters(fsGame);
  a.x = 0;
  a.facing = 1;
  mate.x = 30;
  foe.x = 60;
  a.fsMeter = FS_METER.max;
  const fs = CHARACTER_DEFS['aeval'].finalSmash;
  runFs(fsGame, SPECIAL, (fs === undefined ? 0 : fs.startup) + 2);
  const fsOk = a.fsVictim === 2 && foe.action === 'finalSmashVictim' && mate.action !== 'finalSmashVictim'
    && mate.percent === 0;
  return {
    name: 'teams: no grab, footstool or Final Smash catch on a teammate',
    pass: !grabOn && grabOff && !standOn && standOff && !stooled && stooledOff && fsOk,
    detail: `grab on ${grabOn} off ${grabOff} | standing grab on ${standOn} off ${standOff} | `
      + `footstooled on ${stooled} off ${stooledOff} | FS victim ${a.fsVictim}, `
      + `foe ${foe.action}, mate ${mate.action} ${mate.percent}%`,
  };
}

/**
 * A fighter that drops, with no input, onto a main-stage corner stands when its centre is over
 * the top (on or inside the edge) and slides off when only its hurtbox clips the corner with the
 * centre past the edge; it never hovers at the top in 'air'. Before the fix a drop 1 to 12 px
 * past either edge hovered at y = 0 forever.
 */
function testCornerLanding(): SelfTestResult {
  const drop = (stageId: string, edge: 'left' | 'right', dx: number): { x: number; y: number; action: ActionId; onGround: boolean; hover: number } => {
    const state = fresh(1, 60, stageId);
    const f = simFighters(state)[0];
    const edges = mainEdges(stageId);
    f.x = edge === 'right' ? edges.right + dx : edges.left - dx;
    f.y = -40;
    f.vx = 0;
    f.vy = 0;
    f.onGround = false;
    setAction(f, 'air');
    let run = 0;
    let hover = 0;
    for (let i = 0; i < 120; i++) {
      step(state, NONE, NONE);
      run = !f.onGround && Math.abs(f.y) <= 0.5 ? run + 1 : 0;
      if (run > hover) hover = run;
    }
    return { x: f.x, y: f.y, action: f.action, onGround: f.onGround, hover };
  };
  const parts: string[] = [];
  let ok = true;
  for (const stageId of STAGE_IDS) {
    for (const edge of ['left', 'right'] as const) {
      for (const dx of [-4, 0]) {
        const r = drop(stageId, edge, dx);
        if (!(r.onGround && r.y === 0 && r.action === 'idle')) ok = false;
        parts.push(`${stageId} ${edge} ${dx}: ${r.action} y ${r.y.toFixed(1)} ground ${r.onGround}`);
      }
      for (const dx of [1, 5, 10, 12.9]) {
        const r = drop(stageId, edge, dx);
        // Slid off: never more than 2 frames in a row airborne at the top, and not standing out there.
        if (r.hover > 2 || (r.onGround && r.y === 0)) ok = false;
        parts.push(`${stageId} ${edge} ${dx}: ${r.action} y ${r.y.toFixed(1)} hover ${r.hover}`);
      }
    }
  }
  return {
    name: 'bu. a zero-input fighter dropped on a main-stage corner stands with its centre over the top, otherwise slides off, never hovers',
    pass: ok,
    detail: parts.join(' | '),
  };
}

/**
 * The forward normals reach the tip of the water drawn on their active frames: 80 px for
 * ftilt (ground_spikeMed_2), 102 px for dashatk and fsmash (ground_sweepF_2). The victim's
 * near hurtbox edge is held `edgeGap` px ahead of the attacker's feet every frame, so the
 * dash attack's slide cannot close the gap. Reports whether the move dealt any damage.
 */
function forwardReachHits(move: MoveId, edgeGap: number): boolean {
  const state = fresh(1, 60);
  const atk = simFighters(state)[0];
  const vic = simFighters(state)[1];
  atk.x = -80;
  atk.facing = 1;
  const half = CHARACTER_DEFS['aeval'].hurtbox.w / 2;
  startMove(state, atk, CHARACTER_DEFS['aeval'], move);
  for (let i = 0; i < 80 && atk.action === 'attack'; i++) {
    vic.x = atk.x + edgeGap + half;
    vic.vx = 0;
    step(state, NONE, NONE);
    if (vic.percent > 0) return true;
  }
  return false;
}

function testForwardReach(): SelfTestResult {
  const cases: { move: MoveId; tip: number }[] = [
    { move: 'ftilt', tip: 80 },
    { move: 'dashatk', tip: 102 },
    { move: 'fsmash', tip: 102 },
  ];
  let pass = true;
  const parts: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const atTip = forwardReachHits(c.move, c.tip - 1);
    const past = forwardReachHits(c.move, c.tip + 10);
    if (!atTip || past) pass = false;
    parts.push(`${c.move} at ${c.tip - 1} px ${atTip}, at ${c.tip + 10} px ${past}`);
  }
  return {
    name: 'bv. ftilt, dashatk and fsmash connect at the drawn tip and whiff 10 px past it',
    pass,
    detail: parts.join(' | '),
  };
}

/**
 * One orb thrown after holding special for `holdFrames`, from x -120 with the other fighter
 * behind, followed to its death. Frames are counted from the release step.
 */
function orbFlight(holdFrames: number): { spawnFrame: number; moveEnd: number; vx: number; travel: number; life: number } {
  const state = createGameState(matchConfig(7));
  const me = simFighters(state)[0];
  for (let i = 0; i < 40; i++) step(state, NONE, NONE);
  me.x = -120;
  me.facing = 1;
  state.fighters[1].x = -220;
  step(state, inp(Btn.Special, Btn.Special), NONE);
  for (let i = 0; i < holdFrames; i++) step(state, inp(Btn.Special, 0), NONE);
  let spawnFrame = -1;
  let moveEnd = -1;
  let spawnX = 0;
  let vx = 0;
  let travel = 0;
  let life = -1;
  for (let i = 0; i < 160 && life < 0; i++) {
    step(state, NONE, NONE);
    if (moveEnd < 0 && me.action !== 'attack') moveEnd = i;
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'projectileSpawn' && ev.defId === 'orb' && spawnFrame < 0) {
        spawnFrame = i;
        spawnX = ev.x;
      }
      if (ev.type === 'projectileDie' && ev.defId === 'orb' && spawnFrame >= 0 && life < 0) {
        travel = ev.x - spawnX;
        life = i - spawnFrame;
      }
    }
    for (let p = 0; p < state.projectiles.length; p++) {
      const pr = state.projectiles[p];
      if (pr.alive && pr.defId === 'orb') vx = pr.vx;
    }
  }
  return { spawnFrame, moveEnd, vx, travel, life };
}

function testChargedOrbFlight(): SelfTestResult {
  const tap = orbFlight(0);
  const full = orbFlight(60);
  // Tap: 3.5 px/frame for 48 frames. Full: 9.5 px/frame for 34 frames, 16 frames later.
  const later = full.spawnFrame === tap.spawnFrame + 16 && full.moveEnd === tap.moveEnd + 16;
  const faster = Math.abs(tap.vx - 3.5) < 1e-9 && Math.abs(full.vx - 9.5) < 1e-9;
  const further = Math.abs(tap.travel - 3.5 * 48) < 1e-6 && Math.abs(full.travel - 9.5 * 34) < 1e-6;
  return {
    name: 'bw. a full-charge orb spawns later, flies faster and further than a tap',
    pass: later && faster && further && full.travel > tap.travel,
    detail: `tap: spawn ${tap.spawnFrame} move end ${tap.moveEnd} vx ${tap.vx} travel ${tap.travel.toFixed(1)} life ${tap.life} | `
      + `full: spawn ${full.spawnFrame} move end ${full.moveEnd} vx ${full.vx} travel ${full.travel.toFixed(1)} life ${full.life}`,
  };
}

/**
 * The crescent turns on age 57 at 3.2 px/frame, 182.4 px past where it spawned, and dies at
 * age 146, 89 frames later, 102.4 px behind its spawn point (82.4 behind a thrower who had
 * not moved).
 */
function testCrescentFlight(): SelfTestResult {
  const state = fresh(1, 60);
  const me = simFighters(state)[0];
  me.x = -60;
  me.facing = 1;
  state.fighters[1].x = mainEdges('tidegate').right - 13;   // parked on the far edge, out of the crescent's path
  startMove(state, me, CHARACTER_DEFS['aeval'], 'sspecial');
  let spawnX = 0;
  let spawned = false;
  let maxOut = 0;
  let turnAge = -1;
  let deathOffset = 0;
  let deathAge = -1;
  let lastAge = 0;
  for (let i = 0; i < 200 && deathAge < 0; i++) {
    step(state, NONE, NONE);
    for (let p = 0; p < state.projectiles.length; p++) {
      const pr = state.projectiles[p];
      if (pr.defId !== 'crescent' || !pr.alive) continue;
      if (turnAge < 0 && pr.returned) turnAge = pr.age - 1;   // flipped before this step's age++
      if (spawned && pr.x - spawnX > maxOut) maxOut = pr.x - spawnX;
      lastAge = pr.age;
    }
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'projectileSpawn' && ev.defId === 'crescent') {
        spawned = true;
        spawnX = ev.x;
      }
      if (ev.type === 'projectileDie' && ev.defId === 'crescent') {
        deathOffset = ev.x - spawnX;
        deathAge = lastAge + 1;
      }
    }
  }
  const turned = turnAge === 57 && Math.abs(maxOut - 182.4) < 1e-6;
  const died = deathAge === 146 && Math.abs(deathOffset + 102.4) < 1e-6;
  return {
    name: 'bx. the crescent turns on age 57, 182.4 px out, and dies at age 146, 102.4 px behind its spawn',
    pass: turned && died,
    detail: `turned on age ${turnAge} at ${maxOut.toFixed(2)} px out, died on age ${deathAge} at ${deathOffset.toFixed(2)} px`,
  };
}


/** Fighter 0 run off Tidegate's right edge and hanging on the ledge, fighter 1 far away. */
function hangingState(): GameState {
  const state = fresh(1, 10);
  const f = simFighters(state)[0];
  f.x = mainEdges('tidegate').right - 100;
  state.fighters[1].x = -150;
  for (let i = 0; i < 60 && f.onGround; i++) step(state, inp(Btn.Right, i === 0 ? Btn.Right : 0), NONE);
  for (let i = 0; i < 60 && f.action !== 'ledgeHang'; i++) step(state, inp(Btn.Left, i === 0 ? Btn.Left : 0), NONE);
  return state;
}

function testLedgeStall(): SelfTestResult {
  const state = hangingState();
  const f = simFighters(state)[0];
  const hung = f.action === 'ledgeHang';
  let stayed = true;
  for (let i = 0; i < 600; i++) {
    step(state, NONE, NONE);
    if (f.action !== 'ledgeHang') stayed = false;
  }
  return {
    name: 'by. a fighter hangs 600 frames with no input and is still in ledgeHang',
    pass: hung && stayed && f.action === 'ledgeHang',
    detail: `hung ${hung}, stayed for 600 frames ${stayed}, now ${f.action}, invuln ${f.invuln}`,
  };
}

/**
 * Ledge get-up invulnerability, each option taken after the hang invulnerability has run
 * out: climb 28 frames, ledge roll through ROLL.invEnd + 6, ledge attack move frames 0-21,
 * ledge jump 12 frames from the frame it leaves. Counts the steps the fighter is invulnerable.
 */
function ledgeOptionInvuln(press: InputFrame, action: ActionId): number {
  const state = hangingState();
  const f = simFighters(state)[0];
  for (let i = 0; i < 60; i++) step(state, NONE, NONE);   // LEDGE_HANG_INVULN is 40
  step(state, press, NONE);
  let frames = 0;
  let run = f.action === action && f.invuln > 0;
  if (run) frames++;
  for (let i = 0; i < 60 && run; i++) {
    step(state, NONE, NONE);
    run = f.action === action && f.invuln > 0;
    if (run) frames++;
  }
  return frames;
}

function testLedgeGetUpInvuln(): SelfTestResult {
  const climb = ledgeOptionInvuln(inp(Btn.Up, Btn.Up), 'ledgeClimb');
  const roll = ledgeOptionInvuln(inp(Btn.Dodge, Btn.Dodge), 'ledgeRoll');
  const attack = ledgeOptionInvuln(inp(Btn.Attack, Btn.Attack), 'attack');
  const jump = ledgeOptionInvuln(inp(Btn.Jump, Btn.Jump), 'air');
  // An option that sets invuln 2 each frame of its window leaves one step of tail at 1, so a
  // window of n frames reads as n + 1 steps; the jump's plain 12-frame timer reads as 12.
  const want = { climb: 28 + 1, roll: ROLL.invEnd + 6 + 1 + 1, attack: 22 + 1, jump: 12 };
  const ok = climb === want.climb && roll === want.roll && attack === want.attack && jump === want.jump;
  return {
    name: 'bz. ledge get-up invulnerability: climb 28, roll through ROLL.invEnd + 6, ledgeatk 0-21, jump 12',
    pass: ok,
    detail: `invulnerable steps: climb ${climb} (want ${want.climb}), roll ${roll} (want ${want.roll}), `
      + `ledgeatk ${attack} (want ${want.attack}), jump ${jump} (want ${want.jump})`,
  };
}

/** One air dodge per airborne period, given back by landing, with the AIR_DODGE window. */
function testOneAirDodge(): SelfTestResult {
  const state = airborneState();
  const f = simFighters(state)[0];
  f.y -= 200;   // high enough that the dodge, a second try and the fall all happen in one airborne period
  f.prevY = f.y;
  step(state, inp(Btn.Shield, Btn.Shield), NONE);
  const first = f.action === 'airDodge';
  let invFirst = -1;
  let invLast = -1;
  let length = 0;
  for (let i = 0; i < 60 && f.action === 'airDodge'; i++) {
    length++;
    if (f.invuln >= 2) {
      if (invFirst < 0) invFirst = f.actionFrame;
      invLast = f.actionFrame;
    }
    step(state, NONE, NONE);
  }
  const stillAir = !f.onGround;
  step(state, inp(Btn.Shield, Btn.Shield), NONE);
  const secondShield = f.action;
  step(state, NONE, NONE);
  step(state, inp(Btn.Dodge, Btn.Dodge), NONE);
  const secondDodge = f.action;
  step(state, cmdInp('airDodge', 0, 0), NONE);
  const secondCmd = f.action;
  for (let i = 0; i < 200 && !f.onGround; i++) step(state, NONE, NONE);
  settle(state, 20);
  step(state, inp(Btn.Jump, Btn.Jump), NONE);
  for (let i = 0; i < 6; i++) step(state, inp(Btn.Jump, 0), NONE);
  step(state, inp(Btn.Shield, Btn.Shield), NONE);
  const afterLanding = f.action;
  const refused = secondShield !== 'airDodge' && secondDodge !== 'airDodge' && secondCmd !== 'airDodge';
  const window = invFirst === AIR_DODGE.invStart && invLast === AIR_DODGE.invEnd && length === AIR_DODGE.total
    && AIR_DODGE.total === 34 && AIR_DODGE.invStart === 2 && AIR_DODGE.invEnd === 31;
  return {
    name: 'ca. one air dodge per airborne period: a second is refused, landing gives it back, invuln 2-31 of 34',
    pass: first && stillAir && refused && afterLanding === 'airDodge' && window,
    detail: `first ${first}, lasted ${length}, invuln frames ${invFirst}-${invLast}, still airborne ${stillAir} | `
      + `second: Shield ${secondShield}, Dodge ${secondDodge}, command ${secondCmd} | after landing ${afterLanding}`,
  };
}

/**
 * Real Aeval shots fired at each other by two throwers 240 px apart. A number is the orb's
 * hold in frames, null is a crescent. Reports the clash winner, which shots were still flying
 * 6 frames later, and whether every survivor kept its power untouched.
 * A burst born at the first clash can clash from the next frame, well inside those 6.
 */
function aevalClash(leftCharge: number | null, rightCharge: number | null): {
  winner: number; clashed: boolean; leftAlive: boolean; rightAlive: boolean; powersKept: boolean;
} {
  const state = fresh(1, 60);
  const left = simFighters(state)[0];
  const right = simFighters(state)[1];
  left.x = -120;
  left.facing = 1;
  right.x = 120;
  right.facing = -1;
  const shoot = (f: SimFighter, charge: number | null): number => {
    const def = charge === null ? PROJECTILE_DEFS['crescent'] : PROJECTILE_DEFS['orb'];
    const power = 1;   // both defs spawn at power 1: the orb scales through its charged lerp
    const scale = charge === null ? 1 : projectileChargeScale(charge, true);
    spawnProjectile(state, f, def, power, scale, charge === null ? 0 : charge / TUNING.input.chargeMax);
    return state.nextProjectileId - 1;
  };
  const leftId = shoot(left, leftCharge);
  const rightId = shoot(right, rightCharge);
  const powers: Record<number, number> = {};
  for (let i = 0; i < state.projectiles.length; i++) powers[state.projectiles[i].id] = state.projectiles[i].power;
  let winner = -2;
  let after = -1;
  for (let i = 0; i < 60 && after < 6; i++) {
    step(state, NONE, NONE);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'projectileClash' && winner === -2) winner = ev.winner;
    }
    if (winner !== -2) after++;
  }
  const alive = (id: number): boolean => state.projectiles.some((p) => p.id === id && p.alive);
  let powersKept = true;
  for (let i = 0; i < state.projectiles.length; i++) {
    const p = state.projectiles[i];
    if (p.alive && powers[p.id] !== undefined && p.power !== powers[p.id]) powersKept = false;
  }
  return { winner, clashed: winner !== -2, leftAlive: alive(leftId), rightAlive: alive(rightId), powersKept };
}

function testStrengthTiers(): SelfTestResult {
  const fullOrb = aevalClash(60, null);
  const tapOrb = aevalClash(null, 0);
  const crescents = aevalClash(null, null);
  const midCharge = 20;
  const midStrength = chargedStat(PROJECTILE_DEFS['orb'], midCharge / TUNING.input.chargeMax, 'strength');
  const midOrb = aevalClash(midCharge, null);
  const fullOk = fullOrb.winner === 0 && fullOrb.leftAlive && !fullOrb.rightAlive && fullOrb.powersKept;
  const tapOk = tapOrb.winner === 0 && tapOrb.leftAlive && !tapOrb.rightAlive;
  const bothOk = crescents.clashed && crescents.winner === -1 && !crescents.leftAlive && !crescents.rightAlive;
  // The orb loses (3.91 < 4), and its burst carries the same 3.91, so it cannot beat the
  // crescent either: the crescent is still flying at the end.
  const midOk = midStrength < 4 && midOrb.winner === 1 && !midOrb.leftAlive && midOrb.rightAlive;
  return {
    name: 'cb. strength tiers: a full orb breaks a crescent, a crescent breaks a tap orb, crescents cancel, a 20-frame orb loses',
    pass: fullOk && tapOk && bothOk && midOk,
    detail: `full orb v crescent winner ${fullOrb.winner} orb flies on ${fullOrb.leftAlive} untouched ${fullOrb.powersKept} | `
      + `crescent v tap orb winner ${tapOrb.winner} crescent flies on ${tapOrb.leftAlive} | `
      + `crescents winner ${crescents.winner} both gone ${!crescents.leftAlive && !crescents.rightAlive} | `
      + `orb held ${midCharge} strength ${midStrength.toFixed(2)} v crescent winner ${midOrb.winner}`,
  };
}


/**
 * An orb that hits a fighter bursts, and its burst skips that fighter: the victim takes the
 * orb's own damage and nothing else (4 on a tap, 16 at full), and the orb's launch is not
 * overridden by the burst's weaker one.
 */
function orbHitTotal(holdFrames: number): { percent: number; burst: boolean } {
  const state = createGameState(matchConfig(7));
  const me = simFighters(state)[0];
  const vic = simFighters(state)[1];
  for (let i = 0; i < 40; i++) step(state, NONE, NONE);
  me.x = -60;
  me.facing = 1;
  vic.x = 0;
  vic.percent = 0;
  step(state, inp(Btn.Special, Btn.Special), NONE);
  for (let i = 0; i < holdFrames; i++) step(state, inp(Btn.Special, 0), NONE);
  let burst = false;
  for (let i = 0; i < 80; i++) {
    step(state, NONE, NONE);
    for (let e = 0; e < state.events.length; e++) {
      const ev = state.events[e];
      if (ev.type === 'projectileSpawn' && ev.defId === 'orbBurst') burst = true;
    }
  }
  return { percent: vic.percent, burst };
}

function testBurstSkipsOrbVictim(): SelfTestResult {
  const tap = orbHitTotal(0);
  const full = orbHitTotal(60);
  // What the burst deals to a fighter the orb missed: 2 from a tap orb, 8 from a full one.
  const burstDef = PROJECTILE_DEFS['orbBurst'];
  const tapBurst = chargedStat(burstDef, 0, 'damage');
  const fullBurst = chargedStat(burstDef, 1, 'damage');
  const burstOk = Math.abs(tapBurst - 2) < 1e-9 && Math.abs(fullBurst - 8) < 1e-9;
  return {
    name: 'cc. an orb that hits bursts, the burst skips its victim (tap 4, full 16), and a burst chips 2 to 8',
    pass: tap.burst && full.burst && Math.abs(tap.percent - 4) < 1e-9 && Math.abs(full.percent - 16) < 1e-9 && burstOk,
    detail: `tap: ${tap.percent.toFixed(2)} percent, burst ${tap.burst} | full: ${full.percent.toFixed(2)} percent, burst ${full.burst} | `
      + `burst damage tap ${tapBurst.toFixed(2)} full ${fullBurst.toFixed(2)}`,
  };
}


/**
 * R16: a def with `charged` spawned from a move that cannot charge must use its base values.
 * The charge fraction is stored on the instance (0 here), not read back off `scale`, so a
 * scale-1 spawn no longer reads as 44 percent charge. Also checks the burst inherits it.
 */
function testUnchargeableUsesBase(): SelfTestResult {
  const probe: ProjectileDef = {
    id: 'selftestChargedProbe',
    spawnFrame: 0,
    x: 0, y: -20,
    vx: 2, vy: 0,
    gravity: 0,
    lifetime: 30,
    r: 6,
    damage: 3, angle: 0, bkb: 0, kbg: 0,
    strength: 1,
    charged: { vx: 10, lifetime: 5, damage: 30, r: 20, strength: 9 },
    destroyOnHit: false,
    sprite: 'orb',
  };
  PROJECTILE_DEFS[probe.id] = probe;
  const state = fresh(1, 60);
  const me = simFighters(state)[0];
  state.fighters[1].x = 300;
  me.x = -100;
  me.facing = 1;
  // spawnProjectile's defaults are what an unchargeable move passes: power 1, scale 1, charge 0.
  spawnProjectile(state, me, probe);
  const p = state.projectiles[state.projectiles.length - 1];
  const vxOk = p.vx === 2 && (p.charge ?? -1) === 0;
  let life = 0;
  for (let i = 0; i < 60 && p.alive; i++) {
    step(state, NONE, NONE);
    life++;
  }
  const statsOk = chargedStat(probe, p.charge, 'damage') === 3 && chargedStat(probe, p.charge, 'r') === 6
    && chargedStat(probe, p.charge, 'strength') === 1;
  // A real unchargeable move: the jab bead (no `charged`) and the move's own fraction of 0.
  const jabState = fresh(1, 60);
  step(jabState, inp(Btn.Attack, Btn.Attack), NONE);
  let jabCharge = -1;
  for (let i = 0; i < 10; i++) {
    step(jabState, NONE, NONE);
    for (let k = 0; k < jabState.projectiles.length; k++) {
      const q = jabState.projectiles[k];
      if (q.defId === 'jabDrop' && jabCharge < 0) jabCharge = q.charge ?? -1;
    }
  }
  const cloneOk = cloneGameState(state).projectiles[state.projectiles.length - 1].charge === p.charge;
  return {
    name: 'cd. a def with charged, spawned from a move that cannot charge, uses its base values',
    pass: vxOk && life === 30 && statsOk && jabCharge === 0 && cloneOk,
    detail: `vx ${p.vx} charge ${p.charge}, lived ${life} frames (want 30), damage ${chargedStat(probe, p.charge, 'damage')} `
      + `r ${chargedStat(probe, p.charge, 'r')} strength ${chargedStat(probe, p.charge, 'strength')} | `
      + `jab bead charge ${jabCharge} | clone keeps charge ${cloneOk}`,
  };
}


export function runSimSelfTest(): SelfTestResult[] {
  return [
    testLanding(),
    testWalkAndJump(),
    testJab(),
    testFsmashKo(),
    testProjectile(),
    testShield(),
    testDeterminism(),
    testLedgeGrab(),
    testOrbBurst(),
    testProjectileReturn(),
    testChargedOrb(),
    testOrbCurveIsExponential(),
    testFsmashChargeUnchanged(),
    testClashCancel(),
    testClashPlowsThrough(),
    testClashSameOwner(),
    testRunByDefault(),
    testDoubleTapRoll(),
    testShieldOnlyShields(),
    testAirShieldAndDodge(),
    testDodgeButtonAndDownTap(),
    testRollDodgesHighNotLow(),
    testDirectAndCStick(),
    testGrabCatches(),
    testGrabHoldAndMash(),
    testThrows(),
    testPummel(),
    testThirdPartyBreaksGrab(),
    testForceGrab(),
    testGrabHitbox(),
    testTechOnLanding(),
    testKnockdown(),
    testTechLockout(),
    testDownedOptions(),
    testFootstool(),
    testDodgeAndTauntCommands(),
    testLedgeAndStrayCommands(),
    testGrabCommands(),
    testFsMeterFills(),
    testFsActivation(),
    testFsTargetPick(),
    testFsWhiff(),
    testFsDamageAndLaunch(),
    testFsThirdPartyBlocked(),
    testFsAttackerKoFreesVictim(),
    testFootstoolLanding(),
    testFsSkipsRespawn(),
    testGrabHitboxBlocksLaterHit(),
    testTumbleAirDodge(),
    testRollStopsAtEdge(),
    testLowHitNeedsGroundedAttacker(),
    testAirShortcutDirection(),
    testShieldGrab(),
    testShieldUpSmash(),
    testShieldUpSpecial(),
    testShieldSpecialDropped(),
    testAirShieldAirDodges(),
    testTumbleShieldStillTechs(),
    testJumpCancelUpSmash(),
    testJumpCancelShortcut(),
    testShortcutReplacesFreshAttack(),
    testShortcutTooLateToReplace(),
    testRollMatchesConstants(),
    testWalkNeverSmashes(),
    testJumpsquatForwardShortcutBuffers(),
    testJumpsquatUpSmashCancels(),
    testShortcutSmashCharges(),
    testFlickSmashChargeNeedsAttack(),
    testShieldDecaysWhileMashingSpecial(),
    testCloneCopiesChargeMaskAndRule(),
    testGroundedUpSpecialRises(),
    testAirJumpFlag(),
    testResultsStats(),
    testTeams(),
    testTeamsContact(),
    testCornerLanding(),
    testTeamsTimeOut(),
    testForwardReach(),
    testChargedOrbFlight(),
    testCrescentFlight(),
    testLedgeStall(),
    testLedgeGetUpInvuln(),
    testOneAirDodge(),
    testStrengthTiers(),
    testBurstSkipsOrbVictim(),
    testUnchargeableUsesBase(),
  ];
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('selftest.ts')) {
  const results = runSimSelfTest();
  let passed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.pass) passed++;
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
  }
  process.stdout.write(`${passed}/${results.length} pass\n`);
  if (passed !== results.length) process.exitCode = 1;
}
