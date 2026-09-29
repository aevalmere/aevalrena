import {
  AIR_DODGE, ROLL, SHIELD_BREAK_STUN, SHIELD_DECAY, SHIELD_MAX, SHORTCUT_REPLACE_FRAMES, SPOT_DODGE,
} from '../core/constants';
import { Btn, DIRECT_MOVES } from '../core/types';
import type { CharacterDef, CommandAction, Facing, GameState, MoveId } from '../core/types';
import {
  C_STICK, clearBuffer, commandOf, heldDir, heldDown, heldShield, heldUp, heldWalk, peekBufferedDirect,
  takeBuffered, takeBufferedDirect, TECH_BUTTONS, TECH_CODE, wantsSmash, wantsVerticalSmash,
} from './input';
import { enterAction, setAction, stageOf, type SimFighter } from './state';
import { advanceMove, moveOf, startMove } from './moves';
import { isLedgeAction, stepLedge } from './ledge';
import { stepRespawn } from './match';
import { isGrabAction, startGrab, stepGrabAction } from './grab';
import { holdToPlatform, stepDowned, stepGetUp, stepTech } from './tech';
import { stepFootstooled, tryFootstool } from './footstool';
import { canFinalSmash, startFinalSmash, stepFinalSmash, stepFinalSmashVictim } from './finalsmash';

/** Frames of skid when a run is released. */
const SKID_FRAMES = 6;
export const LAND_LAG = 4;
export const HELPLESS_LAND_LAG = 8;
export const AIR_DODGE_LAND_LAG = 10;
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
  f.airJumped = true;
  state.events.push({ type: 'jump', x: f.x, y: f.y, slot: f.slot, double: true });
  if (!state.finished) f.stats.jumps++;
}

function startRoll(f: SimFighter, dir: number): void {
  setAction(f, 'roll');
  f.vx = dir * (ROLL.distance / ROLL.total);
}

function startDash(state: GameState, f: SimFighter, def: CharacterDef, dir: number): void {
  face(f, dir);
  setAction(f, 'dash');
  f.vx = dir * def.dashSpeed;
  state.events.push({ type: 'dash', x: f.x, y: f.y, slot: f.slot, facing: f.facing });
}

/**
 * `directional` false = the airDodge command: a still air dodge whatever is held.
 * One air dodge per airborne period: it is refused (returns false) once spent, until the
 * fighter lands, grabs a ledge or respawns. Being hit does not give it back. No cooldown.
 */
function startAirDodge(f: SimFighter, directional: boolean): boolean {
  if (f.airDodgeUsed) return false;
  f.airDodgeUsed = true;
  setAction(f, 'airDodge');
  const dx = directional ? heldDir(f) : 0;
  const dy = !directional ? 0 : heldUp(f) ? -1 : heldDown(f) ? 1 : 0;
  if (dx !== 0 || dy !== 0) {
    const len = Math.sqrt(dx * dx + dy * dy);
    f.vx = (dx / len) * AIR_DODGE_SPEED;
    f.vy = (dy / len) * AIR_DODGE_SPEED;
  } else {
    f.vx = 0;
    f.vy = 0;
  }
  f.fastFalling = false;
  return true;
}

/**
 * Double-tap roll: a grounded press of Left or Right that repeats the previous
 * direction press inside TUNING.input.rollTapWindow. The first tap never rolls.
 */
function tryTapRoll(f: SimFighter): boolean {
  const pressed = f.inputPressed & (Btn.Left | Btn.Right);
  if (!f.onGround || pressed === 0 || !f.dirRetap) return false;
  let dir = heldDir(f);
  if (dir === 0) dir = (pressed & Btn.Left) !== 0 ? -1 : 1;
  startRoll(f, dir);
  return true;
}

/** Double-tap spot dodge: a grounded Down press that repeats the previous Down press. */
function tryTapSpotDodge(f: SimFighter): boolean {
  if (!f.onGround || (f.inputPressed & Btn.Down) === 0 || !f.downRetap) return false;
  setAction(f, 'spotDodge');
  return true;
}

