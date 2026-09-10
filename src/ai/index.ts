import type { GameState, InputFrame } from '../core/types';

export function cpuInput(state: GameState, slot: number, level: number, rand: () => number): InputFrame {
  throw new Error('not implemented: ai');
}
