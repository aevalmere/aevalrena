import { GETUP, GETUP_ROLL, KNOCKDOWN, TECH } from '../core/constants';
import { Btn } from '../core/types';
import type { ActionId, CharacterDef, GameState } from '../core/types';
import { commandOf, heldDir, peekBufferedDirect, takeBuffered, takeBufferedDirect } from './input';
import { startMove } from './moves';
import { setAction, stageOf, type SimFighter } from './state';

/**
 * Techs, knockdowns and getting up.
 *
 * A tech press (Shield, Dodge or the tech command, recorded in consumeInput) opens
 * techWindow. A tumbling fighter, or one still in hitstun, that lands while the window is
 * open techs: in place, or rolling toward a held direction. A tumble landing without a
 * tech lies downed until the fighter picks a get-up option or KNOCKDOWN.maxFrames pass.
 * Plain hitstun landings without a tech keep sliding in hitstun as they always have.
 */

/** Keeps a travelling roll (tech, get-up or plain) on the platform under it: it stops at the edge. */
export function holdToPlatform(state: GameState, f: SimFighter): void {
  if (!f.onGround || f.vx === 0) return;
  const stage = stageOf(state);
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (Math.abs(f.y - p.y) > 0.5 || f.x < p.x || f.x > p.x + p.w) continue;
    const next = f.x + f.vx;
    if (next < p.x) f.vx = p.x - f.x;
    else if (next > p.x + p.w) f.vx = p.x + p.w - f.x;
    return;
  }
}

/** Enters a timed option and makes it invulnerable from its first frame. */
function startTimed(f: SimFighter, action: ActionId, vx: number): void {
  setAction(f, action);
  f.vx = vx;
  if (f.invuln < 2) f.invuln = 2;
}

/** Invulnerability up to invEnd, travel held to the platform, then back to neutral at total. */
function stepTimed(state: GameState, f: SimFighter, invEnd: number, total: number): void {
  if (f.actionFrame <= invEnd && f.invuln < 2) f.invuln = 2;
  holdToPlatform(state, f);
  if (f.actionFrame < total) return;
  f.vx = 0;
  setAction(f, f.onGround ? 'idle' : 'air');
}

/**
 * The landing decision, called from physics when a fighter touches down. Returns true
 * when it took the landing over (tech, techRoll or downed); false leaves it to the
 * normal landing code.
 */
export function landTumble(state: GameState, f: SimFighter): boolean {
  const tumble = f.action === 'tumble';
  if (!tumble && !(f.action === 'hitstun' && f.hitstun > 0)) return false;
  if (!tumble && f.techWindow <= 0) return false;

  f.hitstun = 0;
  f.kbSpeed = 0;
  f.kbFall = 0;
  f.kbDirX = 0;
  f.kbDirY = 0;
  if (f.techWindow > 0) {
    f.techWindow = 0;
    const dir = heldDir(f);
    if (dir !== 0) startTimed(f, 'techRoll', dir * (TECH.roll.distance / TECH.roll.total));
    else startTimed(f, 'tech', 0);
    state.events.push({ type: 'tech', x: f.x, y: f.y, slot: f.slot, roll: dir !== 0 });
    if (!state.finished) f.stats.techs++;
    return true;
  }
  setAction(f, 'downed');
  f.vx = 0;
  f.downTimer = 0;
  return true;
}

/** Tech in place or tech roll. Called from stepAction. */
export function stepTech(state: GameState, f: SimFighter): void {
  if (f.action === 'techRoll') stepTimed(state, f, TECH.roll.invEnd, TECH.roll.total);
  else stepTimed(state, f, TECH.inPlace.invEnd, TECH.inPlace.total);
}

/** Standing up or rolling out of downed. Called from stepAction. */
export function stepGetUp(state: GameState, f: SimFighter): void {
  if (f.action === 'getUpRoll') stepTimed(state, f, GETUP_ROLL.invEnd, GETUP_ROLL.total);
  else stepTimed(state, f, GETUP.invEnd, GETUP.total);
}

/**
 * Lying downed. Attack or the getupAttack command attacks, Up, Jump or Shield stands up,
 * a Left or Right press rolls that way, and KNOCKDOWN.maxFrames stands the fighter up
 * anyway. Directions count as presses, not holds, so DI still held from the launch does
 * not pick a roll the moment the fighter lands. Any other command is dropped here.
 */
export function stepDowned(state: GameState, f: SimFighter, def: CharacterDef): void {
  f.downTimer++;
  const cmd = commandOf(peekBufferedDirect(f));
  if (cmd !== null) takeBufferedDirect(f);
  if (cmd === 'getupAttack' || takeBuffered(f, Btn.Attack)) {
    startMove(state, f, def, 'getupatk');
    return;
  }
  if (takeBuffered(f, Btn.Jump | Btn.Shield) || (f.inputPressed & Btn.Up) !== 0) {
    startTimed(f, 'getUp', 0);
    return;
  }
  const pressed = f.inputPressed & (Btn.Left | Btn.Right);
  if (pressed !== 0) {
    let dir = heldDir(f);
    if (dir === 0) dir = (pressed & Btn.Left) !== 0 ? -1 : 1;
    startTimed(f, 'getUpRoll', dir * (GETUP_ROLL.distance / GETUP_ROLL.total));
    return;
  }
  if (f.downTimer >= KNOCKDOWN.maxFrames) startTimed(f, 'getUp', 0);
}
