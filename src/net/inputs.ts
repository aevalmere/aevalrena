import type { InputFrame } from '../core/types';

/** Frames of input history kept per player. Must exceed the prediction window plus the send window. */
export const INPUT_RING = 128;

export function inputsEqual(a: InputFrame, b: InputFrame): boolean {
  return a.held === b.held && a.pressed === b.pressed && a.released === b.released &&
    (a.direct ?? 0) === (b.direct ?? 0);
}

/**
 * One player's inputs by frame, in a ring. Each entry remembers which frame it holds, so a stale
 * entry from 128 frames ago never reads as the current one. `confirmed` means the owner sent it.
 */
export class InputRing {
  readonly held = new Int32Array(INPUT_RING);
  readonly pressed = new Int32Array(INPUT_RING);
  readonly released = new Int32Array(INPUT_RING);
  readonly direct = new Int32Array(INPUT_RING);
  readonly frameOf = new Int32Array(INPUT_RING).fill(-1);
  /** Highest frame f such that every frame 0..f is confirmed; -1 before any. */
  lastConfirmed = -1;

  has(frame: number): boolean {
    return frame >= 0 && this.frameOf[frame % INPUT_RING] === frame;
  }

  /** Store a confirmed input. Returns false when the frame was already known. */
  put(frame: number, held: number, pressed: number, released: number, direct: number): boolean {
    if (frame < 0 || this.has(frame) || frame <= this.lastConfirmed) return false;
    const i = frame % INPUT_RING;
    this.held[i] = held;
    this.pressed[i] = pressed;
    this.released[i] = released;
    this.direct[i] = direct;
    this.frameOf[i] = frame;
    while (this.has(this.lastConfirmed + 1)) this.lastConfirmed++;
    return true;
  }

  /** Forget everything and treat frames before `frame` as confirmed (a resumed session). */
  seed(frame: number): void {
    this.frameOf.fill(-1);
    this.lastConfirmed = frame - 1;
  }

  /** Unconditional write, for the record of inputs a frame was simulated with. */
  set(frame: number, held: number, pressed: number, released: number, direct: number): void {
    const i = frame % INPUT_RING;
    this.held[i] = held;
    this.pressed[i] = pressed;
    this.released[i] = released;
    this.direct[i] = direct;
    this.frameOf[i] = frame;
  }

  read(frame: number, out: InputFrame): void {
    const i = frame % INPUT_RING;
    out.held = this.held[i];
    out.pressed = this.pressed[i];
    out.released = this.released[i];
    out.direct = this.direct[i];
  }

  /**
   * The input to simulate `frame` with: the confirmed one, else a prediction that repeats the
   * last confirmed `held` with no edges (repeating a press would fire a move twice).
   */
  inputFor(frame: number, out: InputFrame): boolean {
    if (this.has(frame)) {
      this.read(frame, out);
      return true;
    }
    const base = this.lastConfirmed;
    out.held = base >= 0 && this.has(base) ? this.held[base % INPUT_RING] : 0;
    out.pressed = 0;
    out.released = 0;
    out.direct = 0;
    return false;
  }
}
