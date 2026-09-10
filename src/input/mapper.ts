import { Btn } from '../core/types';
import type { Bindings, InputAction, InputFrame } from '../core/types';
import type { KeyboardSource } from './keyboard';
import { ACTIONS } from './defaults';

const ACTION_BIT: Record<InputAction, number> = {
  left: Btn.Left,
  right: Btn.Right,
  up: Btn.Up,
  down: Btn.Down,
  jump: Btn.Jump,
  attack: Btn.Attack,
  special: Btn.Special,
  shield: Btn.Shield,
  taunt: Btn.Taunt,
  start: Btn.Start,
};

/**
 * Per-player key-to-bitmask mapper. Tracks the previous sample's held mask so pressed/released
 * can be derived, and consults the shared source's latch so a tap that happened and released
 * entirely between two samples still registers as one frame of `pressed`.
 */
export class PlayerMapper {
  private prevHeld = 0;

  sample(source: KeyboardSource, bindings: Bindings, tapJump: boolean, out: InputFrame): void {
    let held = 0;
    let latched = 0;
    for (const action of ACTIONS) {
      const code = bindings[action];
      const bit = ACTION_BIT[action];
      if (source.held.has(code)) held |= bit;
      if (source.latch.has(code)) latched |= bit;
    }

    // Left and Right both held: Left wins, deterministically.
    if ((held & Btn.Left) !== 0 && (held & Btn.Right) !== 0) held &= ~Btn.Right;
    if ((latched & Btn.Left) !== 0 && (latched & Btn.Right) !== 0) latched &= ~Btn.Right;

    let pressed = (held & ~this.prevHeld) | latched;
    const released = this.prevHeld & ~held;

    if (tapJump && (pressed & Btn.Up) !== 0) {
      pressed |= Btn.Jump;
      held |= Btn.Jump;
    }

    out.held = held;
    out.pressed = pressed;
    out.released = released;
    this.prevHeld = held;
  }

  reset(): void {
    this.prevHeld = 0;
  }
}
