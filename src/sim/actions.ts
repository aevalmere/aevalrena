import {
  AIR_DODGE, ROLL, SHIELD_BREAK_STUN, SHIELD_DECAY, SHIELD_MAX, SPOT_DODGE,
} from '../core/constants';
import { Btn } from '../core/types';
import type { CharacterDef, Facing, GameState, MoveId } from '../core/types';
import {
  clearBuffer, heldDir, heldDown, heldShield, heldUp, takeBuffered, wantsSmash, wantsVerticalSmash,
} from './input';
import { enterAction, setAction, stageOf, type SimFighter } from './state';
import { advanceMove, moveOf, startMove } from './moves';
import { isLedgeAction, stepLedge } from './ledge';
import { stepRespawn } from './match';

/** Frames of skid when a run is released. */
const SKID_FRAMES = 6;
export const LAND_LAG = 4;
export const HELPLESS_LAND_LAG = 8;
export const AIR_DODGE_LAND_LAG = 10;
export const TUMBLE_GETUP = 12;
const AIR_DODGE_SPEED = 3.2;
const DROP_THROUGH_FRAMES = 8;
const SHIELD_BREAK_RECOVERY = SHIELD_MAX * 0.5;

function face(f: SimFighter, dir: number): void {
  const facing: Facing = dir >= 0 ? 1 : -1;
  f.facing = facing;
}

function approach(cur: number, target: number, step: number): number {
  if (cur < target) return Math.min(target, cur + step);
  if (cur > target) return Math.max(target, cur - step);
  return target;
}

function doubleJump(state: GameState, f: SimFighter, def: CharacterDef): void {
  f.vy = -def.doubleJumpVel;
  f.jumpsLeft--;
  f.fastFalling = false;
  const dir = heldDir(f);
  if (dir !== 0) {
    face(f, dir);
    f.vx = dir * def.airSpeed;
  } else {
    f.vx = 0;
  }
  setAction(f, 'air');
  state.events.push({ type: 'jump', x: f.x, y: f.y, slot: f.slot, double: true });
}

function startRoll(f: SimFighter, dir: number): void {
  setAction(f, 'roll');
  f.vx = dir * (ROLL.distance / ROLL.total);
}

function startAirDodge(f: SimFighter): void {
  setAction(f, 'airDodge');
  const dx = heldDir(f);
  const dy = heldUp(f) ? -1 : heldDown(f) ? 1 : 0;
  if (dx !== 0 || dy !== 0) {
    const len = Math.sqrt(dx * dx + dy * dy);
    f.vx = (dx / len) * AIR_DODGE_SPEED;
    f.vy = (dy / len) * AIR_DODGE_SPEED;
  } else {
    f.vx = 0;
    f.vy = 0;
  }
  f.fastFalling = false;
}

function enterShieldOption(f: SimFighter): void {
  if (heldDown(f)) {
    setAction(f, 'spotDodge');
    return;
  }
  const dir = heldDir(f);
  if (dir !== 0) {
    startRoll(f, dir);
    return;
  }
  enterAction(f, 'shield');
}

/** Ground half of the decision table in SPEC 4.3. */
function groundAttack(f: SimFighter): MoveId {
  if (f.action === 'dash' || f.action === 'run') return 'dashatk';
  if (heldUp(f)) return wantsVerticalSmash(f, 1) ? 'usmash' : 'utilt';
  if (heldDown(f)) return wantsVerticalSmash(f, -1) ? 'dsmash' : 'dtilt';
  const dir = heldDir(f);
  if (dir !== 0) {
    face(f, dir);
    return wantsSmash(f, dir) ? 'fsmash' : 'ftilt';
  }
  return 'jab';
}

/** Air half of the decision table in SPEC 4.3. */
function airAttack(f: SimFighter): MoveId {
  if (heldUp(f)) return 'uair';
  if (heldDown(f)) return 'dair';
  const dir = heldDir(f);
  if (dir === 0) return 'nair';
  return dir === f.facing ? 'fair' : 'bair';
}

function specialAttack(f: SimFighter): MoveId {
  if (heldUp(f)) return 'uspecial';
  if (heldDown(f)) return 'dspecial';
  const dir = heldDir(f);
  if (dir !== 0) {
    face(f, dir);
    return 'sspecial';
  }
  return 'nspecial';
}

