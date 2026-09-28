import { TUNING } from '../core/constants';

/** Snapshot capacity. Pads, buttons or axes past these are ignored. */
export const MAX_PADS = 8;
const MAX_BUTTONS = 32;
const MAX_AXES = 16;
/** An axis must pass this far out of rest to be captured as a binding. */
const CAPTURE_AXIS = 0.6;
/** Most buttons one capture will fold into a chord. A press past this is ignored. */
const MAX_CHORD = 3;

const NO_PADS: (Gamepad | null)[] = [];

function readNavigatorPads(): (Gamepad | null)[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return NO_PADS;
  try {
    return navigator.getGamepads() as (Gamepad | null)[];
  } catch {
    return NO_PADS;
  }
}

/** A parsed pad code. `sign` is 0 for a button, +1 / -1 for an axis direction. */
interface PadCode { axis: boolean; index: number; sign: number }

/** Parsed codes by string. Filled the first time a code is seen, so sampling never allocates after warm-up. */
const parsedCodes = new Map<string, PadCode | null>();

/** 'B<n>', 'A<n>+' or 'A<n>-', else null. */
function parseCode(code: string): PadCode | null {
  const cached = parsedCodes.get(code);
  if (cached !== undefined) return cached;
  let parsed: PadCode | null = null;
  const m = /^(?:B(\d+)|A(\d+)([+-]))$/.exec(code);
  if (m !== null) {
    parsed = m[1] !== undefined
      ? { axis: false, index: Number(m[1]), sign: 0 }
      : { axis: true, index: Number(m[2]), sign: m[3] === '+' ? 1 : -1 };
  }
  parsedCodes.set(code, parsed);
  return parsed;
}

/** A pending listenForNextPad. */
export interface PadCapture {
  readonly promise: Promise<string>;
  /** Stops polling and rejects the promise with Error('cancelled'). No-op once settled. */
  cancel(): void;
}

/**
 * Owns raw gamepad state for the whole app. `poll()` copies navigator.getGamepads() into
 * preallocated typed arrays once per call; every query reads that snapshot, so all players
 * sampled in one sim frame see the same pad state. Snapshot index = the browser's pad index.
 */
export class GamepadSource {
  private readonly present = new Uint8Array(MAX_PADS);
  private readonly ids: string[] = new Array<string>(MAX_PADS).fill('');
  private readonly pressed: Uint8Array[] = [];
  private readonly values: Float32Array[] = [];
  private readonly axes: Float32Array[] = [];

  constructor(private readonly getPads: () => (Gamepad | null)[] = readNavigatorPads) {
    for (let i = 0; i < MAX_PADS; i++) {
      this.pressed.push(new Uint8Array(MAX_BUTTONS));
      this.values.push(new Float32Array(MAX_BUTTONS));
      this.axes.push(new Float32Array(MAX_AXES));
    }
  }

  poll(): void {
    const pads = this.getPads();
    for (let i = 0; i < MAX_PADS; i++) {
      const pad = i < pads.length ? pads[i] : null;
      const pressed = this.pressed[i];
      const values = this.values[i];
      const axes = this.axes[i];
      if (pad === null || pad === undefined || !pad.connected) {
        this.present[i] = 0;
        pressed.fill(0);
        values.fill(0);
        axes.fill(0);
        continue;
      }
      this.present[i] = 1;
      this.ids[i] = pad.id;
      const buttons = pad.buttons;
      for (let b = 0; b < MAX_BUTTONS; b++) {
        const button = b < buttons.length ? buttons[b] : undefined;
        pressed[b] = button !== undefined && button.pressed ? 1 : 0;
        values[b] = button !== undefined ? button.value : 0;
      }
      const padAxes = pad.axes;
      for (let a = 0; a < MAX_AXES; a++) axes[a] = a < padAxes.length ? padAxes[a] : 0;
    }
  }

  /**
   * The snapshot index to read for `player`, or -1 when there is none.
   * padIndex -1 = auto: the Nth connected pad for player N.
   */
  padFor(player: number, padIndex: number): number {
    if (padIndex >= 0) return padIndex < MAX_PADS && this.present[padIndex] === 1 ? padIndex : -1;
    let seen = 0;
    for (let i = 0; i < MAX_PADS; i++) {
      if (this.present[i] !== 1) continue;
      if (seen === player) return i;
      seen++;
    }
    return -1;
  }

  /** True when `code` is active on snapshot pad `pad`: a button down, or an axis past the deadzone that way. */
  isActive(pad: number, code: string): boolean {
    if (pad < 0 || pad >= MAX_PADS || this.present[pad] !== 1) return false;
    const parsed = parseCode(code);
    if (parsed === null) return false;
    const dz = TUNING.input.padDeadzone;
    if (!parsed.axis) {
      if (parsed.index >= MAX_BUTTONS) return false;
      return this.pressed[pad][parsed.index] === 1 || this.values[pad][parsed.index] > dz;
    }
    if (parsed.index >= MAX_AXES) return false;
    return this.axes[pad][parsed.index] * parsed.sign >= dz;
  }

