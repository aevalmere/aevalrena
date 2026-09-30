/**
 * Gamepad menu navigation. Polls navigator.getGamepads() every animation frame
 * and turns pad input into synthetic window keydown/keyup events, so every
 * screen's existing keyboard handler drives the menus unchanged.
 */

/** Stick deflection that counts as a menu direction. */
const STICK_THRESHOLD = 0.5;
/** Hold-repeat for directions: first repeat after this many ms... */
const REPEAT_DELAY_MS = 300;
/** ...then one repeat every this many ms. */
const REPEAT_INTERVAL_MS = 110;

/** Dispatched key per direction slot: up, down, left, right. */
const DIR_CODES = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
/** Standard-mapping D-pad button per direction slot. */
const DIR_BUTTONS = [12, 13, 14, 15];

/**
 * Buttons that dispatch a key once per press. B0 Cross/A, B1 Circle/B, B9 Options/Menu,
 * B2 Square/X (KeyN: edit name on Character Select), B3 Triangle/Y (KeyT: team colour),
 * B4 / B5 L1 / R1 (BracketLeft / BracketRight: outfit colour variant on Character Select).
 */
const BUTTON_MAP: { button: number; code: string }[] = [
  { button: 0, code: 'Enter' },
  { button: 1, code: 'Escape' },
  { button: 9, code: 'Escape' },
  { button: 2, code: 'KeyN' },
  { button: 3, code: 'KeyT' },
  { button: 4, code: 'BracketLeft' },
  { button: 5, code: 'BracketRight' },
];

interface PadNavState {
  dirHeld: boolean[];
  /** performance.now() time of the next hold-repeat per direction; Infinity = no repeat pending. */
  nextRepeatAt: number[];
  buttonHeld: boolean[];
  /** Poll tick this pad was last seen on; stale entries are dropped. */
  seenTick: number;
}

function buttonDown(pad: Gamepad, index: number): boolean {
  const b = pad.buttons[index];
  return b !== undefined && (b.pressed || b.value > STICK_THRESHOLD);
}

function dirDown(pad: Gamepad, dir: number): boolean {
  if (buttonDown(pad, DIR_BUTTONS[dir])) return true;
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  switch (dir) {
    case 0: return y <= -STICK_THRESHOLD;
    case 1: return y >= STICK_THRESHOLD;
    case 2: return x <= -STICK_THRESHOLD;
    default: return x >= STICK_THRESHOLD;
  }
}

function dispatchKey(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
}

/**
 * Start the pad-to-key loop. Keys are only dispatched while isActive() and not
 * isCapturing(), but pad state is tracked every frame, so a button already held
 * when a menu opens (the Start press that paused) is not read as a new press.
 */
export function createPadNav(isActive: () => boolean, isCapturing: () => boolean): { stop(): void } {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return { stop(): void {} };
  }

  const states = new Map<number, PadNavState>();
  let tick = 0;
  let rafId = 0;
  let stopped = false;

  function poll(): void {
    if (stopped) return;
    rafId = requestAnimationFrame(poll);
    tick += 1;

    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return;
    }

    const live = isActive() && !isCapturing();
    const now = performance.now();

    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      let st = states.get(pad.index);
      if (!st) {
        // A pad first seen with a button down should not fire it, so seed from its current state.
        st = {
          dirHeld: DIR_CODES.map((_, d) => dirDown(pad, d)),
          nextRepeatAt: DIR_CODES.map(() => Infinity),
          buttonHeld: BUTTON_MAP.map((m) => buttonDown(pad, m.button)),
          seenTick: tick,
        };
        states.set(pad.index, st);
        continue;
      }
      st.seenTick = tick;

      for (let d = 0; d < DIR_CODES.length; d += 1) {
        const down = dirDown(pad, d);
        if (!down || !live) {
          // A direction held while the menu is inactive never fires or repeats until released.
          st.nextRepeatAt[d] = Infinity;
        } else if (!st.dirHeld[d]) {
          dispatchKey(DIR_CODES[d]);
          st.nextRepeatAt[d] = now + REPEAT_DELAY_MS;
        } else if (now >= st.nextRepeatAt[d]) {
          dispatchKey(DIR_CODES[d]);
          st.nextRepeatAt[d] = now + REPEAT_INTERVAL_MS;
        }
        st.dirHeld[d] = down;
      }

      for (let b = 0; b < BUTTON_MAP.length; b += 1) {
        const down = buttonDown(pad, BUTTON_MAP[b].button);
        if (down && !st.buttonHeld[b] && live) dispatchKey(BUTTON_MAP[b].code);
        st.buttonHeld[b] = down;
      }
    }

    for (const [index, st] of states) {
      if (st.seenTick !== tick) states.delete(index);
    }
  }

  rafId = requestAnimationFrame(poll);

  return {
    stop(): void {
      stopped = true;
      cancelAnimationFrame(rafId);
      states.clear();
    },
  };
}
