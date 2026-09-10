import { SHIELD_REGEN } from '../core/constants';
import type { GameState, InputFrame } from '../core/types';
import { stepAction } from './actions';
import { regenShield, resolveHits } from './hits';
import { consumeInput, EMPTY_INPUT } from './input';
import { stepMatch } from './match';
import { stepPhysics } from './physics';
import { stepProjectiles } from './projectiles';
import { defOf, simFighters, type SimFighter } from './state';

export { createGameState, cloneGameState } from './state';

function updateFighter(state: GameState, f: SimFighter): void {
  const def = defOf(f);
  f.actionFrame++;
  f.prevY = f.y;
  f.skipGravity = false;
  if (f.invuln > 0) f.invuln--;
  if (f.ledgeCooldown > 0) f.ledgeCooldown--;
  if (f.dropTimer > 0) f.dropTimer--;
  if (f.hitstun > 0) f.hitstun--;
  regenShield(f, SHIELD_REGEN);
  stepAction(state, f, def);
  stepPhysics(state, f, def);
}

/** One sim frame at 60 Hz. Deterministic given (state, inputs). See SPEC 4.1. */
export function stepGame(state: GameState, inputs: InputFrame[]): void {
  state.events.length = 0;
  state.frame++;
  if (state.timeLeft > 0) state.timeLeft--;

  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) {
    const inp = state.finished || i >= inputs.length ? EMPTY_INPUT : inputs[i];
    consumeInput(fighters[i], inp);
  }

  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f.hitlag > 0) {
      f.hitlag--;
      continue;
    }
    updateFighter(state, f);
  }

  stepProjectiles(state);
  resolveHits(state);
  stepMatch(state);
}
