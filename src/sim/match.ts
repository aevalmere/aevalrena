import { RESPAWN_INVULN, RESPAWN_PLATFORM_FRAMES, SHIELD_MAX } from '../core/constants';
import { BURST_ONLY } from '../core/types';
import type { ActionId, GameState } from '../core/types';
import { PROJECTILE_DEFS } from './projectiles';
import { unlinkGrab } from './grab';
import { unlinkFinalSmash } from './finalsmash';
import { clearBuffer } from './input';
import {
  countMoveStart, defOf, KO_CREDIT_FRAMES, setAction, simFighters, stageOf, teamOf, type SimFighter,
} from './state';

const DEAD_FRAMES = 60;
/** Where a fighter with no stocks left is parked, well outside any blast zone. */
const OUT_OF_PLAY = 10000;

export function koFighter(
  state: GameState, f: SimFighter, side: 'left' | 'right' | 'top' | 'bottom',
): void {
  state.events.push({ type: 'ko', x: f.x, y: f.y, slot: f.slot, side });
  recordKo(state, f);
  f.stocks--;
  // The other side of a grab sees the broken link on its own step and lets go. A Final
  // Smash victim is freed at once; an attacker who loses its victim plays on as a whiff.
  unlinkGrab(state, f);
  unlinkFinalSmash(state, f);
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

/**
 * KO credit (results stats): the last fighter to hit the victim gets the KO if that hit
 * landed within KO_CREDIT_FRAMES; otherwise it is a self-destruct. lastHitBy itself is
 * left alone (the AI tests read it); lastHitFrame is cleared so the credit cannot carry
 * into the next stock.
 */
function recordKo(state: GameState, f: SimFighter): void {
  if (state.finished) return;
  f.stats.falls++;
  let killer: SimFighter | null = null;
  if (f.lastHitFrame >= 0 && state.frame - f.lastHitFrame <= KO_CREDIT_FRAMES) {
    const fighters = simFighters(state);
    for (let i = 0; i < fighters.length; i++) {
      if (fighters[i].slot === f.lastHitBy && fighters[i] !== f) killer = fighters[i];
    }
  }
  if (killer === null) f.stats.sds++;
  else {
    killer.stats.kos++;
    if (killer.stats.firstBloodFrame < 0) killer.stats.firstBloodFrame = state.frame;
  }
  f.lastHitFrame = -1;
  f.comboBy = -1;
  f.comboCount = 0;
}

/** Actions whose ground movement counts toward distanceRun. */
function runs(action: ActionId): boolean {
  return action === 'walk' || action === 'dash' || action === 'run' || action === 'turn' || action === 'idle';
}

/**
 * Per-frame stats tick, called while the match is live. Reads fighter state and this
 * frame's events; never writes anything gameplay reads.
 */
function tickStats(state: GameState): void {
  const fighters = simFighters(state);
  let lead = -1;
  let tied = false;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    const s = f.stats;
    if (f.action === 'attack' && f.moveId !== null && !f.moveCounted) {
      countMoveStart(f, f.moveId);
      f.moveCounted = true;
    }
    if (f.percent > s.peakDamage) s.peakDamage = f.percent;
    if (f.action === 'shield' || f.action === 'shieldStun') s.shieldTime++;
    if (f.action !== 'dead' && f.action !== 'respawn') {
      if (f.onGround) s.groundTime++;
      else s.airTime++;
    }
    if (f.onGround && runs(f.action)) {
      const dx = f.x - f.statX;
      s.distanceRun += dx < 0 ? -dx : dx;
    }
    f.statX = f.x;
    if (f.stocks <= 0) continue;
    if (lead < 0) {
      lead = i;
      continue;
    }
    const b = fighters[lead];
    if (f.stocks > b.stocks || (f.stocks === b.stocks && f.percent < b.percent)) {
      lead = i;
      tied = false;
    } else if (f.stocks === b.stocks && f.percent === b.percent) {
      tied = true;
    }
  }
  if (lead >= 0 && !tied) fighters[lead].stats.timeInLead++;

  for (let i = 0; i < state.events.length; i++) {
    const ev = state.events[i];
    if (ev.type !== 'projectileSpawn') continue;
    const def = PROJECTILE_DEFS[ev.defId];
    if (def !== undefined && def.spawnFrame === BURST_ONLY) continue;   // a burst is not a shot
    for (let j = 0; j < fighters.length; j++) {
      if (fighters[j].slot === ev.slot) fighters[j].stats.projectilesFired++;
    }
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
  unlinkGrab(state, f);
  unlinkFinalSmash(state, f);
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

/**
 * Teams rule winner: the side with the most stocks left in total, then the lowest summed
 * percent among its members still in; equal sides draw. Returns the team index, -1 on a
 * draw. Only the (at most four) distinct teams are compared, with no allocation.
 */
function decideWinnerTeam(state: GameState, fighters: SimFighter[]): number {
  let best = -1;
  let bestStocks = -1;
  let bestPercent = Number.POSITIVE_INFINITY;
  let tied = false;
  for (let i = 0; i < fighters.length; i++) {
    const team = teamOf(state, fighters[i].slot);
    let seen = false;
    for (let j = 0; j < i; j++) if (teamOf(state, fighters[j].slot) === team) seen = true;
    if (seen) continue;
    let stocks = 0;
    let percent = 0;
    for (let j = i; j < fighters.length; j++) {
      const f = fighters[j];
      if (teamOf(state, f.slot) !== team) continue;
      stocks += f.stocks;
      if (f.stocks > 0) percent += f.percent;
    }
    if (stocks > bestStocks || (stocks === bestStocks && percent < bestPercent)) {
      best = team;
      bestStocks = stocks;
      bestPercent = percent;
      tied = false;
    } else if (stocks === bestStocks && percent === bestPercent) {
      tied = true;
    }
  }
  return tied ? -1 : best;
}

/** The winning team's representative slot: its member with most stocks, then lowest percent. */
function bestOfTeam(state: GameState, fighters: SimFighter[], team: number): number {
  let winner = -1;
  let bestStocks = -1;
  let bestPercent = Number.POSITIVE_INFINITY;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (teamOf(state, f.slot) !== team) continue;
    if (f.stocks > bestStocks || (f.stocks === bestStocks && f.percent < bestPercent)) {
      winner = f.slot;
      bestStocks = f.stocks;
      bestPercent = f.percent;
    }
  }
  return winner;
}

/** Number of distinct sides with a member still holding stocks (teams, or single fighters). */
function sidesAlive(state: GameState, fighters: SimFighter[]): number {
  let sides = 0;
  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i].stocks <= 0) continue;
    const team = teamOf(state, fighters[i].slot);
    let counted = false;
    for (let j = 0; j < i; j++) {
      if (fighters[j].stocks > 0 && teamOf(state, fighters[j].slot) === team) counted = true;
    }
    if (!counted) sides++;
  }
  return sides;
}

/** Step 7 of the frame: respawn timers, then the end of the match. */
export function stepMatch(state: GameState): void {
  const fighters = simFighters(state);
  if (!state.finished) tickStats(state);
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f.action !== 'dead' || f.stocks <= 0 || f.respawnTimer <= 0) continue;
    f.respawnTimer--;
    if (f.respawnTimer === 0) respawn(state, f);
  }

  if (state.finished) return;
  // Without the Teams rule teamOf is the slot, so a side is one fighter.
  const alive = sidesAlive(state, fighters);
  const outOfTime = state.timeLeft === 0;
  if ((state.config.players.length >= 2 && alive <= 1) || outOfTime) {
    state.finished = true;
    state.endFrame = state.frame;
    if (state.config.teams === true) {
      const team = decideWinnerTeam(state, fighters);
      state.winnerTeam = team;
      state.winner = team < 0 ? -1 : bestOfTeam(state, fighters, team);
    } else {
      state.winner = decideWinner(fighters);
    }
    state.events.push({ type: 'matchEnd', winner: state.winner });
  }
}
