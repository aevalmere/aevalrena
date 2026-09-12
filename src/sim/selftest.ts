import { SHIELD_MAX } from '../core/constants';
import { Btn } from '../core/types';
import type { GameState, InputFrame, MatchConfig, ProjectileDef } from '../core/types';
import { createGameState, stepGame } from './index';
import { PROJECTILE_DEFS, spawnProjectile } from './projectiles';
import { simFighters } from './state';

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

function matchConfig(seed: number): MatchConfig {
  return {
    stageId: 'tidegate',
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

function fresh(seed: number, settleFrames: number): GameState {
  const state = createGameState(matchConfig(seed));
  settle(state, settleFrames);
  return state;
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
  const hold = inp(Btn.Right, 0);
  for (let i = 0; i < 120; i++) step(state, hold, NONE);
  const walkedX = f.x;
  const walkOk = walkedX > startX + 100 && walkedX < 180 && f.onGround;

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
  // Press, release, press: the second tap of the same direction is the dash input.
  for (let i = 0; i < 40 && leftGround < 0; i++) {
    const held = i === 1 ? 0 : Btn.Right;
    const pressed = i === 0 || i === 2 ? Btn.Right : 0;
    step(state, inp(held, pressed), NONE);
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
function throwOrb(holdFrames: number): { power: number; scale: number; charge: number; frame: number } {
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
  let frame = -1;
  for (let i = 0; i < 40 && power === 0; i++) {
    step(state, NONE, NONE);
    for (let p = 0; p < state.projectiles.length; p++) {
      const pr = state.projectiles[p];
      if (pr.alive && pr.defId === 'orb') {
        power = pr.power;
        scale = pr.scale;
        frame = i;
      }
    }
  }
  return { power, scale, charge, frame };
}

/**
 * Holding the special button charges the water orb. advanceMove pins the move on frame 0 while
 * the button stays down, and the orb that finally spawns carries that charge as extra damage and
 * a bigger hit circle.
 *
 * A tap used to spawn the def's own numbers, power 1 and scale 1. It no longer does: the orb now
 * rides an exponential curve from a feeble, small tap (power 0.25, scale 0.6) up to exactly the
 * old full-charge ceiling (power 1.4, scale 1.5), so a no-charge throw is a distinct chip option
 * instead of a weaker version of the same shot. The tap expectation was updated to those new
 * intended numbers; what the case proves is unchanged, and the full-charge ceiling is still
 * pinned to exactly 1.4 so the fully charged orb deals what it always did.
 */
function testChargedOrb(): SelfTestResult {
  const tap = throwOrb(0);
  const full = throwOrb(60);
  const spawned = tap.power > 0 && full.power > 0;
  // A one frame press fires on its own: nothing is held after the press and the orb
  // still comes out, on the move's own spawn frame, exactly as a charged one does. No
  // hold is needed to make the move happen at all.
  const orbSpawnFrame = PROJECTILE_DEFS['orb'].spawnFrame;
  const instant = tap.charge === 0 && tap.frame === orbSpawnFrame && full.frame === orbSpawnFrame;
  const tapWeakAndSmall = tap.power === 0.25 && tap.scale === 0.6;
  const fullCharged = full.charge === 60;
  const fullStrongAndBig = full.power === 1.4 && full.scale === 1.5;
  const stronger = full.power > tap.power && full.scale > tap.scale;
  return {
    name: 'k. holding special charges the orb into a bigger, harder hit',
    pass: spawned && instant && tapWeakAndSmall && fullCharged && fullStrongAndBig && stronger,
    detail: `tap: charge ${tap.charge} power ${tap.power.toFixed(2)} scale ${tap.scale.toFixed(2)} ` +
      `spawned on move frame ${tap.frame} | full: charge ${full.charge} ` +
      `power ${full.power.toFixed(2)} scale ${full.scale.toFixed(2)} spawned on move frame ${full.frame}`,
  };
}

/**
 * The orb curve has to be a genuine exponential, not a line: each quarter of the charge
 * must be worth more than the one before it, so the last quarter buys far more damage
 * than the first. A straight line would make every quarter worth the same.
 */
function testOrbCurveIsExponential(): SelfTestResult {
  const q = [throwOrb(0), throwOrb(15), throwOrb(30), throwOrb(45), throwOrb(60)];
  const gains = [
    q[1].power - q[0].power,
    q[2].power - q[1].power,
    q[3].power - q[2].power,
    q[4].power - q[3].power,
  ];
  let rising = true;
  for (let i = 1; i < gains.length; i++) {
    if (gains[i] <= gains[i - 1]) rising = false;
  }
  // Not just rising: the last quarter must be worth several times the first.
  const lastDwarfsFirst = gains[3] > gains[0] * 3;
  return {
    name: 'o. the orb charge curve is exponential, not linear',
    pass: rising && lastDwarfsFirst,
    detail: `power ${q.map((r) => r.power.toFixed(3)).join(' ')} | ` +
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
  destroyOnHit: true,
  sprite: 'orb',
  burstId: CLASH_BURST.id,
};

/** Two shots fired at each other from x 0 and x 80, run for `frames` steps. */
function clashRun(powerA: number, powerB: number, frames: number): { state: GameState; bursts: number } {
  PROJECTILE_DEFS[CLASH_DEF.id] = CLASH_DEF;
  PROJECTILE_DEFS[CLASH_BURST.id] = CLASH_BURST;
  const state = fresh(1, 60);
  const left = simFighters(state)[0];
  const right = simFighters(state)[1];
  left.x = 0;
  left.facing = 1;
  right.x = 80;
  right.facing = -1;
  spawnProjectile(state, left, CLASH_DEF, powerA, 1);
  spawnProjectile(state, right, CLASH_DEF, powerB, 1);
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
  const run = clashRun(1, 1, 12);
  const a = run.state.projectiles[0];
  const b = run.state.projectiles[1];
  // Both slots were freed by the clash; each may now hold its own burst, which is
  // exactly what the burst count checks, so only the two clashing ids matter here.
  const bothGone = a.defId === CLASH_BURST.id || !a.alive;
  const otherGone = b.defId === CLASH_BURST.id || !b.alive;
  return {
    name: 'l. two equal opposing projectiles cancel and both burst',
    pass: bothGone && otherGone && run.bursts === 2,
    detail: `slot 0 ${a.defId}/${a.alive}, slot 1 ${b.defId}/${b.alive}, bursts ${run.bursts}`,
  };
}

function testClashPlowsThrough(): SelfTestResult {
  // 30 effective damage against 10: a 67 percent gap, far outside the cancel band.
  const run = clashRun(3, 1, 12);
  let survivors = 0;
  let power = 0;
  for (let i = 0; i < run.state.projectiles.length; i++) {
    const p = run.state.projectiles[i];
    if (!p.alive || p.defId !== CLASH_DEF.id) continue;
    survivors++;
    power = p.power;
  }
  // It absorbed 10 of its 30, so 20 remain: power 3 becomes 2.
  const kept = Math.abs(power - 2) < 1e-9;
  return {
    name: 'm. a stronger projectile ploughs through a weaker one at reduced power',
    pass: survivors === 1 && kept && run.bursts === 1,
    detail: `survivors ${survivors}, power ${power.toFixed(3)} (want 2), bursts ${run.bursts}`,
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
