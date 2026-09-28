import { COMMAND_ACTIONS, DIRECT_MOVES } from '../core/types';
import type {
  BindingPair, Bindings, ButtonAction, CommandAction, ControlsConfig, InputAction, PlayerControls,
} from '../core/types';

/** Button actions in the order they are iterated when sampling. */
export const BUTTON_ACTIONS: ButtonAction[] = [
  'left', 'right', 'up', 'down', 'walk', 'jump', 'attack', 'special', 'shield', 'grab', 'dodge',
  'taunt', 'start', 'cUp', 'cDown', 'cLeft', 'cRight',
];

/** Context commands bindable to their own key or pad slot, in DIRECT_CODES order. */
export const COMMAND_ACTION_LIST: CommandAction[] = [...COMMAND_ACTIONS];

/**
 * Action order used everywhere bindings are iterated: button actions, every direct move,
 * then every command.
 */
export const ACTIONS: InputAction[] = [...BUTTON_ACTIONS, ...DIRECT_MOVES, ...COMMAND_ACTIONS];

/** Bindings with every action present and unbound, then `table` written over it. */
function bindings(table: Partial<Record<InputAction, BindingPair | string>>): Bindings {
  const out = {} as Bindings;
  for (const action of ACTIONS) {
    const entry = table[action];
    if (typeof entry === 'string') out[action] = [entry, ''];
    else if (entry !== undefined) out[action] = [entry[0], entry[1]];
    else out[action] = ['', ''];
  }
  return out;
}

/** Gamepad layout, the same for every player (W3C standard mapping codes). */
function padBindings(): Bindings {
  return bindings({
    left: ['A0-', 'B14'], right: ['A0+', 'B15'], up: ['A1-', 'B12'], down: ['A1+', 'B13'],
    jump: ['B3', 'B2'], attack: 'B0', special: 'B1', shield: ['B6', 'B7'], grab: 'B5', dodge: 'B4',
    taunt: 'B11', start: 'B9', cUp: 'A3-', cDown: 'A3+', cLeft: 'A2-', cRight: 'A2+',
  });
}

function playerControls(keys: Partial<Record<InputAction, BindingPair | string>>): PlayerControls {
  return { keys: bindings(keys), pad: padBindings(), padIndex: -1, tapJump: true };
}

/**
 * Player 1 keyboard layout mimics Smash: WASD moves, W is Up and also jumps (tap jump),
 * J attack, K special, L shield, ; grab, E dodge, Shift walks and, while held, stops W
 * from jumping so W + J is an up tilt. F is the smash modifier and G the tilt modifier:
 * F&J forward smash, F&W up smash, F&S down smash, G&J forward tilt, G&W up tilt,
 * G&S down tilt. Every other move comes from direction + button, as in Smash.
 */
export const DEFAULT_CONTROLS: ControlsConfig = {
  players: [
    playerControls({
      left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', walk: 'ShiftLeft', jump: ['KeyW', 'Space'],
      attack: 'KeyJ', special: 'KeyK', shield: 'KeyL', grab: 'Semicolon', dodge: 'KeyE',
      taunt: 'KeyT', start: 'Escape',
      fsmash: 'KeyF&KeyJ', usmash: 'KeyF&KeyW', dsmash: 'KeyF&KeyS',
      ftilt: 'KeyG&KeyJ', utilt: 'KeyG&KeyW', dtilt: 'KeyG&KeyS',
    }),
    // Every keyboard player has a Walk key so Walk + Up + Attack up tilts; player 1 also has the chords.
    playerControls({
      left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', walk: 'ShiftRight',
      jump: ['ArrowUp', 'ControlRight'],
      attack: 'Comma', special: 'Period', shield: 'Slash', grab: 'Quote', taunt: 'BracketRight',
      start: 'Enter',
    }),
    playerControls({
      left: 'Numpad4', right: 'Numpad6', up: 'Numpad8', down: 'Numpad5', walk: 'Numpad2',
      jump: 'Numpad0', attack: 'Numpad7', special: 'Numpad9', shield: 'NumpadAdd', grab: 'Numpad1',
      dodge: 'Numpad3', taunt: 'NumpadDecimal', start: 'NumpadEnter',
    }),
    playerControls({
      left: 'KeyB', right: 'KeyM', up: 'KeyH', down: 'KeyN', walk: 'KeyX',
      jump: ['KeyH', 'KeyR'], attack: 'KeyY',
      special: 'KeyU', shield: 'KeyI', grab: 'KeyV', dodge: 'KeyC', taunt: 'KeyO', start: 'KeyP',
    }),
  ],
};

/** Copies every pair array, so the result shares nothing with `source`. */
export function cloneBindings(source: Bindings): Bindings {
  const out = {} as Bindings;
  for (const action of ACTIONS) {
    const pair = source[action];
    out[action] = pair === undefined ? ['', ''] : [pair[0], pair[1]];
  }
  return out;
}

/** Deep clone so callers can freely mutate the result without touching the defaults. */
export function cloneControls(config: ControlsConfig): ControlsConfig {
  return { players: config.players.map(clonePlayerControls) };
}

export function clonePlayerControls(config: PlayerControls): PlayerControls {
  return {
    keys: cloneBindings(config.keys),
    pad: cloneBindings(config.pad),
    padIndex: config.padIndex,
    tapJump: config.tapJump,
  };
}
