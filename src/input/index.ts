import type {
  BindConflict,
  BindDevice,
  ControlsConfig,
  InputAction,
  InputSystem,
  LocalSession,
  MatchConfig,
} from '../core/types';
import { ACTIONS, DEFAULT_CONTROLS, clonePlayerControls } from './defaults';
import { GamepadSource, MAX_PADS, type PadCapture } from './gamepad';
import { KeyboardSource } from './keyboard';
import { loadControls, saveControls } from './store';
import { createLocalSessionImpl } from './session';

/** The raw device sources behind one InputSystem. */
interface Sources {
  keys: KeyboardSource;
  pads: GamepadSource;
  /** Whether player 0's Start was down on a pad at the last padStartPressed call. */
  padStartWasDown: boolean;
}

/** Maps a live InputSystem back to the sources it was built with, so every LocalSession
 *  created from that system shares the same keyboard state and the same gamepad snapshot. */
const sourcesByInputSystem = new WeakMap<InputSystem, Sources>();

/**
 * One conflict per cell whose non-empty code is bound more than once. The keyboard is shared,
 * so a key clashes across all players; each player has their own pad, so pad codes clash only
 * within one player.
 */
function findConflicts(config: ControlsConfig): BindConflict[] {
  const result: BindConflict[] = [];
  const keyCounts = new Map<string, number>();
  for (const p of config.players) {
    for (const action of ACTIONS) {
      for (const code of p.keys[action]) {
        if (code !== '') keyCounts.set(code, (keyCounts.get(code) ?? 0) + 1);
      }
    }
  }
  for (let player = 0; player < config.players.length; player++) {
    const p = config.players[player];
    const padCounts = new Map<string, number>();
    for (const action of ACTIONS) {
      for (const code of p.pad[action]) {
        if (code !== '') padCounts.set(code, (padCounts.get(code) ?? 0) + 1);
      }
    }
    for (const action of ACTIONS) {
      pushConflicts(result, player, 'keys', action, p.keys[action], keyCounts);
    }
    for (const action of ACTIONS) {
      pushConflicts(result, player, 'pad', action, p.pad[action], padCounts);
    }
  }
  return result;
}

function pushConflicts(
  out: BindConflict[],
  player: number,
  device: BindDevice,
  action: InputAction,
  pair: [string, string],
  counts: Map<string, number>,
): void {
  for (const slot of [0, 1] as const) {
    const code = pair[slot];
    if (code !== '' && (counts.get(code) ?? 0) > 1) out.push({ player, device, action, slot, code });
  }
}

export function createInputSystem(): InputSystem {
  const controls = loadControls(DEFAULT_CONTROLS);
  const keys = new KeyboardSource(controls);
  const pads = new GamepadSource();
  let padCapture: PadCapture | null = null;

  function cancelCapture(): void {
    keys.cancelListen();
    if (padCapture !== null) {
      const pending = padCapture;
      padCapture = null;
      pending.cancel();
    }
  }

  const system: InputSystem = {
    controls,

    save(): void {
      saveControls(system.controls);
    },

    resetDefaults(player: number): void {
      system.controls.players[player] = clonePlayerControls(DEFAULT_CONTROLS.players[player]);
      system.save();
    },

    setBinding(player: number, device: BindDevice, action: InputAction, slot: 0 | 1, code: string): void {
      system.controls.players[player][device][action][slot] = code;
      system.save();
    },

    setTapJump(player: number, on: boolean): void {
      system.controls.players[player].tapJump = on;
      system.save();
    },

    setPadIndex(player: number, index: number): void {
      system.controls.players[player].padIndex = index;
      system.save();
    },

    /**
     * Resolves with the binding the user types next: hold keys, release one to bind, and the
     * result is every key held, joined by '&' in press order ('KeyF&KeyJ'). A single press and
     * release gives one bare code. Backspace or Delete resolves '' (unbind); Escape, starting
     * another capture, or cancelCapture rejects with Error('cancelled').
     */
    listenForNextKey(): Promise<string> {
      cancelCapture();
      return keys.listenForNextKey();
    },

    listenForNextPad(padIndex: number): Promise<string> {
      cancelCapture();
      const capture = pads.capture(padIndex);
      padCapture = capture;
      const clear = (): void => {
        if (padCapture === capture) padCapture = null;
      };
      capture.promise.then(clear, clear);
      return capture.promise;
    },

    cancelCapture,

    isCapturing(): boolean {
      return keys.isListening() || padCapture !== null;
    },

    conflicts(): BindConflict[] {
      return findConflicts(system.controls);
    },

    connectedPads(): { index: number; id: string }[] {
      pads.poll();
      return pads.connected();
    },

    /** Any raw key or pad button, bound or not, so it never has to read a chord slot. */
    anyKeyDown(): boolean {
      if (keys.anyKeyDown()) return true;
      pads.poll();
      return pads.anyButtonDown();
    },
  };

  // Escape cancels a pad capture the same way it cancels a key capture.
  keys.onEscape = (): boolean => {
    if (padCapture === null) return false;
    cancelCapture();
    return true;
  };

  // The keyboard stays live for the whole app: the controls screen needs
  // listenForNextKey and anyKeyDown outside a match. Sessions add a second ref.
  keys.attach();
  sourcesByInputSystem.set(system, { keys, pads, padStartWasDown: false });
  return system;
}

export function createLocalSession(input: InputSystem, config: MatchConfig): LocalSession {
  const sources = sourcesByInputSystem.get(input);
  if (!sources) {
    throw new Error('createLocalSession requires an InputSystem created by createInputSystem');
  }
  return createLocalSessionImpl(sources.keys, sources.pads, input, config);
}

/** True when every code in a slot is active on `pad`. A chord slot needs all of its codes. */
function slotActive(pads: GamepadSource, pad: number, slot: string): boolean {
  if (slot === '') return false;
  if (slot.indexOf('&') < 0) return pads.isActive(pad, slot);
  for (const code of slot.split('&')) {
    if (!pads.isActive(pad, code)) return false;
  }
  return true;
}

/**
 * True on the call where a pad `start` binding of player 0 goes down on any connected pad.
 * Polls the pads itself. For a CPU-only match, where no slot samples a pad Start; call it once
 * per sim frame so the edge is tracked.
 */
export function padStartPressed(input: InputSystem): boolean {
  const sources = sourcesByInputSystem.get(input);
  if (!sources) return false;
  const pads = sources.pads;
  pads.poll();
  const pair = input.controls.players[0].pad.start;
  let down = false;
  for (let pad = 0; pad < MAX_PADS && !down; pad++) {
    if (!pads.isConnected(pad)) continue;
    if (slotActive(pads, pad, pair[0]) || slotActive(pads, pad, pair[1])) down = true;
  }
  const pressed = down && !sources.padStartWasDown;
  sources.padStartWasDown = down;
  return pressed;
}
