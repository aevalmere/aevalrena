import { TUNING } from '../core/constants';
import { Btn, DIRECT_CODES } from '../core/types';
import type { Bindings, ButtonAction, InputFrame, PlayerControls } from '../core/types';
import type { GamepadSource } from './gamepad';
import type { KeyboardSource } from './keyboard';
import { ACTIONS, BUTTON_ACTIONS } from './defaults';

const ACTION_BIT: Record<ButtonAction, number> = {
  left: Btn.Left,
  right: Btn.Right,
  up: Btn.Up,
  down: Btn.Down,
  walk: Btn.Walk,
  jump: Btn.Jump,
  attack: Btn.Attack,
  special: Btn.Special,
  shield: Btn.Shield,
  grab: Btn.Grab,
  dodge: Btn.Dodge,
  taunt: Btn.Taunt,
  start: Btn.Start,
  cUp: Btn.CUp,
  cDown: Btn.CDown,
  cLeft: Btn.CLeft,
  cRight: Btn.CRight,
};

// The slot index below assumes ACTIONS = [...BUTTON_ACTIONS, ...DIRECT_CODES], so a direct
// code's action index is BUTTON_ACTIONS.length + its DIRECT_CODES index.
if (ACTIONS[BUTTON_ACTIONS.length] !== DIRECT_CODES[0]) {
  throw new Error('ACTIONS must be [...BUTTON_ACTIONS, ...DIRECT_MOVES, ...COMMAND_ACTIONS]');
}

const EMPTY_CODES: string[] = [];
/** Split slots by slot string, filled on first use so sampling never allocates after warm-up. */
const chordCache = new Map<string, string[]>();

/** '' is no codes; anything else is the slot split on '&', two or more codes meaning a chord. */
function codesOf(slot: string): string[] {
  if (slot === '') return EMPTY_CODES;
  let codes = chordCache.get(slot);
  if (codes === undefined) {
    codes = slot.split('&');
    chordCache.set(slot, codes);
  }
  return codes;
}

/** Linear scan: membership without building a Set, so it allocates nothing. */
function isSuppressed(list: string[], code: string): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === code) return true;
  }
  return false;
}

/**
 * Per-player keyboard + gamepad to bitmask mapper. A slot is one code or a chord ('KeyF&KeyJ'),
 * down while every member code is down and fresh on the sample it becomes down or a member
 * re-taps. A chord that fires suppresses its member codes for that sample, so the plain
 * bindings sharing them do not fire too (they still count as held). A jump key that is also an
 * up key is tap jump, and is ignored entirely while the walk bit is held, so Shift + W tilts
 * instead of jumping. A stick tilted up below walkAxis does not tap jump either, so a pad can
 * up tilt. sample() allocates nothing; the pad snapshot must already be polled.
 */
export class PlayerMapper {
  private prevHeld = 0;
  /** Flags per (action, device, slot): idx = actionIndex * 4 + device * 2 + slot. */
  private prevDown = new Uint8Array(ACTIONS.length * 4);
  /** This sample's down flags; swapped with prevDown at the end of sample(). */
  private down = new Uint8Array(ACTIONS.length * 4);
  private readonly fresh = new Uint8Array(ACTIONS.length * 4);
  /** Codes swallowed this sample by a chord that fired, per device. */
  private readonly suppKeys: string[] = [];
  private readonly suppPad: string[] = [];