/** Takes one buffered button if any action accepts it. Returns true when something started. */
function tryBufferedAction(state: GameState, f: SimFighter, def: CharacterDef): boolean {
  if (takeBuffered(f, Btn.Jump)) {
    if (f.onGround) {
      setAction(f, 'jumpsquat');
      f.shortHop = false;
      return true;
    }
    if (f.jumpsLeft > 0) {
      doubleJump(state, f, def);
      return true;
    }
    return false;
  }
  if (takeBuffered(f, Btn.Attack)) {
    startMove(state, f, def, f.onGround ? groundAttack(f) : airAttack(f));
    return true;
  }
  if (takeBuffered(f, Btn.Special)) {
    startMove(state, f, def, specialAttack(f));
    return true;
  }
  if (f.onGround) {
    if (heldShield(f)) {
      enterShieldOption(f);
      return true;
    }
  } else if (takeBuffered(f, Btn.Shield)) {
    startAirDodge(f);
    return true;
  }
  if (f.onGround && takeBuffered(f, Btn.Taunt)) {
    startMove(state, f, def, 'taunt');
    return true;
  }
  return false;
}

function stepJumpsquat(state: GameState, f: SimFighter, def: CharacterDef): void {
  if ((f.inputHeld & Btn.Jump) === 0) f.shortHop = true;
  if (f.actionFrame < def.jumpSquat) return;
  f.vy = -(f.shortHop ? def.shortHopVel : def.jumpVel);
  f.onGround = false;
  f.fastFalling = false;
  f.jumpsLeft = def.jumps - 1;
  setAction(f, 'air');
  state.events.push({ type: 'jump', x: f.x, y: f.y, slot: f.slot, double: false });
}

function stepDodge(f: SimFighter): void {
  let total = SPOT_DODGE.total;
  let invStart = SPOT_DODGE.invStart;
  let invEnd = SPOT_DODGE.invEnd;
  if (f.action === 'roll') {
    total = ROLL.total;
    invStart = ROLL.invStart;
    invEnd = ROLL.invEnd;
  } else if (f.action === 'airDodge') {
    total = AIR_DODGE.total;
    invStart = AIR_DODGE.invStart;
    invEnd = AIR_DODGE.invEnd;
  }
  if (f.actionFrame >= invStart && f.actionFrame <= invEnd && f.invuln < 2) f.invuln = 2;
  if (f.actionFrame < total) return;
  if (f.action !== 'airDodge') f.vx = 0;
  setAction(f, f.onGround ? 'idle' : 'air');
}

function stepShield(state: GameState, f: SimFighter, def: CharacterDef): void {
  if (!f.onGround) {
    setAction(f, 'air');
    return;
  }
  if (!heldShield(f)) {
    setAction(f, 'idle');
    return;
  }
  if (takeBuffered(f, Btn.Jump)) {
    setAction(f, 'jumpsquat');
    f.shortHop = false;
    return;
  }
  if (takeBuffered(f, Btn.Attack)) {
    startMove(state, f, def, groundAttack(f));
    return;
  }
  if (heldDown(f)) {
    setAction(f, 'spotDodge');
    return;
  }
  const dir = heldDir(f);
  if (dir !== 0) {
    startRoll(f, dir);
    return;
  }
  f.shieldHp -= SHIELD_DECAY;
  if (f.shieldHp > 0) return;
  f.shieldHp = 0;
  setAction(f, 'shieldBreak');
  f.stateTimer = SHIELD_BREAK_STUN;
  state.events.push({ type: 'shieldBreak', x: f.x, y: f.y, slot: f.slot });
}

function stepHitstun(f: SimFighter): void {
  if (f.hitstun > 0) return;
  if (f.action === 'hitstun') {
    setAction(f, f.onGround ? 'idle' : 'air');
    return;
  }
  // Tumble holds until the victim presses something or lands.
  if (f.inputPressed !== 0 || f.buffer.btn !== 0) {
    clearBuffer(f);
    setAction(f, f.onGround ? 'idle' : 'air');
  }
}

function dropThrough(state: GameState, f: SimFighter): boolean {
  if (heldShield(f)) return false;
  const stage = stageOf(state);
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (p.solid) continue;
    if (Math.abs(f.y - p.y) > 0.5) continue;
    if (f.x < p.x || f.x > p.x + p.w) continue;
    f.onGround = false;
    f.y += 1;
    f.dropTimer = DROP_THROUGH_FRAMES;
    setAction(f, 'air');
    return true;
  }
  return false;
}

