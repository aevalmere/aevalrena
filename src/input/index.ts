import type { InputSystem, LocalSession, MatchConfig } from '../core/types';

export function createInputSystem(): InputSystem {
  throw new Error('not implemented: input');
}

export function createLocalSession(input: InputSystem, config: MatchConfig): LocalSession {
  throw new Error('not implemented: input');
}