  sample(keys: KeyboardSource, pads: GamepadSource, controls: PlayerControls, player: number, out: InputFrame): void {
    const pad = pads.padFor(player, controls.padIndex);
    const prevDown = this.prevDown;
    const down = this.down;
    const fresh = this.fresh;
    const suppKeys = this.suppKeys;
    const suppPad = this.suppPad;
    down.fill(0);
    fresh.fill(0);
    suppKeys.length = 0;
    suppPad.length = 0;

    // Pass 1: which slots are down, and which of those became down on this sample.
    for (let i = 0; i < ACTIONS.length; i++) {
      const action = ACTIONS[i];
      for (let d = 0; d < 2; d++) {
        const table: Bindings = d === 0 ? controls.keys : controls.pad;
        const pair = table[action];
        for (let s = 0; s < 2; s++) {
          const codes = codesOf(pair[s]);
          if (codes.length === 0) continue;
          let downNow = true;
          let latchedAny = false;
          if (d === 0) {
            for (let c = 0; c < codes.length; c++) {
              const code = codes[c];
              const latched = keys.latch.has(code);
              if (latched) latchedAny = true;
              if (!latched && !keys.held.has(code)) downNow = false;
            }
          } else if (pad >= 0) {
            for (let c = 0; c < codes.length; c++) {
              if (!pads.isActive(pad, codes[c])) {
                downNow = false;
                break;
              }
            }
          } else {
            downNow = false;
          }
          if (!downNow) continue;
          const idx = i * 4 + d * 2 + s;
          down[idx] = 1;
          if (prevDown[idx] === 0 || latchedAny) fresh[idx] = 1;
        }
      }
    }

    // Pass 2: a chord that fired swallows the plain presses of its member codes.
    for (let i = 0; i < ACTIONS.length; i++) {
      const action = ACTIONS[i];
      for (let d = 0; d < 2; d++) {
        const table: Bindings = d === 0 ? controls.keys : controls.pad;
        const pair = table[action];
        for (let s = 0; s < 2; s++) {
          if (fresh[i * 4 + d * 2 + s] === 0) continue;
          const codes = codesOf(pair[s]);
          if (codes.length < 2) continue;
          const supp = d === 0 ? suppKeys : suppPad;
          for (let c = 0; c < codes.length; c++) supp.push(codes[c]);
        }
      }
    }

    // Pass 3: button bits. Walk comes before jump in BUTTON_ACTIONS, so the tap-jump rule
    // below can already see whether the walk binding is held.
    let held = 0;
    let pressed = 0;
    // Bits held by a key or a pad button, as opposed to only by a stick axis.
    let digital = 0;
    let leftAxis = 0;
    let rightAxis = 0;
    let upAxis = 0;
    const upCodes0 = codesOf(controls.keys.up[0]);
    const upCodes1 = codesOf(controls.keys.up[1]);
    for (let i = 0; i < BUTTON_ACTIONS.length; i++) {
      const action = BUTTON_ACTIONS[i];
      const bit = ACTION_BIT[action];
      for (let d = 0; d < 2; d++) {
        const table: Bindings = d === 0 ? controls.keys : controls.pad;
        const pair = table[action];
        for (let s = 0; s < 2; s++) {
          const codes = codesOf(pair[s]);
          if (codes.length === 0) continue;
          const idx = i * 4 + d * 2 + s;
          // '' when the slot is a chord, so the single-code rules below skip it.
          const single = codes.length === 1 ? codes[0] : '';
          if (action === 'jump' && d === 0 && single !== ''
            && (isSuppressed(upCodes0, single) || isSuppressed(upCodes1, single))
            && (held & Btn.Walk) !== 0) {
            continue;
          }
          if (down[idx] !== 0) {
            held |= bit;
            if (d === 0 || single === '' || single.charCodeAt(0) !== 65 /* 'A' */) {
              digital |= bit;
            } else if (bit === Btn.Left) {
              leftAxis = Math.max(leftAxis, pads.axisValue(pad, single));
            } else if (bit === Btn.Right) {
              rightAxis = Math.max(rightAxis, pads.axisValue(pad, single));
            } else if (bit === Btn.Up) {
              upAxis = Math.max(upAxis, pads.axisValue(pad, single));
            }
          }
          if (fresh[idx] !== 0 && (single === '' || !isSuppressed(d === 0 ? suppKeys : suppPad, single))) {
            pressed |= bit;
          }
        }
      }
    }

    // Left and Right both held: Left wins, deterministically. Same for the C-stick.
    if ((held & Btn.Left) !== 0 && (held & Btn.Right) !== 0) held &= ~Btn.Right;
    if ((pressed & Btn.Left) !== 0 && (pressed & Btn.Right) !== 0) pressed &= ~Btn.Right;
    if ((held & Btn.CLeft) !== 0 && (held & Btn.CRight) !== 0) held &= ~Btn.CRight;
    if ((pressed & Btn.CLeft) !== 0 && (pressed & Btn.CRight) !== 0) pressed &= ~Btn.CRight;

    // A gentle upward stick tilt is an up tilt, not a tap jump: Up held by an axis alone,
    // no key or pad button holding it, and the axis short of the walk threshold.
    const gentleUp = (held & Btn.Up) !== 0 && (digital & Btn.Up) === 0 && upAxis < TUNING.input.walkAxis;

    // A small stick tilt walks: the direction is held only by axes, none tilted past walkAxis.
    const walkAxis = TUNING.input.walkAxis;
    if ((held & Btn.Left) !== 0) {
      if ((digital & Btn.Left) === 0 && leftAxis < walkAxis) held |= Btn.Walk;
    } else if ((held & Btn.Right) !== 0) {
      if ((digital & Btn.Right) === 0 && rightAxis < walkAxis) held |= Btn.Walk;
    }

    // Stick tap jump. Pressed Up is already suppression-filtered, so a chord like F&W, which
    // holds Up without pressing it, never jumps; nor does anything while walk is held.
    if (controls.tapJump && (pressed & Btn.Up) !== 0 && (held & Btn.Walk) === 0 && !gentleUp) {
      pressed |= Btn.Jump;
      held |= Btn.Jump;
    }

    // Pass 4: direct moves and commands. The first code in DIRECT_CODES order wins.
    let direct = 0;
    for (let i = 0; i < DIRECT_CODES.length && direct === 0; i++) {
      const action = DIRECT_CODES[i];
      const actionIndex = BUTTON_ACTIONS.length + i;
      for (let d = 0; d < 2 && direct === 0; d++) {
        const table: Bindings = d === 0 ? controls.keys : controls.pad;
        const pair = table[action];
        for (let s = 0; s < 2; s++) {
          const idx = actionIndex * 4 + d * 2 + s;
          if (fresh[idx] === 0) continue;
          const codes = codesOf(pair[s]);
          if (codes.length >= 2 || !isSuppressed(d === 0 ? suppKeys : suppPad, codes[0])) {
            direct = i + 1;
            break;
          }
        }
      }
    }

    out.held = held;
    out.pressed = pressed;
    out.released = this.prevHeld & ~held;
    out.direct = direct;
    this.prevHeld = held;
    // Swap the two preallocated buffers: this sample's down flags become the previous ones.
    this.prevDown = down;
    this.down = prevDown;
  }

  reset(): void {
    this.prevHeld = 0;
    this.prevDown.fill(0);
  }
}
