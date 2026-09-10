import { TUNING } from '../core/constants';
import { Btn } from '../core/types';
import type { InputFrame } from '../core/types';
import type { SimFighter } from './state';

/** Buttons that can sit in the action buffer. Directions are read from held. */
export const ACTION_BUTTONS = Btn.Jump | Btn.Attack | Btn.Special | Btn.Shield | Btn.Taunt;

const TAP_AGE_CAP = 240;

export const EMPTY_INPUT: InputFrame = { held: 0, pressed: 0, released: 0 };

/** Step 2 of the frame: fold one InputFrame into the fighter's buffer and tap timers. */
export function consumeInput(f: SimFighter, inp: InputFrame): void {
  f.inputHeld = inp.held;
  f.inputPressed = inp.pressed;

  if (f.dirTapAge < TAP_AGE_CAP) f.dirTapAge++;
  if (f.udTapAge < TAP_AGE_CAP) f.udTapAge++;
  if ((inp.pressed & Btn.Left) !== 0) {
    f.dirRetap = f.dirTapDir === -1 && f.dirTapAge <= TUNING.input.dashRetapWindow;
    f.dirTapAge = 0;
    f.dirTapDir = -1;
  } else if ((inp.pressed & Btn.Right) !== 0) {
    f.dirRetap = f.dirTapDir === 1 && f.dirTapAge <= TUNING.input.dashRetapWindow;
    f.dirTapAge = 0;
    f.dirTapDir = 1;
  } else if (heldDir(f) === 0) {
    f.dirRetap = false;
  }
  if ((inp.pressed & Btn.Up) !== 0) {
    f.udTapAge = 0;
    f.udTapDir = 1;
  } else if ((inp.pressed & Btn.Down) !== 0) {
    f.udTapAge = 0;
    f.udTapDir = -1;
  }

  const pressed = inp.pressed & ACTION_BUTTONS;
  if (pressed !== 0) {
    f.buffer.btn = pressed;
    f.buffer.age = 0;
  } else if (f.buffer.btn !== 0) {
    f.buffer.age++;
    if (f.buffer.age > TUNING.input.buffer) {
      f.buffer.btn = 0;
      f.buffer.age = 0;
    }
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
  if (f.buffer.btn === 0) f.buffer.age = 0;
  return true;
}

export function clearBuffer(f: SimFighter): void {
  f.buffer.btn = 0;
  f.buffer.age = 0;
}
