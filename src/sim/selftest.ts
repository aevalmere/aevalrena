import { SHIELD_MAX } from '../core/constants';
import { Btn } from '../core/types';
import type { GameState, InputFrame, MatchConfig } from '../core/types';
import { createGameState, stepGame } from './index';

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
  return {
    name: 'e. nspecial projectile travels and expires',
    pass: spawned && died && gone && traveled > 200,
    detail: `spawned at ${spawnX.toFixed(1)}, traveled ${traveled.toFixed(1)} px, died on frame ${dieFrame}`,
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