  /** Deflection 0..1 of an axis code in its own direction. 0 for button codes. */
  axisValue(pad: number, code: string): number {
    if (pad < 0 || pad >= MAX_PADS || this.present[pad] !== 1) return 0;
    const parsed = parseCode(code);
    if (parsed === null || !parsed.axis || parsed.index >= MAX_AXES) return 0;
    const v = this.axes[pad][parsed.index] * parsed.sign;
    return v <= 0 ? 0 : v >= 1 ? 1 : v;
  }

  /** True while any button on any connected pad is down. Axes do not count. */
  anyButtonDown(): boolean {
    const dz = TUNING.input.padDeadzone;
    for (let i = 0; i < MAX_PADS; i++) {
      if (this.present[i] !== 1) continue;
      const pressed = this.pressed[i];
      const values = this.values[i];
      for (let b = 0; b < MAX_BUTTONS; b++) {
        if (pressed[b] === 1 || values[b] > dz) return true;
      }
    }
    return false;
  }

  /** Whether snapshot pad `pad` is connected. */
  isConnected(pad: number): boolean {
    return pad >= 0 && pad < MAX_PADS && this.present[pad] === 1;
  }

  connected(): { index: number; id: string }[] {
    const out: { index: number; id: string }[] = [];
    for (let i = 0; i < MAX_PADS; i++) {
      if (this.present[i] === 1) out.push({ index: i, id: this.ids[i] });
    }
    return out;
  }

  /**
   * Waits for the next input on pad `padIndex` (-1 = any pad) and resolves it as a pad code.
   * A button or axis already away from rest when the capture starts (or when its pad connects)
   * is ignored until it returns to rest, so the press that opened the prompt is never captured.
   * Buttons build a chord: every button pressed since the capture started is collected, and
   * releasing any one of them resolves them joined by '&', in press order. An axis resolves on
   * its own the moment it swings from inside the deadzone out past CAPTURE_AXIS.
   */
  capture(padIndex: number): PadCapture {
    const buttonArmed: Uint8Array[] = [];
    /** [pad][button] = 1 while that button is one of the codes in `chord`. */
    const buttonChord: Uint8Array[] = [];
    const axisArmed: Uint8Array[] = [];
    const seen = new Uint8Array(MAX_PADS);
    const chord: string[] = [];
    for (let i = 0; i < MAX_PADS; i++) {
      buttonArmed.push(new Uint8Array(MAX_BUTTONS));
      buttonChord.push(new Uint8Array(MAX_BUTTONS));
      axisArmed.push(new Uint8Array(MAX_AXES));
    }

    let settled = false;
    let handle = 0;
    let rejectFn: ((err: Error) => void) | null = null;

    const schedule = (fn: () => void): number => (
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(fn)
        : setTimeout(fn, 16) as unknown as number
    );
    const unschedule = (id: number): void => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
      else clearTimeout(id);
    };

    const promise = new Promise<string>((resolve, reject) => {
      rejectFn = reject;
      const tick = (): void => {
        if (settled) return;
        this.poll();
        const dz = TUNING.input.padDeadzone;
        for (let i = 0; i < MAX_PADS; i++) {
          if (padIndex >= 0 && i !== padIndex) continue;
          if (this.present[i] !== 1) {
            seen[i] = 0;
            continue;
          }
          const firstLook = seen[i] === 0;
          seen[i] = 1;
          const pressed = this.pressed[i];
          const values = this.values[i];
          const axes = this.axes[i];
          const bArmed = buttonArmed[i];
          const bChord = buttonChord[i];
          const aArmed = axisArmed[i];
          for (let b = 0; b < MAX_BUTTONS; b++) {
            const down = pressed[b] === 1 || values[b] > dz;
            if (!down) {
              // Letting go of any button that is part of the chord binds the whole chord.
              if (bChord[b] === 1) {
                settled = true;
                resolve(chord.join('&'));
                return;
              }
              bArmed[b] = 1;
            } else if (!firstLook && bArmed[b] === 1) {
              bArmed[b] = 0;
              if (chord.length < MAX_CHORD) {
                bChord[b] = 1;
                chord.push(`B${b}`);
              }
            }
          }
          for (let a = 0; a < MAX_AXES; a++) {
            const v = axes[a];
            if (Math.abs(v) < dz) {
              aArmed[a] = 1;
            } else if (!firstLook && aArmed[a] === 1 && Math.abs(v) >= CAPTURE_AXIS) {
              settled = true;
              resolve(v > 0 ? `A${a}+` : `A${a}-`);
              return;
            }
          }
        }
        handle = schedule(tick);
      };
      handle = schedule(tick);
    });

    return {
      promise,
      cancel: (): void => {
        if (settled) return;
        settled = true;
        unschedule(handle);
        if (rejectFn !== null) rejectFn(new Error('cancelled'));
      },
    };
  }
}
