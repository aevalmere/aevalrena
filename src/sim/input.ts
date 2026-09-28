import { TECH, TUNING } from '../core/constants';
import { Btn, DIRECT_CODES, DIRECT_MOVES } from '../core/types';
import type { CommandAction, InputFrame } from '../core/types';
import type { SimFighter } from './state';

/** Buttons that can sit in the action buffer. Directions and Walk are read from held. */
export const ACTION_BUTTONS = Btn.Jump | Btn.Attack | Btn.Special | Btn.Shield | Btn.Taunt
  | Btn.Dodge | Btn.Grab | Btn.CUp | Btn.CDown | Btn.CLeft | Btn.CRight;

/** The four C-stick directions, which buffer like buttons. */
export const C_STICK = Btn.CUp | Btn.CDown | Btn.CLeft | Btn.CRight;

/** Buttons whose press counts as a tech press. The tech command counts too. */
export const TECH_BUTTONS = Btn.Shield | Btn.Dodge;

/** InputFrame.direct code of the tech command. */
export const TECH_CODE = DIRECT_CODES.indexOf('tech') + 1;

const TAP_AGE_CAP = 240;

export const EMPTY_INPUT: InputFrame = { held: 0, pressed: 0, released: 0 };

/**
 * The command a DIRECT_CODES code (index + 1) names, or null for 0, a direct move code
 * or anything out of range.
 */
export function commandOf(code: number): CommandAction | null {
  if (code <= DIRECT_MOVES.length || code > DIRECT_CODES.length) return null;
  return DIRECT_CODES[code - 1] as CommandAction;
}

/** Step 2 of the frame: fold one InputFrame into the fighter's buffer and tap timers. */
export function consumeInput(f: SimFighter, inp: InputFrame): void {
  f.inputHeld = inp.held;
  f.inputPressed = inp.pressed;
  const direct = inp.direct !== undefined && inp.direct > 0 && inp.direct <= DIRECT_CODES.length ? inp.direct : 0;

  // Tech timers run here rather than in the fighter update so they keep ticking, and
  // presses keep counting, through hitlag, hitstun and tumble. The window includes the
  // frame of the press; a press inside the lockout is not a tech press at all.
  if (f.techWindow > 0) f.techWindow--;
  if (f.techLockout > 0) f.techLockout--;
  if (f.techLockout === 0 && ((inp.pressed & TECH_BUTTONS) !== 0 || direct === TECH_CODE)) {
    f.techWindow = TECH.window;
    f.techLockout = TECH.lockout;
  }

  if (f.dirTapAge < TAP_AGE_CAP) f.dirTapAge++;
  if (f.udTapAge < TAP_AGE_CAP) f.udTapAge++;
  if ((inp.pressed & Btn.Left) !== 0) {
    f.dirRetap = f.dirTapDir === -1 && f.dirTapAge <= TUNING.input.rollTapWindow;
    f.dirTapAge = 0;
    f.dirTapDir = -1;
  } else if ((inp.pressed & Btn.Right) !== 0) {
    f.dirRetap = f.dirTapDir === 1 && f.dirTapAge <= TUNING.input.rollTapWindow;
    f.dirTapAge = 0;
    f.dirTapDir = 1;
  } else if (heldDir(f) === 0) {
    f.dirRetap = false;
  }
  if ((inp.pressed & Btn.Up) !== 0) {
    f.downRetap = false;
    f.udTapAge = 0;
    f.udTapDir = 1;
  } else if ((inp.pressed & Btn.Down) !== 0) {
    f.downRetap = f.udTapDir === -1 && f.udTapAge <= TUNING.input.rollTapWindow;
    f.udTapAge = 0;
    f.udTapDir = -1;
  } else if (!heldDown(f)) {
    f.downRetap = false;
  }

  // The newest press replaces the whole buffer, direct move or command included, exactly
  // as a fresh button press has always replaced an older buffered button.
  const pressed = inp.pressed & ACTION_BUTTONS;
  if (pressed !== 0 || direct !== 0) {
    f.buffer.btn = pressed;
    f.bufDirect = direct;
    f.buffer.age = 0;
  } else if (f.buffer.btn !== 0 || f.bufDirect !== 0) {
    f.buffer.age++;
    if (f.buffer.age > TUNING.input.buffer) clearBuffer(f);
  }
}

/** -1 left, 1 right, 0 neither or both. */
export function heldDir(f: SimFighter): number {
  const left = (f.inputHeld & Btn.Left) !== 0;
  const right = (f.inputHeld & Btn.Right) !== 0;
  if (left === right) return 0;
  return left ? -1 : 1;
}

export function heldUp(f: SimFighter): boolean {
  return (f.inputHeld & Btn.Up) !== 0;
}

export function heldDown(f: SimFighter): boolean {
  return (f.inputHeld & Btn.Down) !== 0;
}

export function heldShield(f: SimFighter): boolean {
  return (f.inputHeld & Btn.Shield) !== 0;
}

/** Walk modifier: a direction walks instead of dashing while this is down. */
export function heldWalk(f: SimFighter): boolean {
  return (f.inputHeld & Btn.Walk) !== 0;
}

/** True when the fighter flicked that horizontal direction inside the smash window. */
export function wantsSmash(f: SimFighter, dir: number): boolean {
  return f.dirTapDir === dir && f.dirTapAge <= TUNING.input.smashTapWindow;
}

/** dir 1 = up smash, dir -1 = down smash. */
export function wantsVerticalSmash(f: SimFighter, dir: number): boolean {
  return f.udTapDir === dir && f.udTapAge <= TUNING.input.smashTapWindow;
}

/** Takes a buffered button out of the buffer. */
export function takeBuffered(f: SimFighter, btn: number): boolean {
  if ((f.buffer.btn & btn) === 0) return false;
  f.buffer.btn &= ~btn;
  if (f.buffer.btn === 0 && f.bufDirect === 0) f.buffer.age = 0;
  return true;
}

/**
 * The buffered DIRECT_CODES code without taking it, 0 if none. Lets a state ask whether
 * the buffered code is one of its commands and leave anything else where it is.
 */
export function peekBufferedDirect(f: SimFighter): number {
  return f.bufDirect;
}

/** Takes the buffered direct move or command out of the buffer. Returns its DIRECT_CODES code, 0 if none. */
export function takeBufferedDirect(f: SimFighter): number {
  const code = f.bufDirect;
  if (code === 0) return 0;
  f.bufDirect = 0;
  if (f.buffer.btn === 0) f.buffer.age = 0;
  return code;
}

export function clearBuffer(f: SimFighter): void {
  f.buffer.btn = 0;
  f.buffer.age = 0;
  f.bufDirect = 0;
}
