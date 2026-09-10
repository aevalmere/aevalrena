import { RESPAWN_INVULN, RESPAWN_PLATFORM_FRAMES, SHIELD_MAX } from '../core/constants';
import type { GameState } from '../core/types';
import { clearBuffer } from './input';
import { defOf, setAction, simFighters, stageOf, type SimFighter } from './state';

const DEAD_FRAMES = 60;
/** Where a fighter with no stocks left is parked, well outside any blast zone. */
const OUT_OF_PLAY = 10000;

export function koFighter(
  state: GameState, f: SimFighter, side: 'left' | 'right' | 'top' | 'bottom',
): void {
  state.events.push({ type: 'ko', x: f.x, y: f.y, slot: f.slot, side });
  f.stocks--;
  setAction(f, 'dead');
  f.vx = 0;
  f.vy = 0;
  f.kbSpeed = 0;
  f.hitstun = 0;
  f.hitlag = 0;
  f.invuln = 0;
  f.onGround = false;
  f.ledge = -1;
  f.ledgeRegrabs = 0;
  f.fastFalling = false;
  f.respawnTimer = DEAD_FRAMES;
  clearBuffer(f);
  if (f.stocks <= 0) {
    f.stocks = 0;
    f.respawnTimer = -1;
    const blast = stageOf(state).blast;
    f.x = blast.x - OUT_OF_PLAY;
    f.y = blast.y - OUT_OF_PLAY;
  }
}

function respawn(state: GameState, f: SimFighter): void {
  const stage = stageOf(state);
  const def = defOf(f);
  f.x = stage.respawn.x;
  f.y = stage.respawn.y;
  f.vx = 0;
  f.vy = 0;
  f.kbSpeed = 0;
  f.percent = 0;
  f.onGround = true;
  f.facing = f.x > 0 ? -1 : 1;
  f.jumpsLeft = def.jumps;
  f.shieldHp = SHIELD_MAX;
  f.fastFalling = false;
  f.hitstun = 0;
  f.ledge = -1;
  f.ledgeRegrabs = 0;
  f.respawnTimer = 0;
  setAction(f, 'respawn');
  f.invuln = RESPAWN_INVULN;
  clearBuffer(f);
  state.events.push({ type: 'respawn', x: f.x, y: f.y, slot: f.slot });
}

/**
 * The respawn platform is a floor only for the fighter standing on it. Any button
 * press, or RESPAWN_PLATFORM_FRAMES, drops the fighter off it.
 */
export function stepRespawn(f: SimFighter): void {
  f.vx = 0;
  f.vy = 0;
  f.onGround = true;
  if (f.inputPressed !== 0 || f.actionFrame >= RESPAWN_PLATFORM_FRAMES) {
    setAction(f, 'air');
    f.onGround = false;
    clearBuffer(f);
  }
}

function decideWinner(fighters: SimFighter[]): number {
  let winner = -1;
  let bestStocks = -1;
  let bestPercent = Number.POSITIVE_INFINITY;
  let tied = false;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f.stocks > bestStocks || (f.stocks === bestStocks && f.percent < bestPercent)) {
      winner = f.slot;
      bestStocks = f.stocks;
      bestPercent = f.percent;
      tied = false;
    } else if (f.stocks === bestStocks && f.percent === bestPercent) {
      tied = true;
    }
  }
  return tied ? -1 : winner;
}

/** Step 7 of the frame: respawn timers, then the end of the match. */
export function stepMatch(state: GameState): void {
  const fighters = simFighters(state);
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f.action !== 'dead' || f.stocks <= 0 || f.respawnTimer <= 0) continue;
    f.respawnTimer--;
    if (f.respawnTimer === 0) respawn(state, f);
  }

  if (state.finished) return;
  let alive = 0;
  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i].stocks > 0) alive++;
  }
  const outOfTime = state.timeLeft === 0;
  if ((state.config.players.length >= 2 && alive <= 1) || outOfTime) {
    state.finished = true;
    state.winner = decideWinner(fighters);
    state.events.push({ type: 'matchEnd', winner: state.winner });
  }
}
