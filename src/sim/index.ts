import type { GameState, InputFrame, MatchConfig } from '../core/types';

export function createGameState(config: MatchConfig): GameState {
  throw new Error('not implemented: sim');
}

export function stepGame(state: GameState, inputs: InputFrame[]): void {
  throw new Error('not implemented: sim');
}

export function cloneGameState(state: GameState): GameState {
  throw new Error('not implemented: sim');
}
