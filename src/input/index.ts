import type { ControlsConfig, InputAction, InputSystem, LocalSession, MatchConfig } from '../core/types';
import { ACTIONS, DEFAULT_CONTROLS, clonePlayerControls } from './defaults';
import { KeyboardSource } from './keyboard';
import { loadControls, saveControls } from './store';
import { createLocalSessionImpl } from './session';

/** Maps a live InputSystem back to the KeyboardSource it was built with, so every LocalSession
 *  created from that system shares the same keyboard state. */
const sourceByInputSystem = new WeakMap<InputSystem, KeyboardSource>();

function findConflicts(config: ControlsConfig): { player: number; action: InputAction; code: string }[] {
  const counts = new Map<string, number>();
  for (const p of config.players) {
    for (const action of ACTIONS) {
      const code = p.bindings[action];
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const result: { player: number; action: InputAction; code: string }[] = [];
  for (let player = 0; player < config.players.length; player++) {
    for (const action of ACTIONS) {
      const code = config.players[player].bindings[action];
      if ((counts.get(code) ?? 0) > 1) result.push({ player, action, code });
    }
  }
  return result;
}

export function createInputSystem(): InputSystem {
  const controls = loadControls(DEFAULT_CONTROLS);
  const source = new KeyboardSource(controls);

  const system: InputSystem = {
    controls,

    save(): void {
      saveControls(system.controls);
    },

    resetDefaults(player: number): void {
      system.controls.players[player] = clonePlayerControls(DEFAULT_CONTROLS.players[player]);
      system.save();
    },

    setBinding(player: number, action: InputAction, code: string): void {
      system.controls.players[player].bindings[action] = code;
      system.save();
    },

    setTapJump(player: number, on: boolean): void {
      system.controls.players[player].tapJump = on;
      system.save();
    },

    listenForNextKey(): Promise<string> {
      return source.listenForNextKey();
    },

    conflicts(): { player: number; action: InputAction; code: string }[] {
      return findConflicts(system.controls);
    },

    anyKeyDown(): boolean {
      return source.anyKeyDown();
    },
  };

  sourceByInputSystem.set(system, source);
  return system;
}

export function createLocalSession(input: InputSystem, config: MatchConfig): LocalSession {
  const source = sourceByInputSystem.get(input);
  if (!source) {
    throw new Error('createLocalSession requires an InputSystem created by createInputSystem');
  }
  return createLocalSessionImpl(source, input, config);
}