/** The Dodge button: roll toward a held direction, spot dodge without one, air dodge in the air. */
function startDodgeButton(f: SimFighter): void {
  if (!f.onGround) {
    startAirDodge(f, true);
    return;
  }
  const dir = heldDir(f);
  if (dir !== 0) startRoll(f, dir);
  else setAction(f, 'spotDodge');
}

/**
 * Ground half of the decision table in SPEC 4.3.
 *
 * A flick of the direction is a smash even out of a dash; only a dash that is
 * already under way turns the attack into a dash attack. Walk held means the
 * stick is tilted, not flicked: never a smash.
 */
function groundAttack(f: SimFighter): MoveId {
  const walking = heldWalk(f);
  if (heldUp(f)) return !walking && wantsVerticalSmash(f, 1) ? 'usmash' : 'utilt';
  if (heldDown(f)) return !walking && wantsVerticalSmash(f, -1) ? 'dsmash' : 'dtilt';
  const dir = heldDir(f);
  if (dir !== 0 && !walking && wantsSmash(f, dir)) {
    face(f, dir);
    return 'fsmash';
  }
  if (f.action === 'dash' || f.action === 'run') return 'dashatk';
  if (dir !== 0) {
    face(f, dir);
    return 'ftilt';
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

/**
 * A move fired by its own key. Ground moves used in the air and aerials used on the
 * ground map to the nearest equivalent, so every binding does something anywhere. A
 * forward shortcut in the air is a fair, or a bair when the held direction is behind
 * the fighter.
 */
function directMove(f: SimFighter, id: MoveId): MoveId {
  const dir = heldDir(f);
  if (f.onGround) {
    switch (id) {
      case 'ftilt':
      case 'fsmash':
      case 'dashatk':
        if (dir !== 0) face(f, dir);
        return id;
      case 'nair': return 'jab';
      case 'fair': return 'ftilt';
      case 'bair':
        face(f, -f.facing);
        return 'ftilt';
      case 'uair': return 'utilt';
      case 'dair': return 'dtilt';
      default: break;
    }
  } else {
    switch (id) {
      case 'jab': return 'nair';
      case 'ftilt':
      case 'fsmash':
      case 'dashatk':
        return (dir !== 0 && dir !== f.facing) ? 'bair' : 'fair';
      case 'utilt':
      case 'usmash':
        return 'uair';
      case 'dtilt':
      case 'dsmash':
        return 'dair';
      default: break;
    }
  }
  if (id === 'sspecial' && dir !== 0) face(f, dir);
  return id;
}

/** C-stick: smashes on the ground, aerials in the air. `c` is the buffered C_STICK bits. */
function cStickMove(f: SimFighter, c: number): MoveId {
  if (f.onGround) {
    if ((c & Btn.CUp) !== 0) return 'usmash';
    if ((c & Btn.CDown) !== 0) return 'dsmash';
    face(f, (c & Btn.CLeft) !== 0 ? -1 : 1);
    return 'fsmash';
  }
  if ((c & Btn.CUp) !== 0) return 'uair';
  if ((c & Btn.CDown) !== 0) return 'dair';
  const dir = (c & Btn.CLeft) !== 0 ? -1 : 1;
  return dir === f.facing ? 'fair' : 'bair';
}

/** The Taunt button: no direction or Up taunts, a side taunts 2, Down taunts 3. */
function tauntFor(f: SimFighter): MoveId {
  if (heldUp(f)) return 'taunt';
  if (heldDown(f)) return 'taunt3';
  return heldDir(f) !== 0 ? 'taunt2' : 'taunt';
}

/**
 * A command from its own key, for an actionable fighter outside the states that own the
 * rest. Returns true when it started something. The code is already out of the buffer, so
 * a command with nothing to do here is simply dropped: tech was recorded in consumeInput,
 * the grab, ledge and getupAttack commands only mean something in their own states, and
 * finalSmash needs a full meter under the rule.
 */
function tryCommand(state: GameState, f: SimFighter, def: CharacterDef, cmd: CommandAction): boolean {
  switch (cmd) {
    case 'spotDodge':
      if (!f.onGround) return false;
      setAction(f, 'spotDodge');
      return true;
    case 'rollForward':
    case 'rollBack':
      if (!f.onGround) return false;
      startRoll(f, cmd === 'rollForward' ? f.facing : -f.facing);
      return true;
    case 'airDodge':
    case 'dirAirDodge':
      if (f.onGround) return false;
      return startAirDodge(f, cmd === 'dirAirDodge');
    case 'taunt2':
    case 'taunt3':
      if (!f.onGround) return false;
      startMove(state, f, def, cmd);
      return true;
    case 'footstool':
      return tryFootstool(state, f, def);
    case 'finalSmash':
      if (!canFinalSmash(state, f, def)) return false;
      startFinalSmash(state, f, def);
      return true;
    default:
      return false;
  }
}

/** Takes one buffered button if any action accepts it. Returns true when something started. */
function tryBufferedAction(state: GameState, f: SimFighter, def: CharacterDef): boolean {
  if (takeBuffered(f, Btn.Jump)) {
    if (f.onGround) {
      setAction(f, 'jumpsquat');
      f.shortHop = false;
      return true;
    }
    // A footstool beats the double jump and does not spend one.
    if (tryFootstool(state, f, def)) return true;
    if (f.jumpsLeft > 0) {
      doubleJump(state, f, def);
      return true;
    }
    return false;
  }
  const code = takeBufferedDirect(f);
  if (code > 0 && code <= DIRECT_MOVES.length) {
    startMove(state, f, def, directMove(f, DIRECT_MOVES[code - 1]));
    return true;
  }
  // A command that does nothing here is gone from the buffer and the buttons still run.
  const cmd = commandOf(code);
  if (cmd !== null && tryCommand(state, f, def, cmd)) return true;
  const c = f.buffer.btn & C_STICK;
  if (c !== 0) {
    takeBuffered(f, C_STICK);
    startMove(state, f, def, cStickMove(f, c));
    return true;
  }
  // Grab is ground only. In the air the press is dropped and the rest of the buffer still runs.
  if (takeBuffered(f, Btn.Grab) && f.onGround) {
    startGrab(state, f, def);
    return true;
  }
  if (takeBuffered(f, Btn.Attack)) {
    startMove(state, f, def, f.onGround ? groundAttack(f) : airAttack(f));
    return true;
  }
  if (takeBuffered(f, Btn.Special)) {
    // A full meter under the rule spends the press on the Final Smash, on the ground or in the air.
    if (canFinalSmash(state, f, def)) startFinalSmash(state, f, def);
    else startMove(state, f, def, specialAttack(f));
    return true;
  }
  if (takeBuffered(f, Btn.Dodge)) {
    startDodgeButton(f);
    return true;
  }
  if (f.onGround) {
    if (heldShield(f)) {
      enterAction(f, 'shield');
      return true;
    }
  } else {
    // Shield only shields on the ground. In the air it air dodges, drifting toward the held
    // direction, as in Smash. Out of tumble it stays a tech press (stepHitstun).
    if (takeBuffered(f, Btn.Shield) && startAirDodge(f, true)) return true;
  }
  if (f.onGround && takeBuffered(f, Btn.Taunt)) {
    startMove(state, f, def, tauntFor(f));
    return true;
  }
  return false;
}

function stepJumpsquat(state: GameState, f: SimFighter, def: CharacterDef): void {
  // Smash's jump-cancel up smash and up special, and only those two. A shortcut for any
  // other move stays in the buffer and comes out in the air as its aerial. A chord such as
  // W then F still gives an up smash because F&W is the up smash shortcut.
  const code = peekBufferedDirect(f);
  if (code > 0 && code <= DIRECT_MOVES.length) {
    const id = DIRECT_MOVES[code - 1];
    if (id === 'usmash' || id === 'uspecial') {
      takeBufferedDirect(f);
      startMove(state, f, def, id);
      return;
    }
  }
  if ((f.buffer.btn & Btn.CUp) !== 0) {
    takeBuffered(f, C_STICK);
    startMove(state, f, def, 'usmash');
    return;
  }
  if ((f.buffer.btn & Btn.Attack) !== 0 && (heldUp(f) || wantsVerticalSmash(f, 1))) {
    takeBuffered(f, Btn.Attack);
    startMove(state, f, def, 'usmash');
    return;
  }
  if ((f.buffer.btn & Btn.Special) !== 0 && heldUp(f)) {
    takeBuffered(f, Btn.Special);
    startMove(state, f, def, 'uspecial');
    return;
  }
  if ((f.inputHeld & Btn.Jump) === 0) f.shortHop = true;
  if (f.actionFrame < def.jumpSquat) return;
  f.vy = -(f.shortHop ? def.shortHopVel : def.jumpVel);
  f.onGround = false;
  f.fastFalling = false;
  f.jumpsLeft = def.jumps - 1;
  setAction(f, 'air');
  state.events.push({ type: 'jump', x: f.x, y: f.y, slot: f.slot, double: false });
  if (!state.finished) f.stats.jumps++;
}

function stepDodge(state: GameState, f: SimFighter): void {
  if (f.action === 'roll') {
    // A roll dodges everything except low hits, so it runs on highDodge, not invuln.
    if (f.actionFrame >= ROLL.invStart && f.actionFrame <= ROLL.invEnd && f.highDodge < 2) f.highDodge = 2;
    // Like a tech roll, it stops at the platform edge instead of carrying off it.
    holdToPlatform(state, f);
    if (f.actionFrame < ROLL.total) return;
    f.vx = 0;
    setAction(f, f.onGround ? 'idle' : 'air');
    return;
  }
  let total = SPOT_DODGE.total;
  let invStart = SPOT_DODGE.invStart;
  let invEnd = SPOT_DODGE.invEnd;
  if (f.action === 'airDodge') {
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
  // Out of shield, as in Smash: Attack grabs, Up + Attack is an up smash, Up + Special is an
  // up special. Every other attack, special, C-stick press or shortcut is dropped.
  if (takeBuffered(f, Btn.Attack)) {
    if (heldUp(f) || wantsVerticalSmash(f, 1)) startMove(state, f, def, 'usmash');
    else startGrab(state, f, def);
    return;
  }
  // Up + Special leaves shield; a bare Special is eaten and the shield keeps decaying, so
  // mashing Special out of shield cannot pause the decay.
  if (takeBuffered(f, Btn.Special) && heldUp(f)) {
    startMove(state, f, def, 'uspecial');
    return;
  }
  if ((f.buffer.btn & Btn.CUp) !== 0) {
    takeBuffered(f, C_STICK);
    startMove(state, f, def, 'usmash');
    return;
  }
  if ((f.buffer.btn & C_STICK) !== 0) takeBuffered(f, C_STICK);
  {
    const code = peekBufferedDirect(f);
    if (code > 0 && code <= DIRECT_MOVES.length) {
      takeBufferedDirect(f);
      const id = DIRECT_MOVES[code - 1];
      if (id === 'usmash' || id === 'uspecial') {
        startMove(state, f, def, id);
        return;
      }
    }
  }
  if (takeBuffered(f, Btn.Grab)) {
    startGrab(state, f, def);
    return;
  }
  if (tryTapRoll(f) || tryTapSpotDodge(f)) return;
  if (takeBuffered(f, Btn.Dodge)) {
    startDodgeButton(f);
    return;
  }
  // The dodge commands work out of shield like the Dodge button; other codes wait in the buffer.
  const cmd = commandOf(peekBufferedDirect(f));
  if (cmd === 'spotDodge' || cmd === 'rollForward' || cmd === 'rollBack') {
    takeBufferedDirect(f);
    tryCommand(state, f, def, cmd);
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
  // Out of hitstun, Dodge or an air dodge command air dodges out of tumble, as in Smash.
  // The Dodge press still counted as a tech press in consumeInput. Shield does not dodge.
  const cmd = commandOf(peekBufferedDirect(f));
  const dodge = ((f.inputPressed | f.buffer.btn) & Btn.Dodge) !== 0 || cmd === 'airDodge' || cmd === 'dirAirDodge';
  if (dodge && !f.onGround && !f.airDodgeUsed) {
    clearBuffer(f);
    startAirDodge(f, cmd !== 'airDodge');
    return;
  }
  // Tumble holds until the victim presses something or lands. A tech press (Shield, Dodge,
  // the tech command) does not count: it is meant for the landing, and ending the tumble
  // would throw away the tech it was pressed for.
  const presses = (f.inputPressed | f.buffer.btn) & ~TECH_BUTTONS;
  if (presses !== 0 || (f.bufDirect !== 0 && f.bufDirect !== TECH_CODE)) {
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

  // A double tap rolls, and it wins over the dash the same press would start.
  if (tryTapRoll(f)) return;
  const dir = heldDir(f);
  if ((f.inputPressed & Btn.Down) !== 0 && dropThrough(state, f)) return;
  if (tryTapSpotDodge(f)) return;
  if (heldDown(f) && dir === 0) {
    enterAction(f, 'crouch');
    return;
  }

  const walking = heldWalk(f);
  switch (f.action) {
    case 'dash': {
      if (dir === 0) {
        setAction(f, 'turn');
        f.stateTimer = SKID_FRAMES;
        return;
      }
      if (walking) {
        face(f, dir);
        setAction(f, 'walk');
        f.vx = approach(f.vx, dir * def.walkSpeed, def.groundAccel);
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
      if (walking) {
        face(f, dir);
        setAction(f, 'walk');
        f.vx = approach(f.vx, dir * def.walkSpeed, def.groundAccel);
        return;
      }
      if (dir !== f.facing) {
        startDash(state, f, def, dir);
        return;
      }
      f.vx = approach(f.vx, dir * def.runSpeed, def.groundAccel);
      return;
    }
    case 'turn': {
      if (dir !== 0) {
        if (walking) {
          face(f, dir);
          setAction(f, 'walk');
        } else {
          startDash(state, f, def, dir);
        }
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
      // Holding a direction runs by default; the Walk modifier walks instead.
      if (!walking) {
        startDash(state, f, def, dir);
        return;
      }
      face(f, dir);
      enterAction(f, 'walk');
      f.vx = approach(f.vx, dir * def.walkSpeed, def.groundAccel);
      return;
    }
  }
}

/** Step 4a of the frame: one state machine transition for one fighter. */
export function stepAction(state: GameState, f: SimFighter, def: CharacterDef): void {
  if (isGrabAction(f.action)) {
    stepGrabAction(state, f, def);
    return;
  }
  switch (f.action) {
    case 'dead':
      return;
    case 'respawn':
      f.airDodgeUsed = false;   // a respawn gives the air dodge back
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
    case 'tech':
    case 'techRoll':
      stepTech(state, f);
      return;
    case 'downed':
      stepDowned(state, f, def);
      return;
    case 'getUp':
    case 'getUpRoll':
      stepGetUp(state, f);
      return;
    case 'footstooled':
      stepFootstooled(f);
      return;
    case 'finalSmash':
      stepFinalSmash(state, f, def);
      return;
    case 'finalSmashVictim':
      stepFinalSmashVictim(state, f);
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
      stepDodge(state, f);
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
      // A shortcut move that lands right after a button started an attack replaces it, so a
      // chord pressed "together" (J one frame before F) still comes out as the chord's move.
      if (f.actionFrame < SHORTCUT_REPLACE_FRAMES) {
        const code = peekBufferedDirect(f);
        if (code > 0 && code <= DIRECT_MOVES.length) {
          takeBufferedDirect(f);
          startMove(state, f, def, directMove(f, DIRECT_MOVES[code - 1]));
          return;
        }
      }
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
