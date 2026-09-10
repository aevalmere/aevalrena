import type { ControlsConfig, InputAction, PlayerControls } from '../core/types';

/** Action order used everywhere bindings are iterated. */
export const ACTIONS: InputAction[] = [
  'left', 'right', 'up', 'down', 'jump', 'attack', 'special', 'shield', 'taunt', 'start',
];

function playerControls(
  left: string, right: string, up: string, down: string, jump: string,
  attack: string, special: string, shield: string, taunt: string, start: string,
): PlayerControls {
  return {
    bindings: { left, right, up, down, jump, attack, special, shield, taunt, start },
    tapJump: false,
  };
}

export const DEFAULT_CONTROLS: ControlsConfig = {
  players: [
    playerControls('KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'KeyJ', 'KeyK', 'KeyL', 'KeyT', 'Escape'),
    playerControls(
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftRight',
      'Comma', 'Period', 'Slash', 'Quote', 'Enter',
    ),
    playerControls(
      'Numpad4', 'Numpad6', 'Numpad8', 'Numpad5', 'Numpad0',
      'Numpad7', 'Numpad9', 'NumpadAdd', 'NumpadDecimal', 'NumpadEnter',
    ),
    playerControls('KeyB', 'KeyM', 'KeyH', 'KeyN', 'KeyG', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'),
  ],
};

/** Deep clone so callers can freely mutate the result without touching the defaults. */
export function cloneControls(config: ControlsConfig): ControlsConfig {
  return {
    players: config.players.map((p) => ({ bindings: { ...p.bindings }, tapJump: p.tapJump })),
  };
}

export function clonePlayerControls(config: PlayerControls): PlayerControls {
  return { bindings: { ...config.bindings }, tapJump: config.tapJump };
}
