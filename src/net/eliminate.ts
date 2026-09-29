import type { GameState } from '../core/types';
import { koFighter } from '../sim/match';
import type { SimFighter } from '../sim/state';

/**
 * RollbackSim.eliminate for the real sim: a player who left loses their last stock through the
 * sim's own KO path (falls, parked out of play, respawn off), so the next step's match end rule
 * gives the win to whoever remains, teams included. This is the one place netcode reaches past
 * stepGame into the sim; docs/LAN.md section 8 lists it in the porting checklist.
 */
export function eliminateFighter(state: GameState, index: number): void {
  const f = state.fighters[index] as SimFighter | undefined;
  if (f === undefined || f.stocks <= 0 || state.finished) return;
  f.stocks = 1;
  koFighter(state, f, 'bottom');
}