function locomotion(state: GameState, f: SimFighter, def: CharacterDef): void {
  if (!f.onGround) {
    if ((f.inputPressed & Btn.Down) !== 0 && f.vy > 0 && !f.fastFalling) {
      f.fastFalling = true;
      f.vy = def.fastFall;
    }
    return;
  }

  const dir = heldDir(f);
  if ((f.inputPressed & Btn.Down) !== 0 && dropThrough(state, f)) return;
  if (heldDown(f) && dir === 0) {
    enterAction(f, 'crouch');
    return;
  }

  switch (f.action) {
    case 'dash': {
      if (dir === 0) {
        setAction(f, 'turn');
        f.stateTimer = SKID_FRAMES;
        return;
      }
      if (dir !== f.facing) {
        face(f, dir);
        f.actionFrame = 0;
        state.events.push({ type: 'dash', x: f.x, y: f.y, slot: f.slot, facing: f.facing });
      }
      f.vx = f.facing * def.dashSpeed;
      if (f.actionFrame >= def.dashFrames) setAction(f, 'run');
      return;
    }
    case 'run': {
      if (dir === 0) {
        setAction(f, 'turn');
        f.stateTimer = SKID_FRAMES;
        return;
      }
      if (dir !== f.facing) {
        face(f, dir);
        setAction(f, 'dash');
        f.vx = dir * def.dashSpeed;
        state.events.push({ type: 'dash', x: f.x, y: f.y, slot: f.slot, facing: f.facing });
        return;
      }
      f.vx = approach(f.vx, dir * def.runSpeed, def.groundAccel);
      return;
    }
    case 'turn': {
      if (dir !== 0) {
        face(f, dir);
        setAction(f, 'walk');
        return;
      }
      f.stateTimer--;
      if (f.stateTimer <= 0) setAction(f, 'idle');
      return;
    }
    default: {
      if (dir === 0) {
        enterAction(f, 'idle');
        return;
      }
      face(f, dir);
      if (f.action !== 'walk' && wantsSmash(f, dir)) {
        setAction(f, 'dash');
        f.vx = dir * def.dashSpeed;
        state.events.push({ type: 'dash', x: f.x, y: f.y, slot: f.slot, facing: f.facing });
        return;
      }
      enterAction(f, 'walk');
      f.vx = approach(f.vx, dir * def.walkSpeed, def.groundAccel);
      return;
    }
  }
}

/** Step 4a of the frame: one state machine transition for one fighter. */
export function stepAction(state: GameState, f: SimFighter, def: CharacterDef): void {
  switch (f.action) {
    case 'dead':
      return;
    case 'respawn':
      stepRespawn(f);
      return;
    case 'ledgeGrab':
    case 'ledgeHang':
    case 'ledgeClimb':
    case 'ledgeRoll':
    case 'ledgeJump':
      stepLedge(state, f, def);
      return;
    case 'hitstun':
    case 'tumble':
      stepHitstun(f);
      return;
    case 'shieldBreak':
      f.stateTimer--;
      if (f.stateTimer <= 0) {
        f.shieldHp = SHIELD_BREAK_RECOVERY;
        setAction(f, f.onGround ? 'idle' : 'air');
      }
      return;
    case 'shieldStun':
      f.stateTimer--;
      if (f.stateTimer <= 0) {
        setAction(f, f.onGround && heldShield(f) ? 'shield' : f.onGround ? 'idle' : 'air');
      }
      return;
    case 'spotDodge':
    case 'roll':
    case 'airDodge':
      stepDodge(f);
      return;
    case 'jumpsquat':
      stepJumpsquat(state, f, def);
      return;
    case 'shield':
      stepShield(state, f, def);
      return;
    case 'land':
      f.stateTimer--;
      if (f.stateTimer > 0) return;
      setAction(f, 'idle');
      break;
    case 'attack': {
      if (!advanceMove(state, f, def)) {
        if (f.action === 'attack' && f.moveId !== null) {
          const mv = moveOf(f, def);
          if (mv.iasa !== undefined && f.actionFrame >= mv.iasa) tryBufferedAction(state, f, def);
        }
        return;
      }
      break;
    }
    default:
      break;
  }

  if (f.action === 'airHelpless' || f.action === 'attack' || isLedgeAction(f.action)) return;
  if (!tryBufferedAction(state, f, def)) locomotion(state, f, def);
}
